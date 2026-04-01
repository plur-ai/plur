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

// The hook script that runs on first user message — injects engrams based on the prompt.
// Subsequent messages skip (~1ms) because the session marker file exists.
const INJECT_HOOK = 'npx @plur-ai/cli hook-inject'

// Re-inject after context compaction so engrams survive long conversations.
const REHYDRATE_HOOK = 'npx @plur-ai/cli hook-inject --rehydrate'

const PLUR_HOOKS: Record<string, HookEntry[]> = {
  UserPromptSubmit: [
    {
      hooks: [
        { type: 'command', command: INJECT_HOOK, timeout: 15 },
      ],
    },
  ],
  PostCompact: [
    {
      matcher: 'auto|manual',
      hooks: [
        { type: 'command', command: REHYDRATE_HOOK, timeout: 15 },
      ],
    },
  ],
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

  outputText('PLUR hooks installed for Claude Code.')
  outputText('')
  outputText('Hooks added:')
  outputText('  UserPromptSubmit  — inject relevant engrams on first message')
  outputText('  PostCompact       — re-inject engrams after context compaction')
  outputText('')
  outputText(`Settings: ${settingsPath}`)
  outputText('')
  outputText('Restart Claude Code to pick up the changes.')
}
