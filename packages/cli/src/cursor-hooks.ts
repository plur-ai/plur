import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { isPlurHookCommand } from './lib/hook-command.js'

/**
 * Support for Cursor's `.cursor/hooks.json`. Structurally different from
 * Claude Code's `.claude/settings.json` hooks section: Cursor nests one level
 * shallower — `hooks[event]` is a flat array of command specs, not an array
 * of `{matcher, hooks: [...]}` wrapper objects — so this intentionally does
 * NOT reuse init.ts's Claude Code hook-merge helpers.
 */

export interface CursorHookEntry {
  command: string
  type?: 'command' | 'prompt'
  timeout?: number
  matcher?: string
  failClosed?: boolean
}

export interface CursorHooksConfig {
  version: number
  hooks: Record<string, CursorHookEntry[]>
  /** Unknown top-level keys a user's hooks.json carries — preserved verbatim through read→merge→write. */
  [key: string]: unknown
}

/**
 * Build the PLUR hook contribution, given the resolved shim/CLI command to
 * invoke. Every entry pins `failClosed: false` explicitly: Cursor's schema
 * documents `failClosed` as a real field, and every "allow" path in these
 * hooks works by the process exiting 0 with empty stdout. If Cursor's
 * undocumented default for "hook ran, said nothing" were closed rather than
 * open, `plur init --cursor` would silently block every tool call. Pinning
 * the field removes the dependency on that assumption.
 */
export function buildCursorHooks(cmd: string): Record<string, CursorHookEntry[]> {
  return {
    // 10s is generous, not tight: hook-cursor-session-start is BM25-only
    // (see its file-level comment), well under 1s against a
    // multi-thousand-engram store. Cursor's hook schema has no
    // async/fire-and-forget option to fall back on if this ever needs
    // hybrid search instead — keep it BM25-only rather than raising this.
    sessionStart: [{ command: `${cmd} hook-cursor-session-start`, timeout: 10, failClosed: false }],
    preToolUse: [{ command: `${cmd} hook-cursor-guard`, timeout: 3, failClosed: false }],
    postToolUse: [{ command: `${cmd} hook-cursor-post-tool`, timeout: 10, failClosed: false }],
    stop: [{ command: `${cmd} hook-cursor-stop`, timeout: 3, failClosed: false }],
    // Auto-rate injected engrams from the reply text: the `stop`
    // payload carries no reply, `afterAgentResponse` carries `text`.
    afterAgentResponse: [{ command: `${cmd} hook-auto-rate cursor`, timeout: 10, failClosed: false }],
  }
}

/**
 * A command is PLUR-owned when PLUR's own launcher (the plur-hook shim or
 * the `@plur-ai/cli` npx fallback) runs a `hook-*` subcommand — the shared
 * matcher `plur init` uses for every editor (a prefix match, no subcommand
 * list, so a new Cursor hook needs no update here). A user's own
 * `./scripts/hook-cursor-lint.sh`, or any hook-* run by another binary, is
 * not PLUR's and survives `stripPlurCursorHooks()`; a bare `hook-cursor-`
 * substring test would delete such hooks.
 */
function isPlurCursorHookEntry(entry: CursorHookEntry): boolean {
  return typeof entry?.command === 'string' && isPlurHookCommand(entry.command)
}

export function hasPlurCursorHooks(config: CursorHooksConfig): boolean {
  return Object.values(config.hooks ?? {}).some(entries => (entries ?? []).some(isPlurCursorHookEntry))
}

function stripPlurCursorHooks(config: CursorHooksConfig): CursorHooksConfig {
  const hooks: Record<string, CursorHookEntry[]> = {}
  for (const [event, entries] of Object.entries(config.hooks ?? {})) {
    const kept = (entries ?? []).filter(e => !isPlurCursorHookEntry(e))
    if (kept.length > 0) hooks[event] = kept
  }
  return { ...config, hooks }
}

/** Idempotent — strips any existing PLUR entries before adding the current set (upgrade-safe, mirrors init.ts's mergeHooks). */
export function mergeCursorHooks(config: CursorHooksConfig, additions: Record<string, CursorHookEntry[]>): CursorHooksConfig {
  const clean = stripPlurCursorHooks(config)
  const hooks = { ...(clean.hooks ?? {}) }
  for (const [event, entries] of Object.entries(additions)) {
    hooks[event] = [...(hooks[event] ?? []), ...entries]
  }
  // Spread `clean`: unknown top-level keys readCursorHooksConfig preserved
  // must survive the merge too.
  return { ...clean, version: clean.version ?? 1, hooks }
}

export function readCursorHooksConfig(path: string): CursorHooksConfig {
  if (!existsSync(path)) return { version: 1, hooks: {} }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { version: 1, hooks: {} }
    // Spread first: unknown top-level keys survive the round trip, as in the
    // codex writer.
    return { ...parsed, version: parsed.version ?? 1, hooks: parsed.hooks ?? {} }
  } catch {
    return { version: 1, hooks: {} }
  }
}

export function writeCursorHooksConfig(path: string, config: CursorHooksConfig): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n')
}
