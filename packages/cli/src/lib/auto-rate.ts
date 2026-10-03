import {
  appendFileSync, readFileSync, openSync, fstatSync, readSync, closeSync, existsSync,
  writeSync, renameSync, unlinkSync, statSync, readdirSync,
} from 'fs'
import { join, dirname, basename } from 'path'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import {
  rateInjectedEngrams,
  extractSelfReportedLearnings,
  findProjectConfigPath,
  readProjectConfigFromPath,
  bareEngramId,
  FEEDBACK_SOURCE_CAPABILITY,
  type RatedEngram,
} from '@plur-ai/core'
import { createPlur, type GlobalFlags } from '../plur.js'
import { safeSessionKey } from './session-key.js'
import { ensureSessionDir, sessionDirSafeToSweep, cleanupStaleSessionFiles } from './codex-hook-io.js'

/**
 * Automatic rating of injected engrams at the end of a turn (#1310), shared by
 * every editor's end-of-turn hook (`plur hook-auto-rate --editor <name>`).
 *
 * Two halves:
 *
 * 1. The inject hooks call {@link recordInjected} with the ids they injected,
 *    keyed by (editor, the editor's own session id). Only ids are stored —
 *    never engram text — in a vetted per-user directory (the same checks the
 *    Codex/Cursor/Antigravity session dirs get, #1060).
 * 2. The end-of-turn hook calls {@link autoRateTurn} with the reply text. Ids
 *    injected this session and not yet rated are loaded, rated against the
 *    reply by core's `rateInjectedEngrams`, and every verdict at or above 0.6
 *    is sent as `source: 'auto'` feedback — ranking only, never commitment.
 *    Each engram gets at most one automatic verdict per session: a rated id is
 *    recorded and not rated again, so one engram quoted in every reply of a
 *    long session is not pushed up on every turn.
 *
 * Fast path: when nothing was injected this session (or everything injected
 * has been rated) and auto-capture is off, no store is opened at all — the
 * cost is one small file read.
 *
 * The hook never does the store work itself (#1318 audit M1). It appends the
 * turn to a per-session queue and hands it to a detached background worker
 * (`plur hook-auto-rate --worker`), then returns. On a large store the store
 * work takes seconds to tens of seconds of synchronous YAML parsing and
 * writing; done inside the hook it overran the editor's budget, was killed
 * part-way, and could leave the store lock behind. The worker is not bound
 * by the editor's timeout, runs one at a time per session, and never exits
 * while a store write is in flight.
 *
 * At most one verdict per engram per session: an id is recorded as rated
 * BEFORE its feedback is applied (write-ahead). A worker killed between the
 * two loses that one signal; it can never apply it twice.
 *
 * Switches (environment, the same convention as PLUR_REMOTE_RECALL):
 *   PLUR_AUTO_RATE=0|false|off   turns automatic rating off (on by default)
 *   PLUR_AUTO_CAPTURE=1|true|on  turns automatic capture on (off by default)
 */

export type AutoRateEditor = 'claude' | 'codex' | 'cursor' | 'agy'

const DIR = join(tmpdir(), 'plur-auto-rate')

/** Test seam — where the per-session id lists live. */
export function autoRateDir(): string {
  return DIR
}

export function autoRateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.PLUR_AUTO_RATE ?? '').trim().toLowerCase()
  return !(v === '0' || v === 'false' || v === 'off')
}

export function autoCaptureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.PLUR_AUTO_CAPTURE ?? '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'on'
}

/**
 * How many end-of-turn replies an injected engram is checked against before
 * it is settled without a verdict (#1318 review). Without a cap, an engram
 * the reply never mentions stays pending all session and every turn's hook
 * opens the store; with it, the fast path returns after this many turns.
 */
export const AUTO_RATE_MAX_TURNS = 3

/**
 * Server time for ALL the team saves of one hook run together — every
 * statement of every turn the run drains (#1532 review F3, re-audit R4, S5). Well inside the inline watchdog
 * (hook-auto-rate, 9 s): every save must have reached the server or fallen
 * through to the outbox before the watchdog can exit. One budget for the run,
 * not one per statement — three statements at 3 s each already passed the
 * watchdog. Once it is spent, the remaining statements go straight to the
 * outbox (a minimal deadline aborts their request at once).
 */
export const AUTO_CAPTURE_REMOTE_TIMEOUT_MS = 4_000
/** Floor for a statement's deadline once the run's budget is spent. */
const AUTO_CAPTURE_SPENT_MS = 1

function fileFor(editor: AutoRateEditor, sessionId: string, kind: 'injected' | 'rated' | 'tries' | 'queue' | 'worker'): string {
  return join(DIR, `${editor}-${safeSessionKey(sessionId)}.${kind}`)
}

function readIds(path: string): string[] {
  try {
    return readFileSync(path, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * One id per line, appended: each line is far below PIPE_BUF, so concurrent
 * hooks (Claude Code runs async hooks in parallel) cannot tear each other's
 * writes. Fail-open: a hook must never break because this bookkeeping could
 * not be written — the only cost is that the turn is not rated.
 */
function appendIds(path: string, ids: string[]): boolean {
  if (ids.length === 0) return true
  if (!ensureSessionDir(DIR)) return false
  try {
    appendFileSync(path, ids.join('\n') + '\n', { mode: 0o600 })
    return true
  } catch {
    // Fail-open for the hook — but the caller learns the record did not land.
    // For the write-ahead "rated" record that decides whether the verdict may
    // be applied at all (decision H2).
    return false
  }
}

/** Record the ids an inject hook just delivered for this editor session. */
export function recordInjected(editor: AutoRateEditor, sessionId: unknown, ids: unknown): void {
  try {
    if (!autoRateEnabled()) return
    if (typeof sessionId !== 'string' || !sessionId) return
    if (!Array.isArray(ids)) return
    const clean = ids.filter((id): id is string => typeof id === 'string' && id.length > 0 && !/\s/.test(id))
    appendIds(fileFor(editor, sessionId, 'injected'), clean)
  } catch { /* fail-open */ }
}

/**
 * Ids injected in this session that have neither had an automatic verdict
 * nor been checked against {@link AUTO_RATE_MAX_TURNS} replies already.
 */
export function pendingInjected(editor: AutoRateEditor, sessionId: string): string[] {
  const rated = new Set(readIds(fileFor(editor, sessionId, 'rated')))
  const tries = new Map<string, number>()
  for (const id of readIds(fileFor(editor, sessionId, 'tries'))) tries.set(id, (tries.get(id) ?? 0) + 1)
  return [...new Set(readIds(fileFor(editor, sessionId, 'injected')))]
    .filter(id => !rated.has(id) && (tries.get(id) ?? 0) < AUTO_RATE_MAX_TURNS)
}

export interface AutoRateOutcome {
  /** Verdicts that were applied. */
  rated: RatedEngram[]
  /** Statements written by auto-capture (0 unless PLUR_AUTO_CAPTURE opts in). */
  captured: number
}

interface QueuedTurn {
  reply: string
  cwd?: string
  /**
   * The scope already decided for the whole workspace (Cursor, audit M1 of
   * #1583): a string, or null for no scope. Absent (other editors, and lines
   * queued by an older version): decided from `cwd` alone, as before.
   */
  workspaceScope?: string | null
}

/**
 * Hook side: queue this turn for the background worker. Returns false (and
 * writes nothing) when there is nothing to do — nothing pending, capture off.
 * Cheap: a couple of small file reads and one append.
 */
export function enqueueTurn(opts: { editor: AutoRateEditor; sessionId: string; reply: string; cwd?: string; workspaceScope?: string | null }): boolean {
  try {
    const reply = typeof opts.reply === 'string' ? opts.reply : ''
    if (!reply.trim() || !opts.sessionId) return false
    const pending = autoRateEnabled() ? pendingInjected(opts.editor, opts.sessionId) : []
    if (pending.length === 0 && !autoCaptureEnabled()) return false
    if (!ensureSessionDir(DIR)) return false
    const line = JSON.stringify({
      reply,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.workspaceScope !== undefined ? { workspaceScope: opts.workspaceScope } : {}),
    } satisfies QueuedTurn) + '\n'
    appendFileSync(fileFor(opts.editor, opts.sessionId, 'queue'), line, { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/**
 * Hook side: did a killed worker leave a turn batch behind for this session?
 * If so the hook starts a worker even when it queued nothing itself, so the
 * leftovers are finished (write-ahead makes that safe) and cleaned up.
 */
export function hasLeftoverBatches(editor: AutoRateEditor, sessionId: string): boolean {
  try {
    const prefix = `${basename(fileFor(editor, sessionId, 'queue'))}.`
    return readdirSync(DIR).some(f => f.startsWith(prefix))
  } catch {
    return false
  }
}

/**
 * Hook side: start the background worker for this session, detached, so the
 * hook can exit at once. Returns false if it could not be started.
 */
export function spawnWorker(editor: AutoRateEditor, sessionId: string, flags: GlobalFlags): boolean {
  try {
    const entry = process.argv[1]
    if (!entry) return false
    const child = spawn(process.execPath, [
      ...process.execArgv, entry, 'hook-auto-rate', '--worker', editor, sessionId,
      ...(flags.path ? ['--path', flags.path] : []),
    ], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env })
    child.on('error', () => { /* fail-open: the queue stays for the next turn */ })
    child.unref()
    return true
  } catch {
    return false
  }
}

/** A worker lock older than this, or owned by a dead pid, is abandoned. */
const WORKER_STALE_MS = 15 * 60 * 1000

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM' }
}

/** This process's worker-lock token: pid first, so a reader can check liveness. */
const WORKER_TOKEN = `${process.pid}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`

/**
 * Take over a worker lock judged stale, atomically (decision H2). Mirrors
 * core's `stealLock` (store/async-lock.ts): CLAIM the file by renaming it to
 * a unique name — only one contender's rename can succeed — then check that
 * the claimed file is the one judged stale. If it is not (another contender
 * already took over, and this is now their live lock), put it back with an
 * exclusive create and report failure. A plain unlink here would delete a
 * lock another worker had created in the meantime — the pattern the formal
 * model refutes (`InjectLock.old_removes_live`).
 *
 * Returns true only when the stale lock judged by `expected` was removed.
 * Exported for tests.
 */
export function takeOverStaleWorkerLock(path: string, expected: string): boolean {
  const claim = `${path}.steal.${process.pid}.${Math.random().toString(36).slice(2, 10)}`
  try { renameSync(path, claim) } catch { return false }
  try {
    const current = readFileSync(claim, 'utf8')
    if (current === expected) {
      unlinkSync(claim)
      return true
    }
    // A live holder's lock. Put it back — never over a lock acquired since.
    try {
      const fd = openSync(path, 'wx', 0o600)
      try { writeSync(fd, current) } finally { closeSync(fd) }
    } catch { /* someone acquired meanwhile; theirs wins */ }
    try { unlinkSync(claim) } catch { /* best effort */ }
    return false
  } catch {
    try { unlinkSync(claim) } catch { /* never leave the claim behind */ }
    return false
  }
}

/** Exported for tests. Acquire this session's worker lock, taking over a stale one. */
export function acquireWorkerLock(path: string): boolean {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600)
      try { writeSync(fd, WORKER_TOKEN) } finally { closeSync(fd) }
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return false
      let observed: string
      let stale: boolean
      try {
        observed = readFileSync(path, 'utf8')
        const owner = parseInt(observed, 10)
        stale = !pidAlive(owner) || Date.now() - statSync(path).mtimeMs > WORKER_STALE_MS
      } catch {
        continue // released between the create and the read: try the create again
      }
      if (!stale) return false
      takeOverStaleWorkerLock(path, observed) // win or lose, the next create decides
    }
  }
  return false
}

/** Release the worker lock only if it is still ours. */
function releaseWorkerLock(path: string): void {
  try {
    if (readFileSync(path, 'utf8') === WORKER_TOKEN) unlinkSync(path)
  } catch { /* already gone */ }
}

/**
 * Worker side: drain this session's queue, one turn at a time. Only one
 * worker runs per session; a second one exits at once and leaves its turn
 * to the running worker, which re-checks the queue before it leaves.
 */
export async function runWorker(editor: AutoRateEditor, sessionId: string, flags: GlobalFlags): Promise<AutoRateOutcome> {
  const total: AutoRateOutcome = { rated: [], captured: 0 }
  if (!ensureSessionDir(DIR)) return total
  const lock = fileFor(editor, sessionId, 'worker')
  const queue = fileFor(editor, sessionId, 'queue')
  let plur: ReturnType<typeof createPlur> | null = null
  // Batches a killed worker renamed but never finished. Only ever read while
  // holding the lock, and the lock is only taken over from a dead or stale
  // owner, so no live worker is still working on them.
  // ONE server budget for every turn this run drains (#1532 re-audit 2, S5):
  // the inline fallback drains all queued turns under one 9 s watchdog.
  const captureDeadline = Date.now() + AUTO_CAPTURE_REMOTE_TIMEOUT_MS
  const orphans = (): string[] => {
    try {
      const prefix = `${basename(queue)}.`
      return readdirSync(DIR).filter(f => f.startsWith(prefix)).map(f => join(DIR, f))
    } catch { return [] }
  }
  for (let round = 0; round < 10 && (existsSync(queue) || orphans().length > 0); round++) {
    if (!acquireWorkerLock(lock)) break
    try {
      for (;;) {
        let batch = orphans()[0]
        if (!batch) {
          if (!existsSync(queue)) break
          batch = `${queue}.${process.pid}`
          try { renameSync(queue, batch) } catch { break }
        }
        let lines: string[] = []
        try { lines = readFileSync(batch, 'utf8').split('\n').filter(Boolean) } catch { /* empty */ }
        for (const line of lines) {
          let turn: QueuedTurn
          try { turn = JSON.parse(line) as QueuedTurn } catch { continue }
          plur ??= createPlur(flags)
          const out = await autoRateTurn({ editor, sessionId, reply: turn.reply, flags, cwd: turn.cwd, ...(turn.workspaceScope !== undefined ? { workspaceScope: turn.workspaceScope } : {}), plur, captureDeadline })
          total.rated.push(...out.rated)
          total.captured += out.captured
        }
        try { unlinkSync(batch) } catch { if (existsSync(batch)) break }
      }
    } finally {
      releaseWorkerLock(lock)
    }
    // A hook may have queued a turn between the last drain and the unlock;
    // it saw the lock held and did not start a worker. Take it too.
  }
  sweep()
  return total
}

/**
 * Rate this session's injected engrams against one reply, and — only when
 * opted in — capture the reply's self-reported learnings. Never throws.
 * The worker calls this; it is exported for tests.
 */
export async function autoRateTurn(opts: {
  editor: AutoRateEditor
  sessionId: string
  reply: string
  flags: GlobalFlags
  /** Project root for `.plur.yaml` scope/domain on captured learnings. */
  cwd?: string
  /**
   * The scope the hook already decided for the whole workspace (null: none).
   * When given, a capture never uses any other scope: the folder's own scope
   * is kept only when it is this one (audit M1 of #1583).
   */
  workspaceScope?: string | null
  /** Reuse an open store (the worker handles several turns with one). */
  plur?: ReturnType<typeof createPlur>
  /** When the run's capture budget ends (epoch ms); shared by every turn a worker drains. */
  captureDeadline?: number
}): Promise<AutoRateOutcome> {
  const outcome: AutoRateOutcome = { rated: [], captured: 0 }
  try {
    const reply = typeof opts.reply === 'string' ? opts.reply : ''
    if (!reply.trim() || !opts.sessionId) return outcome

    const pending = autoRateEnabled() ? pendingInjected(opts.editor, opts.sessionId) : []
    const capture = autoCaptureEnabled()
    if (pending.length === 0 && !capture) return outcome // nothing injected, nothing to do

    const plur = opts.plur ?? createPlur(opts.flags)

    if (pending.length > 0) {
      // Remote ids are fetched by id (the remote cache is empty in a fresh
      // process), and only from servers that advertise feedback.source —
      // a server that would not receive the verdict is never asked (#1318).
      const engrams = await plur.getByIds(pending, { remoteCapability: FEEDBACK_SOURCE_CAPABILITY })
      // One record can be injected under two ids — its own and a store-
      // namespaced alias (ENG-XYZ-…) when the same file is also mounted as a
      // secondary store. Rate each record once: same bare id and statement
      // means same engram, and rating both would count one reply twice.
      const seen = new Set<string>()
      const unique = engrams.filter(e => {
        const k = `${bareEngramId(e.id)}\u0000${e.statement}`
        if (seen.has(k)) return false
        seen.add(k)
        return true
      })
      const verdicts = rateInjectedEngrams(
        unique.map(e => ({ id: e.id, statement: e.statement })),
        reply,
      )
      const ratedFile = fileFor(opts.editor, opts.sessionId, 'rated')
      // Aliases skipped above, and ids that no longer exist anywhere, will
      // never be rated on their own; stop loading them.
      const kept = new Set(unique.map(e => e.id))
      appendIds(ratedFile, pending.filter(id => !kept.has(id)))
      // This reply counts as one of the turns each remaining engram gets.
      const withVerdict = new Set(verdicts.map(v => v.id))
      appendIds(fileFor(opts.editor, opts.sessionId, 'tries'), [...kept].filter(id => !withVerdict.has(id)))
      for (const v of verdicts) {
        // Write-ahead (#1318 audit F5/M1): recorded as rated BEFORE the
        // feedback is applied, so a kill between the two can lose this one
        // signal but can never apply it twice. And only if the record landed
        // (decision H2): a verdict whose record failed is skipped, because
        // nothing would stop the next turn from applying it again.
        if (!appendIds(ratedFile, [v.id])) {
          process.stderr.write(`[plur] auto-rate: ${v.id} skipped (could not record it as rated)\n`)
          continue
        }
        try {
          await plur.feedback(v.id, v.signal, undefined, { source: 'auto' })
          outcome.rated.push(v)
        } catch (err) {
          process.stderr.write(`[plur] auto-rate: ${v.id} not rated (${(err as Error)?.message ?? 'unknown'})\n`)
        }
      }
    }

    // `auto_learn: false` in config.yaml is the store-wide kill switch for
    // automatic writes (the opencode plugin honours it the same way).
    if (capture && (plur as unknown as { config?: { auto_learn?: boolean } }).config?.auto_learn !== false) {
      const statements = extractSelfReportedLearnings({ role: 'assistant', content: reply })
      if (statements.length > 0) {
        // Where captured text may go (#1318 audit, adversarial M3). This is an
        // unattended write of the agent's own reply text, so a repository must
        // not choose its destination. A scope is used only when the user set
        // it: a folder-map entry's scope (`plur folders`), or a `.plur.yaml`
        // scope/domain in a trusted folder (`plur trust`). Otherwise — and
        // whenever no scope applies — the statement goes to the local store
        // via `learn()`, which never routes, so it can never be auto-routed
        // into a shared scope either. A folder the map turns off gets nothing.
        const dir = opts.cwd ?? process.cwd()
        const policy = plur.resolveFolderPolicy(dir)
        const configPath = findProjectConfigPath(dir)
        const hint = configPath ? readProjectConfigFromPath(configPath) : {}
        const trusted = configPath !== null && plur.isDirectoryTrusted(dirname(configPath))
        const mapScope = policy.scope && policy.scope !== hint.scope ? policy.scope : undefined
        const own: { scope?: string; domain?: string } = policy.mode === 'off'
          ? {}
          : trusted
            ? { ...(policy.scope ? { scope: policy.scope } : {}), ...(hint.domain ? { domain: hint.domain } : {}) }
            : (mapScope ? { scope: mapScope } : {})
        // The workspace decision narrows, never widens: roots that disagree
        // (or one with no scope) mean no scope, whatever this one folder says.
        const project = opts.workspaceScope === undefined || own.scope === (opts.workspaceScope ?? undefined) ? own : {}
        if (policy.mode === 'off') statements.length = 0
        const base = {
          type: 'behavioral' as const,
          source: `${opts.editor}:auto-capture`,
          rationale: 'self-reported by the agent in its reply (auto-capture)',
          tags: ['auto-capture'],
          claim_class: 'inferred' as const,
        }
        const budgetEnd = opts.captureDeadline ?? Date.now() + AUTO_CAPTURE_REMOTE_TIMEOUT_MS
        for (const statement of statements) {
          try {
            if (project.scope) {
              // Bounded below the inline watchdog (#1532 review F3): the POST runs
              // outside the store lock, so to the watchdog the store looks idle
              // mid-request, and an exit there lost the statement. Past this
              // deadline it is saved here and queued in the outbox.
              await plur.learnRouted(
                statement,
                { ...base, scope: project.scope, ...(project.domain ? { domain: project.domain } : {}) },
                { remoteTimeoutMs: Math.max(AUTO_CAPTURE_SPENT_MS, budgetEnd - Date.now()) },
              )
            } else {
              await plur.learn(statement, base)
            }
            outcome.captured++
          } catch (err) {
            process.stderr.write(`[plur] auto-capture: not stored (${(err as Error)?.message ?? 'unknown'})\n`)
          }
        }
      }
    }
  } catch (err) {
    process.stderr.write(`[plur] auto-rate failed: ${(err as Error)?.message ?? 'unknown'}\n`)
  }
  return outcome
}

let swept = false
function sweep(): void {
  if (swept) return
  swept = true
  if (sessionDirSafeToSweep(DIR)) cleanupStaleSessionFiles(Date.now(), DIR)
}

/**
 * Antigravity's Stop payload carries no reply text, so read it from the
 * transcript the payload points at: every MODEL `PLANNER_RESPONSE` step with
 * text content after the last USER_INPUT step, joined. Format observed on
 * agy 1.1.22; like `lastUserInput`, any read or parse failure is "no reply",
 * never an error. Reads at most the trailing 4MB.
 */
export function agyReplySinceLastUser(transcriptPath: string): string {
  const CAP = 4 * 1024 * 1024
  let raw = ''
  try {
    if (!transcriptPath || !existsSync(transcriptPath)) return ''
    const fd = openSync(transcriptPath, 'r')
    try {
      const size = fstatSync(fd).size
      const len = Math.min(size, CAP)
      const buf = Buffer.alloc(len)
      const n = readSync(fd, buf, 0, len, size - len)
      raw = buf.subarray(0, n).toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
  let parts: string[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const d = JSON.parse(line) as { type?: string; source?: string; content?: unknown }
      if (d.type === 'USER_INPUT') { parts = []; continue }
      if (d.source === 'MODEL' && d.type === 'PLANNER_RESPONSE' && typeof d.content === 'string' && d.content.trim()) {
        parts.push(d.content)
      }
    } catch { /* torn line — skip */ }
  }
  return parts.join('\n')
}
