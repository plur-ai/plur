#!/usr/bin/env node
export {}

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { homedir } from 'os'

const VERSION = '0.9.5'

const HELP = `plur-mcp v${VERSION} — persistent memory for AI agents

Usage:
  plur-mcp              Start the MCP server (stdio transport)
  plur-mcp init         Set up PLUR: storage + MCP config + hooks + CLAUDE.md
  plur-mcp --help       Show this help message
  plur-mcp --version    Show version

Environment:
  PLUR_PATH             Storage location (default: ~/.plur/)

Quick start:
  npx @plur-ai/mcp init

Docs: https://plur.ai · https://github.com/plur-ai/plur
`

// --- Constants (must be before any await that uses them) ---

const MCP_SERVER_CONFIG = {
  command: 'npx',
  args: ['-y', '@plur-ai/mcp@latest'],
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

// Hook commands — all use npx for zero-install compatibility
const CLI = 'npx @plur-ai/cli'

const PLUR_HOOKS: Record<string, HookEntry[]> = {
  // --- Session lifecycle ---
  UserPromptSubmit: [{
    hooks: [{ type: 'command', command: `${CLI} hook-inject`, timeout: 15 }],
  }],
  PostCompact: [{
    matcher: 'auto|manual',
    hooks: [{ type: 'command', command: `${CLI} hook-inject --rehydrate`, timeout: 15 }],
  }],
  // --- Contextual injection ---
  PreToolUse: [
    { matcher: 'EnterPlanMode', hooks: [{ type: 'command', command: `${CLI} hook-inject --event plan_mode`, timeout: 10 }] },
    { matcher: 'Skill', hooks: [{ type: 'command', command: `${CLI} hook-inject --event skill`, timeout: 10 }] },
    { matcher: 'Agent', hooks: [{ type: 'command', command: `${CLI} hook-inject --event agent`, timeout: 10 }] },
    { matcher: 'Bash|Edit|Write|Agent', hooks: [{ type: 'command', command: `${CLI} hook-observe`, timeout: 3 }] },
  ],
  PostToolUse: [
    { matcher: 'Bash|Edit|Write|Agent', hooks: [{ type: 'command', command: `${CLI} hook-observe --post`, timeout: 3 }] },
  ],
  SubagentStart: [
    { matcher: '.*', hooks: [{ type: 'command', command: `${CLI} hook-inject --event subagent`, timeout: 10 }] },
  ],
  Stop: [
    { matcher: '*', hooks: [{ type: 'command', command: `${CLI} hook-learn-check`, timeout: 2 }] },
  ],
}

// --- Types ---

interface McpConfig {
  mcpServers?: Record<string, unknown>
  [key: string]: unknown
}

interface Settings {
  hooks?: Record<string, HookEntry[]>
  [key: string]: unknown
}

interface HookEntry {
  matcher?: string
  hooks: Array<{ type: string; command: string; timeout?: number }>
}

const CLAUDE_MD_SECTION = `## PLUR Memory

You have persistent memory via PLUR. Corrections, preferences, and conventions persist across sessions as engrams.

### Architecture

PLUR is installed **globally** — one MCP server, one engram store (\`~/.plur/\`), available in every project. You do NOT need per-project installation. Multi-project scoping uses \`domain\` and \`scope\` fields on engrams, not separate stores.

Hooks inject engrams automatically on every first message — you do not need to call \`plur_session_start\` manually (though you can for explicit session tracking).

### Session Workflow

1. **Automatic**: Hooks inject relevant engrams on first message — no action needed
2. **Learn**: When corrected or discovering something new, call \`plur_learn\` immediately
3. **Recall**: Before answering factual questions, call \`plur_recall_hybrid\` — check memory first
4. **Feedback**: Rate injected engrams with \`plur_feedback\` (positive/negative) — trains relevance
5. **End**: Call \`plur_session_end\` with summary + engram_suggestions

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

function writeMcpConfig(configPath: string): string {
  let config: McpConfig = {}
  if (existsSync(configPath)) {
    try { config = JSON.parse(readFileSync(configPath, 'utf8')) } catch {}
  }

  const servers = (config.mcpServers ?? {}) as Record<string, unknown>
  if (servers.plur) {
    return `already configured in ${configPath}`
  }

  servers.plur = MCP_SERVER_CONFIG
  config.mcpServers = servers
  const dir = join(configPath, '..')
  mkdirSync(dir, { recursive: true })
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
  return `added to ${configPath}`
}

function installHooks(): string {
  const projectSettings = join(process.cwd(), '.claude', 'settings.json')
  const globalSettings = join(homedir(), '.claude', 'settings.json')
  const settingsPath = existsSync(join(process.cwd(), '.claude'))
    ? projectSettings
    : globalSettings

  let settings: Settings = {}
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')) } catch {}
  }

  // Check if already installed
  const hooks = settings.hooks ?? {}
  for (const entries of Object.values(hooks)) {
    for (const entry of (entries as HookEntry[])) {
      for (const h of entry.hooks ?? []) {
        if (h.command.includes('@plur-ai/cli')) {
          return `already installed in ${settingsPath}`
        }
      }
    }
  }

  // Merge hooks
  const existing = settings.hooks ?? {}
  const merged: Record<string, HookEntry[]> = { ...existing }
  for (const [event, newEntries] of Object.entries(PLUR_HOOKS)) {
    merged[event] = [...(merged[event] ?? []), ...newEntries]
  }
  settings.hooks = merged

  const dir = join(settingsPath, '..')
  mkdirSync(dir, { recursive: true })
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
  return `installed in ${settingsPath}`
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
          plur.installPack(join(bundledPacksDir, entry))
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
          plur.installPack(join(bundledPacksDir, entry))
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
