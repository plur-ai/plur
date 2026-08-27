import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'

/**
 * Support for Antigravity CLI's `hooks.json` (`~/.gemini/config/hooks.json`).
 *
 * A third config shape, different from both Claude Code/Codex (nested
 * `hooks → Event → [{matcher, hooks}]`) and Cursor (flat `hooks → event →
 * [spec]`): the top level is a map of NAMED HOOK SETS, each holding its
 * events. Tool events (`PreToolUse`/`PostToolUse`) wrap handlers in a
 * `{matcher, hooks: []}` group; lifecycle events (`PreInvocation`,
 * `PostInvocation`, `Stop`) take a flat handler array. Source:
 * `~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/hooks.md`
 * (the CLI's own bundled reference), confirmed live against agy 1.1.21.
 *
 * The named-set structure makes ownership trivial compared to the other
 * harnesses: PLUR owns exactly one top-level key (`plur-memory`) and never
 * touches any other. No command-string fingerprinting needed.
 *
 * Install location is the GLOBAL config dir, deliberately. Workspace
 * discovery (`.agents/hooks.json`, walked up to the repo root) exists but
 * did not load in `--print` mode during live probing — `loaded 0 named
 * hooks` with `workspacePaths: []` — while `~/.gemini/config/hooks.json`
 * loaded immediately. Global also matches how PLUR is installed everywhere
 * else: one store, one memory, every project.
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
 * Build PLUR's hook set, given the resolved shim/CLI command.
 *
 * Two hooks only:
 *
 * - `PreInvocation` carries everything context-shaped: the session-open
 *   batch, per-prompt recall (via the transcript — the payload has no prompt
 *   text), and the periodic learn nudge. There is no SessionStart event and
 *   no end-of-turn context channel, so this one event is the entire
 *   injection surface.
 * - `PreToolUse` is the session guard, and also where the sentinel is
 *   marked when `plur_session_start` itself passes through — PostToolUse's
 *   payload carries no tool name (`stepIdx` + `error` only, per the bundled
 *   docs), so detection has to happen on the way IN.
 *
 * Deliberately absent: `PostToolUse` (can only output `{}` — nothing to do),
 * and `Stop` (its only power is `decision: "continue"`, which BLOCKS
 * termination and forces another loop — never acceptable for a memory
 * nudge).
 *
 * Timeouts are SECONDS (agy default 30). PreInvocation gets 20 to cover
 * injectWithFallback's bounded worst case (~10s hybrid deadline + BM25);
 * hooks are synchronous-only in agy ("no async execution" — bundled docs),
 * so the same no-async rule as Codex applies without needing a regression
 * test: there is no flag to accidentally set.
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
