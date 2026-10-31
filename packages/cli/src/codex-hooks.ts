import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { isPlurHookCommand } from './lib/hook-command.js'

/**
 * Support for Codex's `~/.codex/hooks.json` — structurally identical to Claude Code's
 * settings.json hooks section. We write this JSON file rather than a `[hooks]` table in
 * config.toml (Codex warns if both exist): no TOML dependency, and PLUR's hooks stay
 * out of the file the user hand-edits.
 */

export interface CodexHookSpec {
  type: 'command'
  command: string
  timeout?: number
  statusMessage?: string
}

export interface CodexHookEntry {
  matcher?: string
  hooks: CodexHookSpec[]
}

export interface CodexHooksConfig {
  description?: string
  hooks: Record<string, CodexHookEntry[]>
}

/**
 * Build PLUR's Codex hook contribution, given the resolved shim/CLI command.
 * NOTHING HERE MAY SET `async: true`: async `additionalContext` arrives after the
 * triggering turn (never, for `codex exec`). `codex-hooks.test.ts` asserts this.
 * Timeouts are SECONDS (Codex's unit), deliberately tight so a wedged hook cannot hang a turn.
 */
export function buildCodexHooks(cmd: string): Record<string, CodexHookEntry[]> {
  return {
    // Session open: mark the sentinel and inject an initial batch.
    SessionStart: [
      {
        hooks: [{
          type: 'command',
          command: `${cmd} hook-codex-session-start`,
          timeout: 25,
          statusMessage: 'PLUR: loading memory',
        }],
      },
    ],

    // Per-prompt injection — the load-bearing hook.
    UserPromptSubmit: [
      {
        hooks: [{
          type: 'command',
          command: `${cmd} hook-codex-inject`,
          timeout: 25,
          statusMessage: 'PLUR: recalling',
        }],
      },
    ],

    // Session guard. Codex accepts `permissionDecision: "deny"` from a
    // PreToolUse hook and surfaces the reason to the model (verified), but
    // REJECTS "allow" and "ask" — so, exactly like the Cursor guard, this
    // only ever denies or stays silent.
    PreToolUse: [
      {
        matcher: '.*',
        hooks: [{ type: 'command', command: `${cmd} hook-codex-guard`, timeout: 5 }],
      },
    ],

    // Sentinel + periodic learn nudge.
    PostToolUse: [
      {
        matcher: '.*',
        hooks: [{ type: 'command', command: `${cmd} hook-codex-post-tool`, timeout: 10 }],
      },
    ],

    // Auto-rate injected engrams from the reply. Stop carries
    // `last_assistant_message`; the hook prints nothing, which is Codex's
    // valid "no opinion" Stop result.
    Stop: [
      {
        hooks: [{ type: 'command', command: `${cmd} hook-auto-rate codex`, timeout: 10 }],
      },
    ],

    // Session cleanup. Codex clamps SessionEnd timeouts to 3s and forces
    // them synchronous, so this must stay cheap: it removes the sentinel and
    // counters, NOTHING more — it deliberately does not capture a closing
    // episode (being killed mid-write at the 3s clamp is worse than not
    // writing; see hook-codex-session-end's docstring). Closing the memory
    // lifecycle properly is the agent's job via plur_session_end.
    SessionEnd: [
      {
        hooks: [{ type: 'command', command: `${cmd} hook-codex-session-end`, timeout: 3 }],
      },
    ],
  }
}

/**
 * A hook is PLUR's when PLUR's own launcher runs a `hook-*` subcommand —
 * the shared prefix matcher, so a new Codex hook needs no
 * list update. A user's own `./scripts/hook-codex-lint.sh`, or any hook-*
 * run by another binary, is not PLUR's and is never deleted by
 * `plur init --codex`.
 */
function isPlurCodexHookSpec(spec: CodexHookSpec): boolean {
  return typeof spec?.command === 'string' && isPlurHookCommand(spec.command)
}

function entryIsPlurOwned(entry: CodexHookEntry): boolean {
  return (entry?.hooks ?? []).some(isPlurCodexHookSpec)
}

export function hasPlurCodexHooks(config: CodexHooksConfig): boolean {
  return Object.values(config.hooks ?? {}).some(entries => (entries ?? []).some(entryIsPlurOwned))
}

/**
 * Drop PLUR's own entries, preserving everything else — including a
 * user-authored hook that happens to sit in the same event array, and a
 * mixed entry where only some specs are ours.
 */
function stripPlurCodexHooks(config: CodexHooksConfig): CodexHooksConfig {
  const hooks: Record<string, CodexHookEntry[]> = {}
  for (const [event, entries] of Object.entries(config.hooks ?? {})) {
    const kept: CodexHookEntry[] = []
    for (const entry of entries ?? []) {
      const specs = (entry?.hooks ?? []).filter(s => !isPlurCodexHookSpec(s))
      // An entry whose specs were ALL ours disappears; one that still has
      // foreign specs survives with only those.
      if (specs.length > 0) kept.push({ ...entry, hooks: specs })
    }
    if (kept.length > 0) hooks[event] = kept
  }
  return { ...config, hooks }
}

/** Idempotent — strips existing PLUR entries before adding the current set (upgrade-safe). */
export function mergeCodexHooks(
  config: CodexHooksConfig,
  additions: Record<string, CodexHookEntry[]>,
): CodexHooksConfig {
  const clean = stripPlurCodexHooks(config)
  const hooks = { ...(clean.hooks ?? {}) }
  for (const [event, entries] of Object.entries(additions)) {
    hooks[event] = [...(hooks[event] ?? []), ...entries]
  }
  return { ...clean, hooks }
}

export function readCodexHooksConfig(path: string): CodexHooksConfig {
  if (!existsSync(path)) return { hooks: {} }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CodexHooksConfig>
    return { ...parsed, hooks: parsed.hooks ?? {} }
  } catch {
    return { hooks: {} }
  }
}

export function writeCodexHooksConfig(path: string, config: CodexHooksConfig): void {
  mkdirSync(dirname(path), { recursive: true })
  const out: CodexHooksConfig = {
    ...config,
    description: config.description
      ?? 'Hook configuration (PLUR memory hooks managed by `plur init --codex`)',
  }
  writeFileSync(path, JSON.stringify(out, null, 2) + '\n')
}
