import { existsSync, readFileSync, copyFileSync, mkdirSync, unlinkSync, chmodSync, lstatSync, realpathSync, constants as fsConstants } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'
import { atomicWrite } from '@plur-ai/core'
import { readConfigForWrite, codexConfigTomlPath } from '../mcp-config.js'
import { parseJsonc } from '../lib/jsonc.js'
import { parseTOML, getStaticTOMLValue, type AST } from 'toml-eslint-parser'
import { applyEdits, modify } from 'jsonc-parser'

export type ToolId = 'claude-code' | 'codex' | 'opencode' | 'cursor'

export interface CleanupEntry {
  target: string
  status: 'removed' | 'absent' | 'refused'
  backup?: string
  detail?: string
}

const ENTRY = 'plur-enterprise'

/**
 * Remove old `plur-enterprise` MCP entries and the header file after the
 * hello proof passes. Every removal is preceded by a backup in `backupDir`.
 * Only tools whose hello passed are included in `tools`.
 */
export function cleanupLegacy(opts: {
  tools: ToolId[]
  backupDir: string
  plurDir: string
  /** Override for testing: the home directory (default: os.homedir()) */
  home?: string
  /** Override for testing: process environment for path resolution */
  env?: NodeJS.ProcessEnv
}): CleanupEntry[] {
  const home = opts.home ?? homedir()
  const env = opts.env ?? process.env
  const toolSet = new Set(opts.tools)
  const results: CleanupEntry[] = []

  // One target's failure (unreadable file, backup dir not writable, …) is
  // reported as refused and never stops the others. A write happens only
  // after its backup succeeded, so a throw before that point changed nothing.
  const run = (target: string, fn: (target: string, backupDir: string) => CleanupEntry): void => {
    try {
      results.push(fn(target, opts.backupDir))
    } catch (e) {
      results.push({ target, status: 'refused', detail: e instanceof Error ? e.message : String(e) })
    }
  }

  if (toolSet.has('claude-code')) run(join(home, '.claude.json'), cleanupClaudeJson)
  if (toolSet.has('cursor')) run(join(home, '.cursor', 'mcp.json'), cleanupJsonMcpFile)
  if (toolSet.has('codex')) run(codexConfigTomlPath(env), cleanupCodexToml)
  if (toolSet.has('opencode')) run(resolveOpencodePath(home, env), cleanupOpencodeConfig)

  // Header file: always cleaned regardless of tools
  run(join(opts.plurDir, 'mcp-enterprise-header'), cleanupFile)

  return results
}

// ─── Claude Code ─────────────────────────────────────────────────────────────

function cleanupClaudeJson(target: string, backupDir: string): CleanupEntry {
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

  const backup = writeBackup(target, backupDir)
  writeInPlace(target, JSON.stringify(config, null, 2) + '\n')
  return { target, status: 'removed', backup }
}

// ─── Generic JSON mcpServers file (Cursor) ────────────────────────────────────

function cleanupJsonMcpFile(target: string, backupDir: string): CleanupEntry {
  if (!existsSync(target)) return { target, status: 'absent' }

  const { config, ok } = readConfigForWrite(target)
  if (!ok) return { target, status: 'refused', detail: 'file exists but could not be parsed' }

  const servers = config.mcpServers as Record<string, unknown> | undefined
  if (!servers || !(ENTRY in servers)) return { target, status: 'absent' }

  delete servers[ENTRY]
  const backup = writeBackup(target, backupDir)
  writeInPlace(target, JSON.stringify(config, null, 2) + '\n')
  return { target, status: 'removed', backup }
}

// ─── Codex config.toml ────────────────────────────────────────────────────────

function cleanupCodexToml(target: string, backupDir: string): CleanupEntry {
  if (!existsSync(target)) return { target, status: 'absent' }

  const original = readFileSync(target, 'utf8')
  const result = removeTomlEnterpriseSection(original)
  if (result === null) return { target, status: 'refused', detail: 'config.toml could not be parsed' }
  if (typeof result === 'object') return { target, status: 'refused', detail: result.refused }
  if (result === original) return { target, status: 'absent' }

  const backup = writeBackup(target, backupDir)
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

function cleanupOpencodeConfig(target: string, backupDir: string): CleanupEntry {
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

  const backup = writeBackup(target, backupDir)
  writeInPlace(target, modified)
  return { target, status: 'removed', backup }
}

// ─── Header file ──────────────────────────────────────────────────────────────

function cleanupFile(target: string, backupDir: string): CleanupEntry {
  if (!existsSync(target)) return { target, status: 'absent' }
  const backup = writeBackup(target, backupDir)
  unlinkSync(target)
  return { target, status: 'removed', backup }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Copy `source` into `backupDir` (created owner-only, 0700) and return the
 * backup path. An existing backup is never overwritten: a second backup of
 * the same file gets a numbered name. The copy is 0600 on non-Windows.
 */
function writeBackup(source: string, backupDir: string): string {
  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') chmodSync(backupDir, 0o700)
  }
  const name = basename(source)
  let dest = join(backupDir, name)
  for (let n = 1; existsSync(dest); n++) dest = join(backupDir, `${name}.${n}`)
  copyFileSync(source, dest, fsConstants.COPYFILE_EXCL)
  if (process.platform !== 'win32') chmodSync(dest, 0o600)
  return dest
}

/**
 * Replace a config file's content atomically (temp file, fsync, rename; the
 * file's mode is kept). A symlinked config is resolved first, so the rename
 * lands on the real file and the link survives.
 */
function writeInPlace(path: string, content: string): void {
  let target = path
  try {
    if (lstatSync(path).isSymbolicLink()) target = realpathSync(path)
  } catch {
    // not there or not statable — write at the given path
  }
  atomicWrite(target, content)
}

/** Resolve the OpenCode config path from home + env, matching opencodeConfigDir logic. */
function resolveOpencodePath(home: string, env: NodeJS.ProcessEnv): string {
  const dir = env.OPENCODE_CONFIG_DIR
    ? env.OPENCODE_CONFIG_DIR
    : join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode')
  const jsonPath = join(dir, 'opencode.json')
  const jsoncPath = join(dir, 'opencode.jsonc')
  if (!existsSync(jsonPath) && existsSync(jsoncPath)) return jsoncPath
  return jsonPath
}
