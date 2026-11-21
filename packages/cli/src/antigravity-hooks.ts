import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'

/**
 * Support for Antigravity CLI's `hooks.json` (`~/.gemini/config/hooks.json`): a map of NAMED
 * HOOK SETS; tool events use `{matcher, hooks: []}` groups, lifecycle events
 * (`PreInvocation`, `PostInvocation`, `Stop`) flat arrays. Reference: the CLI's bundled
 * `~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/hooks.md`.
 * PLUR owns exactly one key (`plur-memory`) and never touches others.
 * Installed globally: workspace `.agents/hooks.json` does not load in `--print` mode.
 */

/** PLUR's top-level key in hooks.json — the whole ownership story. */
export const AGY_HOOK_SET_NAME = 'plur-memory'

export interface AgyHookHandler {
  type?: 'command'
  command: string
  timeout?: number
}

export interface AgyToolHookGroup {
  matcher: string
  hooks: AgyHookHandler[]
}

export interface AgyHookSet {
  enabled?: boolean
  PreInvocation?: AgyHookHandler[]
  PostInvocation?: AgyHookHandler[]
  Stop?: AgyHookHandler[]
  PreToolUse?: AgyToolHookGroup[]
  PostToolUse?: AgyToolHookGroup[]
}

export type AgyHooksConfig = Record<string, AgyHookSet>

/**
 * Build PLUR's hook set, given the resolved shim/CLI command. Two hooks only:
 * - `PreInvocation`: the whole injection surface (session-open batch, per-prompt recall via
 *   the transcript, learn nudge) — there is no SessionStart or end-of-turn channel.
 * - `PreToolUse`: the session guard, also marking the sentinel when `plur_session_start`
 *   passes (PostToolUse payloads carry no tool name).
 * No `PostToolUse`; `Stop` only runs the silent auto-rate (a decision would block termination).
 * Timeouts are SECONDS; PreInvocation gets 20 for injectWithFallback's ~10s worst case.
 * agy hooks are synchronous-only, so no async flag exists to set.
 */
export function buildAgyHookSet(cmd: string): AgyHookSet {
  return {
    enabled: true,
    PreInvocation: [
      { type: 'command', command: `${cmd} hook-agy-pre-invocation`, timeout: 20 },
    ],
    PreToolUse: [
      {
        matcher: '*',
        hooks: [{ type: 'command', command: `${cmd} hook-agy-guard`, timeout: 5 }],
      },
    ],
    // Auto-rate injected engrams. Prints nothing — never
    // `decision: "continue"` — so it cannot block the stop; the reply is read
    // from the transcript because the Stop payload carries none.
    Stop: [
      { type: 'command', command: `${cmd} hook-auto-rate agy`, timeout: 10 },
    ],
  }
}

export function hasPlurAgyHooks(config: AgyHooksConfig): boolean {
  return Object.prototype.hasOwnProperty.call(config, AGY_HOOK_SET_NAME)
}

/**
 * Idempotent merge: replace PLUR's named set, touch nothing else. A user's
 * own hook sets — whatever their names — pass through byte-identical.
 */
export function mergeAgyHooks(config: AgyHooksConfig, plurSet: AgyHookSet): AgyHooksConfig {
  return { ...config, [AGY_HOOK_SET_NAME]: plurSet }
}

export function readAgyHooksConfig(path: string): AgyHooksConfig {
  if (!existsSync(path)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      ? parsed as AgyHooksConfig
      : {}
  } catch {
    return {}
  }
}

export function writeAgyHooksConfig(path: string, config: AgyHooksConfig): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n')
}
