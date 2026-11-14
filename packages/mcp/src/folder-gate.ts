import {
  folderOffEntries, folderMapProblem, folderAsk, hostFolderAsk, folderNonceOutstanding, endFolderNonceSession,
  sweepFolderNonces, coversHomeOrRoot, workspaceScopeDecision, FOLDER_NONCE_TTL_MS, type WorkspaceScopeDecision, type FolderMapProblem, type Plur, type FolderAsk, type FolderAskAnswer,
  type FolderAskHost,
} from '@plur-ai/core'
import { folderMapAdvice } from './folder-map-advice.js'
import { fileURLToPath } from 'url'
import { randomBytes } from 'crypto'
import { execFileSync } from 'child_process'
import { realpathSync } from 'fs'
import { dirname, resolve } from 'path'
import { folderOnCommand } from './tools.js'

/**
 * The folder map's `off` decision in the MCP server. In a folder marked
 * `plur: off` in `<PLUR home>/folders.yaml`, gated tools answer (not error)
 * that PLUR is off and touch no store: no local file, outbox row or remote request.
 * - Gated: FOLDER_GATED_TOOLS (anything reading, writing or returning engram or
 *   episode text). Ungated: ADMIN_UNGATED_TOOLS and plur_admin `help`; some of
 *   these read stores to count or probe them, but none returns engram text.
 *   Every tool is in exactly one set (a test holds this).
 * - An unreadable folder map fails SAFE; `ask` folders get the folder question
 *   (createFolderGate). The gate never writes folders.yaml itself (only the
 *   one-time trust.yaml import can create it).
 */
export const FOLDER_GATED_TOOLS: ReadonlySet<string> = new Set([
  // write engrams
  'plur_learn',
  'plur_learn_batch',
  'plur_feedback',
  'plur_pin',
  'plur_forget',
  'plur_ingest',
  'plur_promote',
  'plur_rescope',
  'plur_episode_to_engram',
  'plur_report_failure',
  'plur_extract_meta',
  'plur_validate_meta',
  'plur_tensions',
  'plur_tensions_purge',
  'plur_packs_install',
  'plur_packs_uninstall',
  // read engrams
  'plur_recall',
  'plur_recall_hybrid',
  'plur_inject',
  'plur_inject_hybrid',
  'plur_similarity_search',
  'plur_meta_engrams',
  'plur_history',
  'plur_provenance',
  'plur_profile',
  'plur_packs_export',
  // episodes and sessions
  'plur_capture',
  'plur_timeline',
  'plur_session_start',
  'plur_session_end',
  // move engrams between the local store and a remote
  'plur_sync',
  'plur_outbox',
  // returns the statements of recently retrieved engrams
  'plur_receipt',
])

/** The tools that stay available in an `off` folder: admin and diagnostics. */
export const ADMIN_UNGATED_TOOLS: ReadonlySet<string> = new Set([
  'plur_status',
  'plur_doctor',
  'plur_stores_list',
  'plur_stores_add',
  'plur_sync_status',
  'plur_packs_list',
  'plur_packs_discover',
  'plur_packs_preview',
  'plur_scopes_discover',
  'plur_suggest_scope',
  'plur_session_scope',
])

/** The non-error answer a gated tool gives in an `off` folder (or under a broken map). */
export interface FolderOffAnswer {
  success: true
  plur: 'off'
  folder?: string
  reason?: 'folder-map-unreadable' | 'workspace-unknown' | 'not-now' | 'folder-cannot-be-asked' | 'folder-ask-failed'
  file?: string
  /** For a broken map: where the problem is (1-based). */
  line?: number
  column?: number
  /** Whether `plur folders repair` can fix it. */
  fixable?: boolean
  /** The exact command to run, only after the user agrees (when fixable). */
  repair_command?: string
  /** What that command changes (lines and keys, no values): show it to the user first. */
  repair_summary?: string
  message: string
}

function log(line: string): void {
  try { process.stderr.write(`[plur] ${line}\n`) } catch { /* never fail a tool over a log line */ }
}

function unreadable(problem: FolderMapProblem, root: string): FolderOffAnswer {
  const advice = folderMapAdvice(problem, root)
  return {
    success: true,
    plur: 'off',
    reason: 'folder-map-unreadable',
    file: problem.file,
    ...(problem.line !== undefined ? { line: problem.line } : {}),
    ...(problem.column !== undefined ? { column: problem.column } : {}),
    fixable: problem.fixable,
    ...(advice.command ? { repair_command: advice.command } : {}),
    ...(advice.summary ? { repair_summary: advice.summary } : {}),
    message:
      `PLUR memory is paused: the folder map ${JSON.stringify(problem.file)} ${problem.problem}. ` +
      `Until it is fixed, PLUR cannot tell whether memory is allowed in this folder, so nothing was read from or ` +
      `written to memory. This is not an error — carry on without memory. ${advice.text}`,
  }
}

/**
 * The `off` answer when PLUR must do nothing here, else null (the tool runs
 * normally):
 *  - the folder map exists but cannot be read or parsed → fail safe, naming
 *    the file and the problem;
 *  - any of `dirs` resolves to `off` → off, naming every map entry that turns
 *    it off and the command for each.
 * Resolved on every call, so a decision changed mid-session applies to the
 * next call. A missing folder map is not a problem (no decisions yet).
 */
export function folderOffAnswer(plur: Plur, dirs: string[]): FolderOffAnswer | null {
  const root = plur.storageRoot
  let problem: FolderMapProblem | null
  try {
    problem = folderMapProblem(root)
  } catch (err) {
    problem = { file: `${root}/folders.yaml`, problem: `could not be checked (${(err as Error)?.message ?? err})`, fixable: false }
  }
  if (problem) {
    log(`folder map ${problem.file} ${problem.problem}; memory tools do nothing until it is fixed.`)
    return unreadable(problem, root)
  }
  for (const dir of dirs) {
    let mode: string
    try {
      mode = plur.resolveFolderPolicy(dir).mode
    } catch (err) {
      const why = `could not be applied to ${JSON.stringify(dir)} (${(err as Error)?.message ?? err})`
      log(`folder map: ${why}; memory tools do nothing.`)
      return unreadable({ file: `${root}/folders.yaml`, problem: why, fixable: false }, root)
    }
    if (mode !== 'off') continue
    let entries: string[] = []
    try { entries = folderOffEntries(dir, { root }).map(e => e.path) } catch { /* name the folder itself */ }
    if (entries.length === 0) entries = [dir]
    const cmds = entries.map(e => folderOnCommand(e, root))
    const how = cmds.every(c => c !== null)
      ? cmds.join(entries.length > 1 ? ' and ' : '')
      : `plur folders set <folder> --on for ${entries.length > 1 ? 'each of ' : ''}${entries.map(e => JSON.stringify(e)).join(', ')} (see plur folders list)`
    const through = entries.length === 1 && entries[0] === dir
      ? ''
      : ` through ${entries.length > 1 ? 'the entries' : 'the entry'} ${entries.map(e => JSON.stringify(e)).join(', ')}`
    return {
      success: true,
      plur: 'off',
      folder: dir,
      message:
        `PLUR is off for this folder (${JSON.stringify(dir)}): your folder map turns memory off here${through}, ` +
        `so nothing was read from or written to memory. This is not an error — carry on without memory. ` +
        `Only the user can turn it back on, from a terminal: ${how}`,
    }
  }
  return null
}

/** What {@link createWorkspaceDirs} needs from an MCP server. */
export interface RootsServer {
  getClientCapabilities(): { roots?: unknown } | undefined
  listRoots(params?: undefined, options?: { timeout?: number }): Promise<{ roots: Array<{ uri: string }> }>
  setNotificationHandler(method: 'notifications/roots/list_changed', handler: () => void): void
}

/**
 * The editor's workspace: every `file://` root from MCP `roots/list` (when
 * declared) plus the server's cwd. `dirs()` resolves to null when roots cannot
 * be fetched (error, 2 s timeout) or a root is not a local folder; the caller
 * then FAILS CLOSED ({@link workspaceUnknownAnswer}), never falling back to cwd.
 * Caching: only with `roots.listChanged` (callers share the in-flight request);
 * failures are never cached; `roots/list_changed` bumps a generation and stale
 * answers are discarded. Exported for other server entry points.
 */
export function createWorkspaceDirs(
  server: RootsServer,
  opts: { timeoutMs?: number; cwd?: () => string } = {},
): { dirs(): Promise<string[] | null>; workspace(): Promise<Workspace | null> } {
  const timeout = opts.timeoutMs ?? 2000
  const cwd = opts.cwd ?? (() => process.cwd())
  let cached: { gen: number; dirs: string[] } | null = null
  let gen = 0
  let pending: { gen: number; promise: Promise<string[] | null> } | null = null
  server.setNotificationHandler('notifications/roots/list_changed', () => {
    gen++
    cached = null
    pending = null
  })
  const request = (g: number): Promise<string[] | null> =>
    server.listRoots(undefined, { timeout }).then(
      ({ roots }) => {
        // Every declared root must resolve to a local folder. One that cannot
        // (another host's file://host/..., an encoded slash, a non-file URI)
        // is a workspace the folder map cannot be checked against: the call
        // fails closed, and nothing is cached.
        const dirs: string[] = []
        for (const r of roots) {
          let dir: string | null = null
          try {
            if (typeof r.uri === 'string' && /^file:\/\//i.test(r.uri)) dir = fileURLToPath(r.uri.replace(/^file:/i, 'file:'))
          } catch { dir = null }
          if (dir === null) {
            log(`a workspace root the server cannot resolve to a local folder (${JSON.stringify(String(r.uri).slice(0, 200))}); memory tools do nothing for this call.`)
            return null
          }
          dirs.push(dir)
        }
        // Cache only when the client promises to say when its roots change;
        // without listChanged, ask on every call.
        if (g === gen && listChanged()) cached = { gen: g, dirs }
        return dirs
      },
      (err: unknown) => {
        log(`roots/list failed (${(err as Error)?.message ?? err}); memory tools do nothing for this call, the next call asks the client again.`)
        return null
      },
    ).finally(() => { if (pending?.gen === g) pending = null })
  const listChanged = (): boolean => {
    const roots = server.getClientCapabilities()?.roots as { listChanged?: boolean } | undefined
    return roots?.listChanged === true
  }
  const clientRoots = async (): Promise<string[] | null> => {
    if (!server.getClientCapabilities()?.roots) return []
    for (let attempt = 0; attempt < 3; attempt++) {
      if (cached && cached.gen === gen) return cached.dirs
      const g = gen
      // Share one in-flight request only with a client that will tell us when
      // its roots change. Without listChanged, a call made after a workspace
      // switch must not join a request sent before it: each call asks.
      let promise: Promise<string[] | null>
      if (listChanged()) {
        if (!pending || pending.gen !== g) pending = { gen: g, promise: request(g) }
        promise = pending.promise
      } else {
        promise = request(g)
      }
      const dirs = await promise
      if (dirs === null) return null
      if (g === gen) return dirs
      // The roots changed while we waited: that answer is stale, ask again.
    }
    return null
  }
  return {
    async dirs() {
      const roots = await clientRoots()
      return roots === null ? null : [...new Set([...roots, cwd()])]
    },
    async workspace() {
      const roots = await clientRoots()
      return roots === null ? null : { roots: [...new Set(roots)], cwd: cwd() }
    },
  }
}

/** The editor's workspace as the folder gate needs it: the client's roots, and the server's own cwd. */
export interface Workspace { roots: string[]; cwd: string }

/** The answer a gated tool gives when the editor's workspace folders could not be fetched. */
export function workspaceUnknownAnswer(): FolderOffAnswer {
  return {
    success: true,
    plur: 'off',
    reason: 'workspace-unknown',
    message:
      `PLUR couldn't get the editor's workspace folders (the MCP roots request failed, timed out, or named a ` +
      `folder that is not on this machine), so it cannot tell whether memory is allowed here: memory is off for ` +
      `this call, and nothing was read from or written to memory. This is not an error. The next call will ask ` +
      `again; if the editor's roots keep failing, memory stays off until they work.`,
  }
}

/** The non-error answer a gated tool gives in an undecided folder: the folder question. */
export interface FolderAskPayload {
  success: true
  plur: 'ask'
  folder: string
  /** The whole question, as the editor hooks word it, with every command. */
  question: string
  /** Each offered answer and the command that records it (one nonce each). */
  answers: FolderAskAnswer[]
}

/** Every workspace folder is `on`: the tool runs, with the folder map's scope when there is one. */
export interface FolderOn { plur: 'on'; scope?: string }

/** `ps` etime (`[[dd-]hh:]mm:ss`) in seconds, or null. */
export function parseEtime(etime: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim())
  if (!m) return null
  return (Number(m[1] ?? 0) * 86400) + (Number(m[2] ?? 0) * 3600) + Number(m[3]) * 60 + Number(m[4])
}

/**
 * This process's ancestors, nearest first, each with its start time: the
 * processes that may have asked the folder question
 * already, as the opencode plugin does in the opencode process that started
 * this server (directly, or through npx). One `ps` call, at most eight
 * levels. [] when it cannot be told (Windows, no `ps`, unreadable output):
 * then the server asks its own question. Without a start time a
 * process is never matched, so a reused process id cannot pass for the host.
 */
export function ancestorHosts(now: number = Date.now()): FolderAskHost[] {
  if (process.platform === 'win32') return []
  let table: string
  try {
    table = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,etime='], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return []
  }
  const info = new Map<number, { ppid: number; startedAt: number }>()
  for (const line of table.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line)
    if (!m) continue
    const secs = parseEtime(m[3])
    if (secs === null) continue
    info.set(Number(m[1]), { ppid: Number(m[2]), startedAt: now - secs * 1000 })
  }
  const out: FolderAskHost[] = []
  let pid = process.ppid
  while (pid > 1 && out.length < 8 && !out.some(h => h.pid === pid)) {
    const i = info.get(pid)
    if (!i) break
    out.push({ pid, startedAt: i.startedAt })
    pid = i.ppid
  }
  return out
}

/**
 * THE default write scope for an unscoped write in this workspace, used by
 * every default-picking path (learn, learn_batch, session_end, session_start,
 * session_scope clear). Inputs are all client roots (else the start folder),
 * realpath-resolved; each must resolve to `on` with a scope (map, else trusted
 * `.plur.yaml`) and all to the SAME scope. Otherwise null (write stays local),
 * with no fallback: mixed or missing scopes, home / above-home / filesystem
 * root inputs, unresolvable inputs, or any error.
 */
export function workspaceWriteScope(plur: Plur, ws: Workspace): WorkspaceScopeDecision {
  // The rule lives in core (workspaceFolderScope) so the CLI, whose one input
  // is the folder it runs in, resolves exactly as this server does.
  return workspaceScopeDecision(ws.roots.length > 0 ? ws.roots : [ws.cwd], dir => plur.resolveFolderPolicy(dir))
}

/** The workspace's identity for a session default: its roots, or its start folder. */
export function workspaceKey(ws: Workspace): string {
  const inputs = ws.roots.length > 0 ? ws.roots : [ws.cwd]
  const real = inputs.map(i => { try { return realpathSync.native(i) } catch { return resolve(i) } })
  return JSON.stringify([ws.roots.length > 0 ? 'roots' : 'cwd', ...[...new Set(real)].sort()])
}

/** True for the home folder, a filesystem root or a folder above home. */
function isHomeOrAbove(dir: string): boolean {
  try { return coversHomeOrRoot(dir) } catch { return true }
}

/** True for a filesystem root (`/`, `C:\\`): not a project folder, never asked about. */
function isFilesystemRoot(dir: string): boolean {
  const r = resolve(dir)
  return dirname(r) === r
}

/**
 * The folder map per MCP session (one per createServer): `off` and `ask`.
 * - `ask`: gated tools return the folder question; each answer's nonce is bound
 *   to this session (`--session`), reused until answered or expired. A nonce from
 *   another session, or naming none, is refused; the agent runs the command only
 *   after the user's explicit answer.
 * - The server never writes the folder map; the next call after the user's
 *   command re-resolves. "Not now" (`--not-now`) writes nothing: off for this session.
 * - Precedence off > ask > on, `off` checked on every folder incl. cwd; home,
 *   above-home and filesystem roots are never asked about.
 * - `end()` deletes unanswered nonces (stdin end, SIGTERM/SIGINT); orphans expire.
 */
export function createFolderGate(plur: Plur, opts: { sessionId?: string; hosts?: () => FolderAskHost[] } = {}): {
  sessionId: string
  /**
   * The off answer, the folder question, or — every folder decided `on` — the
   * folder map's write scope for the workspace, only when every folder has
   * the same one, for plur_session_start's default and
   * the unscoped writes.
   */
  check(workspace: Workspace): FolderOffAnswer | FolderAskPayload | FolderOn
  end(): void
} {
  const sessionId = opts.sessionId ?? `mcp-${randomBytes(8).toString('hex')}`
  // Nonce files left by sessions that never closed (a server killed
  // outright) are removed once their nonces have expired.
  try { sweepFolderNonces(plur.storageRoot) } catch { /* best-effort */ }
  /** The question built for a workspace folder, by that folder, while it is undecided. */
  const asked = new Map<string, { ask: FolderAsk; issuedAt: number; reason?: string }>()
  const notNow = new Set<string>()
  /** Set by end(): a closing session issues no new question (no nonce outlives it). */
  let ended = false
  // Re-issue a minute before core would call the nonces expired.
  const reissueAfter = Math.max(0, FOLDER_NONCE_TTL_MS - 60_000)
  // The processes that may have asked already, looked up once, when
  // first needed.
  let hosts: FolderAskHost[] | null = null
  const hostList = (): FolderAskHost[] => {
    if (hosts === null) {
      try { hosts = (opts.hosts ?? ancestorHosts)() } catch { hosts = [] }
    }
    return hosts
  }
  /** The host's question this session is showing, by folder, with this session's "not now" nonce. */
  const hosted = new Map<string, FolderAsk>()

  const notNowAnswer = (folder: string): FolderOffAnswer => ({
    success: true,
    plur: 'off',
    reason: 'not-now',
    folder,
    message:
      `PLUR memory is off in this folder (${JSON.stringify(folder)}) for the rest of this session: the user answered ` +
      `"not now" to the folder question, so nothing was read from or written to memory. This is not an error — carry ` +
      `on without memory, and do not ask again. The folder is still undecided; a new session will ask.`,
  })

  const outstanding = (nonce: string): boolean => {
    try { return folderNonceOutstanding(plur.storageRoot, sessionId, nonce) } catch { return false }
  }

  /**
   * "Not now" to this session's own question about `dir`, if the user gave
   * it: their command consumed its nonce while the question's other nonces
   * are still there. Marks the folder off for the rest of the session.
   */
  const notNowGiven = (dir: string): FolderOffAnswer | null => {
    const entry = asked.get(dir)
    if (entry?.ask.notNowNonce === undefined) return null
    const notNowNonce = entry.ask.notNowNonce
    if (outstanding(notNowNonce) || !entry.ask.nonces.some(n => n !== notNowNonce && outstanding(n))) return null
    log(`folder ${JSON.stringify(entry.ask.folder)}: the user answered "not now"; memory tools do nothing for the rest of this session.`)
    notNow.add(dir)
    asked.delete(dir)
    return notNowAnswer(entry.ask.folder)
  }

  const askFor = (dir: string, policy: ReturnType<Plur['resolveFolderPolicy']>): FolderOffAnswer | FolderAskPayload => {
    // "Not now" first: it holds for the rest of the
    // session, whatever happens to the question afterwards. Consumed, not
    // just gone: "not now" leaves the question's other nonces in place, while
    // a session file that was swept or ended loses them all. Only the first
    // is an answer; the second falls through and the question is asked afresh.
    const given = notNowGiven(dir)
    if (given) return given
    let entry = asked.get(dir)
    // Rebuilt when the nonces are about to expire, or the reason the folder
    // is undecided changed (a repo .plur.yaml appeared or went away).
    if (entry && ((!entry.ask.notice && Date.now() - entry.issuedAt > reissueAfter) || entry.reason !== policy.reason)) {
      asked.delete(dir)
      entry = undefined
    }
    // Another answer was used, yet the folder is undecided again (its entry
    // was removed since): that question no longer works, ask afresh.
    if (entry && entry.ask.nonces.some(n => !outstanding(n))) {
      asked.delete(dir)
      entry = undefined
    }
    // One set of nonces per folder: when the process that started
    // this server (the opencode plugin, in opencode) already asked about this
    // folder, show that question, with its nonces, instead of a second one.
    // It also offers "not now", with a nonce of THIS session, issued once and
    // shown on every call; once it is used, memory is off here for the rest
    // of the session, as for the server's own question.
    if (!entry && !ended) {
      const shown = hosted.get(dir)
      if (shown) {
        // "Not now" was answered: its nonce (in the host's session) is gone
        // while the question's other nonces are still there. All of them gone
        // means the host's question ended, which is no answer.
        const hostSession = shown.hostSession
        const inHost = (n: string): boolean => {
          try { return hostSession !== undefined && folderNonceOutstanding(plur.storageRoot, hostSession, n) } catch { return false }
        }
        const nn = shown.notNowNonce
        if (nn !== undefined && !inHost(nn) && shown.nonces.some(n => n !== nn && inHost(n))) {
          log(`folder ${JSON.stringify(shown.folder)}: the user answered "not now"; memory tools do nothing for the rest of this session.`)
          hosted.delete(dir)
          notNow.add(dir)
          return notNowAnswer(shown.folder)
        }
        // Still the host's question (its nonces unused): show it again.
        let still: FolderAsk | null = null
        try { still = hostFolderAsk({ dir, policy, root: plur.storageRoot, hosts: hostList(), plur }) } catch { /* treated as gone */ }
        if (still && still.nonces.every(n => shown.nonces.includes(n))) {
          return { success: true, plur: 'ask', folder: shown.folder, question: shown.text, answers: shown.answers }
        }
        hosted.delete(dir)
      } else {
        let found: FolderAsk | null = null
        try {
          const list = hostList()
          if (list.length > 0) found = hostFolderAsk({ dir, policy, root: plur.storageRoot, hosts: list, offerNotNow: true, plur })
        } catch (err) {
          log(`folder question of the host process could not be read (${(err as Error)?.message ?? err}).`)
        }
        if (found && !found.notice) {
          hosted.set(dir, found)
          return { success: true, plur: 'ask', folder: found.folder, question: found.text, answers: found.answers }
        }
      }
    }
    if (!entry && ended) {
      return {
        success: true,
        plur: 'off',
        reason: 'folder-ask-failed',
        folder: dir,
        message:
          `PLUR has no decision for this folder (${JSON.stringify(dir)}) and this session is closing, so it did not ` +
          `ask; nothing was read from or written to memory. This is not an error. A new session will ask.`,
      }
    }
    if (!entry) {
      let ask: FolderAsk | null = null
      try {
        ask = folderAsk({ dir, policy, sessionId, root: plur.storageRoot, plur, claim: () => true, bindSession: true, mcp: true })
      } catch (err) {
        log(`folder question for ${JSON.stringify(dir)} could not be built (${(err as Error)?.message ?? err}).`)
      }
      if (!ask) {
        return {
          success: true,
          plur: 'off',
          reason: 'folder-ask-failed',
          folder: dir,
          message:
            `PLUR has no decision for this folder (${JSON.stringify(dir)}) and could not prepare the question that asks ` +
            `the user, so nothing was read from or written to memory. This is not an error — carry on without memory. ` +
            `The next call tries again; the user can also decide from a terminal: plur folders set <folder> --on | --off.`,
        }
      }
      entry = { ask, issuedAt: Date.now(), ...(policy.reason ? { reason: policy.reason } : {}) }
      asked.set(dir, entry)
    }
    if (entry.ask.notice) {
      // A folder the question cannot name safely in a command: no command,
      // no nonce. Memory stays off here until the user sets it by hand.
      return { success: true, plur: 'off', reason: 'folder-cannot-be-asked', folder: entry.ask.folder, message: entry.ask.text }
    }
    return { success: true, plur: 'ask', folder: entry.ask.folder, question: entry.ask.text, answers: entry.ask.answers }
  }

  return {
    sessionId,
    check(workspace) {
      // `off` is checked on every folder, the server's cwd included:
      // there, checking more folders only ever turns memory off.
      const off = folderOffAnswer(plur, [...new Set([...workspace.roots, workspace.cwd])])
      if (off) return off
      // The question is asked only about the folders the user works in:
      // the client's roots when it gives any — the
      // server's cwd is wherever the client happened to start the process —
      // else the cwd, unless that is the home folder, a filesystem root or a
      // folder above home: an answer there would cover every folder under it.
      // A root that is the home folder, a filesystem root or above home is
      // not asked about either, and roots that are all such count
      // as no roots.
      const usableRoots = workspace.roots.filter(r => !isHomeOrAbove(r))
      const askable = usableRoots.length > 0
        ? usableRoots
        : (isHomeOrAbove(workspace.cwd) ? [] : [workspace.cwd])
      const on: Array<{ dir: string; scope?: string }> = []
      for (const dir of askable) {
        if (isFilesystemRoot(dir)) continue
        let policy: ReturnType<Plur['resolveFolderPolicy']>
        try {
          policy = plur.resolveFolderPolicy(dir)
        } catch (err) {
          const why = `could not be applied to ${JSON.stringify(dir)} (${(err as Error)?.message ?? err})`
          log(`folder map: ${why}; memory tools do nothing.`)
          return unreadable({ file: `${plur.storageRoot}/folders.yaml`, problem: why, fixable: false }, plur.storageRoot)
        }
        if (policy.mode === 'ask') {
          if (notNow.has(dir)) return notNowAnswer(asked.get(dir)?.ask.folder ?? dir)
          return askFor(dir, policy)
        }
        // An untrusted .plur.yaml is `on` without its settings (owner
        // decision 2026-11-14), but it is no decision of the user's: a "not
        // now" they gave this session still holds, so a repository file that
        // appears afterwards cannot switch memory back on.
        if (policy.reason === 'untrusted-plur-yaml') {
          if (notNow.has(dir)) return notNowAnswer(dir)
          const given = notNowGiven(dir)
          if (given) return given
        }
        // Only on and remote-only let the tool run. An `off` read here (the
        // map changed after the off check above) turns memory off too.
        if (policy.mode !== 'on' && policy.mode !== 'remote-only') {
          return folderOffAnswer(plur, [dir]) ?? {
            success: true,
            plur: 'off',
            folder: dir,
            message:
              `PLUR is off for this folder (${JSON.stringify(dir)}): your folder map turns memory off here, so nothing ` +
              `was read from or written to memory. This is not an error — carry on without memory.`,
          }
        }
        on.push({ dir, ...(policy.scope ? { scope: policy.scope } : {}) })
      }
      // The workspace's scope: workspaceWriteScope, the one resolver every
      // default uses. Only when every input — every
      // root, none left out — agrees on one scope; otherwise none.
      const scopeDecision = workspaceWriteScope(plur, workspace)
      const scope = scopeDecision.kind === 'agreed' ? scopeDecision.scope : undefined
      // Every folder is decided: a question this session asked about one of
      // them is answered. Its scope reaches writes through the workspace
      // resolver (FOLDER_SCOPE); the process-wide slot is never set.
      for (const { dir } of on) {
        hosted.delete(dir)
        if (!asked.has(dir)) continue
        asked.delete(dir)
        notNow.delete(dir)
      }
      return { plur: 'on', ...(scope ? { scope } : {}) }
    },
    end() {
      ended = true
      asked.clear()
      hosted.clear()
      try { endFolderNonceSession(plur.storageRoot, sessionId) } catch { /* best-effort */ }
    },
  }
}
