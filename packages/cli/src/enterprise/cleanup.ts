import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, unlinkSync, chmodSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'
import { readConfigForWrite, writeConfig, codexConfigTomlPath } from '../mcp-config.js'
import { parseJsonc } from '../lib/jsonc.js'
import { parseTOML, type AST } from 'toml-eslint-parser'
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

  if (toolSet.has('claude-code')) {
    results.push(cleanupClaudeJson(join(home, '.claude.json'), opts.backupDir))
  }

  if (toolSet.has('cursor')) {
    results.push(cleanupJsonMcpFile(join(home, '.cursor', 'mcp.json'), opts.backupDir))
  }

  if (toolSet.has('codex')) {
    results.push(cleanupCodexToml(codexConfigTomlPath(env), opts.backupDir))
  }

  if (toolSet.has('opencode')) {
    const opencodePath = resolveOpencodePath(home, env)
    results.push(cleanupOpencodeConfig(opencodePath, opts.backupDir))
  }

  // Header file: always cleaned regardless of tools
  results.push(cleanupFile(join(opts.plurDir, 'mcp-enterprise-header'), opts.backupDir))

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
  writeConfig(target, config)
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
  writeConfig(target, config)
  return { target, status: 'removed', backup }
}

// ─── Codex config.toml ────────────────────────────────────────────────────────

function cleanupCodexToml(target: string, backupDir: string): CleanupEntry {
  if (!existsSync(target)) return { target, status: 'absent' }

  const original = readFileSync(target, 'utf8')
  const result = removeTomlEnterpriseSection(original)
  if (result === null) return { target, status: 'refused', detail: 'config.toml could not be parsed' }
  if (result === original) return { target, status: 'absent' }

  const backup = writeBackup(target, backupDir)
  writeFileSync(target, result)
  return { target, status: 'removed', backup }
}

/**
 * Remove all TOML table sections whose key starts with `mcp_servers.plur-enterprise`.
 * Returns the modified text, the original text if nothing was removed, or null if
 * the TOML is invalid.
 */
function removeTomlEnterpriseSection(text: string): string | null {
  let ast: AST.TOMLProgram
  try {
    ast = parseTOML(text, { tomlVersion: '1.0' })
  } catch {
    return null
  }

  const allTables: AST.TOMLTable[] = []
  for (const node of ast.body[0].body) {
    if (node.type !== 'TOMLKeyValue') allTables.push(node as AST.TOMLTable)
  }

  const removeSet = new Set<AST.TOMLTable>()
  for (const node of allTables) {
    const rk = node.resolvedKey as (string | number)[]
    if (rk[0] === 'mcp_servers' && rk[1] === ENTRY) {
      removeSet.add(node)
    }
  }

  if (removeSet.size === 0) return text

  // For each contiguous block of sections to remove, cut from the start of
  // the first removed section to the start of the next kept section (or EOF).
  const cuts: Array<[number, number]> = []
  let i = 0
  while (i < allTables.length) {
    if (!removeSet.has(allTables[i])) { i++; continue }

    const blockStart = allTables[i].range[0]
    while (i < allTables.length && removeSet.has(allTables[i])) i++
    const blockEnd = i < allTables.length ? allTables[i].range[0] : text.length

    cuts.push([blockStart, blockEnd])
  }

  cuts.reverse()
  let result = text
  for (const [start, end] of cuts) {
    result = result.slice(0, start) + result.slice(end)
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
  writeFileSync(target, modified)
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

/** Copy `source` to `backupDir/<basename>`, creating the dir with mode 0700.
 *  The backup file gets mode 0600 on non-Windows. Returns the backup path. */
function writeBackup(source: string, backupDir: string): string {
  mkdirSync(backupDir, { recursive: true })
  const dest = join(backupDir, basename(source))
  copyFileSync(source, dest)
  if (process.platform !== 'win32') chmodSync(dest, 0o600)
  return dest
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
