import { existsSync, readSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import {
  resolveFolderPolicy,
  coversHomeOrRoot,
  folderAskOnce as coreFolderAskOnce,
  type FolderAskOptions as CoreFolderAskOptions,
  type FolderPolicy,
  type Plur,
} from '@plur-ai/core'
import { createPlur, type GlobalFlags } from '../plur.js'

// The question itself, its quoting rules and the session settings moved to
// core (packages/core/src/folder-ask.ts) so the opencode plugin, which runs
// in-process and cannot call a hook, asks the same question. Re-exported here
// under their old names for the hooks and their tests.
export {
  sessionSettings,
  clearFolderAsk,
  folderQuoted as quoted,
  folderEscapedPath as escapedPath,
  isFolderAskText,
} from '@plur-ai/core'

/**
 * The folder map in the editor hooks (#1347, design r2 "Resolution" and
 * "The ask"). Every hook asks one question first — what has the user decided
 * about this folder? — and this module answers it, replacing the old
 * `isPlurConfigured()` gate:
 *
 *   - `on`  → the hook works as it always did. The policy's `scope` (a map
 *             entry's scope, else a trusted `.plur.yaml`'s hint) is the
 *             session scope, which is also what makes core dial the team
 *             store that scope belongs to.
 *   - `off` → the hook is silent and does nothing at all.
 *   - `ask` → the hook is silent, except the prompt-level inject hook of each
 *             editor, which on the first prompt of a session emits the one
 *             question built by {@link folderAskOnce} instead of memories.
 *
 * Only the CLI (`plur folders set`) writes the map; nothing here writes it.
 */

/** The PLUR home the hooks read the map from: `--path`, else PLUR_PATH, else ~/.plur. */
export function plurRoot(flags?: { path?: string }): string {
  return flags?.path ?? process.env.PLUR_PATH ?? join(homedir(), '.plur')
}

/**
 * The folder a hook payload is about: its `cwd` when the editor sends one that
 * exists, else process.cwd() (the folder the editor started the hook in).
 */
export function payloadDir(input: Record<string, unknown> | null | undefined): string {
  const cwd = input?.cwd
  return typeof cwd === 'string' && cwd && existsSync(cwd) ? cwd : process.cwd()
}

/**
 * The folder policy for `dir`. A resolver failure must never break a hook, and
 * must not switch memory on where the map could say off: it fails safe to
 * `ask` with reason `resolver-error` (no memory, a notice instead of commands).
 */
export function hookFolderPolicy(dir: string, flags?: { path?: string }): FolderPolicy {
  try {
    return resolveFolderPolicy(dir, { root: plurRoot(flags) })
  } catch (err) {
    // Fail SAFE (audit F4 of #1517, owner decision): an unreadable decision
    // could be `off`, so no project marker turns memory on here.
    process.stderr.write(`[plur] folder map: could not resolve ${dir} (${(err as Error)?.message ?? err}); memory is off here.\n`)
    return { mode: 'ask', remoteAllowed: false, source: 'default', reason: 'resolver-error' }
  }
}

/** True when the hooks should do their normal work in `dir`. */
export function hookFolderOn(dir: string, flags?: { path?: string }): boolean {
  return hookFolderPolicy(dir, flags).mode === 'on'
}


/**
 * The folder a Cursor hook decides for, and its policy (G1, 0.21.1
 * Codex/Cursor pre-release check). Cursor's payload carries no `cwd`, only
 * `workspace_roots`; the hook process runs wherever Cursor starts it (a
 * plugin's folder, for hooks loaded from a plugin), so `process.cwd()` named
 * the wrong folder: PLUR asked about the plugin folder, recorded the answer
 * for it and wrote its rule file there.
 *
 * The folder is the payload's `cwd` when it has one; else the workspace
 * roots, all of them; else the process folder, as before. With several roots
 * the rule is the MCP server's: any `off` root turns memory off (and wins over
 * everything), the first undecided root is asked about, and a scope applies
 * only when every root is on with that same scope. A root that is the home
 * folder, a filesystem root or above home is never asked about (an answer
 * there would cover every folder under it), unless every root is one.
 * `dir` is the folder hook output (rule files, the question) belongs to.
 */
export function cursorHookFolder(
  input: Record<string, unknown> | null | undefined,
  flags?: { path?: string },
): { dir: string; policy: FolderPolicy } {
  const cwd = input?.cwd
  if (typeof cwd === 'string' && cwd && existsSync(cwd)) return { dir: cwd, policy: hookFolderPolicy(cwd, flags) }
  const raw = Array.isArray(input?.workspace_roots) ? (input!.workspace_roots as unknown[]) : []
  const roots = [...new Set(raw.filter((r): r is string => typeof r === 'string' && r.length > 0 && existsSync(r)))]
  if (roots.length === 0) return { dir: process.cwd(), policy: hookFolderPolicy(process.cwd(), flags) }
  if (roots.length === 1) return { dir: roots[0], policy: hookFolderPolicy(roots[0], flags) }
  const decided = roots.map(dir => ({ dir, policy: hookFolderPolicy(dir, flags) }))
  const off = decided.find(d => d.policy.mode === 'off')
  if (off) return off
  const coversHome = (dir: string): boolean => { try { return coversHomeOrRoot(dir) } catch { return true } }
  const askable = decided.filter(d => !coversHome(d.dir))
  const considered = askable.length > 0 ? askable : decided
  const ask = considered.find(d => d.policy.mode === 'ask')
  if (ask) return ask
  const scopes = new Set(decided.map(d => d.policy.scope))
  const first = considered[0]
  if (scopes.size === 1 && first.policy.scope) return first
  const { scope: _dropped, ...rest } = first.policy
  return { dir: first.dir, policy: rest as FolderPolicy }
}

/** True when a SessionStart payload says the session was resumed. */
export function isResumeStart(input: Record<string, unknown> | null | undefined): boolean {
  return input?.source === 'resume'
}

/**
 * The Plur the folder question ranks scopes with, or null. Read-only, and
 * with the constructor's `<cwd>/.plur/engrams.yaml` discovery off: discovery
 * registers that store in config.yaml as a shared project store, so merely
 * asking in an undecided folder added its repository's memories to every
 * later session, in any folder, and offered its scope (#1418 review).
 */
export function createAskPlur(flags: GlobalFlags): Plur | null {
  try { return createPlur(flags, { readonly: true, autoDiscover: false }) } catch { return null }
}

export interface FolderAskOptions extends Omit<CoreFolderAskOptions, 'root'> {
  flags?: { path?: string }
}

/**
 * The one-time question for an `ask` folder (see core's folderAskOnce), on the
 * store this hook reads: `--path`, else PLUR_PATH, else ~/.plur.
 */
export function folderAskOnce(opts: FolderAskOptions): string | null {
  const { flags, ...rest } = opts
  return coreFolderAskOnce({ ...rest, root: plurRoot(flags) })
}

/** The raw hook payload on stdin ('' when there is none). */
export function readStdinRaw(): string {
  try {
    const chunks: Buffer[] = []
    const buf = Buffer.alloc(65536)
    for (;;) {
      let n = 0
      try { n = readSync(0, buf, 0, buf.length, null) } catch { break }
      if (n === 0) break
      chunks.push(Buffer.from(buf.subarray(0, n)))
    }
    return Buffer.concat(chunks).toString('utf8')
  } catch {
    return ''
  }
}

/** The payload as an object; {} when it is missing or not JSON. */
export function parsePayload(raw: string): Record<string, unknown> {
  try {
    const v = raw.trim() ? JSON.parse(raw) : {}
    return v && typeof v === 'object' ? v as Record<string, unknown> : {}
  } catch {
    return {}
  }
}
