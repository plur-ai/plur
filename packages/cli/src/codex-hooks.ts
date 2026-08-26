import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'

/**
 * Support for Codex's `~/.codex/hooks.json`.
 *
 * Structurally IDENTICAL to Claude Code's `.claude/settings.json` hooks
 * section — `hooks[event]` is an array of `{matcher, hooks: [...]}` wrapper
 * objects — which is why this file can be so much smaller than
 * `cursor-hooks.ts` (Cursor nests one level shallower and needed its own
 * merge implementation).
 *
 * Codex accepts hooks from either `~/.codex/hooks.json` or a `[hooks]` table
 * in `~/.codex/config.toml`, and warns when both exist for the same layer
 * ("loading hooks from both … prefer a single representation"). We write the
 * JSON file: it needs no TOML dependency, it reuses the shape the Claude
 * Code builders already emit, and it keeps PLUR's hooks out of the file the
 * user hand-edits for models and MCP servers.
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
 *
 * NOTHING HERE MAY SET `async: true`. Codex does support async hooks as of
 * 0.149.1 (they were silently skipped in 0.146.0), but an async hook's
 * `additionalContext` is delivered at the "next safe point" — i.e. NOT to
 * the turn that triggered it. For a `codex exec` one-shot that means never.
 * Claude Code's `hook-inject` is async with a 90s timeout precisely because
 * hybrid search cold-starts the BGE embedder; that trade does not transfer.
 * These hooks are synchronous and BM25-only instead, the same call
 * `hook-cursor-session-start` makes for the same reason. `codex-hooks.test.ts`
 * asserts this invariant.
 *
 * Timeouts are SECONDS here (Codex's unit), not the milliseconds Gemini CLI
 * uses. Codex's own default is 600s; ours are deliberately tight so a wedged
 * hook cannot hang a turn.
 */
export function buildCodexHooks(cmd: string): Record<string, CodexHookEntry[]> {
  return {
    // Session open: mark the sentinel and inject an initial batch.
    SessionStart: [
      {
        hooks: [{
          type: 'command',
          command: `${cmd} hook-codex-session-start`,
          timeout: 15,
          statusMessage: 'PLUR: loading memory',
        }],
      },
    ],

    // Per-prompt injection — the load-bearing hook. Verified reaching the
    // model on codex-cli 0.149.1.
    UserPromptSubmit: [
      {
        hooks: [{
          type: 'command',
          command: `${cmd} hook-codex-inject`,
          timeout: 15,
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

    // Close the memory lifecycle. Codex clamps SessionEnd timeouts to 3s and
    // forces them synchronous, so this must stay cheap — it captures the
    // closing episode and cleans up the sentinel, nothing more.
    SessionEnd: [
      {
        hooks: [{ type: 'command', command: `${cmd} hook-codex-session-end`, timeout: 3 }],
      },
    ],
  }
}

/** The exact set of subcommands `buildCodexHooks()` installs. */
const PLUR_CODEX_SUBCOMMANDS = [
  'hook-codex-session-start',
  'hook-codex-inject',
  'hook-codex-guard',
  'hook-codex-post-tool',
  'hook-codex-session-end',
]

/**
 * A hook is PLUR's only if it BOTH names the PLUR binary AND invokes one of
 * PLUR's exact subcommands — the same two-part test `cursor-hooks.ts` uses,
 * and for the same reason: matching on a bare `hook-codex-` substring would
 * claim a user's own `./scripts/hook-codex-lint.sh` and silently delete it
 * on the next `plur init --codex`.
 */
function isPlurCodexHookSpec(spec: CodexHookSpec): boolean {
  const cmd = spec?.command ?? ''
  const isPlurBinary = cmd.includes('@plur-ai/cli') || cmd.includes('plur-hook')
  if (!isPlurBinary) return false
  return PLUR_CODEX_SUBCOMMANDS.some((sub) => cmd.includes(sub))
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
