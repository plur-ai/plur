import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { type GlobalFlags } from '../plur.js'
import { outputText } from '../output.js'
import {
  buildMcpServerEntry,
  claudeDesktopConfigPath,
  hasPlurMcp,
  mergePlurMcp,
  readConfig,
  writeConfig,
} from '../mcp-config.js'

/**
 * plur init — install Claude Code hooks AND register the plur MCP server.
 *
 * Architecture: PLUR is a GLOBAL tool. One MCP server, one engram store
 * (~/.plur/), available in every project. Per-project scoping is handled
 * via domain/scope fields on engrams, not separate installations.
 *
 * Two things must be in place for plur to work in Claude Code:
 *
 *   1. The `plur` MCP server must be registered, so the `plur_*` tools exist.
 *   2. The lifecycle hooks must call `npx @plur-ai/cli hook-*` to inject
 *      relevant engrams into the conversation.
 *
 * Usage:
 *   plur init              # auto-detect project vs global
 *   plur init --global     # force global ~/.claude/settings.json
 *   plur init --project    # force project .claude/settings.json
 *   plur init --no-desktop # skip Claude Desktop config registration
 *   plur init --domain X   # set default domain for this project (.plur.yaml)
 *   plur init --scope Y    # set default scope for this project (.plur.yaml)
 */

interface Settings {
  hooks?: Record<string, HookEntry[]>
  mcpServers?: Record<string, unknown>
  [key: string]: unknown
}

interface HookEntry {
  matcher?: string
  hooks: Array<{
    type: string
    command: string
    timeout?: number
  }>
}

// Hook commands — all use npx for zero-install compatibility
const CLI = 'npx @plur-ai/cli'

const PLUR_HOOKS: Record<string, HookEntry[]> = {
  // --- Session enforcement ---
  // These three hooks ensure plur_session_start is always called first.
  // Without session start, feedback loops, episode tracking, and scoped
  // injection don't work. The guard blocks all tools until the sentinel
  // file exists; the mark creates it after plur_session_start succeeds.

  // Forceful directive at session open
  SessionStart: [
    {
      hooks: [
        { type: 'command', command: `${CLI} hook-session-remind`, timeout: 3 },
      ],
    },
  ],

  // --- Session lifecycle ---

  // First message: inject engrams based on the prompt.
  // Subsequent messages: periodic reminder to call plur_learn (~1ms skip).
  UserPromptSubmit: [
    {
      hooks: [
        { type: 'command', command: `${CLI} hook-inject`, timeout: 15 },
      ],
    },
  ],

  // Re-inject after context compaction so engrams survive long conversations.
  PostCompact: [
    {
      matcher: 'auto|manual',
      hooks: [
        { type: 'command', command: `${CLI} hook-inject --rehydrate`, timeout: 15 },
      ],
    },
  ],

  // --- Contextual injection + session guard ---

  PreToolUse: [
    // Session guard — blocks all tools until plur_session_start is called.
    // Must be first so it runs before any other PreToolUse hook.
    {
      matcher: '*',
      hooks: [
        { type: 'command', command: `${CLI} hook-session-guard`, timeout: 3 },
      ],
    },
    // Full injection when entering plan mode — planning needs broad context
    {
      matcher: 'EnterPlanMode',
      hooks: [
        { type: 'command', command: `${CLI} hook-inject --event plan_mode`, timeout: 10 },
      ],
    },
    // Domain-specific engrams when a skill is invoked
    {
      matcher: 'Skill',
      hooks: [
        { type: 'command', command: `${CLI} hook-inject --event skill`, timeout: 10 },
      ],
    },
    // Agent-scoped engrams when spawning an agent
    {
      matcher: 'Agent',
      hooks: [
        { type: 'command', command: `${CLI} hook-inject --event agent`, timeout: 10 },
      ],
    },
    // Observation capture — log tool calls for offline pattern extraction
    {
      matcher: 'Bash|Edit|Write|Agent',
      hooks: [
        { type: 'command', command: `${CLI} hook-observe`, timeout: 3 },
      ],
    },
  ],

  // Observation capture — log tool results + session sentinel
  PostToolUse: [
    // Session sentinel — creates marker file after plur_session_start succeeds
    {
      matcher: 'mcp__plur__plur_session_start',
      hooks: [
        { type: 'command', command: `${CLI} hook-session-mark`, timeout: 3 },
      ],
    },
    {
      matcher: 'Bash|Edit|Write|Agent',
      hooks: [
        { type: 'command', command: `${CLI} hook-observe --post`, timeout: 3 },
      ],
    },
  ],

  // Inject agent-scoped engrams into subagent context
  SubagentStart: [
    {
      matcher: '.*',
      hooks: [
        { type: 'command', command: `${CLI} hook-inject --event subagent`, timeout: 10 },
      ],
    },
  ],

  // Learning reflection — nudge the LLM to call plur_learn after responses
  // where it discovered or learned something. Fires every 3rd Stop to avoid fatigue.
  Stop: [
    {
      matcher: '*',
      hooks: [
        { type: 'command', command: `${CLI} hook-learn-check`, timeout: 2 },
      ],
    },
  ],
}

const CLAUDE_MD_SECTION = `## PLUR Memory

You have persistent memory via PLUR. Corrections, preferences, and conventions persist across sessions as engrams.

### Architecture

PLUR is installed **globally** — one MCP server, one engram store (\`~/.plur/\`), available in every project. You do NOT need per-project installation. The \`plur\` MCP server provides tools named \`plur_session_start\`, \`plur_learn\`, \`plur_recall_hybrid\`, \`plur_feedback\`, \`plur_session_end\`, etc. If you cannot find these tools, run \`plur doctor\` to diagnose. Do **not** substitute tools from other MCP servers (e.g. \`datacore_*\`) — those belong to a different system.

A PreToolUse guard enforces that \`plur_session_start\` is called at the beginning of every session. All other tools are blocked until this is done. The flow is: ToolSearch to load \`plur_session_start\` → call it with a task description → proceed.

### Session Workflow

1. **Start**: Call \`plur_session_start\` with task description — enforced by guard hook
2. **Learn**: When corrected or discovering something new, call \`plur_learn\` immediately
3. **Recall**: Before answering factual questions, call \`plur_recall_hybrid\` — check memory first
4. **Feedback**: Rate injected engrams with \`plur_feedback\` (positive/negative) — trains relevance
5. **End**: Call \`plur_session_end\` with summary + engram_suggestions

Do not ask permission to use these tools — they are your memory system.

### Multi-project scoping

PLUR uses \`domain\` and \`scope\` fields on engrams to separate knowledge by project. When calling \`plur_learn\`, set \`scope\` (e.g. \`project:my-app\`) to namespace the engram. Scoped recall automatically includes global engrams.

### When to check memory

Before reaching for web search, file reads, or guessing — apply this priority:
1. Is the answer already in engrams? → \`plur_recall_hybrid\`
2. Is the answer in the local filesystem? → Read/Grep/Glob
3. Is the answer derivable from context already loaded? → Just answer
4. Only if 1-3 fail → Use external tools

### When corrected

When the user corrects you ("no, use X not Y", "that's wrong"):
1. Call \`plur_learn\` immediately — before continuing the task
2. Call \`plur_feedback\` with negative signal on the wrong engram if one was injected
3. Then continue with the corrected approach
`

/**
 * Write a .plur.yaml project config with default domain/scope.
 * This file is read by hooks to auto-apply scoping to learn/recall calls.
 */
function installProjectConfig(args: string[]): string | null {
  const domainIdx = args.indexOf('--domain')
  const scopeIdx = args.indexOf('--scope')
  const domain = domainIdx >= 0 ? args[domainIdx + 1] : null
  const scope = scopeIdx >= 0 ? args[scopeIdx + 1] : null

  if (!domain && !scope) return null

  const configPath = join(process.cwd(), '.plur.yaml')
  const lines: string[] = ['# PLUR project defaults — read by hooks for automatic scoping']
  if (domain) lines.push(`domain: ${domain}`)
  if (scope) lines.push(`scope: ${scope}`)
  lines.push('')

  writeFileSync(configPath, lines.join('\n'))
  return configPath
}

function installClaudeMd(): string {
  const marker = '## PLUR Memory'
  const projectClaudeMd = join(process.cwd(), 'CLAUDE.md')
  const globalClaudeMd = join(homedir(), 'CLAUDE.md')
  const claudeMdPath = existsSync(projectClaudeMd) ? projectClaudeMd : existsSync(globalClaudeMd) ? globalClaudeMd : projectClaudeMd

  if (existsSync(claudeMdPath)) {
    const content = readFileSync(claudeMdPath, 'utf8')
    if (content.includes(marker)) {
      return `already in ${claudeMdPath}`
    }
    writeFileSync(claudeMdPath, content.trimEnd() + '\n\n' + CLAUDE_MD_SECTION)
    return `added to ${claudeMdPath}`
  }

  writeFileSync(claudeMdPath, `# CLAUDE.md\n\n${CLAUDE_MD_SECTION}`)
  return `created ${claudeMdPath}`
}

function findSettingsPath(_flags: GlobalFlags, args: string[]): string {
  const forceGlobal = args.includes('--global')
  const forceProject = args.includes('--project')

  if (forceGlobal) {
    return join(homedir(), '.claude', 'settings.json')
  }

  // Check for project-level .claude/ directory
  const projectSettings = join(process.cwd(), '.claude', 'settings.json')
  const projectDir = join(process.cwd(), '.claude')

  if (forceProject || existsSync(projectDir)) {
    return projectSettings
  }

  // Default to global
  return join(homedir(), '.claude', 'settings.json')
}

function loadSettings(path: string): Settings {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

function isPlurHook(entry: HookEntry): boolean {
  return (entry.hooks ?? []).some((h) => h.command.includes('@plur-ai/cli'))
}

function hasPlurHooks(settings: Settings): boolean {
  const hooks = settings.hooks ?? {}
  for (const entries of Object.values(hooks)) {
    if (entries.some(isPlurHook)) return true
  }
  return false
}

function stripPlurHooks(settings: Settings): Settings {
  const hooks = { ...(settings.hooks ?? {}) }
  for (const [event, entries] of Object.entries(hooks)) {
    const kept = entries.filter((e) => !isPlurHook(e))
    if (kept.length > 0) {
      hooks[event] = kept
    } else {
      delete hooks[event]
    }
  }
  return { ...settings, hooks }
}

function mergeHooks(settings: Settings): Settings {
  // Strip old plur hooks first so init is idempotent (upgrade-safe)
  const clean = stripPlurHooks(settings)
  const hooks = { ...(clean.hooks ?? {}) }

  for (const [event, newEntries] of Object.entries(PLUR_HOOKS)) {
    const existing = hooks[event] ?? []
    hooks[event] = [...existing, ...newEntries]
  }

  return { ...clean, hooks }
}

/**
 * Register the plur MCP server in Claude Desktop's config file (if present
 * or if --desktop is forced). Returns a status string for the report.
 */
function installDesktopMcp(args: string[]): string {
  if (args.includes('--no-desktop')) return 'skipped (--no-desktop)'

  const desktopPath = claudeDesktopConfigPath()
  const forceDesktop = args.includes('--desktop')

  if (!existsSync(desktopPath) && !forceDesktop) {
    return 'not installed (Claude Desktop not detected — pass --desktop to force)'
  }

  const config = readConfig(desktopPath)
  if (hasPlurMcp(config)) {
    return `already registered in ${desktopPath}`
  }

  mergePlurMcp(config)
  writeConfig(desktopPath, config)
  return `registered in ${desktopPath}`
}

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const settingsPath = findSettingsPath(flags, args)
  const settingsDir = join(settingsPath, '..')

  // Load existing settings
  let settings = loadSettings(settingsPath)

  const hadHooks = hasPlurHooks(settings)
  const mcpAlreadyInstalled = hasPlurMcp(settings)

  // Always run mergeHooks — it strips old plur hooks first, so it's
  // idempotent and handles upgrades (new hooks added in newer versions).
  const before = JSON.stringify(settings.hooks ?? {})
  settings = mergeHooks(settings)
  const hooksChanged = JSON.stringify(settings.hooks ?? {}) !== before

  let hooksStatus: string
  if (!hadHooks) {
    hooksStatus = 'installed'
  } else if (hooksChanged) {
    hooksStatus = 'upgraded'
  } else {
    hooksStatus = 'already up to date'
  }

  let mcpStatus: string
  if (!mcpAlreadyInstalled) {
    mergePlurMcp(settings as Record<string, unknown>)
    mcpStatus = 'registered'
  } else {
    mcpStatus = 'already registered'
  }

  // Always write — mergeHooks may have upgraded hooks even if they existed
  mkdirSync(settingsDir, { recursive: true })
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')

  // Install CLAUDE.md section
  const claudeMdStatus = installClaudeMd()

  // Register in Claude Desktop too
  const desktopStatus = installDesktopMcp(args)

  // Write project config if --domain or --scope provided
  const projectConfigPath = installProjectConfig(args)

  const entry = buildMcpServerEntry()

  outputText('PLUR installed for Claude Code.')
  outputText('')
  outputText('Architecture: PLUR is a global tool — one MCP server, one engram')
  outputText('store (~/.plur/), available in every project. Multi-project scoping')
  outputText('is handled via domain/scope fields on engrams, not per-project installs.')
  outputText('')
  outputText(`MCP server (plur): ${mcpStatus}`)
  outputText(`  command: ${entry.command} ${entry.args.join(' ')}`)
  outputText('')
  outputText(`Hooks (12):        ${hooksStatus}`)
  outputText('  SessionStart      — enforce plur_session_start before any work')
  outputText('  PreToolUse        — session guard (blocks tools until session started)')
  outputText('  PostToolUse       — session sentinel (marks session as started)')
  outputText('  UserPromptSubmit  — inject engrams + auto-start session')
  outputText('  PostCompact       — re-inject engrams after context compaction')
  outputText('  PreToolUse        — contextual injection (plan mode, skills, agents)')
  outputText('  PreToolUse        — observation capture for pattern learning')
  outputText('  PostToolUse       — observation results capture')
  outputText('  SubagentStart     — inject agent-scoped engrams into subagents')
  outputText('  Stop              — learning reflection nudge (every 3rd response)')
  outputText('')
  outputText(`Settings:       ${settingsPath}`)
  outputText(`Claude Desktop: ${desktopStatus}`)
  outputText(`CLAUDE.md:      ${claudeMdStatus}`)
  if (projectConfigPath) {
    outputText(`Project config: ${projectConfigPath}`)
  }
  outputText('')
  if (projectConfigPath) {
    outputText('Project scoping configured. Engrams learned in this project will')
    outputText('be tagged automatically. Run `plur init --domain X --scope Y` in')
    outputText('other projects to set their defaults.')
    outputText('')
  }
  outputText('Restart Claude Code to pick up the changes, then run `plur doctor` to verify.')
}
