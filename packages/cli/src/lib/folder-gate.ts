import { existsSync, readSync, realpathSync } from 'fs'
import { join, resolve } from 'path'
import { homedir } from 'os'
import {
  resolveFolderPolicy,
  workspaceFolderScope,
  folderMapProblem,
  coversHomeOrRoot,
  type FolderMapProblem,
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


/** Registry key for the folder's scope on a CLI read; no real session id starts with NUL. */
const CLI_FOLDER_SESSION = '\u0000plur:cli-folder-scope'

/** What an unscoped or scoped CLI read passes to core for its remote leg. */
export interface FolderReadContext {
  /** The dialing context: the folder's scope, registered under an internal key. */
  session?: string
  /** False when the folder map says no store may be contacted from here. */
  remote?: false
}

/**
 * The remote side of a `plur recall` / `plur inject` run in `cwd` (L10 of the
 * third 0.21.1 pre-release check; L1 and L2 of the PR #1579 audit). Local
 * memory is always read and printed; this decides only what leaves the
 * machine, by the MCP server's rule for the same folder:
 *
 *  - a broken folder map: no store is contacted, whatever `--scope` says
 *    (MCP refuses every memory tool until the map is fixed). One stderr note
 *    says so and names the repair command;
 *  - an `off` folder: no store is contacted, whatever `--scope` says (MCP
 *    refuses an `off` folder outright);
 *  - an undecided folder: no store is contacted for an unscoped read. An
 *    explicit `--scope` is the user's own choice for this one command and is
 *    honoured. The home folder, a folder above it and a filesystem root are
 *    never undecided here, as over MCP (an answer there would cover every
 *    folder under it), so a read there is unchanged;
 *  - an `on` folder: an explicit `--scope` wins in core; otherwise the
 *    folder's scope (core's workspaceFolderScope, the MCP resolver) is the
 *    dialing context, registered under an internal key. It is a dialing
 *    context, not a filter: local results are unchanged.
 */
export function folderReadContext(plur: Plur, explicitScope: string | undefined, cwd: string = process.cwd()): FolderReadContext {
  const root = plur.storageRoot
  let problem: FolderMapProblem | null
  try { problem = folderMapProblem(root) } catch (err) {
    problem = { file: join(root, 'folders.yaml'), problem: `could not be checked (${(err as Error)?.message ?? err})`, fixable: false }
  }
  if (problem) return brokenMap(problem, root)
  let dir: string
  try { dir = realpathSync.native(cwd) } catch { dir = cwd }
  let mode: FolderPolicy['mode']
  try { mode = plur.resolveFolderPolicy(dir).mode } catch (err) {
    return brokenMap({ file: join(root, 'folders.yaml'), problem: `could not be applied to ${JSON.stringify(dir)} (${(err as Error)?.message ?? err})`, fixable: false }, root)
  }
  if (mode === 'off') return { remote: false }
  if (mode === 'ask') {
    let wide = false
    try { wide = coversHomeOrRoot(dir) } catch { wide = false }
    if (!wide && !explicitScope) return { remote: false }
    return {}
  }
  if (explicitScope) return {}
  const scope = workspaceFolderScope([cwd], d => plur.resolveFolderPolicy(d))
  if (scope === null) return {}
  plur.setSessionScope(scope, { session: CLI_FOLDER_SESSION })
  return { session: CLI_FOLDER_SESSION }
}

/** The stderr note for a broken map on a CLI read, and no remote leg. */
function brokenMap(problem: Pick<FolderMapProblem, 'file' | 'problem' | 'fixable' | 'line'>, root: string): FolderReadContext {
  const store = resolve(root)
  const cmd = store === resolve(join(homedir(), '.plur')) ? 'plur folders repair' : `plur --path ${JSON.stringify(store)} folders repair`
  const fix = problem.fixable
    ? `Run \`${cmd}\` to see the problem and repair it (it asks first).`
    : `\`${cmd}\` cannot fix it automatically: fix ${problem.line !== undefined ? `line ${problem.line}` : 'the file'} by hand (\`${cmd}\` re-checks it).`
  try {
    process.stderr.write(
      `[plur] The folder map ${problem.file} ${problem.problem}. Until it is fixed, no team memory is used: ` +
      `this command read only the memory on this machine. ${fix}\n`)
  } catch { /* a note never fails the read */ }
  return { remote: false }
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
