import { existsSync, readSync, realpathSync } from 'fs'
import { join, resolve, posix, relative, sep, isAbsolute, win32 } from 'path'
import { fileURLToPath } from 'url'
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


/**
 * A Cursor workspace root (or payload `cwd`) as a local folder path, or null
 * when it is not one (audit L2 of #1583). Cursor documents folder paths; a
 * `file://` URI is converted with fileURLToPath (Windows drive letters
 * included; a URI naming another host is not local and gives null). Anything
 * that is not an absolute path is unusable: a relative path would be read
 * against wherever the hook process happens to run.
 */
export function cursorRootPath(raw: unknown, windows: boolean = process.platform === 'win32'): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  if (/^file:/i.test(raw)) {
    try {
      // The options argument exists from Node 20.13 / 22.1; older Nodes use
      // the running platform, which is the right answer outside tests.
      return (fileURLToPath as (u: string, o?: { windows?: boolean }) => string)(raw.replace(/^file:/i, 'file:'), { windows })
    } catch {
      return null
    }
  }
  if (/^[a-z][a-z0-9+.-]+:\/\//i.test(raw)) return null // another scheme: not a local folder
  return (windows ? win32 : posix).isAbsolute(raw) && (!windows || /^([a-z]:[\\/]|[\\/]{2})/i.test(raw)) ? raw : null
}

/** What a Cursor hook decides for the workspace (see {@link cursorHookFolder}). */
export interface CursorWorkspaceDecision {
  /**
   * The workspace root hook output belongs to (rule files, the question).
   * Null only when the decision is off and there is no usable root.
   */
  dir: string | null
  /** The workspace's policy. Its `scope` is set only when every root agrees on it. */
  policy: FolderPolicy
}

/** Off, decided here because the workspace could not be read: no scope, no question, no memory. */
const WORKSPACE_UNKNOWN: FolderPolicy = { mode: 'off', remoteAllowed: false, source: 'default' }

/** True for the home folder, a folder above it or a filesystem root (an error counts as true). */
function coversHome(dir: string): boolean {
  try { return coversHomeOrRoot(dir) } catch { return true }
}

/** True when `dir` is `root` or inside it. */
function within(dir: string, root: string): boolean {
  const rel = relative(root, dir)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * What a Cursor hook decides for the workspace (G1 of the 0.21.1
 * Codex/Cursor pre-release check; the audit of #1583). Cursor runs a hook
 * wherever it likes (a plugin's folder, for hooks loaded from a plugin) and
 * names the workspace in `workspace_roots`; some hooks also send the tool's
 * `cwd`. Every Cursor hook calls this, so they all reach the same decision
 * for the same workspace, and it is the MCP server's decision
 * (workspaceWriteScope and the folder gate in packages/mcp):
 *
 *  - The inputs are the workspace roots. Only when the payload has no
 *    `workspace_roots` key: its `cwd`, else (no `cwd` either) the hook
 *    process folder, as before.
 *  - Roots that are present but unusable — not a list, an empty list, an
 *    entry that is not an absolute path or a local `file://` URI — fail
 *    closed: off, so no scope, no question and no memory. Never the process
 *    folder: that is where Cursor started the hook, not the workspace.
 *  - Each input is realpath-resolved before the folder map and `.plur.yaml`
 *    are read, so a link takes the decision of the folder it points at.
 *  - Off wins: any root off — including a root that does not exist (an
 *    unmounted disk), checked by its path as given — or a payload `cwd` that
 *    is off, makes the whole workspace off, for every hook.
 *  - The question is about the first undecided root that exists and is not
 *    the home folder, a folder above it or a filesystem root (an answer there
 *    would cover every folder under it). With no such root, an undecided
 *    workspace is off (asked about nothing, nothing loaded).
 *  - Otherwise memory is on. The scope applies only when every root exists,
 *    is not home or above, and is on with that same scope; else no scope.
 *  - A payload `cwd` never decides by itself when there are roots: it picks
 *    which root the output belongs to (the root it is in), nothing more.
 */
export function cursorHookFolder(
  input: Record<string, unknown> | null | undefined,
  flags?: { path?: string },
): CursorWorkspaceDecision {
  const closed: CursorWorkspaceDecision = { dir: null, policy: WORKSPACE_UNKNOWN }
  const rawCwd = input?.cwd
  const hasCwd = rawCwd !== undefined && rawCwd !== null && rawCwd !== ''
  const cwd = hasCwd ? cursorRootPath(rawCwd) : null
  if (hasCwd && cwd === null) return closed

  let inputs: string[]
  if (input && Object.prototype.hasOwnProperty.call(input, 'workspace_roots')) {
    const raw = input.workspace_roots
    if (!Array.isArray(raw) || raw.length === 0) return closed
    const paths = raw.map(r => cursorRootPath(r))
    if (paths.some(p => p === null)) return closed
    inputs = [...new Set(paths as string[])]
  } else {
    inputs = [cwd ?? process.cwd()]
  }

  const real = (p: string): string | null => { try { return realpathSync.native(p) } catch { return null } }
  const roots = inputs.map(given => ({ given, real: real(given) }))
  const existing = roots.filter((r): r is { given: string; real: string } => r.real !== null)
  const cwdReal = cwd ? real(cwd) ?? cwd : null

  // Off wins, on every root (missing ones by their given path) and the cwd.
  const firstDir = existing[0]?.real ?? null
  for (const p of [...roots.map(r => r.real ?? r.given), ...(cwdReal ? [cwdReal] : [])]) {
    const policy = hookFolderPolicy(p, flags)
    if (policy.mode === 'off') return { dir: firstDir, policy }
  }

  const decided = existing.map(r => ({ dir: r.real, policy: hookFolderPolicy(r.real, flags), broad: coversHome(r.real) }))
  const askable = decided.filter(d => !d.broad)
  const ask = askable.find(d => d.policy.mode === 'ask')
  if (ask) return { dir: ask.dir, policy: ask.policy }
  // Every root asked about is on. With none to ask about (only home-or-above
  // roots, or none that exist), memory is on only when every root is: an
  // undecided home folder is not a decision to turn memory on.
  if (askable.length === 0 && (decided.length === 0 || decided.some(d => d.policy.mode !== 'on'))) {
    return { dir: firstDir, policy: WORKSPACE_UNKNOWN }
  }

  // The scope: every root, none left out — core's workspaceFolderScope, the
  // resolver the MCP server's workspaceWriteScope uses.
  const scope = workspaceFolderScope(inputs, d => hookFolderPolicy(d, flags))

  // The output folder: the root the cwd is in (the deepest), else the first
  // root that is not home or above, else the first root.
  const pool = askable.length > 0 ? askable : decided
  const inCwd = cwdReal ? pool.filter(d => within(cwdReal, d.dir)).sort((a, b) => b.dir.length - a.dir.length)[0] : undefined
  const chosen = inCwd ?? pool[0]
  const { scope: _own, ...rest } = chosen.policy
  return { dir: chosen.dir, policy: scope ? { ...rest, scope } : { ...rest, ...(chosen.policy.scope ? { remoteAllowed: false } : {}) } }
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
