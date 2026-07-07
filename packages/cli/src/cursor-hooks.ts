import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'

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
}

/**
 * Build the PLUR hook contribution, given the resolved shim/CLI command to
 * invoke. Every entry pins `failClosed: false` explicitly (audit fix, data
 * evaluator): Cursor's schema documents `failClosed` as a real field, which
 * implies a genuine closed-by-default failure mode exists somewhere in the
 * hook pipeline. Every "allow" path in these hooks works by the process
 * exiting 0 with empty stdout — if Cursor's actual undocumented default for
 * "hook ran, said nothing" ever turned out to be closed rather than open,
 * `plur init --cursor` would silently brick every tool call for every user.
 * Pin the field so behavior doesn't depend on an unverified assumption;
 * Task 11 still separately confirms this in practice.
 */
export function buildCursorHooks(cmd: string): Record<string, CursorHookEntry[]> {
  return {
    // 10s is generous, not tight: hook-cursor-session-start is BM25-only
    // (PR #502 lesson — see its file-level comment), measured well under 1s
    // against a multi-thousand-engram store. Cursor's hook schema has no
    // async/fire-and-forget option to fall back on if this ever needs
    // hybrid search instead — keep it BM25-only rather than raising this.
    sessionStart: [{ command: `${cmd} hook-cursor-session-start`, timeout: 10, failClosed: false }],
    preToolUse: [{ command: `${cmd} hook-cursor-guard`, timeout: 3, failClosed: false }],
    postToolUse: [{ command: `${cmd} hook-cursor-post-tool`, timeout: 10, failClosed: false }],
    stop: [{ command: `${cmd} hook-cursor-stop`, timeout: 3, failClosed: false }],
  }
}

function isPlurCursorHookEntry(entry: CursorHookEntry): boolean {
  return entry.command.includes('@plur-ai/cli') || entry.command.includes('plur-hook') || entry.command.includes('hook-cursor-')
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
  return { version: clean.version ?? 1, hooks }
}

export function readCursorHooksConfig(path: string): CursorHooksConfig {
  if (!existsSync(path)) return { version: 1, hooks: {} }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return { version: parsed.version ?? 1, hooks: parsed.hooks ?? {} }
  } catch {
    return { version: 1, hooks: {} }
  }
}

export function writeCursorHooksConfig(path: string, config: CursorHooksConfig): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n')
}
