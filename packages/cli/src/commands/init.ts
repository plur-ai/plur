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
 * Two things must be in place for plur to work in Claude Code:
 *
 *   1. The `plur` MCP server must be registered, so the `plur_*` tools exist.
 *   2. The lifecycle hooks must call `npx @plur-ai/cli hook-*` to inject
 *      relevant engrams into the conversation.
 *
 * Earlier versions of `plur init` only did step 2, which led users to
 * believe a separately-installed `datacore` MCP server *was* plur — because
 * the CLAUDE.md section installed by init told the model to call
 * `plur_session_start`, `plur_learn`, etc. and the model would then reach
 * for whatever similarly-named tools it saw. This command now does both.
 *
 * Usage:
 *   plur init              # auto-detect project vs global
 *   plur init --global     # force global ~/.claude/settings.json
 *   plur init --project    # force project .claude/settings.json
 *   plur init --no-desktop # skip Claude Desktop config registration
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

  // --- Contextual injection ---

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

  // Observation capture — log tool results
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

const CLAUDE_MD_SECTION = `## PLUR Memory

You have persistent memory via PLUR. Corrections, preferences, and conventions persist across sessions as engrams.

> **PLUR is its own MCP server.** The tools below come from the \`plur\` MCP server registered by \`plur init\` — \`plur_session_start\`, \`plur_learn\`, \`plur_recall_hybrid\`, \`plur_feedback\`, \`plur_session_end\`. If you do not see these exact tool names, **PLUR is not connected**: stop and run \`plur doctor\` to diagnose. Do **not** substitute tools from other MCP servers (e.g. \`datacore_*\`) — those belong to a different system and will not persist anything for PLUR.

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

function hasPlurHooks(settings: Settings): boolean {
  const hooks = settings.hooks ?? {}
  for (const entries of Object.values(hooks)) {
    for (const entry of entries) {
      for (const h of entry.hooks ?? []) {
        if (h.command.includes('@plur-ai/cli')) return true
      }
    }
  }
  return false
}

function mergeHooks(settings: Settings): Settings {
  const hooks = { ...(settings.hooks ?? {}) }

  for (const [event, newEntries] of Object.entries(PLUR_HOOKS)) {
    const existing = hooks[event] ?? []
    // Append PLUR hooks to existing hooks for this event
    hooks[event] = [...existing, ...newEntries]
  }

  return { ...settings, hooks }
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

  const hooksAlreadyInstalled = hasPlurHooks(settings)
  const mcpAlreadyInstalled = hasPlurMcp(settings)

  let hooksStatus: string
  let mcpStatus: string

  if (hooksAlreadyInstalled && mcpAlreadyInstalled) {
    hooksStatus = 'already installed'
    mcpStatus = 'already registered'
  } else {
    if (!hooksAlreadyInstalled) {
      settings = mergeHooks(settings)
      hooksStatus = 'installed'
    } else {
      hooksStatus = 'already installed'
    }

    if (!mcpAlreadyInstalled) {
      mergePlurMcp(settings as Record<string, unknown>)
      mcpStatus = 'registered'
    } else {
      mcpStatus = 'already registered'
    }

    // Ensure directory exists and write
    mkdirSync(settingsDir, { recursive: true })
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
  }

  // Install CLAUDE.md section
  const claudeMdStatus = installClaudeMd()

  // Register in Claude Desktop too
  const desktopStatus = installDesktopMcp(args)

  const entry = buildMcpServerEntry()

  outputText('PLUR installed for Claude Code.')
  outputText('')
  outputText(`MCP server (plur): ${mcpStatus}`)
  outputText(`  command: ${entry.command} ${entry.args.join(' ')}`)
  outputText('')
  outputText(`Hooks (9):         ${hooksStatus}`)
  outputText('  UserPromptSubmit  — inject relevant engrams on first message')
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
  outputText('')
  outputText('Restart Claude Code to pick up the changes, then run `plur doctor` to verify.')
}
