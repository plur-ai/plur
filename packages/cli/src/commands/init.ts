import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { type GlobalFlags } from '../plur.js'
import { outputText, exit } from '../output.js'

/**
 * plur init — install Claude Code hooks for automatic engram injection.
 *
 * Adds hooks to .claude/settings.json (project-level if in a project, else global).
 * Hooks use `npx @plur-ai/cli inject` for engram selection — no Python, no Datacore deps.
 *
 * Usage:
 *   plur init              # auto-detect project vs global
 *   plur init --global     # force global ~/.claude/settings.json
 *   plur init --project    # force project .claude/settings.json
 */

interface Settings {
  hooks?: Record<string, HookEntry[]>
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

function findSettingsPath(flags: GlobalFlags, args: string[]): string {
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

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const settingsPath = findSettingsPath(flags, args)
  const settingsDir = join(settingsPath, '..')

  // Load existing settings
  const settings = loadSettings(settingsPath)

  // Check if already installed
  if (hasPlurHooks(settings)) {
    outputText('PLUR hooks are already installed.')
    outputText(`  Settings: ${settingsPath}`)
    return
  }

  // Merge hooks
  const updated = mergeHooks(settings)

  // Ensure directory exists
  mkdirSync(settingsDir, { recursive: true })

  // Write settings
  writeFileSync(settingsPath, JSON.stringify(updated, null, 2) + '\n')

  // Install CLAUDE.md section
  const claudeMdStatus = installClaudeMd()

  outputText('PLUR installed for Claude Code.')
  outputText('')
  outputText('Hooks added (8):')
  outputText('  UserPromptSubmit  — inject relevant engrams on first message')
  outputText('  PostCompact       — re-inject engrams after context compaction')
  outputText('  PreToolUse        — contextual injection (plan mode, skills, agents)')
  outputText('  PreToolUse        — observation capture for pattern learning')
  outputText('  PostToolUse       — observation results capture')
  outputText('  SubagentStart     — inject agent-scoped engrams into subagents')
  outputText('')
  outputText(`Settings:  ${settingsPath}`)
  outputText(`CLAUDE.md: ${claudeMdStatus}`)
  outputText('')
  outputText('Restart Claude Code to pick up the changes.')
}
