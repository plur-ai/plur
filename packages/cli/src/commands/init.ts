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
 *   plur init              # default: creates .claude/settings.json in current directory
 *   plur init --global     # force global ~/.claude/settings.json
 *   plur init --project    # force project .claude/settings.json (same as default)
 *   plur init --no-desktop # skip Claude Desktop config registration
 *   plur init --domain X   # set default domain for this project (.plur.yaml)
 *   plur init --scope Y    # set default scope for this project (.plur.yaml)
 *
 * For multi-project setups (Issue #19):
 *   cd ~/projects/my-app
 *   plur init --domain myapp.core --scope project:my-app
 *
 * This creates .claude/settings.json (hooks + MCP) and .plur.yaml (scoping).
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

// Enforcement hooks ensure plur_session_start is always called first.
// Installed into global ~/.claude/settings.json unconditionally (issue #95) so
// they fire from any subdirectory project. Each hook silent-passes when
// isPlurConfigured() is false, so projects without plur are unaffected.
const PLUR_HOOKS_ENFORCEMENT: Record<string, HookEntry[]> = {
  SessionStart: [
    {
      hooks: [
        { type: 'command', command: `${CLI} hook-session-remind`, timeout: 3 },
      ],
    },
  ],

  PreToolUse: [
    // Session guard — blocks all tools until plur_session_start is called.
    // Must be first so it runs before any other PreToolUse hook.
    {
      matcher: '*',
      hooks: [
        { type: 'command', command: `${CLI} hook-session-guard`, timeout: 3 },
      ],
    },
  ],

  PostToolUse: [
    // Session sentinel — creates marker file after plur_session_start succeeds
    {
      matcher: 'mcp__plur__plur_session_start',
      hooks: [
        { type: 'command', command: `${CLI} hook-session-mark`, timeout: 3 },
      ],
    },
  ],
}

// Injection hooks pull relevant engrams into the conversation context. Installed
// at the path chosen by --global/--project (default project) because per-project
// domain/scope tuning may matter for what gets injected.
const PLUR_HOOKS_INJECTION: Record<string, HookEntry[]> = {
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

  PreToolUse: [
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

  PostToolUse: [
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

function mergeHookMaps(
  a: Record<string, HookEntry[]>,
  b: Record<string, HookEntry[]>,
): Record<string, HookEntry[]> {
  const out: Record<string, HookEntry[]> = {}
  for (const [event, entries] of Object.entries(a)) out[event] = [...entries]
  for (const [event, entries] of Object.entries(b)) {
    out[event] = [...(out[event] ?? []), ...entries]
  }
  return out
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

  // --project flag forces project-level config, regardless of whether .claude/ exists
  if (forceProject) {
    return projectSettings
  }

  // Auto-detect: prefer project if .claude/ already exists
  if (existsSync(projectDir)) {
    return projectSettings
  }

  // Default: create project-level config (Issue #19)
  // PLUR works best with project-scoped hooks for multi-project setups
  return projectSettings
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

function mergeHooks(settings: Settings, hooksMap: Record<string, HookEntry[]>): Settings {
  // Strip old plur hooks first so init is idempotent (upgrade-safe)
  const clean = stripPlurHooks(settings)
  const hooks = { ...(clean.hooks ?? {}) }

  for (const [event, newEntries] of Object.entries(hooksMap)) {
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

function writeSettings(path: string, settings: Settings): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n')
}

function hooksStatusFor(before: string, after: string, hadHooks: boolean): string {
  if (!hadHooks) return 'installed'
  return before === after ? 'already up to date' : 'upgraded'
}

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const injectionPath = findSettingsPath(flags, args)
  const enforcementPath = join(homedir(), '.claude', 'settings.json')
  const samePath = injectionPath === enforcementPath

  let injectionHooksStatus: string
  let enforcementHooksStatus: string
  let mcpStatus: string

  if (samePath) {
    // Single file — combined enforcement + injection hooks
    let settings = loadSettings(enforcementPath)
    const hadHooks = hasPlurHooks(settings)
    const mcpAlready = hasPlurMcp(settings)
    const before = JSON.stringify(settings.hooks ?? {})

    settings = mergeHooks(settings, mergeHookMaps(PLUR_HOOKS_ENFORCEMENT, PLUR_HOOKS_INJECTION))
    const after = JSON.stringify(settings.hooks ?? {})

    if (!mcpAlready) {
      mergePlurMcp(settings as Record<string, unknown>)
      mcpStatus = 'registered'
    } else {
      mcpStatus = 'already registered'
    }

    writeSettings(enforcementPath, settings)
    const status = hooksStatusFor(before, after, hadHooks)
    injectionHooksStatus = status
    enforcementHooksStatus = status
  } else {
    // Enforcement at global, injection at project (or wherever findSettingsPath chose)
    let globalSettings = loadSettings(enforcementPath)
    const globalHadHooks = hasPlurHooks(globalSettings)
    const globalBefore = JSON.stringify(globalSettings.hooks ?? {})
    globalSettings = mergeHooks(globalSettings, PLUR_HOOKS_ENFORCEMENT)
    const globalAfter = JSON.stringify(globalSettings.hooks ?? {})
    writeSettings(enforcementPath, globalSettings)
    enforcementHooksStatus = hooksStatusFor(globalBefore, globalAfter, globalHadHooks)

    let projectSettings = loadSettings(injectionPath)
    const projectHadHooks = hasPlurHooks(projectSettings)
    const projectMcpAlready = hasPlurMcp(projectSettings)
    const projectBefore = JSON.stringify(projectSettings.hooks ?? {})
    projectSettings = mergeHooks(projectSettings, PLUR_HOOKS_INJECTION)
    const projectAfter = JSON.stringify(projectSettings.hooks ?? {})

    if (!projectMcpAlready) {
      mergePlurMcp(projectSettings as Record<string, unknown>)
      mcpStatus = 'registered'
    } else {
      mcpStatus = 'already registered'
    }

    writeSettings(injectionPath, projectSettings)
    injectionHooksStatus = hooksStatusFor(projectBefore, projectAfter, projectHadHooks)
  }

  // Install CLAUDE.md section
  const claudeMdStatus = installClaudeMd()

  // Register in Claude Desktop too
  const desktopStatus = installDesktopMcp(args)

  // Write project config if --domain or --scope provided
  const projectConfigPath = installProjectConfig(args)

  const entry = buildMcpServerEntry()

  outputText('PLUR installed for Claude Code.')
  outputText('')
  outputText('Architecture: One global engram store (~/.plur/), enforcement hooks global, injection hooks project-scoped.')
  outputText('Multi-project scoping via domain/scope fields on engrams, not separate installs.')
  outputText('')
  outputText(`MCP server (plur): ${mcpStatus}`)
  outputText(`  command: ${entry.command} ${entry.args.join(' ')}`)
  outputText('')
  outputText(`Enforcement hooks (3, always global): ${enforcementHooksStatus}`)
  outputText('  SessionStart      — enforce plur_session_start before any work')
  outputText('  PreToolUse        — session guard (blocks tools until session started)')
  outputText('  PostToolUse       — session sentinel (marks session as started)')
  outputText('')
  outputText(`Injection hooks (9): ${injectionHooksStatus}`)
  outputText('  UserPromptSubmit  — inject engrams + auto-start session')
  outputText('  PostCompact       — re-inject engrams after context compaction')
  outputText('  PreToolUse        — contextual injection (plan mode, skills, agents)')
  outputText('  PreToolUse        — observation capture for pattern learning')
  outputText('  PostToolUse       — observation results capture')
  outputText('  SubagentStart     — inject agent-scoped engrams into subagents')
  outputText('  Stop              — learning reflection nudge (every 3rd response)')
  outputText('')
  outputText(`Enforcement file: ${enforcementPath}`)
  if (!samePath) outputText(`Injection file:   ${injectionPath}`)
  outputText(`Claude Desktop:   ${desktopStatus}`)
  outputText(`CLAUDE.md:        ${claudeMdStatus}`)
  if (projectConfigPath) {
    outputText(`Project config:   ${projectConfigPath}`)
  }
  outputText('')
  outputText('Enforcement hooks fire from any subdirectory; they silent-pass when plur is not configured.')
  if (projectConfigPath) {
    outputText('Project scoping configured. Engrams learned in this project will')
    outputText('be tagged automatically. Run `plur init --domain X --scope Y` in')
    outputText('other projects to set their defaults.')
    outputText('')
  }
  outputText('Restart Claude Code to pick up the changes, then run `plur doctor` to verify.')
}
