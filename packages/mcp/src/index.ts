#!/usr/bin/env node
export {}

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const VERSION = '0.7.0'

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

### Session Workflow

1. **Start**: Call \`plur_session_start\` with task description — injects relevant engrams
2. **Learn**: When corrected or discovering something new, call \`plur_learn\` immediately
3. **Recall**: Before answering factual questions, call \`plur_recall_hybrid\` — check memory first
4. **Feedback**: Rate injected engrams with \`plur_feedback\` (positive/negative) — trains relevance
5. **End**: Call \`plur_session_end\` with summary + engram_suggestions

Do not ask permission to use these tools — they are your memory system.

### When to check memory

Before reaching for web search, file reads, or guessing — apply this priority:
1. Is the answer already in engrams? → \`plur_recall_hybrid\`
2. Is the answer in the local filesystem? → Read/Grep/Glob
3. Is the answer derivable from context already loaded? → Just answer
4. Only if 1-3 fail → Use external tools

| Domain | When to recall |
|--------|----------------|
| Decisions | Past design choices, architecture rationale |
| Corrections | API quirks, bugs, wrong assumptions |
| Preferences | Formatting, tone, workflow, tool choices |
| Conventions | Tag formats, file routing, naming rules |
| Infrastructure | Server IPs, SSH configs, deployment targets |

### When corrected

When the user corrects you ("no, use X not Y", "that's wrong"):
1. Call \`plur_learn\` immediately — before continuing the task
2. Call \`plur_feedback\` with negative signal on the wrong engram if one was injected
3. Then continue with the corrected approach

### Verification

When recalling facts that will drive actions:
1. State the recalled fact explicitly before acting on it
2. Include the engram ID or search that produced it
3. If no engram matches, say so and verify from the filesystem
4. Never interpolate between two engrams to produce a "probably correct" composite
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

  process.stdout.write(`PLUR initialized.

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
