#!/usr/bin/env node
export {}

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { homedir, platform } from 'os'

import { VERSION } from './version.js'

const HELP = `plur-mcp v${VERSION} — persistent memory for AI agents

Usage:
  plur-mcp                           Start the MCP server (stdio transport)
  plur-mcp init                      Set up PLUR: storage + MCP config + hooks + CLAUDE.md
  plur-mcp packs install <path>      Install a knowledge pack from a local directory
  plur-mcp packs list                List installed knowledge packs
  plur-mcp packs uninstall <name>    Uninstall a knowledge pack by name
  plur-mcp --help                    Show this help message
  plur-mcp --version                 Show version

Environment:
  PLUR_PATH             Storage location (default: ~/.plur/)

Quick start:
  npx @plur-ai/mcp init

Docs: https://plur.ai · https://github.com/plur-ai/plur
`

// --- Constants (must be before any await that uses them) ---

// Pinned to THIS build's version, never @latest (#1069): an @latest entry
// makes npx rewrite its cached native binaries on every publish, and macOS
// SIGKILLs (CODESIGNING Invalid Page) any process that pages one in
// mid-rewrite. Upgrades re-run init, which re-pins.
const MCP_SERVER_CONFIG = {
  command: 'npx',
  args: ['-y', `@plur-ai/mcp@${VERSION}`],
}

// --- Pack-upgrade helpers ---

/**
 * Compare two semver strings (e.g. "1.0.0" vs "1.1.0"). Returns negative if
 * a < b, 0 if equal, positive if a > b. Tolerates missing patch segments
 * (treats "1.0" as "1.0.0"). Strips prerelease suffixes — "1.0.0-rc1" is
 * compared as "1.0.0", which means a prerelease compares EQUAL to its base
 * release. Adequate for the controlled pack ecosystem; for prerelease
 * support add a dedicated semver lib.
 *
 * Non-numeric leading segments (e.g. "v1.0.0", "abc.1.0") parse as 0 — so
 * "v1.0.0" compares as [0,0,0]. This is intentional: we'd rather accept the
 * pack and treat it as version-zero than throw. The `extractManifestVersion`
 * regex normally strips the leading `v`; this is a defense-in-depth fallback.
 *
 * Calendar versioning (e.g. "2025.04") parses correctly as numeric segments,
 * but a calendar-versioned pack will compare as far-future against semver-
 * versioned bundled packs and never receive upgrades. Packs ship semver.
 */
export function compareSemver(a: string, b: string): number {
  const stripPrerelease = (v: string): string => v.split('-')[0].split('+')[0]
  const stripV = (v: string): string => v.replace(/^v/i, '')
  const parse = (v: string): number[] =>
    stripV(stripPrerelease(v))
      .split('.')
      .map(n => {
        const parsed = parseInt(n, 10)
        return Number.isNaN(parsed) ? 0 : parsed
      })
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const ai = pa[i] ?? 0
    const bi = pb[i] ?? 0
    if (ai !== bi) return ai - bi
  }
  return 0
}

/**
 * Extract the `version` field from a pack's SKILL.md frontmatter without
 * loading the whole pack. Returns null when SKILL.md is missing, the
 * frontmatter has no version, or the version is nested under another key.
 *
 * Accepts both quoted (`version: "1.0.0"`) and unquoted (`version: 1.0.0`)
 * forms. Rejects nested keys (`metadata:\n  version: 1.0.0`) — the regex
 * anchors to start-of-line so a leading space breaks the match.
 */
export function extractManifestVersion(skillMdPath: string): string | null {
  try {
    const content = readFileSync(skillMdPath, 'utf8')
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/m)
    if (!fmMatch) return null
    const versionMatch = fmMatch[1].match(/^version:\s*"?([^"\n]+)"?\s*$/m)
    return versionMatch ? versionMatch[1].trim() : null
  } catch {
    return null
  }
}

// Prefer local hook shim if available (installed by `plur init`, see #178).
// Fall back to npx for first-time users who haven't run `plur init` yet.
const _shimName = platform() === 'win32' ? 'plur-hook.cmd' : 'plur-hook'
const _shimCandidate = join(homedir(), '.plur', 'bin', _shimName)
const CLI = existsSync(_shimCandidate) ? _shimCandidate : 'npx @plur-ai/cli'

/**
 * Hook set for `plur-mcp init`. Mirrors `buildInjectionHooks` in
 * @plur-ai/cli's init.ts, which this package cannot import. The rehydrate
 * entry must stay identical to the cli's; test/init-hooks.test.ts fails if
 * the two diverge (#1279).
 */
export function buildPlurHooks(cli: string): Record<string, HookEntry[]> {
  return {
    // --- Session lifecycle ---
    UserPromptSubmit: [{
      hooks: [{ type: 'command', command: `${cli} hook-inject`, timeout: 15 }],
    }],
    // Re-inject after compaction. SessionStart with matcher "compact" fires
    // right after compaction and can carry context; PostCompact cannot
    // (#1274, #1279). Re-running init moves an old PostCompact entry here.
    SessionStart: [{
      matcher: 'compact',
      hooks: [{ type: 'command', command: `${cli} hook-inject --rehydrate`, timeout: 90, async: true }],
    }],
    // Auto-close the memory lifecycle at session end (Claude Code SessionEnd,
    // shipped v1.0.85) — captures a closing episode and cleans up the session
    // checkpoint even if the agent forgot to call plur_session_end (#217).
    SessionEnd: [{
      hooks: [{ type: 'command', command: `${cli} hook-session-end`, timeout: 5 }],
    }],
    // --- Contextual injection ---
    PreToolUse: [
      { matcher: 'EnterPlanMode', hooks: [{ type: 'command', command: `${cli} hook-inject --event plan_mode`, timeout: 10 }] },
      { matcher: 'Skill', hooks: [{ type: 'command', command: `${cli} hook-inject --event skill`, timeout: 10 }] },
      { matcher: 'Agent', hooks: [{ type: 'command', command: `${cli} hook-inject --event agent`, timeout: 10 }] },
      { matcher: 'Bash|Edit|Write|Agent', hooks: [{ type: 'command', command: `${cli} hook-observe`, timeout: 3 }] },
    ],
    PostToolUse: [
      { matcher: 'Bash|Edit|Write|Agent', hooks: [{ type: 'command', command: `${cli} hook-observe --post`, timeout: 3 }] },
    ],
    SubagentStart: [
      { matcher: '.*', hooks: [{ type: 'command', command: `${cli} hook-inject --event subagent`, timeout: 10 }] },
    ],
    Stop: [
      { matcher: '*', hooks: [{ type: 'command', command: `${cli} hook-learn-check`, timeout: 2 }] },
    ],
  }
}

const PLUR_HOOKS = buildPlurHooks(CLI)

// --- Types ---

interface McpConfig {
  mcpServers?: Record<string, unknown>
  [key: string]: unknown
}

export interface Settings {
  hooks?: Record<string, HookEntry[]>
  [key: string]: unknown
}

export interface HookEntry {
  matcher?: string
  hooks: Array<{ type: string; command: string; timeout?: number; async?: boolean }>
}

const CLAUDE_MD_SECTION = `## PLUR Memory

You have persistent memory via PLUR. Corrections, preferences, and conventions persist across sessions as engrams.

### Architecture

PLUR is installed **globally** — one MCP server, one engram store (\`~/.plur/\`), available in every project. You do NOT need per-project installation. Multi-project scoping uses \`domain\` and \`scope\` fields on engrams, not separate stores.

Hooks inject engrams automatically on every first message — you do not need to call \`plur_session_start\` manually (though you can for explicit session tracking).

### Session Workflow

1. **Automatic**: Hooks inject relevant engrams on first message — no action needed
2. **Learn**: When corrected or discovering something new, call \`plur_learn\` immediately
3. **Recall**: Before answering factual questions, call \`plur_recall\` — check memory first
4. **Feedback**: Rate injected engrams with \`plur_feedback\` (positive/negative) — trains relevance
5. **End**: Call \`plur_session_end\` with summary + engram_suggestions — a SessionEnd hook auto-closes the lifecycle if you forget, but calling it yourself captures higher-quality learnings

Do not ask permission to use these tools — they are your memory system.

### When corrected

When the user corrects you ("no, use X not Y", "that's wrong"):
1. Call \`plur_learn\` immediately — before continuing the task
2. Call \`plur_feedback\` with negative signal on the wrong engram if one was injected
3. Then continue with the corrected approach
`

// --- Functions ---

function installClaudeMd(): string {
  const marker = '## PLUR Memory'
  // Check project CLAUDE.md first, then global
  const projectClaudeMd = join(process.cwd(), 'CLAUDE.md')
  const globalClaudeMd = join(homedir(), 'CLAUDE.md')
  const claudeMdPath = existsSync(projectClaudeMd) ? projectClaudeMd : existsSync(globalClaudeMd) ? globalClaudeMd : projectClaudeMd

  if (existsSync(claudeMdPath)) {
    const content = readFileSync(claudeMdPath, 'utf8')
    if (content.includes(marker)) {
      return `already in ${claudeMdPath}`
    }
    // Append to existing file
    writeFileSync(claudeMdPath, content.trimEnd() + '\n\n' + CLAUDE_MD_SECTION)
    return `added to ${claudeMdPath}`
  }

  // Create new CLAUDE.md with just the PLUR section
  writeFileSync(claudeMdPath, `# CLAUDE.md\n\n${CLAUDE_MD_SECTION}`)
  return `created ${claudeMdPath}`
}

function findMcpConfig(): string {
  const projectMcp = join(process.cwd(), '.mcp.json')
  if (existsSync(projectMcp)) return projectMcp
  const globalMcp = join(homedir(), '.claude', 'mcp.json')
  if (existsSync(globalMcp)) return globalMcp
  return projectMcp
}

/**
 * Read a config file this function intends to WRITE BACK. The #1059 rule,
 * ported from @plur-ai/cli's readConfigForWrite (this package cannot import
 * the CLI): a file that exists but does not parse to a JSON object is the
 * user's damaged-but-recoverable data — reading it as {} and writing the
 * merge back destroys every other entry they had. Reproduced live in the
 * 0.19.1 evaluator audit against exactly this function.
 */
function readJsonObjectForWrite(path: string): { data: Record<string, unknown>; ok: boolean } {
  if (!existsSync(path)) return { data: {}, ok: true }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { data: parsed as Record<string, unknown>, ok: true }
    }
  } catch { /* fall through */ }
  return { data: {}, ok: false }
}

function writeMcpConfig(configPath: string): string {
  const { data, ok } = readJsonObjectForWrite(configPath)
  if (!ok) {
    return `skipped — ${configPath} exists but is not a JSON object; writing would discard your other MCP servers. Fix it by hand, then re-run \`plur-mcp init\``
  }
  const config = data as McpConfig

  const servers = (config.mcpServers ?? {}) as Record<string, unknown>
  const existing = servers.plur as { command?: string; args?: string[] } | undefined
  if (existing) {
    // Heal the @latest entries THIS command's older releases wrote — the
    // #1069 npx cache-rewrite race. Only the exact racey shape is touched;
    // a custom or version-pinned entry is the user's decision.
    const args = existing.args ?? []
    const spec = args.filter(a => a !== '-y' && !a.startsWith('-'))[0] ?? ''
    if (existing.command === 'npx' && /^@plur-ai\/mcp(@latest)?$/.test(spec)) {
      const healed = { ...existing, ...MCP_SERVER_CONFIG }
      if (JSON.stringify(healed) !== JSON.stringify(existing)) {
        servers.plur = healed
        config.mcpServers = servers
        writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
        return `upgraded stale npx entry in ${configPath}`
      }
    }
    return `already configured in ${configPath}`
  }

  servers.plur = MCP_SERVER_CONFIG
  config.mcpServers = servers
  const dir = join(configPath, '..')
  mkdirSync(dir, { recursive: true })
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
  return `added to ${configPath}`
}

/** Same test as @plur-ai/cli's isPlurHook: the npx form or the local shim. */
function isPlurHook(entry: HookEntry): boolean {
  return (entry.hooks ?? []).some(h =>
    h.command.includes('@plur-ai/cli') || h.command.includes('.plur/bin/plur-hook'),
  )
}

function isPlurRehydrate(entry: HookEntry): boolean {
  return isPlurHook(entry) && entry.hooks.some(h => h.command.includes('hook-inject --rehydrate'))
}

/**
 * Merge PLUR hooks into Claude Code settings (#1279). Pure, no I/O.
 * - No PLUR hook present: append the full set ('installed').
 * - PLUR hooks present: drop PLUR entries from PostCompact, which cannot
 *   carry context (#1274), and add the SessionStart(compact) rehydrate entry
 *   if it is missing ('healed'). Nothing else changes, so a fuller
 *   `plur init` install is not replaced by this smaller set.
 * - Otherwise 'already', and the settings come back unchanged.
 * User hooks are never removed or reordered.
 */
export function applyPlurHooks(
  settings: Settings,
  hooksMap: Record<string, HookEntry[]>,
): { settings: Settings; status: 'installed' | 'healed' | 'already' } {
  const hooks: Record<string, HookEntry[]> = { ...(settings.hooks ?? {}) }
  const installed = Object.values(hooks).some(entries => (entries ?? []).some(isPlurHook))

  if (!installed) {
    for (const [event, entries] of Object.entries(hooksMap)) {
      hooks[event] = [...(hooks[event] ?? []), ...entries]
    }
    return { settings: { ...settings, hooks }, status: 'installed' }
  }

  let changed = false
  if (hooks.PostCompact?.some(isPlurHook)) {
    const kept = hooks.PostCompact.filter(e => !isPlurHook(e))
    if (kept.length > 0) hooks.PostCompact = kept
    else delete hooks.PostCompact
    changed = true
  }
  if (!(hooks.SessionStart ?? []).some(isPlurRehydrate)) {
    hooks.SessionStart = [...(hooks.SessionStart ?? []), ...(hooksMap.SessionStart ?? [])]
    changed = true
  }
  return changed
    ? { settings: { ...settings, hooks }, status: 'healed' }
    : { settings, status: 'already' }
}

function installHooks(): string {
  const projectSettings = join(process.cwd(), '.claude', 'settings.json')
  const globalSettings = join(homedir(), '.claude', 'settings.json')
  const settingsPath = existsSync(join(process.cwd(), '.claude'))
    ? projectSettings
    : globalSettings

  const settingsRead = readJsonObjectForWrite(settingsPath)
  if (!settingsRead.ok) {
    return `skipped — ${settingsPath} exists but is not a JSON object; writing would discard your other settings. Fix it by hand, then re-run \`plur-mcp init\``
  }
  const settings = settingsRead.data as Settings

  const { settings: next, status } = applyPlurHooks(settings, PLUR_HOOKS)
  if (status === 'already') return `already installed in ${settingsPath}`

  const dir = join(settingsPath, '..')
  mkdirSync(dir, { recursive: true })
  writeFileSync(settingsPath, JSON.stringify(next, null, 2) + '\n')
  return status === 'healed'
    ? `moved rehydrate hook to SessionStart(compact) in ${settingsPath}`
    : `installed in ${settingsPath}`
}

async function runInit() {
  const results: string[] = []

  // Step 1: Initialize storage
  const { detectPlurStorage } = await import('@plur-ai/core')
  const paths = detectPlurStorage()
  results.push(`Storage:  ${paths.root}`)

  let searchMode = 'BM25 keyword search'
  try {
    const mod = '@huggingface/' + 'transformers'
    await import(/* @vite-ignore */ mod)
    searchMode = 'hybrid (BM25 + embeddings)'
  } catch {}
  results.push(`Search:   ${searchMode}`)

  // Step 2: Write MCP config
  const mcpConfigPath = findMcpConfig()
  const mcpStatus = writeMcpConfig(mcpConfigPath)
  results.push(`MCP:      ${mcpStatus}`)

  // Step 3: Install Claude Code hooks
  const hooksStatus = installHooks()
  results.push(`Hooks:    ${hooksStatus}`)

  // Step 4: Add PLUR section to CLAUDE.md
  const claudeMdStatus = installClaudeMd()
  results.push(`CLAUDE.md: ${claudeMdStatus}`)

  // Step 5: Install bundled knowledge packs.
  // Two cases: (1) pack not installed → install fresh. (2) pack installed at
  // an older version → reinstall to upgrade. We compare manifest versions
  // (semver, dotted ints) instead of just-presence so existing users running
  // `plur init` after an upgrade actually receive new content.
  const { Plur } = await import('@plur-ai/core')
  const plur = new Plur({ path: paths.root })
  const bundledPacksDir = join(fileURLToPath(import.meta.url), '..', '..', 'packs')
  let packsStatus = 'no bundled packs found'
  if (existsSync(bundledPacksDir)) {
    const installed = plur.listPacks()
    const installedByName = new Map(installed.map((p: { name: string; manifest?: { version?: string } }) => [p.name, p.manifest?.version]))
    const entries = readdirSync(bundledPacksDir).filter(e => statSync(join(bundledPacksDir, e)).isDirectory())
    const newPacks: string[] = []
    const upgradedPacks: string[] = []
    for (const entry of entries) {
      const bundledManifestPath = join(bundledPacksDir, entry, 'SKILL.md')
      const bundledVersion = existsSync(bundledManifestPath)
        ? extractManifestVersion(bundledManifestPath)
        : null
      const installedVersion = installedByName.get(entry)
      if (!installedByName.has(entry)) {
        try {
          await plur.installPack(join(bundledPacksDir, entry))
          newPacks.push(entry)
        } catch {}
      } else if (
        bundledVersion &&
        (!installedVersion || compareSemver(bundledVersion, installedVersion) > 0)
      ) {
        // Upgrade in place — installPack overwrites the pack directory and
        // re-registers integrity in the registry. The `!installedVersion`
        // case catches packs installed with a missing or unreadable manifest
        // version (older installs predating versioned manifests, or
        // hand-edited packs without a `version:` field). In that case we
        // can't do a comparison, so we upgrade unconditionally rather than
        // leave a versionless pack stale forever.
        try {
          await plur.installPack(join(bundledPacksDir, entry))
          upgradedPacks.push(
            `${entry} ${installedVersion ?? 'unknown'}→${bundledVersion}`,
          )
        } catch {}
      }
    }
    const segments: string[] = []
    if (newPacks.length > 0) segments.push(`installed ${newPacks.join(', ')}`)
    if (upgradedPacks.length > 0) segments.push(`upgraded ${upgradedPacks.join(', ')}`)
    if (segments.length === 0) segments.push(`${entries.length} pack(s) already up-to-date`)
    packsStatus = segments.join('; ')
  }
  results.push(`Packs:    ${packsStatus}`)

  process.stdout.write(`PLUR initialized.

  Architecture: PLUR is a global tool — one MCP server, one engram
  store (~/.plur/), available in every project. Multi-project scoping
  uses domain/scope fields on engrams, not separate installations.

  ${results.join('\n  ')}

`)

  if (mcpStatus.includes('added') || hooksStatus.includes('installed')) {
    process.stdout.write(`  Restart Claude Code to activate.\n\n`)
  } else {
    process.stdout.write(`  Everything is set up. Start a new conversation to use PLUR.\n\n`)
  }
}

// --- Packs subcommands ---

async function runPacks(): Promise<void> {
  const plurPath = process.env.PLUR_PATH ?? join(homedir(), '.plur')
  const { Plur } = await import('@plur-ai/core')
  const { packsCommand } = await import('./packs-cli.js')
  const plur = new Plur({ path: plurPath })

  // The branch logic lives in `packs-cli.ts` so it can be tested without
  // spawning a process (#545). This function's only job is streams and exit.
  const result = await packsCommand(process.argv.slice(3), plur)
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.exitCode !== 0) process.exit(result.exitCode)
}

// --- Main execution ---

const arg = process.argv[2]

if (arg === '--help' || arg === '-h') {
  process.stdout.write(HELP)
  process.exit(0)
}

if (arg === '--version' || arg === '-v') {
  process.stdout.write(`${VERSION}\n`)
  process.exit(0)
}

if (arg === 'init') {
  await runInit()
  process.exit(0)
}

if (arg === 'packs') {
  await runPacks()
  process.exit(0)
}

if (arg === 'serve' || arg === undefined) {
  const { runStdio } = await import('./server.js')
  runStdio().catch(err => {
    console.error('Failed to start PLUR MCP server:', err)
    process.exit(1)
  })
} else {
  console.error(`Unknown command: ${arg}\nRun plur-mcp --help for usage.`)
  process.exit(1)
}
