import { existsSync, readFileSync, mkdirSync, unlinkSync, chmodSync, lstatSync, realpathSync, openSync, closeSync, writeSync, fstatSync, fsyncSync, statSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'
import { atomicWrite } from '@plur-ai/core'
import { readConfigForWrite, codexConfigTomlPath } from '../mcp-config.js'
import { parseJsonc } from '../lib/jsonc.js'
import { parseTOML, getStaticTOMLValue, type AST } from 'toml-eslint-parser'
import { applyEdits, modify } from 'jsonc-parser'
import { currentWindowsAccount, protectOwnerOnlyWindows, type OwnerOnlyExec } from './owner-only.js'

export type ToolId = 'claude-code' | 'codex' | 'opencode' | 'cursor'

export interface CleanupEntry {
  target: string
  status: 'removed' | 'absent' | 'refused'
  backup?: string
  detail?: string
}

const ENTRY = 'plur-enterprise'

/** Writes a backup of a file and returns its path; throws when it cannot be made safely. */
type Backup = (source: string) => string

const HEADER_FILE = 'mcp-enterprise-header'

/**
 * Remove old `plur-enterprise` MCP entries and the header file after the
 * hello proof passes. Every removal is preceded by a backup in `backupDir`,
 * which is made owner-only (and verified) before the first secret is copied.
 * Only tools whose hello passed are included in `tools`. The shared header
 * file is removed only when no editor config still has a legacy entry or
 * names the file, and every editor config could be read.
 */
export function cleanupLegacy(opts: {
  tools: ToolId[]
  backupDir: string
  plurDir: string
  /** Override for testing: the home directory (default: os.homedir()) */
  home?: string
  /** Override for testing: process environment for path resolution */
  env?: NodeJS.ProcessEnv
  /** Override for testing: the platform (default: process.platform) */
  platform?: NodeJS.Platform
  /** Override for testing: runs icacls on Windows */
  exec?: OwnerOnlyExec
  /** Override for testing: the Windows account (default: USERDOMAIN\\USERNAME from env) */
  account?: string
}): CleanupEntry[] {
  const home = opts.home ?? homedir()
  const env = opts.env ?? process.env
  const toolSet = new Set(opts.tools)
  const results: CleanupEntry[] = []
  const backup = backupWriter(opts.backupDir, {
    platform: opts.platform ?? process.platform,
    exec: opts.exec,
    account: opts.account ?? currentWindowsAccount(env),
  })

  // One target's failure (unreadable file, backup dir not writable, …) is
  // reported as refused and never stops the others. A write happens only
  // after its backup succeeded, so a throw before that point changed nothing.
  const run = (target: string, fn: (target: string, backup: Backup) => CleanupEntry): void => {
    try {
      results.push(fn(target, backup))
    } catch (e) {
      results.push({ target, status: 'refused', detail: e instanceof Error ? e.message : String(e) })
    }
  }

  const paths = editorConfigPaths(home, env)
  if (toolSet.has('claude-code')) run(paths.claude, cleanupClaudeJson)
  if (toolSet.has('cursor')) run(paths.cursor, cleanupJsonMcpFile)
  if (toolSet.has('codex')) run(paths.codex, cleanupCodexToml)
  if (toolSet.has('opencode')) run(resolveOpencodePath(home, env), cleanupOpencodeConfig)

  // The header file is shared by every legacy entry: it goes only when no
  // editor still needs it — checked after the cleanups above, across ALL
  // editors (proven or not).
  run(join(opts.plurDir, HEADER_FILE), (target, b) => {
    if (!existsSync(target)) return { target, status: 'absent' }
    const holders = headerHolders(home, env)
    if (holders.length > 0) return { target, status: 'refused', detail: `kept: ${holders.join('; ')}` }
    return cleanupFile(target, b)
  })

  return results
}

function editorConfigPaths(home: string, env: NodeJS.ProcessEnv): { claude: string; cursor: string; codex: string } {
  return {
    claude: join(home, '.claude.json'),
    cursor: join(home, '.cursor', 'mcp.json'),
    codex: codexConfigTomlPath(env),
  }
}

/**
 * Why the header file must stay: every editor config that still has a legacy
 * entry, names the header file, or could not be read or parsed (it might).
 * Empty when nothing can still use it.
 */
function headerHolders(home: string, env: NodeJS.ProcessEnv): string[] {
  const paths = editorConfigPaths(home, env)
  const dir = opencodeDir(home, env)
  const checks: Array<{ tool: string; path: string; has: (text: string) => boolean }> = [
    { tool: 'Claude Code', path: paths.claude, has: t => claudeHasEntry(JSON.parse(t)) },
    { tool: 'Cursor', path: paths.cursor, has: t => mcpServersHas(JSON.parse(t)) },
    { tool: 'Codex', path: paths.codex, has: t => definesEnterprise(parseTOML(t, { tomlVersion: '1.0' })) },
    { tool: 'OpenCode', path: join(dir, 'opencode.json'), has: t => opencodeHasEntry(parseJsonc(t)) },
    { tool: 'OpenCode', path: join(dir, 'opencode.jsonc'), has: t => opencodeHasEntry(parseJsonc(t)) },
  ]
  const holders: string[] = []
  for (const c of checks) {
    // Only a config KNOWN to be absent counts as no reference. existsSync
    // answers false for every failed stat (e.g. EACCES on a parent folder),
    // which would read "could not look" as "not there".
    const seen = lookup(c.path)
    if (seen === 'absent') continue
    if (seen === 'unknown') {
      holders.push(`${c.tool}'s config ${c.path} could not be read`)
      continue
    }
    let text: string
    try {
      text = readFileSync(c.path, 'utf8')
    } catch {
      holders.push(`${c.tool}'s config ${c.path} could not be read`)
      continue
    }
    let has: boolean
    try {
      has = c.has(text)
    } catch {
      holders.push(`${c.tool}'s config ${c.path} could not be parsed`)
      continue
    }
    if (has) holders.push(`${c.tool} still has the old ${ENTRY} entry (${c.path})`)
    else if (text.includes(HEADER_FILE)) holders.push(`${c.path} still names ${HEADER_FILE}`)
  }
  return holders
}

/** 'absent' only when the path is known not to exist; any other failure to look is 'unknown'. */
function lookup(path: string): 'present' | 'absent' | 'unknown' {
  try {
    statSync(path)
    return 'present'
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unknown'
  }
}

function mcpServersHas(config: unknown): boolean {
  const servers = isPlainObject(config) ? config.mcpServers : undefined
  return isPlainObject(servers) && ENTRY in servers
}

function claudeHasEntry(config: unknown): boolean {
  if (mcpServersHas(config)) return true
  const projects = isPlainObject(config) ? config.projects : undefined
  return isPlainObject(projects) && Object.values(projects).some(p => mcpServersHas(p))
}

function opencodeHasEntry(config: unknown): boolean {
  const mcp = isPlainObject(config) ? config.mcp : undefined
  if (!isPlainObject(mcp)) return false
  return ENTRY in mcp || (isPlainObject(mcp.servers) && ENTRY in mcp.servers)
}

// ─── Claude Code ─────────────────────────────────────────────────────────────

function cleanupClaudeJson(target: string, makeBackup: Backup): CleanupEntry {
  const { config, ok } = readConfigForWrite(target)
  if (!ok) return { target, status: 'refused', detail: 'file exists but could not be parsed' }
  if (!existsSync(target)) return { target, status: 'absent' }

  let changed = false

  // Top-level mcpServers
  const servers = config.mcpServers as Record<string, unknown> | undefined
  if (servers && ENTRY in servers) {
    delete servers[ENTRY]
    changed = true
  }

  // projects[*].mcpServers
  const projects = config.projects as Record<string, unknown> | undefined
  if (projects && typeof projects === 'object') {
    for (const key of Object.keys(projects)) {
      const proj = projects[key] as Record<string, unknown> | undefined
      if (!proj || typeof proj !== 'object') continue
      const projServers = proj.mcpServers as Record<string, unknown> | undefined
      if (projServers && ENTRY in projServers) {
        delete projServers[ENTRY]
        changed = true
      }
    }
  }

  if (!changed) return { target, status: 'absent' }

  const backup = makeBackup(target)
  writeInPlace(target, JSON.stringify(config, null, 2) + '\n')
  return { target, status: 'removed', backup }
}

// ─── Generic JSON mcpServers file (Cursor) ────────────────────────────────────

function cleanupJsonMcpFile(target: string, makeBackup: Backup): CleanupEntry {
  if (!existsSync(target)) return { target, status: 'absent' }

  const { config, ok } = readConfigForWrite(target)
  if (!ok) return { target, status: 'refused', detail: 'file exists but could not be parsed' }

  const servers = config.mcpServers as Record<string, unknown> | undefined
  if (!servers || !(ENTRY in servers)) return { target, status: 'absent' }

  delete servers[ENTRY]
  const backup = makeBackup(target)
  writeInPlace(target, JSON.stringify(config, null, 2) + '\n')
  return { target, status: 'removed', backup }
}

// ─── Codex config.toml ────────────────────────────────────────────────────────

function cleanupCodexToml(target: string, makeBackup: Backup): CleanupEntry {
  if (!existsSync(target)) return { target, status: 'absent' }

  const original = readFileSync(target, 'utf8')
  const result = removeTomlEnterpriseSection(original)
  if (result === null) return { target, status: 'refused', detail: 'config.toml could not be parsed' }
  if (typeof result === 'object') return { target, status: 'refused', detail: result.refused }
  if (result === original) return { target, status: 'absent' }

  const backup = makeBackup(target)
  writeInPlace(target, result)
  return { target, status: 'removed', backup }
}

/** Does the parsed TOML still define mcp_servers.plur-enterprise, in any form? */
function definesEnterprise(ast: AST.TOMLProgram): boolean {
  const value = getStaticTOMLValue(ast) as Record<string, unknown>
  const servers = value?.mcp_servers
  return typeof servers === 'object' && servers !== null && ENTRY in servers
}

/**
 * Remove all TOML table sections whose key starts with `mcp_servers.plur-enterprise`.
 * Each removed section is cut from its header to the end of its last key, plus
 * the line break and blank lines after it — so a comment that introduces the
 * NEXT table stays with that table. Returns the modified text, the original
 * text if nothing was removed, null if the TOML is invalid, or `{ refused }`
 * when the entry is defined in a form this cleanup does not edit (inline or
 * dotted keys) or the result would not parse.
 */
function removeTomlEnterpriseSection(text: string): string | null | { refused: string } {
  let ast: AST.TOMLProgram
  try {
    ast = parseTOML(text, { tomlVersion: '1.0' })
  } catch {
    return null
  }

  const removeSet: AST.TOMLTable[] = []
  for (const node of ast.body[0].body) {
    if (node.type !== 'TOMLTable') continue
    const rk = node.resolvedKey as (string | number)[]
    if (rk[0] === 'mcp_servers' && rk[1] === ENTRY) removeSet.push(node)
  }

  if (removeSet.length === 0) {
    return definesEnterprise(ast)
      ? { refused: 'plur-enterprise is defined inline in config.toml; remove it by hand' }
      : text
  }

  const cuts: Array<[number, number]> = removeSet.map(node => {
    let end = node.range[1]
    // Swallow the rest of the last line and any blank lines that follow.
    const m = /^[^\S\n]*(?:\r?\n[^\S\n]*)*(?:\r?\n|$)/.exec(text.slice(end))
    if (m) end += m[0].length
    return [node.range[0], end]
  })

  let result = text
  for (const [start, end] of cuts.reverse()) {
    result = result.slice(0, start) + result.slice(end)
  }

  let after: AST.TOMLProgram
  try {
    after = parseTOML(result, { tomlVersion: '1.0' })
  } catch {
    return { refused: 'config.toml would not parse after the edit; left unchanged' }
  }
  if (definesEnterprise(after)) {
    return { refused: 'plur-enterprise is also defined inline in config.toml; remove it by hand' }
  }
  return result
}

// ─── OpenCode config (JSONC) ──────────────────────────────────────────────────

function cleanupOpencodeConfig(target: string, makeBackup: Backup): CleanupEntry {
  if (!existsSync(target)) return { target, status: 'absent' }

  let source: string
  try {
    source = readFileSync(target, 'utf8')
  } catch {
    return { target, status: 'refused', detail: 'could not read file' }
  }

  let parsed: unknown
  try {
    parsed = parseJsonc(source)
  } catch {
    return { target, status: 'refused', detail: 'file could not be parsed as JSONC' }
  }

  if (!isPlainObject(parsed)) return { target, status: 'refused', detail: 'unexpected file shape' }

  const cfg = parsed
  let modified = source
  let changed = false

  // Remove from mcp['plur-enterprise'] (legacy location)
  const mcp = cfg.mcp
  if (isPlainObject(mcp) && ENTRY in mcp) {
    const edits = modify(modified, ['mcp', ENTRY], undefined, { formattingOptions: {} })
    modified = applyEdits(modified, edits)
    changed = true
  }

  // Remove from mcp.servers['plur-enterprise'] (native location)
  const mcpServers = isPlainObject(mcp) ? (mcp.servers as unknown) : undefined
  if (isPlainObject(mcpServers) && ENTRY in mcpServers) {
    const edits = modify(modified, ['mcp', 'servers', ENTRY], undefined, { formattingOptions: {} })
    modified = applyEdits(modified, edits)
    changed = true
  }

  if (!changed) return { target, status: 'absent' }

  const backup = makeBackup(target)
  writeInPlace(target, modified)
  return { target, status: 'removed', backup }
}

// ─── Header file ──────────────────────────────────────────────────────────────

function cleanupFile(target: string, makeBackup: Backup): CleanupEntry {
  if (!existsSync(target)) return { target, status: 'absent' }
  const backup = makeBackup(target)
  unlinkSync(target)
  return { target, status: 'removed', backup }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * A backup writer for `backupDir`. Before the first backup, the folder is
 * created (or an existing one checked) and made owner-only, and that is
 * verified: 0700 on Unix (a symlink, a non-folder or a folder owned by
 * another account is refused), an owner-only ACL on Windows. Each backup is
 * created owner-only from the outset — opened with mode 0600 on Unix, and on
 * Windows created empty and given an owner-only ACL before the content is
 * written — so a secret is never readable by anyone else, not even briefly.
 * An existing backup is never overwritten: a second backup of the same file
 * gets a numbered name. When protection cannot be established the writer
 * throws, and the target is refused with nothing changed.
 */
function backupWriter(
  backupDir: string,
  o: { platform: NodeJS.Platform; exec?: OwnerOnlyExec; account: string | null },
): Backup {
  let dirReady: true | Error | null = null
  const win = o.platform === 'win32'
  const ensureDir = (): void => {
    if (dirReady === null) {
      try {
        protectBackupDir(backupDir, o)
        dirReady = true
      } catch (e) {
        dirReady = e instanceof Error ? e : new Error(String(e))
      }
    }
    if (dirReady !== true) throw dirReady
  }
  return (source: string): string => {
    ensureDir()
    const data = readFileSync(source)
    const name = basename(source)
    let dest = join(backupDir, name)
    for (let n = 1; existsSync(dest); n++) dest = join(backupDir, `${name}.${n}`)
    // 'wx': created new (O_EXCL), never an existing file or a planted link.
    const fd = openSync(dest, 'wx', 0o600)
    let written = false
    try {
      if (win) {
        const r = protectOwnerOnlyWindows(dest, { directory: false, account: o.account, exec: o.exec })
        if (!r.ok) throw new Error(`the backup ${dest} could not be made private: ${r.detail}`)
      } else if ((fstatSync(fd).mode & 0o077) !== 0) {
        throw new Error(`the backup ${dest} could not be made private`)
      }
      // writeSync may write fewer bytes than asked; a backup counts only when
      // all of it is written and on disk, since the config change after it
      // is itself fsynced (atomicWrite).
      for (let off = 0; off < data.length; ) {
        const n = writeSync(fd, data, off, data.length - off)
        if (n <= 0) throw new Error(`the backup ${dest} could not be written`)
        off += n
      }
      fsyncSync(fd)
      written = true
    } finally {
      closeSync(fd)
      if (!written) {
        try { unlinkSync(dest) } catch { /* nothing was written to it */ }
      }
    }
    return dest
  }
}

function protectBackupDir(dir: string, o: { platform: NodeJS.Platform; exec?: OwnerOnlyExec; account: string | null }): void {
  const fail = (why: string): never => {
    throw new Error(`the backup folder ${dir} could not be made private: ${why}; nothing was changed`)
  }
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const st = lstatSync(dir)
  if (st.isSymbolicLink()) fail('it is a symbolic link')
  if (!st.isDirectory()) fail('it is not a folder')
  if (o.platform === 'win32') {
    const r = protectOwnerOnlyWindows(dir, { directory: true, account: o.account, exec: o.exec })
    if (!r.ok) fail(r.detail)
    return
  }
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) fail('it belongs to another account')
  if ((st.mode & 0o777) !== 0o700) {
    try {
      chmodSync(dir, 0o700)
    } catch (e) {
      fail(`chmod failed (${e instanceof Error ? e.message : String(e)})`)
    }
  }
  const mode = lstatSync(dir).mode & 0o777
  if (mode !== 0o700) fail(`mode is ${mode.toString(8)}, expected 700`)
}

/**
 * Replace a config file's content atomically (temp file, fsync, rename; the
 * file's mode is kept). A symlinked config is resolved first, so the rename
 * lands on the real file and the link survives. The content can still hold
 * other servers' credentials, so the write is `secret`: the temp file is as
 * protected as the config before the first byte (an owner-only access list on
 * Windows when the config has one; on Unix the config's mode).
 */
function writeInPlace(path: string, content: string): void {
  let target = path
  try {
    if (lstatSync(path).isSymbolicLink()) target = realpathSync(path)
  } catch {
    // not there or not statable — write at the given path
  }
  atomicWrite(target, content, { secret: true })
}

function opencodeDir(home: string, env: NodeJS.ProcessEnv): string {
  return env.OPENCODE_CONFIG_DIR
    ? env.OPENCODE_CONFIG_DIR
    : join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode')
}

/** Resolve the OpenCode config path from home + env, matching opencodeConfigDir logic. */
function resolveOpencodePath(home: string, env: NodeJS.ProcessEnv): string {
  const dir = opencodeDir(home, env)
  const jsonPath = join(dir, 'opencode.json')
  const jsoncPath = join(dir, 'opencode.jsonc')
  if (!existsSync(jsonPath) && existsSync(jsoncPath)) return jsoncPath
  return jsonPath
}
