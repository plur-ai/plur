import {
  folderOffEntries, folderMapProblem, folderAsk, folderNonceOutstanding, endFolderNonceSession,
  FOLDER_NONCE_TTL_MS, type Plur, type FolderAsk, type FolderAskAnswer,
} from '@plur-ai/core'
import { fileURLToPath } from 'url'
import { randomBytes } from 'crypto'
import { dirname, resolve } from 'path'
import { folderOnCommand } from './tools.js'

/**
 * The folder map's `off` decision in the MCP server.
 *
 * The editor hooks and the opencode plugin go silent in a folder the user
 * marked `plur: off` in `<PLUR home>/folders.yaml`. The MCP server is the
 * other way in: an agent can call plur_learn or plur_recall itself. So before
 * any of the tools below runs, the server resolves the folder policy for the
 * editor's workspace, and in an `off` folder it answers — without an error —
 * that PLUR is off here, and touches no store at all: no local file, no
 * outbox row, no request to a remote store.
 *
 * Gated: every tool that reads or writes engrams or episodes, or returns
 * their text (FOLDER_GATED_TOOLS). Not gated: the admin and diagnostic tools
 * (ADMIN_UNGATED_TOOLS) and plur_admin's `help`. Some admin tools still read
 * stores to count or probe them (status, doctor, stores_list); none returns
 * engram text. Every registered tool is in exactly one of the two sets (a
 * test holds this), so a new tool cannot slip through ungated unnoticed.
 *
 * A folder map that exists but cannot be read or parsed fails SAFE: the gated
 * tools do nothing and name the file and the problem. An undecided (`ask`)
 * folder gets the folder question instead of memory (createFolderGate, #1525);
 * `on` folders are unchanged. The gate never writes folders.yaml itself
 * (core's one-time trust.yaml import can create it on the first read).
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
  message: string
}

function log(line: string): void {
  try { process.stderr.write(`[plur] ${line}\n`) } catch { /* never fail a tool over a log line */ }
}

function unreadable(file: string, problem: string): FolderOffAnswer {
  return {
    success: true,
    plur: 'off',
    reason: 'folder-map-unreadable',
    file,
    message:
      `PLUR memory is paused: the folder map ${JSON.stringify(file)} ${problem}. ` +
      `Until it is fixed, PLUR cannot tell whether memory is allowed in this folder, so nothing was read from or ` +
      `written to memory. This is not an error — carry on without memory. The user can fix the file, or ` +
      `rewrite it from a terminal with plur folders set / plur folders rm.`,
  }
}

/**
 * The `off` answer when PLUR must do nothing here, else null (the tool runs as
 * before):
 *  - the folder map exists but cannot be read or parsed → fail safe, naming
 *    the file and the problem;
 *  - any of `dirs` resolves to `off` → off, naming every map entry that turns
 *    it off and the command for each.
 * Resolved on every call, so a decision changed mid-session applies to the
 * next call. A missing folder map is not a problem (no decisions yet).
 */
export function folderOffAnswer(plur: Plur, dirs: string[]): FolderOffAnswer | null {
  const root = plur.storageRoot
  let problem: { file: string; problem: string } | null
  try {
    problem = folderMapProblem(root)
  } catch (err) {
    problem = { file: `${root}/folders.yaml`, problem: `could not be checked (${(err as Error)?.message ?? err})` }
  }
  if (problem) {
    log(`folder map ${problem.file} ${problem.problem}; memory tools do nothing until it is fixed.`)
    return unreadable(problem.file, problem.problem)
  }
  for (const dir of dirs) {
    let mode: string
    try {
      mode = plur.resolveFolderPolicy(dir).mode
    } catch (err) {
      const why = `could not be applied to ${JSON.stringify(dir)} (${(err as Error)?.message ?? err})`
      log(`folder map: ${why}; memory tools do nothing.`)
      return unreadable(`${root}/folders.yaml`, why)
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
 * The editor's workspace for the folder map: every `file://` root the client
 * lists over MCP `roots/list` (when it declares the roots capability), plus
 * the server's cwd — the folder the editor started it in, which is also where
 * readTrustedProjectConfig looks for `.plur.yaml`.
 *
 * `dirs()` resolves to null when the roots could not be fetched (an error or
 * the 2 s timeout) or a declared root does not resolve to a local folder. The caller then FAILS CLOSED for that call
 * ({@link workspaceUnknownAnswer}) — it never falls back to cwd alone, which
 * would run memory in a workspace the user may have turned off.
 *
 * The roots answer is cached, with three rules:
 *  - with a client that declares `roots.listChanged`, every caller awaits the
 *    SAME in-flight request, so a call made while it is pending never runs on
 *    a partial picture; without it, each call sends its own request, so a call
 *    made after a workspace switch never joins a request sent before it;
 *  - a failed or timed-out request is never cached: the next call asks again;
 *  - an answer is cached only when the client declared `roots.listChanged`;
 *  - `roots/list_changed` bumps a generation; an answer that arrives for an
 *    older generation is discarded and the caller asks again.
 *
 * Self-contained and exported so other server entry points can share it.
 */
export function createWorkspaceDirs(
  server: RootsServer,
  opts: { timeoutMs?: number; cwd?: () => string } = {},
): { dirs(): Promise<string[] | null> } {
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
  }
}

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

/** The non-error answer a gated tool gives in an undecided folder: the folder question (#1525). */
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

/** True for a filesystem root (`/`, `C:\\`): not a project folder, never asked about. */
function isFilesystemRoot(dir: string): boolean {
  const r = resolve(dir)
  return dirname(r) === r
}

/**
 * The folder map in the MCP server, per MCP session (one per createServer):
 * `off` (folderOffAnswer) and, since #1525, `ask`.
 *
 * In a workspace whose folder resolves to `ask` (undecided, or a `.plur.yaml`
 * asking for settings not yet trusted), a gated tool touches no memory and
 * answers with the folder question the editor hooks ask: one command per
 * answer, each with its own nonce from core, bound to this MCP session (the
 * command names it with `--session`, and a nonce redeemed from another
 * session or naming none is refused). The question and its nonces are built
 * once per folder and returned on every gated call until the user answers;
 * they are re-issued only after the nonce lifetime. The server never writes
 * the folder map: the user (or the agent, after the user's explicit answer)
 * runs the command, and the next call resolves the folder again and follows
 * the new decision. Yes → memory on, with the answer's scope as this
 * session's default write scope when nothing set one. Never here → off.
 *
 * "Not now" has a command too, because the server cannot see the chat:
 * `plur folders set <folder> --not-now --nonce <n> --session <id>` consumes
 * its nonce and writes nothing. Once it is gone from this session's nonce
 * file, the folder is off for the rest of this session, without the question.
 * The folder stays undecided, so another session asks again.
 *
 * Precedence across the workspace folders: off > ask > on. A filesystem root
 * (some clients start MCP servers in `/`) is not a project folder: it is never
 * asked about, and its `ask` does not hold memory back. `end()` deletes the
 * session's unanswered nonces (called when the MCP connection closes).
 */
export function createFolderGate(plur: Plur, opts: { sessionId?: string } = {}): {
  sessionId: string
  /**
   * The off answer, the folder question, or — every folder decided `on` — the
   * folder map's write scope for the workspace (the first folder that has
   * one), for plur_session_start's default.
   */
  check(dirs: string[]): FolderOffAnswer | FolderAskPayload | FolderOn
  end(): void
} {
  const sessionId = opts.sessionId ?? `mcp-${randomBytes(8).toString('hex')}`
  /** The question built for a workspace folder, by that folder, while it is undecided. */
  const asked = new Map<string, { ask: FolderAsk; issuedAt: number }>()
  const notNow = new Set<string>()
  // Re-issue a minute before core would call the nonces expired.
  const reissueAfter = Math.max(0, FOLDER_NONCE_TTL_MS - 60_000)

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

  const askFor = (dir: string, policy: ReturnType<Plur['resolveFolderPolicy']>): FolderOffAnswer | FolderAskPayload => {
    let entry = asked.get(dir)
    if (entry && !entry.ask.notice && Date.now() - entry.issuedAt > reissueAfter) {
      asked.delete(dir)
      entry = undefined
    }
    if (entry?.ask.notNowNonce !== undefined) {
      let open = false
      try { open = folderNonceOutstanding(plur.storageRoot, sessionId, entry.ask.notNowNonce) } catch { open = false }
      if (!open) {
        // The not-now nonce was consumed (or this session's nonces are gone):
        // off for the rest of the session, never the question again.
        log(`folder ${JSON.stringify(entry.ask.folder)}: the user answered "not now"; memory tools do nothing for the rest of this session.`)
        notNow.add(dir)
        asked.delete(dir)
        return notNowAnswer(entry.ask.folder)
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
      entry = { ask, issuedAt: Date.now() }
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
    check(dirs) {
      const off = folderOffAnswer(plur, dirs)
      if (off) return off
      const on: Array<{ dir: string; scope?: string }> = []
      for (const dir of dirs) {
        if (isFilesystemRoot(dir)) continue
        let policy: ReturnType<Plur['resolveFolderPolicy']>
        try {
          policy = plur.resolveFolderPolicy(dir)
        } catch (err) {
          const why = `could not be applied to ${JSON.stringify(dir)} (${(err as Error)?.message ?? err})`
          log(`folder map: ${why}; memory tools do nothing.`)
          return unreadable(`${plur.storageRoot}/folders.yaml`, why)
        }
        if (policy.mode === 'ask') {
          if (notNow.has(dir)) return notNowAnswer(asked.get(dir)?.ask.folder ?? dir)
          return askFor(dir, policy)
        }
        on.push({ dir, ...(policy.scope ? { scope: policy.scope } : {}) })
      }
      // Every folder is decided. A folder this session asked about and the
      // user answered "yes" for: its scope becomes the session's default
      // write scope, unless something already set one. (plur_session_start
      // gets the workspace scope through FOLDER_SCOPE as well.)
      for (const { dir, scope } of on) {
        if (!asked.has(dir)) continue
        asked.delete(dir)
        notNow.delete(dir)
        if (scope) {
          try {
            if (plur.getSessionScope() == null) plur.setSessionScope(scope)
          } catch { /* the scope is a default, never a reason to fail the call */ }
        }
      }
      const scope = on.find(o => o.scope)?.scope
      return { plur: 'on', ...(scope ? { scope } : {}) }
    },
    end() {
      asked.clear()
      try { endFolderNonceSession(plur.storageRoot, sessionId) } catch { /* best-effort */ }
    },
  }
}
