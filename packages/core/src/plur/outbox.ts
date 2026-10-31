import { randomUUID } from 'crypto'
import * as fs from 'fs'
import { hostname } from 'os'
import { basename, dirname, join } from 'path'
import { Plur } from '../index.js'
import { logger } from '../logger.js'
import { classifyOutboxFailure, credentialChanged, NEEDS_ACTION_RETRY_MS, NEEDS_ACTION_STATUSES, OUTBOX_CLAIM_ERROR_PREFIX, statusFromErrorText, summarizeOutbox, type OutboxState, type OutboxSummary } from '../outbox-health.js'
import { orderBySupersedes } from '../outbox-order.js'
import { isRemoteOnlyQueued } from '../remote-only-rows.js'
import {
    isHostInCooldown, recordWriteOutcome,
    tokenHealthKey
} from '../remote-recall.js'
import type { StoreEntry } from '../schemas/config.js'
import type { Engram } from '../schemas/engram.js'
import { resolveScopeTarget, urlGroupsForScope } from '../store-resolver.js'
import { normalizeEndpointUrl, RemoteAbortedError, RemoteHttpError } from '../store/remote-store.js'
import { YamlPrimaryStore } from '../store/yaml-primary-store.js'
import { getSyncStatus, sync as gitSync, type SyncRemoteType, type SyncResult, type SyncStatus } from '../sync.js'
import type { UploadLocalResult } from '../types.js'
import { OUTBOX_CLAIM_LEASE_MS, OUTBOX_CLAIM_MAX_AGE_MS, OUTBOX_ID_MAP_MAX, OUTBOX_TAKEOVER_MAX_DEPTH, outboxClaimTag, pidAlive, queuedOutboxKeys } from './helpers.js'

export interface OutboxMethods {
  /** Where breaker/cooldown/unsupported state persists across processes.
   *  Inside the store root so tests and PLUR_PATH overrides isolate it. */
  remoteHealthStatePath(): string

  /**
   * Where local→server id mappings survive between outbox flushes, so a correction pushed after its target's flush
   * (whose local row was spliced out) can still resolve its supersedes edge.
   * Derived state, not truth: losing it costs at most an edge, never an engram, so all access is best-effort.
   */
  outboxIdMapPath(): string

  /**
   * Per-entry push claims: the one duplicate-push guard. A
   * claim is a small file created with O_EXCL, so two writers — two flushes,
   * or a flush and learn()'s background push, in one process or several —
   * cannot both push an entry at once. It is released once the push's outcome
   * is recorded (or the flush ends); a claim left by a process that died is
   * taken over (see `_claimOutboxEntry`), and the write is simply retried with
   * the key already on its outbox row. A claim guards the row,
   * not a snapshot: whoever takes it re-reads the row before pushing.
   */
  outboxClaimsDir(): string

  /** @internal */
  _outboxClaimPath(id: string): string

  /**
   * Take the claim on an outbox entry (`busy` if a live writer holds it; lapsed claims are taken over). Every
   * decision is made by O_EXCL, never read-compare-rename:
   * - Free: publish a fully written claim with `link(2)`.
   * - Lapsed: one racer creates `<claim>.takeover-<tag>`, re-reads, renames a fresh claim over it, removes the
   *   marker. A dead marker is stepped past at once (`…-<tag>-<tag>`) but removed only after the stale claim
   *   changed hands, so two racers never win at two levels. Cleanup after the decision never changes it.
   * Fails CLOSED and never throws: an unrecordable claim is `busy` with the error, never `claimed`, because an
   * unrecorded claim would let two processes push the same engram.
   */
  /** @internal */
  _claimOutboxEntry(id: string, keyFor: () => string): { status: 'busy'; error?: string } | { status: 'claimed'; key: string }

  /**
   * Is this claim still held by a live writer?
   * - Owner on this host: held while its process lives, however long the push runs (not bounded by the lease, so a
   *   slow server cannot cause a re-push), up to {@link OUTBOX_CLAIM_MAX_AGE_MS} against pid reuse.
   * - Owner on another host: the lease decides. A timestamp implausibly far ahead is clock skew, not liveness.
   */
  /** @internal */
  _outboxClaimHeld(held: { pid?: number; host?: string; until?: number; at?: number }, now: number): boolean

  /**
   * When the live claim on `id` lapses, as an ISO time; undefined when there is
   * no live claim. Read from the claim file alone and judged by
   * the same rule as `_claimOutboxEntry`. Advisory: nothing is held back by it.
   */
  /** @internal */
  _outboxClaimUntil(id: string, now: number): string | undefined

  /**
   * Release a claim this process holds. Never throws.
   *
   * Also clears takeover markers left by a racer that died after its rename
   * but before its cleanup. Only markers guarding a claim that is no longer in
   * place (their tag differs from the current claim's) are removed: a racer
   * that re-creates one then fails its re-read, so this cannot make a second
   * winner.
   */
  /** @internal */
  _releaseOutboxClaim(id: string): void

  /** Read the persisted local→server map. Never throws; `{}` on any problem. */
  /** @internal */
  _readOutboxIdMap(): Record<string, { server_id: string; url: string; at: number }>

  /**
   * Persist local→server mappings recorded during a flush. Never throws.
   *
   * Bounded at {@link OUTBOX_ID_MAP_MAX} entries, oldest dropped first: this
   * grows by one row per remote write forever otherwise, and an unbounded
   * cache file in the store root is its own defect. Dropping the oldest is
   * safe because the edges that need it are queued corrections, which are
   * resolved within a flush or two of the target.
   */
  /** @internal */
  _writeOutboxIdMap(entries: Record<string, { server_id: string; url: string; at: number }>): void

  /**
   * Sync engrams to git AND refresh the derived index from YAML.
   *
   * Behavior:
   *   - default: git push/pull + incremental syncFromYaml on the active index
   *   - { full: true }: git push/pull + drop-and-rebuild the index from YAML
   *
   * The `--full` mode is the recovery path for "the index is wrong" — it
   * deletes every row in the derived index and replays YAML. YAML is never
   * touched in either mode.
   */
  sync(remote?: string, options?: { full?: boolean; remoteType?: SyncRemoteType }): Promise<SyncResult>

  /** Get git sync status without making changes. */
  syncStatus(): SyncStatus

  /** Count engrams pending remote sync (outbox entries). Must mirror
   *  flushOutbox()'s filter exactly: a retired engram still carrying `_outbox`
   *  (direct YAML edit, older client) is skipped by the flush forever, so
   *  counting it would report a permanent phantom "pending". */
  outboxCount(): Promise<number>

  /**
   * The outbox (`structured_data._outbox` inside engrams in `engrams.yaml`) as inspectable entries.
   * `target_url` is DELIBERATELY not returned: it identifies a credentialed endpoint and these entries reach agent
   * context and CLI output; `target_scope` answers "which store is behind?".
   */
  listOutbox(): Promise<Array<{
    id: string
    /** `push`: a write waiting to reach its store (`_outbox`). `retire`: a
     *  queued DELETE of a copy the remote accepted after a forget/rescope
     *  cancelled its delivery (`_retireRemote`), listed so a
     *  stuck retirement is visible, not reported as an empty outbox. */
    kind: 'push' | 'retire'
    target_scope: string
    queued_at: string
    attempt_count: number
    last_error?: string
    /** HTTP status of the last failed push, when the remote gave one. */
    last_status?: number
    age_days: number
    /**
     * `retrying` — the next flush may succeed; `needs_action` — it
     * cannot (401/403/404/422, a write refusal, no writable store).
     */
    state: OutboxState
    /** One line, `needs_action` only: why retrying will not help. */
    reason?: string
    /** One line, `needs_action` only: what would. */
    next_step?: string
    /** `needs_action` only: the earliest time an automatic flush retries it. */
    next_retry_at?: string
    /** Advisory: set while a writer holds the entry's live
     *  per-entry claim — any process's, THIS instance's own in-progress flush
     *  or learn() push included: the row is not stuck, it is being delivered,
     *  until this time. Read from the claim file alone. Only the expiry is
     *  reported — the holder names a process. */
    leased_until?: string
  }>>

  /**
   * Why the push-claims folder cannot be written, or undefined when it can.
   * A claim that cannot be recorded holds every queued
   * write on this machine, so doctor reports it. Creates the folder when
   * missing (it is PLUR's own cache), and writes nothing else.
   */
  outboxClaimsProblem(): string | undefined

  /** Counts by state plus one line per needs_action scope. */
  outboxSummary(): Promise<OutboxSummary>

  /** A url store accepting writes for exactly this scope — the flush's own lookup. */
  /** @internal */
  _hasWritableStoreFor(scope: string): boolean

  /**
   * When an automatic flush may next dial a `needs_action` entry:
   * one attempt per NEEDS_ACTION_RETRY_MS, counted from the last attempt.
   * An entry with no readable last attempt is due now.
   */
  /** @internal */
  _needsActionRetryAt(ob: { last_attempt?: string }): number | undefined

  /**
   * Flush the outbox — retry pushing pending engrams to their remote stores (runs on session_start and plur_sync).
   * Success removes the local copy; failure updates attempt metadata; after 7 days a warning is reported.
   *
   * - `timeoutMs` bounds only the network part; undelivered entries count in `deferred`, stay queued, and are not a
   *   strike against the host. The merge-back afterwards always runs to completion.
   * - Retries are safe by the idempotency key: a UUID persisted on the row BEFORE the first POST and sent every
   *   time (docs/remote-store-contract.md). Each entry is claimed before push; claims are released when the flush ends.
   * - `skipped`: host circuit breaker open. `held`: `needs_action` entries (401/403/404/422, write refusal) retried at
   *   most once per NEEDS_ACTION_RETRY_MS unless `force: true`. Nothing is dropped or rescoped for `needs_action`.
   */
  flushOutbox(options?: { timeoutMs?: number; force?: boolean }): Promise<{ flushed: number; failed: number; deferred: number; held: number; skipped: number; expired_warnings: string[] }>

  /** @internal */
  _runOutboxFlush(options: { timeoutMs?: number; force?: boolean }, upload?: { ids: Set<string>; results: Map<string, UploadLocalResult> }): Promise<{ flushed: number; failed: number; deferred: number; held: number; skipped: number; expired_warnings: string[] }>

  /** @internal */
  _flushOutboxClaimed(claimed: Set<string>, budget: AbortSignal, force: boolean, startBudget: () => void, entryClaims: Set<string>, upload?: { ids: Set<string>; results: Map<string, UploadLocalResult> }): Promise<{ flushed: number; failed: number; deferred: number; held: number; skipped: number; expired_warnings: string[] }>

  /**
   * Identity of the YAML store file's current contents (inode, size, mtime in
   * ns): any write changes it. `undefined` when the primary store is not the
   * default YAML file, or it cannot be stat'ed — the caller then reads.
   */
  /** @internal */
  _engramsFileStamp(): string | undefined

  /**
   * Is this outbox row still queued, under this key, in the store as it is NOW? False if gone, retired, requeued
   * under another key, or the store cannot be read (skipping costs a flush; pushing blind can duplicate).
   * `seen` caches the newest read with its file stamp; an unchanged stamp skips reloading. Embedder-supplied stores
   * have no stamp and are read every time.
   */
  /** @internal */
  _outboxRowStillQueued(id: string, key: string, seen: { stamp: string | undefined; keys: Map<string, string | undefined> }): Promise<boolean>

  /**
   * Mint and persist an idempotency key for every pending outbox row that has
   * none (rows queued by clients that predate keys), BEFORE any is posted.
   * Under the store lock; a row another writer keyed in the
   * meantime keeps that key. Updates `pending` in place. Never throws: a row
   * whose key could not be saved stays keyless and is not posted this flush.
   */
  /** @internal */
  _persistMissingOutboxKeys(pending: Engram[]): Promise<void>
}

export const outboxMethods: OutboxMethods & ThisType<Plur> = {
  remoteHealthStatePath(): string {
    return join(this.paths.root, 'cache', 'remote-health.json')
  },

  outboxIdMapPath(): string {
    return join(this.paths.root, 'cache', 'outbox-id-map.json')
  },

  outboxClaimsDir(): string {
    return join(this.paths.root, 'cache', 'outbox-claims')
  },

  _outboxClaimPath(id: string): string {
    return join(this.outboxClaimsDir(), `${id.replace(/[^\w.-]/g, '_')}.json`)
  },

  _claimOutboxEntry(id: string, keyFor: () => string): { status: 'busy'; error?: string } | { status: 'claimed'; key: string } {
    const path = this._outboxClaimPath(id)
    const readRaw = (at: string): string | undefined => {
      try { return fs.readFileSync(at, 'utf8') } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw err
      }
    }
    /** Cleanup after the outcome is decided: it never changes the outcome. */
    const removeQuietly = (at: string): void => {
      try { fs.rmSync(at, { force: true }) } catch (err) {
        logger.warning(`[plur:outbox] could not remove ${at}: ${(err as Error).message}`)
      }
    }
    const heldBy = (raw: string, file: string): boolean => {
      let held: { pid?: number; host?: string; until?: number; at?: number }
      try { held = JSON.parse(raw) } catch {
        // Empty or half-written: without hard links a claim
        // is created and then written, two steps, so a racer can read it in
        // between. Unreadable counts as live while it is younger than the
        // lease, and as lapsed after (its writer died mid-write).
        try { return Date.now() - fs.statSync(file).mtimeMs < OUTBOX_CLAIM_LEASE_MS } catch { return false }
      }
      return this._outboxClaimHeld(held ?? {}, Date.now())
    }
    /** Create `target` holding `body` only if nothing is there (O_EXCL). */
    const publishExclusive = (target: string, body: string): boolean => {
      const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`
      try {
        // Inside the try: a temp file written part-way (disk full) is
        // removed too.
        fs.writeFileSync(tmp, body)
        fs.linkSync(tmp, target)
        return true
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'EEXIST') return false
        // A filesystem without hard links: O_EXCL on open instead.
        if (code === 'EPERM' || code === 'ENOTSUP' || code === 'ENOSYS') {
          try { fs.writeFileSync(target, body, { flag: 'wx' }); return true } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false
            throw e
          }
        }
        throw err
      } finally {
        removeQuietly(tmp)
      }
    }
    try {
      fs.mkdirSync(this.outboxClaimsDir(), { recursive: true })
      const stale = readRaw(path)
      if (stale !== undefined && heldBy(stale, path)) return { status: 'busy' }
      const key = keyFor()
      const token = randomUUID()
      const at = Date.now()
      const owner = { token, pid: process.pid, host: hostname(), at, until: at + OUTBOX_CLAIM_LEASE_MS }
      const body = JSON.stringify({ key, ...owner })
      if (stale === undefined) {
        if (!publishExclusive(path, body)) return { status: 'busy' } // someone else got it first
        this._outboxClaimTokens.set(id, token)
        return { status: 'claimed', key }
      }

      // Takeover: win the marker for this exact stale claim.
      const passed: string[] = []
      let marker = `${path}.takeover-${outboxClaimTag(stale)}`
      let won = false
      for (let depth = 0; depth < OUTBOX_TAKEOVER_MAX_DEPTH; depth++) {
        if (publishExclusive(marker, JSON.stringify(owner))) { won = true; break }
        const m = readRaw(marker)
        // Gone means its holder finished: the claim has changed hands.
        if (m === undefined || heldBy(m, marker)) return { status: 'busy' }
        passed.push(marker)
        marker = `${marker}-${outboxClaimTag(m)}`
      }
      if (!won) return { status: 'busy' }
      let changedHands = false
      try {
        // Under the marker: is it still the claim we judged stale?
        if (readRaw(path) !== stale) { changedHands = true; return { status: 'busy' } }
        const tmp = `${path}.${process.pid}.${token}.tmp`
        try {
          fs.writeFileSync(tmp, body)
          fs.renameSync(tmp, path)
        } catch (err) {
          // Not renamed: the stale claim is still in place. Remove the temp file.
          removeQuietly(tmp)
          throw err
        }
        changedHands = true
        this._outboxClaimTokens.set(id, token)
        return { status: 'claimed', key }
      } finally {
        // Best effort: the claim is already decided. A marker
        // that cannot be removed now is dead once we exit, and is judged and
        // replaced by the same liveness rule as any dead marker.
        removeQuietly(marker)
        // The dead markers we walked past are cleared only once the stale
        // claim they guard is gone. Before that, clearing one would let a
        // second racer win a level we already passed.
        if (changedHands) for (const p of passed) removeQuietly(p)
      }
    } catch (err) {
      const error = (err as Error).message
      logger.warning(`[plur:outbox] could not record a push claim for ${id}: ${error}. Not pushed now; it stays queued for the next flush.`)
      return { status: 'busy', error }
    }
  },

  _outboxClaimHeld(held: { pid?: number; host?: string; until?: number; at?: number }, now: number): boolean {
    if (held.host === hostname()) {
      if (typeof held.pid !== 'number' || !pidAlive(held.pid)) return false
      const at = typeof held.at === 'number'
        ? held.at
        : typeof held.until === 'number' ? held.until - OUTBOX_CLAIM_LEASE_MS : undefined
      if (at === undefined) return false
      const age = now - at
      return age >= -OUTBOX_CLAIM_LEASE_MS && age < OUTBOX_CLAIM_MAX_AGE_MS
    }
    return typeof held.until === 'number' && held.until > now
      && held.until - now <= 2 * OUTBOX_CLAIM_LEASE_MS
  },

  _outboxClaimUntil(id: string, now: number): string | undefined {
    try {
      const held = JSON.parse(fs.readFileSync(this._outboxClaimPath(id), 'utf8')) as { pid?: number; host?: string; until?: number; at?: number }
      if (!this._outboxClaimHeld(held, now) || typeof held.until !== 'number') return undefined
      return new Date(held.until).toISOString()
    } catch { return undefined }
  },

  _releaseOutboxClaim(id: string): void {
    const path = this._outboxClaimPath(id)
    const token = this._outboxClaimTokens.get(id)
    this._outboxClaimTokens.delete(id)
    try {
      const held = JSON.parse(fs.readFileSync(path, 'utf8')) as { pid?: number; host?: string; token?: string }
      // Only the writer that took this claim releases it: its token, not just
      // its pid. Two Plur instances in one process share a pid; one that never
      // took the claim holds no token and must not remove the other's.
      if (token !== undefined && held.token === token && held.pid === process.pid && held.host === hostname()) {
        fs.rmSync(path, { force: true })
      }
    } catch { /* already gone */ }
    try {
      let current: string | undefined
      try { current = outboxClaimTag(fs.readFileSync(path, 'utf8')) } catch { /* no claim now */ }
      const prefix = `${basename(path)}.takeover-`
      for (const f of fs.readdirSync(this.outboxClaimsDir())) {
        if (!f.startsWith(prefix) || f.endsWith('.tmp')) continue
        if (f.slice(prefix.length).split('-')[0] !== current) fs.rmSync(join(this.outboxClaimsDir(), f), { force: true })
      }
    } catch { /* best effort */ }
  },

  _readOutboxIdMap(): Record<string, { server_id: string; url: string; at: number }> {
    try {
      const raw = JSON.parse(fs.readFileSync(this.outboxIdMapPath(), 'utf8')) as unknown
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        return raw as Record<string, { server_id: string; url: string; at: number }>
      }
    } catch { /* absent or corrupt — a cache miss, not an error */ }
    return {}
  },

  _writeOutboxIdMap(entries: Record<string, { server_id: string; url: string; at: number }>): void {
    try {
      const ids = Object.keys(entries)
      if (ids.length > OUTBOX_ID_MAP_MAX) {
        const keep = ids
          .sort((a, b) => (entries[b].at ?? 0) - (entries[a].at ?? 0))
          .slice(0, OUTBOX_ID_MAP_MAX)
        const trimmed: typeof entries = {}
        for (const id of keep) trimmed[id] = entries[id]
        entries = trimmed
      }
      fs.mkdirSync(dirname(this.outboxIdMapPath()), { recursive: true })
      fs.writeFileSync(this.outboxIdMapPath(), JSON.stringify(entries), 'utf8')
    } catch { /* derived state — a failed write must never fail a flush */ }
  },

  async sync(remote?: string, options?: { full?: boolean; remoteType?: SyncRemoteType }): Promise<SyncResult> {
    this._remoteOnlyRefuseLocalStore('Syncing the store (run it outside the remote-only folder)')
    // Explicit option > config.sync.remote_type > 'personal' (mirror
    // everything; `shared` is an explicit opt-in that filters the push set to
    // shared-scope, non-private engrams).
    const remoteType = options?.remoteType ?? this.config.sync?.remote_type ?? 'personal'
    // Git sync REPLACES engrams.yaml, so it must hold the store lock: otherwise a writer holding a stale corpus can
    // save over a pulled engram with an unchanged count, the shrink guard passes, and the next sync pushes the
    // deletion. Held across network calls deliberately (a delay beats a lost engram); gitSync takes no lock itself.
    // CALLER CONTRACT: do NOT call `sync()` from inside `_withStoreLock` — the in-process lock is not reentrant and
    // has no timeout, so nesting hangs.
    const result = await this._withStoreLock(this.paths.engrams, async () => {
      return gitSync(this.paths.root, remote, { remoteType })
    })
    // `git pull --rebase` may have REPLACED engrams.yaml underneath us, so any
    // cached snapshot the store is holding now describes a file that no longer
    // exists in that form. This is the one place where the bytes change
    // without going through `save()`, so the cache must be invalidated here.
    this._primaryStore.invalidate()
    for (const store of this._secondaryStores.values()) store.invalidate()
    // After git pull, YAML may have changed — refresh the index.
    // PGLite path is the only backend that honors --full directly here; the
    // legacy SQLite path also reindexes on full, otherwise calls syncFromYaml.
    if (options?.full) {
      await this.reindex()
    } else {
      await this._syncIndex()
    }
    return result
  },

  syncStatus(): SyncStatus {
    return getSyncStatus(this.paths.root)
  },

  async outboxCount(): Promise<number> {
    // Same entries as `listOutbox()` (pushes AND queued remote retirements),
    // so the count and the list cannot disagree.
    return (await this.listOutbox()).length
  },

  async listOutbox(): Promise<Array<{
    id: string
    /** `push`: a write waiting to reach its store (`_outbox`). `retire`: a
     *  queued DELETE of a copy the remote accepted after a forget/rescope
     *  cancelled its delivery (`_retireRemote`), listed so a
     *  stuck retirement is visible, not reported as an empty outbox. */
    kind: 'push' | 'retire'
    target_scope: string
    queued_at: string
    attempt_count: number
    last_error?: string
    /** HTTP status of the last failed push, when the remote gave one. */
    last_status?: number
    age_days: number
    /**
     * `retrying` — the next flush may succeed; `needs_action` — it
     * cannot (401/403/404/422, a write refusal, no writable store).
     */
    state: OutboxState
    /** One line, `needs_action` only: why retrying will not help. */
    reason?: string
    /** One line, `needs_action` only: what would. */
    next_step?: string
    /** `needs_action` only: the earliest time an automatic flush retries it. */
    next_retry_at?: string
    /** Advisory: set while a writer holds the entry's live
     *  per-entry claim — any process's, THIS instance's own in-progress flush
     *  or learn() push included: the row is not stuck, it is being delivered,
     *  until this time. Read from the claim file alone. Only the expiry is
     *  reported — the holder names a process. */
    leased_until?: string
  }>> {
    const engrams = await this._loadCached(this.paths.engrams)
    const now = Date.now()
    const out = []
    type Entry = {
      target_scope?: string; queued_at?: string; attempt_count?: number; last_error?: string
      last_status?: unknown; last_attempt?: string
    }
    const toEntry = (id: string, kind: 'push' | 'retire', ob: Entry) => {
      const queued_at = typeof ob.queued_at === 'string' ? ob.queued_at : ''
      const queuedMs = queued_at ? Date.parse(queued_at) : NaN
      const target_scope = ob.target_scope ?? '(unknown)'
      const last_status = typeof ob.last_status === 'number' ? ob.last_status : undefined
      const verdict = classifyOutboxFailure({
        last_status,
        last_error: ob.last_error,
        has_store: this._hasWritableStoreFor(target_scope),
        scope: target_scope,
      })
      const nextRetry = verdict.state === 'needs_action' ? this._needsActionRetryAt(ob) : undefined
      return {
        id,
        kind,
        target_scope,
        queued_at,
        attempt_count: typeof ob.attempt_count === 'number' ? ob.attempt_count : 0,
        ...(ob.last_error ? { last_error: ob.last_error } : {}),
        ...(last_status !== undefined ? { last_status } : {}),
        state: verdict.state,
        ...(verdict.reason ? { reason: verdict.reason } : {}),
        ...(verdict.next_step ? { next_step: verdict.next_step } : {}),
        ...(nextRetry !== undefined && nextRetry > now ? { next_retry_at: new Date(nextRetry).toISOString() } : {}),
        // A malformed or missing timestamp reports 0, not NaN: this number is
        // rendered, and NaN in a report reads as a bug in the reporter rather
        // than as the missing data it actually is.
        age_days: Number.isFinite(queuedMs) ? Math.floor((now - queuedMs) / 86_400_000) : 0,
      }
    }
    for (const e of engrams) {
      const sd = (e as any).structured_data as { _outbox?: Entry; _retireRemote?: Entry } | undefined
      // Advisory only, read from the entry's claim file alone.
      // A live claim (any holder's, this instance's own included)
      // says the entry is being pushed now.
      const claimUntil = sd ? this._outboxClaimUntil(e.id, now) : undefined
      const leased = claimUntil ? { leased_until: claimUntil } : {}
      if (sd?._outbox && e.status !== 'retired') out.push({ ...toEntry(e.id, 'push', sd._outbox), ...leased })
      // Selected exactly as flushOutbox selects them (any status).
      if (sd?._retireRemote) out.push({ ...toEntry(e.id, 'retire', sd._retireRemote), ...leased })
    }
    return out
  },

  outboxClaimsProblem(): string | undefined {
    try {
      fs.mkdirSync(this.outboxClaimsDir(), { recursive: true })
      fs.accessSync(this.outboxClaimsDir(), fs.constants.W_OK)
      return undefined
    } catch (err) {
      return (err as Error).message
    }
  },

  async outboxSummary(): Promise<OutboxSummary> {
    return summarizeOutbox(await this.listOutbox())
  },

  _hasWritableStoreFor(scope: string): boolean {
    return urlGroupsForScope(scope, this.config.stores ?? []).some(g => g.some(s => !s.readonly))
  },

  _needsActionRetryAt(ob: { last_attempt?: string }): number | undefined {
    const last = typeof ob.last_attempt === 'string' ? Date.parse(ob.last_attempt) : NaN
    return Number.isFinite(last) ? last + NEEDS_ACTION_RETRY_MS : undefined
  },

  async flushOutbox(options: { timeoutMs?: number; force?: boolean } = {}): Promise<{ flushed: number; failed: number; deferred: number; held: number; skipped: number; expired_warnings: string[] }> {
    return this._runOutboxFlush(options)
  },

  async _runOutboxFlush(options: { timeoutMs?: number; force?: boolean }, upload?: { ids: Set<string>; results: Map<string, UploadLocalResult> }): Promise<{ flushed: number; failed: number; deferred: number; held: number; skipped: number; expired_warnings: string[] }> {
    this._assertWritable()
    // The network budget. Started by the flush itself once the local load is
    // done, so a large store does not spend it on disk.
    const budget = new AbortController()
    let budgetTimer: NodeJS.Timeout | undefined
    const startBudget = () => {
      if (options.timeoutMs !== undefined && !budgetTimer) {
        budgetTimer = setTimeout(() => budget.abort(), Math.max(0, options.timeoutMs))
      }
    }
    // Ids this flush marks in `_outboxInFlight`, released however it ends.
    const claimed = new Set<string>()
    // Per-entry claims this flush takes; released however it ends.
    const entryClaims = new Set<string>()
    try {
      return await this._flushOutboxClaimed(claimed, budget.signal, options.force === true, startBudget, entryClaims, upload)
    } finally {
      if (budgetTimer) clearTimeout(budgetTimer)
      // The per-entry claims are released however the flush ended, a thrown
      // merge-back included. The idempotency key lives on the
      // outbox row, so the retry does not need the claim to remember anything.
      for (const id of entryClaims) this._releaseOutboxClaim(id)
      for (const id of claimed) this._outboxInFlight.delete(id)
    }
  },

  async _flushOutboxClaimed(claimed: Set<string>, budget: AbortSignal, force: boolean, startBudget: () => void, entryClaims: Set<string>, upload?: { ids: Set<string>; results: Map<string, UploadLocalResult> }): Promise<{ flushed: number; failed: number; deferred: number; held: number; skipped: number; expired_warnings: string[] }> {
    // The re-guard below promises the target scope's CURRENT policy; without
    // this a long-running process would flush against the config it started
    // with.
    this.reloadConfigIfChanged()
    let flushed = 0
    let failed = 0
    let deferred = 0
    let held = 0
    let skipped = 0
    /** Outbox metadata changed without a delivery or a failure (a cut). */
    let metadataDirty = false
    /** Warn once per host, not once per queued engram. */
    const cooldownSkippedHosts = new Set<string>()
    const expired_warnings: string[] = []
    const TTL_MS = 7 * 24 * 60 * 60 * 1000
    let now = new Date()
    type OutboxEntry = {
      target_url: string; target_scope: string; queued_at: string
      last_attempt: string; attempt_count: number; last_error: string
      /** HTTP status of the last failed push. */
      last_status?: number
      last_token_fp?: string
      /** Unique per logical write, stable across its retries. */
      idempotency_key?: string
    }
    /**
     * Back off an entry the store has already refused in a way a retry
     * cannot fix. Nothing about it changes; it is only not dialled. `force` —
     * the explicit flush — dials it.
     */
    const heldBack = (outbox: OutboxEntry, currentToken?: string): boolean => {
      if (force) return false
      const status = typeof outbox.last_status === 'number' ? outbox.last_status : statusFromErrorText(outbox.last_error)
      if ((status === 401 || status === 403) &&
        credentialChanged(outbox.last_token_fp, currentToken ? tokenHealthKey(currentToken) : undefined)) return false
      const verdict = classifyOutboxFailure({
        last_status: typeof outbox.last_status === 'number' ? outbox.last_status : undefined,
        last_error: outbox.last_error,
      })
      const retryAt = verdict.state === 'needs_action' ? this._needsActionRetryAt(outbox) : undefined
      return retryAt !== undefined && retryAt > now.getTime()
    }
    const warnIfOld = (engram: Engram, outbox: OutboxEntry): void => {
      const ageMs = now.getTime() - new Date(outbox.queued_at).getTime()
      if (ageMs > TTL_MS) {
        expired_warnings.push(
          `${engram.id} queued ${outbox.queued_at} (${Math.floor(ageMs / 86400000)}d ago) — consider manual resolution`
        )
      }
    }
    /**
     * Will this queued row be POSTed now, and to which store? A row that will
     * not (held back, no store, host in cooldown) needs no network call, so
     * it is not claimed, and a flush that attempts nothing writes nothing.
     * Consulted at
     * selection AND again right before the push, since this flush's own
     * failures can open a host's breaker mid-batch.
     */
    const routeFor = (engram: Engram, outbox: OutboxEntry):
      { storeEntry: StoreEntry } | { skip: 'failed' | 'skipped'; warning?: string } => {
      // Invariant `_outbox ⇒ scope === _outbox.target_scope`. Every in-process
      // writer keeps it (rescope() and updateEngram() cancel or retarget, and
      // cross-scope recurrence never widens a queued row). Kept as DEFENCE: a
      // hand-edited engrams.yaml, an older client sharing the store, or an
      // update that supplies its own `_outbox` can still break it, and pushing
      // such a row would deliver it, carrying its scope, to another store. Held
      // back, loudly and non-destructively: the entry stays queued, so
      // rescoping the engram decides where it goes.
      if (engram.scope !== outbox.target_scope) {
        return {
          skip: 'failed',
          warning: `${engram.id}: NOT pushed — its scope is now "${engram.scope}" but it was queued for `
            + `"${outbox.target_scope}". Rescope it (to "${outbox.target_scope}" to deliver, or to a local `
            + `scope to cancel the delivery).`,
        }
      }
      // A scope two servers now claim is held, never pushed to whichever is
      // listed first: the same refusal as learn, non-destructively —
      // the row stays queued until one of the entries is removed.
      const target = resolveScopeTarget(outbox.target_scope, this.config.stores ?? [])
      if (target.kind === 'local' && target.entry?.path) {
        return { skip: 'failed', warning: `${engram.id}: NOT pushed — scope "${outbox.target_scope}" now belongs to a local path store; the save stays queued. Rescope or forget it explicitly.` }
      }
      if (target.kind === 'conflict') {
        return {
          skip: 'failed',
          warning: `${engram.id}: NOT pushed — scope "${outbox.target_scope}" is claimed by two servers `
            + `(${target.servers.join(', ')}). Remove it from one of them in config.yaml; the save stays queued.`,
        }
      }
      // Resolve the remote driver from current config (tokens are never stored in the outbox).
      const storeEntry = (this.config.stores ?? []).find(
        s => s.url && s.scope === outbox.target_scope && !s.readonly
      )
      if (!storeEntry) {
        return { skip: 'failed', warning: `${engram.id}: no matching remote store for scope ${outbox.target_scope}` }
      }
      // Consult the per-host breaker the recall leg maintains, so N queued engrams for a down host do not cost N
      // timeouts per session start; skipped engrams stay queued. Use `remoteHealthStatePath()` (from `paths.root`),
      // NOT `remoteHealthPath()` (from PLUR_PATH), so both legs share one reachability opinion.
      const healthPath = this.remoteHealthStatePath()
      // Per credential: a 429 on another token for
      // this url does not park this one.
      const cooldown = isHostInCooldown(storeEntry.url!, Date.now(), healthPath, storeEntry.token)
      if (cooldown.inCooldown) {
        if (cooldownSkippedHosts.has(normalizeEndpointUrl(storeEntry.url!))) return { skip: 'skipped' }
        cooldownSkippedHosts.add(normalizeEndpointUrl(storeEntry.url!))
        const secs = Math.max(1, Math.ceil(((cooldown.until ?? 0) - Date.now()) / 1000))
        return {
          skip: 'skipped',
          warning: `${storeEntry.url}: skipped — ${cooldown.reason === 'rate_limit' ? 'rate-limited' : 'circuit breaker open'}, `
            + `retrying in ~${secs}s. Queued engrams stay queued.`,
        }
      }
      return { storeEntry }
    }
    const holdBack = (r: { skip: 'failed' | 'skipped'; warning?: string }): void => {
      if (r.warning) expired_warnings.push(r.warning)
      if (r.skip === 'failed') failed++
      else skipped++
    }
    type RetireEntry = { target_url: string; target_scope: string; server_id: string; queued_at: string; last_attempt: string; attempt_count: number; last_error: string }
    const retireStoreFor = (entry: RetireEntry): StoreEntry | undefined => (this.config.stores ?? []).find(
      s => s.url && s.scope === entry.target_scope && normalizeEndpointUrl(s.url) === normalizeEndpointUrl(entry.target_url),
    )

    // Per-entry claims are the one duplicate-push guard (leases alone
    // duplicate after a crash; claims alone suffice). There are no row leases,
    // so selection needs no store lock — the merge-back below still merges
    // into a fresh read under it.
    // Stamped BEFORE the load, so the rows are at least as new as the stamp:
    // the re-read after claiming trusts this read while
    // the store file is unchanged.
    const rowsSeen = { stamp: this._engramsFileStamp(), keys: new Map<string, string | undefined>() }
    let engrams: Engram[] = await this._primaryStore.load()
    rowsSeen.keys = queuedOutboxKeys(engrams)
    now = new Date()
    // A row this process is pushing right now (`_outboxInFlight`: learn()'s
    // immediate push, a concurrent flush) is not ours to push; another
    // process's push is kept off by the claim taken in the push loop.
    const free = (e: Engram) => !this._outboxInFlight.has(e.id)
    // Skip retired engrams: a retired engram must not be pushed to the
    // remote and resurrected. The cancel-outbox path in forget() strips _outbox
    // on retirement; this guard covers any path that retires without
    // explicitly cancelling (e.g. direct YAML edits, older client versions).
    const pending: Engram[] = engrams.filter(e => {
      if (upload && !upload.ids.has(e.id)) return false
      if (!Plur._stillQueued(e) || !free(e)) return false
      // A row owing a retire is decided in the push loop (after its retire).
      if ((e as any).structured_data._retireRemote) return true
      const outbox = (e as any).structured_data._outbox as OutboxEntry
      const route = routeFor(e, outbox)
      if ('storeEntry' in route) {
        if (!heldBack(outbox, route.storeEntry.token)) return true
        held++
        return false
      }
      // Not attempted now: reported, and nothing is written.
      warnIfOld(e, outbox)
      holdBack(route)
      return false
    })
    for (const e of pending) { this._outboxInFlight.add(e.id); claimed.add(e.id) }
    // Queued "retire on remote" entries — retired or rescoped
    // rows whose remote copy was accepted after the delivery was cancelled.
    // A row can carry both (retargeted to another store while the push to the
    // old one was in flight); it is claimed by
    // THIS flush through `pending`, so it is not skipped as in flight: the
    // old copy is retired here, before the push to the new store below. Two
    // concurrent retirers are harmless: `removeIdempotent` treats 404/410 as done.
    const pendingClaimed = new Set(pending.map(e => e.id))
    const retiring: Engram[] = engrams.filter(e => {
      if (upload && !upload.ids.has(e.id)) return false
      const entry = (e as any).structured_data?._retireRemote as RetireEntry | undefined
      if (!entry || !(pendingClaimed.has(e.id) || free(e))) return false
      if (retireStoreFor(entry)) return true
      // No store to send the DELETE to: reported, nothing written.
      expired_warnings.push(
        `${e.id}: remote copy ${entry.server_id} is queued for retirement on "${entry.target_scope}", `
        + `but no store with that url and scope is configured — still queued.`,
      )
      failed++
      return false
    })
    for (const e of retiring) { this._outboxInFlight.add(e.id); claimed.add(e.id) }
    // The network budget starts NOW, after the local load.
    startBudget()
    // Nothing to attempt: no merge-back, no write.
    if (pending.length === 0 && retiring.length === 0) {
      return { flushed, failed, deferred, held, skipped, expired_warnings }
    }

    // Every entry's idempotency key is ON ITS ROW before its first
    // POST. Rows queued by clients that predate keys get one minted and
    // persisted here, under the store lock, before anything is posted — so a
    // merge-back that later throws cannot cost the retry its key.
    await this._persistMissingOutboxKeys(pending)

    // Push supersedes TARGETS before the engrams that supersede them, so the server id of the target is known when
    // the correction is pushed; a dropped edge leaves the stale statement live at equal weight. This is a
    // TOPOLOGICAL SORT, not a comparator (see `orderBySupersedes`).
    const pendingIds = new Set(pending.map(e => e.id))
    const supersedesTargets = (e: Engram): string[] => {
      const rel = (e as any).relations?.supersedes
      return Array.isArray(rel) ? rel.filter((x: unknown): x is string => typeof x === 'string') : []
    }
    const ordered = orderBySupersedes(pending, supersedesTargets)
    pending.length = 0
    pending.push(...ordered)
    /**
     * local id -> server-assigned id.
     *
     * Seeded from the PERSISTED map so an edge whose target left in an earlier
     * flush still resolves; a mapping is only trusted for the host that
     * produced it, since server ids are per-store. Grown as this flush
     * proceeds, and written back at the end.
     */
    const persistedIdMap = this._readOutboxIdMap()
    const localToServer = new Map<string, string>()
    let idMapDirty = false

    /**
     * Engrams this flush DEMOTED to local/private on a policy change.
     *
     * Tracked explicitly because the merge-back applies fields, not rows: a
     * demotion changes `scope` and `visibility` as well as the structured-data
     * markers, and those two are ordinary engram fields that a concurrent
     * `rescope` also writes. Carrying them for every survivor would revert
     * that; carrying them only for the ids this flush actually demoted does
     * not.
     */
    const demotedIds = new Set<string>()
    /**
     * Entries found already delivered (or re-queued) by another writer once
     * claimed. Left out of the merge-back entirely: this flush's snapshot of
     * them is stale and must not be written over the current row.
     */
    const leftToOthers = new Set<string>()

    // Retire accepted-after-cancel remote copies. A DELETE by the
    // server id the remote assigned; 404/410 means already gone (done). The
    // outcome is merged below: `undefined` = done (entry removed), otherwise
    // the entry with its attempt bookkeeping bumped.
    const retireOutcome = new Map<string, { serverId: string; next: RetireEntry | undefined }>()
    for (const row of retiring) {
      // Out of budget: leave it queued, untouched, for next time.
      if (budget.aborted) { deferred++; continue }
      const entry = (row as any).structured_data._retireRemote as RetireEntry
      const storeEntry = retireStoreFor(entry)
      if (!storeEntry) {
        expired_warnings.push(
          `${row.id}: remote copy ${entry.server_id} is queued for retirement on "${entry.target_scope}", `
          + `but no store with that url and scope is configured — still queued.`,
        )
        failed++
        continue
      }
      const driver = this._getRemoteDriver({ url: storeEntry.url!, token: storeEntry.token, scope: storeEntry.scope })
      try {
        await driver.removeIdempotent(entry.server_id)
        retireOutcome.set(row.id, { serverId: entry.server_id, next: undefined })
        flushed++
        this._appendHistory({
          event: 'engram_retired',
          engram_id: row.id,
          timestamp: now.toISOString(),
          data: { reason: 'delivery cancelled locally during the push', routed_to: 'remote', scope: entry.target_scope, server_id: entry.server_id, outbox_flush: true },
        })
      } catch (err) {
        retireOutcome.set(row.id, {
          serverId: entry.server_id,
          next: { ...entry, last_attempt: now.toISOString(), attempt_count: (entry.attempt_count ?? 0) + 1, last_error: (err as Error).message },
        })
        failed++
        logger.warning(`[plur:outbox] retiring remote copy ${entry.server_id} of ${row.id} failed: ${(err as Error).message}`)
      }
    }
    /** Where each pushed id went, for queuing a retire if it was cancelled meanwhile. */
    const pushedTo = new Map<string, { url: string; scope: string }>()
    // A configuration-only server replacement changes the endpoint, not the
    // queued write. Keep its admitted identity separate from the actual
    // receipt endpoint so acknowledgment cannot erase a newer queued write.
    const admittedWrites = new Map<string, { url: string; scope: string; key: string }>()

    for (const engram of pending) {
      // Out of budget: leave the rest queued, untouched, for next time.
      if (budget.aborted) { deferred++; continue }
      const outbox = (engram as any).structured_data._outbox as OutboxEntry

      // Never post without the key already on the row. Only a failed
      // key write above leaves one keyless; it waits for the next flush.
      if (!outbox.idempotency_key) {
        expired_warnings.push(`${engram.id}: its idempotency key could not be saved — left for the next flush`)
        deferred++
        continue
      }

      // Claim the entry before touching the network — one pusher at a
      // time (another flush in any process, or learn()'s own background push).
      const claim = this._claimOutboxEntry(engram.id, () => outbox.idempotency_key!)
      if (claim.status === 'busy') {
        if (claim.error) {
          // Say on the row why it is held, so `plur outbox`,
          // doctor and status show it. Not a push attempt: attempt_count and
          // last_attempt are untouched. Written back by the merge below.
          outbox.last_error = `${OUTBOX_CLAIM_ERROR_PREFIX}${claim.error}`
          metadataDirty = true
        }
        expired_warnings.push(claim.error
          ? `${engram.id}: its push claim could not be recorded (${claim.error}) — left queued for a later flush`
          : `${engram.id}: another writer is pushing it right now — left to that writer`)
        deferred++
        continue
      }
      entryClaims.add(engram.id)

      // The claim guards the ROW, not this flush's snapshot of it. The snapshot was loaded before any network round-trip; since
      // then another writer may have pushed this entry, removed its row and
      // released its claim. Both removal paths delete the row BEFORE they
      // release, so reading it now, under our claim, sees that. Gone, or
      // re-queued under a different key: someone else owns it — leave it.
      if (!(await this._outboxRowStillQueued(engram.id, outbox.idempotency_key, rowsSeen))) {
        leftToOthers.add(engram.id)
        continue
      }

      // A row still owing a retire of an older
      // remote copy is delivered only once that retire is done. Pushing first
      // and then losing the row on hand-off would drop the retire entry with it.
      const owedRetire = (engram as any).structured_data._retireRemote as { server_id?: string } | undefined
      if (owedRetire) {
        const r = retireOutcome.get(engram.id)
        if (!r || r.serverId !== owedRetire.server_id || r.next !== undefined) {
          expired_warnings.push(
            `${engram.id}: NOT pushed yet — its earlier remote copy ${owedRetire.server_id ?? '?'} must be retired `
            + `first (still queued; the next flush retries both).`,
          )
          failed++
          continue
        }
      }

      // Earlier pushes and the row claim await external work. Re-read the
      // destination and retry credential at admission, not only at selection.
      this.reloadConfigIfChanged()
      warnIfOld(engram, outbox)
      const route = routeFor(engram, outbox)
      if (!('storeEntry' in route)) { holdBack(route); continue }
      const { storeEntry } = route
      if (heldBack(outbox, storeEntry.token)) { held++; continue }
      const attemptedTokenFp = storeEntry.token ? tokenHealthKey(storeEntry.token) : undefined

      const driver = this._getRemoteDriver({ url: storeEntry.url!, token: storeEntry.token, scope: storeEntry.scope })

      // Clean copy without outbox metadata for the remote.
      const cleanEngram = { ...engram } as any
      const sd = { ...(cleanEngram.structured_data ?? {}) }
      delete sd._outbox
      if (Object.keys(sd).length === 0) {
        delete cleanEngram.structured_data
      } else {
        cleanEngram.structured_data = sd
      }

      // Re-run the leak guard against the TARGET scope's CURRENT policy before
      // pushing. The queue-time verdict can go stale: a user may tighten the
      // scope's `sensitivity.forbid` before the flush (up to the 7-day TTL
      // later). If it now offends, demote in place (scope→local/private, drop
      // _outbox) and skip the push, like every other egress path.
      const scanText = (() => {
        const fields = this._engramContextFields(cleanEngram as Engram)
        return fields ? `${cleanEngram.statement}\n${JSON.stringify(fields)}` : cleanEngram.statement
      })()
      const offending = this._offendingHitsForScope(scanText, outbox.target_scope)
      if (isRemoteOnlyQueued(engram) && !this._isDeliverableTeamScope(outbox.target_scope)) {
        // A remote-only save goes only to a deliverable team scope: held, never
        // sent elsewhere and never demoted.
        outbox.last_attempt = now.toISOString()
        outbox.last_error = `held: "${outbox.target_scope}" is not a team scope served by a writable team store; ` +
          'a save from a remote-only folder is never sent elsewhere or kept locally — forget it, or add the team store'
        metadataDirty = true
        expired_warnings.push(`${engram.id}: remote-only save held — "${outbox.target_scope}" is not a deliverable team scope`)
        failed++
        continue
      }
      if (offending.length > 0 && isRemoteOnlyQueued(engram)) {
        // A save from a remote-only folder is never demoted to a local row:
        // it stays queued, not pushed, and says why.
        const patterns = [...new Set(offending.map(h => h.pattern))].join(', ')
        outbox.last_attempt = now.toISOString()
        outbox.last_error = `held: sensitive content (${patterns}) is now forbidden by scope ${outbox.target_scope}'s policy; ` +
          'a save from a remote-only folder is never kept locally — forget it, or relax the policy'
        metadataDirty = true
        expired_warnings.push(`${engram.id}: sensitive content (${patterns}) now forbidden by scope ${outbox.target_scope}'s policy — remote-only save held in the queue, not pushed and not kept locally`)
        failed++
        continue
      }
      if (offending.length > 0) {
        const patterns = [...new Set(offending.map(h => h.pattern))].join(', ')
        const localIdx = engrams.findIndex(e => e.id === engram.id)
        if (localIdx !== -1) {
          const local = engrams[localIdx] as any
          const lsd = { ...(local.structured_data ?? {}) }
          delete lsd._outbox
          lsd._demoted = { from: outbox.target_scope, to: 'local', patterns }
          local.structured_data = lsd
          local.scope = 'local'
          local.visibility = 'private'
          demotedIds.add(engram.id)
        }
        expired_warnings.push(
          `${engram.id}: sensitive content (${patterns}) now forbidden by scope ${outbox.target_scope}'s policy — demoted to local/private, not pushed`,
        )
        logger.warning(
          `[plur:outbox] ${engram.id} held back from "${outbox.target_scope}" — policy tightened since queue-time; demoted to local/private (${patterns}).`,
        )
        failed++
        continue
      }

      // Rewrite supersedes to the DESTINATION's ids before pushing.
      //
      // Three cases, and they are not the same:
      //   - target already flushed in THIS run -> remap to its server id.
      //   - target is a live LOCAL engram that was never destined for this
      //     remote -> the edge is inherently unrepresentable there. Strip it and
      //     say so, rather than blocking a legitimate write forever.
      //   - target is neither -> refuse. A half-record leaves two live
      //     contradictory statements; a loud failure beats a silent drop.
      const targets = supersedesTargets(cleanEngram as Engram)
      if (targets.length > 0) {
        const remapped: string[] = []
        let refuse: string | null = null
        for (const t of targets) {
          const server = localToServer.get(t)
            ?? (persistedIdMap[t]?.url !== undefined && normalizeEndpointUrl(persistedIdMap[t].url) === normalizeEndpointUrl(storeEntry.url!) ? persistedIdMap[t].server_id : undefined)
          if (server) { remapped.push(server); continue }
          const localTarget = engrams.find(e => e.id === t)
          if (localTarget && Plur._stillQueued(localTarget) && !pendingIds.has(t)) {
            refuse = t
            break
          }
          if (localTarget && !pendingIds.has(t)) {
            expired_warnings.push(
              `${engram.id}: supersedes ${t}, which lives only in the local store — that edge cannot be `
              + `represented on ${storeEntry.url} and was dropped from the pushed copy. The local record keeps it.`,
            )
            continue
          }
          refuse = t
          break
        }
        if (refuse) {
          expired_warnings.push(
            `${engram.id}: NOT pushed — it supersedes ${refuse}, which could not be resolved in `
            + `"${outbox.target_scope}". Pushing it would create two live, equally-authoritative records `
            + `for the same fact, and tension scans skip supersedes-linked pairs so nothing would flag it. `
            + `Still queued; flush again once ${refuse} has been pushed.`,
          )
          failed++
          continue
        }
        const sd = (cleanEngram as any).relations ?? {}
        ;(cleanEngram as any).relations = { ...sd, supersedes: remapped }
      }

      try {
        // The same key on every retry of this write.
        admittedWrites.set(engram.id, {
          url: outbox.target_url, scope: outbox.target_scope, key: outbox.idempotency_key,
        })
        const pushed = await driver.appendAndGetServerId(cleanEngram, { signal: budget, idempotencyKey: outbox.idempotency_key })
        upload?.results.set(engram.id, { id: engram.id, outcome: pushed.review_required ? 'held_for_review' : pushed.deduplicated ? 'already_on_server' : 'sent', new_id: pushed.id })
        // Remember the mapping so a later engram in this same flush can
        // point at the server id rather than the local one.
        pushedTo.set(engram.id, { url: storeEntry.url!, scope: outbox.target_scope })
        if (pushed?.id) {
          localToServer.set(engram.id, pushed.id)
          persistedIdMap[engram.id] = { server_id: pushed.id, url: storeEntry.url!, at: Date.now() }
          // Also in the seen-on-server record: the id map
          // is capped and lives under cache/, so it can drop this evidence.
          this._noteSeenOnServer([{ id: pushed.id, scope: outbox.target_scope }])
          idMapDirty = true
        }
        // A write success clears the host's failure count for BOTH legs.
        recordWriteOutcome(storeEntry.url!, true, Date.now(), this.remoteHealthStatePath())
        // Success: remove from the local store.
        const idx = engrams.findIndex(e => e.id === engram.id)
        if (idx !== -1) engrams.splice(idx, 1)
        flushed++
        this._appendHistory({
          event: 'engram_created',
          engram_id: engram.id,
          timestamp: now.toISOString(),
          data: { routed_to: 'remote', outbox_flush: true, scope: engram.scope },
        })
        this._maybeWriteProvenance(engram.id, engram)
      } catch (err) {
        // Cut at the caller's budget. Not a failure of the remote, so
        // the breaker is not fed. Recorded as an attempt so `plur outbox`
        // shows it, and retried on the next flush with the same key.
        // A remote timeout or any other error takes the ordinary failure
        // path below and is retried the same way.
        if (err instanceof RemoteAbortedError) {
          outbox.last_token_fp = attemptedTokenFp
          outbox.last_attempt = now.toISOString()
          outbox.attempt_count += 1
          outbox.last_error = 'cut at the flush time budget before the remote answered — retried on the next flush'
          // This attempt got no status; an older 403 must not keep
          // classifying the entry as needs_action.
          delete outbox.last_status
          metadataDirty = true
          deferred++
          logger.warning(`[plur:outbox] ${engram.id}: flush budget ran out mid-push — left queued for retry`)
          continue
        }
        outbox.last_attempt = now.toISOString()
        outbox.attempt_count += 1
        outbox.last_error = (err as Error).message
        outbox.last_token_fp = attemptedTokenFp
        // The status when the remote gave one; cleared when it did not,
        // so a stale 403 cannot outlive a later network failure.
        if (err instanceof RemoteHttpError) outbox.last_status = err.status
        else delete outbox.last_status
        // A write failure counts toward the same breaker, so a host that only
        // ever fails on writes still opens one.
        //
        // Except a refusal (401/403/404/422): the host answered that the
        // REQUEST was wrong, and counting it would let a few refused writes to
        // one scope open the breaker for every scope on the host. It neither
        // counts nor resets. Network errors, timeouts and 5xx still count.
        const refused = err instanceof RemoteHttpError && NEEDS_ACTION_STATUSES.has(err.status)
        if (!refused) recordWriteOutcome(storeEntry.url!, false, Date.now(), this.remoteHealthStatePath())
        failed++
        logger.warning(`[plur:outbox] retry failed for ${engram.id}: ${(err as Error).message}`)
      }
    }

    // Write back by MERGING into a fresh read, never the array loaded before the network round-trips (that would
    // delete engrams created meanwhile). Only outbox engrams in `pending` are touched, and only the fields the
    // flush changes (outbox metadata, demotion marker, scope/visibility on demotion) — so concurrent feedback,
    // activation, pins or rescopes survive.
    if (flushed > 0 || failed > 0 || metadataDirty) {
      const consideredIds = new Set(pending.map(e => e.id).filter(id => !leftToOthers.has(id)))
      const retiredAt = new Date().toISOString()
      const survivorsById = new Map(
        engrams.filter(e => consideredIds.has(e.id)).map(e => [e.id, e] as const),
      )
      await this._withStoreLock(this.paths.engrams, async () => {
        const fresh = await this._storeAt(this.paths.engrams).load()
        const merged = fresh
          // Drop the ones this flush successfully pushed (remote now owns them)
          // — but only while the fresh row is STILL queued. A forget() or local
          // rescope that landed during the push cancelled the delivery; the
          // remote accepted it anyway (the POST was already on the wire), so
          // keep the local record and report the stray remote copy.
          .filter(e => {
            if (!(consideredIds.has(e.id) && !survivorsById.has(e.id))) return true
            const dest = pushedTo.get(e.id)
            // A config replacement may authorize a different server for the
            // same queued scope. Acknowledge the admitted write only while its
            // original identity survives; cancellation, rescope and requeue
            // still preserve the fresh row and retire the actual remote copy.
            const admitted = admittedWrites.get(e.id)
            if (admitted && e.scope === admitted.scope && Plur._stillQueuedFor(e, admitted)
              && (e as any).structured_data._outbox.idempotency_key === admitted.key) return false
            const retargeted = Plur._stillQueued(e)
            const serverId = localToServer.get(e.id)
            // Queue the accepted copy for retirement on the remote
            // (durable, on this kept row); the next flush DELETEs it.
            const queuedRetire = !!(serverId && dest)
              && Plur._queueRetireRemote(e, { target_url: dest!.url, target_scope: dest!.scope, server_id: serverId! }, retiredAt)
            expired_warnings.push(
              `${e.id}: delivery was ${retargeted ? 'retargeted to another store' : 'cancelled locally (forget/rescope)'} `
              + `while the push was in flight, but the remote accepted it${serverId ? ` as ${serverId}` : ''}. `
              + `The local record is kept${retargeted ? ', still queued for the new store' : ''}; `
              + (queuedRetire || (serverId && (e as any).structured_data?._retireRemote?.server_id === serverId)
                ? `the remote copy is queued for retirement (next flush).`
                : `retire the remote copy there if it should not exist.`),
            )
            return true
          })
          .map(e => {
            const survivor = survivorsById.get(e.id)
            if (!survivor) return e
            // The delivery was cancelled while this flush ran (forget
            // stripped `_outbox`, a local rescope dropped it). Copying the
            // snapshot's `_outbox` back would re-queue it; leave the row alone.
            if (!Plur._stillQueued(e)) return e
            const sSd = (survivor as any).structured_data as Record<string, unknown> | undefined
            // Retargeted meanwhile (update or rescope to another store). The snapshot's `_outbox` names the OLD
            // store; copying it back would re-point the row there.
            const sOb = sSd?._outbox as { target_url?: string; target_scope?: string; idempotency_key?: string } | undefined
            if (sOb?.target_url && !Plur._stillQueuedFor(e, { url: sOb.target_url, scope: sOb.target_scope ?? '' })) return e
            // A same-destination requeue is a different logical write too.
            // Failure bookkeeping from this attempt must not restore its old key.
            if (sOb && (e as any).structured_data._outbox.idempotency_key !== sOb.idempotency_key) return e
            const fSd = { ...((e as any).structured_data as Record<string, unknown> | undefined ?? {}) }
            // `_outbox` and `_demoted` are the flush's own bookkeeping: copy
            // them across (including their ABSENCE, which is how a cancelled
            // or demoted queue entry is expressed), and leave every other key
            // of the fresh row alone.
            for (const key of ['_outbox', '_demoted'] as const) {
              if (sSd && key in sSd) fSd[key] = sSd[key]
              else delete fSd[key]
            }
            return {
              ...e,
              // A demotion is the one case where the flush changes ordinary
              // engram fields, so those are carried for exactly those ids.
              ...(demotedIds.has(e.id) ? { scope: 'local', visibility: 'private' } : {}),
              structured_data: Object.keys(fSd).length > 0 ? fSd : undefined,
            } as Engram
          })
          // Apply the retire outcomes — only to a row whose entry
          // is still the one this flush worked on (same server id).
          .map(e => {
            const r = retireOutcome.get(e.id)
            const cur = (e as any).structured_data?._retireRemote as { server_id?: string } | undefined
            if (!r || cur?.server_id !== r.serverId) return e
            const fSd = { ...((e as any).structured_data as Record<string, unknown>) }
            if (r.next) fSd._retireRemote = r.next
            else delete fSd._retireRemote
            return { ...e, structured_data: Object.keys(fSd).length > 0 ? fSd : undefined } as Engram
          })
        // The dropped engrams are the ones the remote accepted — a deliberate
        // handoff, not a loss (for the shrink guard).
        await this._writeEngrams(this.paths.engrams, merged, { allowShrink: true })
      })
      await this._syncIndex()
    }

    // Persist the id map LAST, and only if something was pushed. Writing it
    // before the store write-back would leave a mapping for an engram whose
    // local removal had not landed; writing it unconditionally would rewrite
    // the file on every no-op flush.
    if (idMapDirty) this._writeOutboxIdMap(persistedIdMap)

    return { flushed, failed, deferred, held, skipped, expired_warnings }
  },

  _engramsFileStamp(): string | undefined {
    if (!(this._basePrimaryStore instanceof YamlPrimaryStore)) return undefined
    try {
      const st = fs.statSync(this._basePrimaryStore.location!, { bigint: true })
      return `${st.ino}:${st.size}:${st.mtimeNs}`
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : undefined
    }
  },

  async _outboxRowStillQueued(id: string, key: string, seen: { stamp: string | undefined; keys: Map<string, string | undefined> }): Promise<boolean> {
    try {
      const stamp = this._engramsFileStamp()
      if (stamp === undefined) {
        const row = (await this._loadTargeted([id])).find(e => e.id === id)
        return row !== undefined && queuedOutboxKeys([row]).get(id) === key
      }
      if (stamp !== seen.stamp) {
        seen.stamp = stamp
        seen.keys = queuedOutboxKeys(await this._primaryStore.load())
      }
      return seen.keys.get(id) === key
    } catch (err) {
      logger.warning(`[plur:outbox] could not re-read ${id} before pushing it — left for the next flush: ${(err as Error).message}`)
      return false
    }
  },

  async _persistMissingOutboxKeys(pending: Engram[]): Promise<void> {
    const keyless = pending.filter(e => !(e as any).structured_data?._outbox?.idempotency_key)
    if (keyless.length === 0) return
    try {
      await this._withStoreLock(this.paths.engrams, async () => {
        const fresh = await this._loadTargeted(keyless.map(e => e.id))
        const changed: Engram[] = []
        for (const row of fresh) {
          const ob = (row as any).structured_data?._outbox
          const mine = keyless.find(e => e.id === row.id) as any
          if (!ob || !mine) continue
          if (!ob.idempotency_key) {
            ob.idempotency_key = randomUUID()
            changed.push(row)
          }
          mine.structured_data._outbox.idempotency_key = ob.idempotency_key
        }
        await this._updateEngrams(fresh, changed)
      })
    } catch (err) {
      for (const e of keyless) delete (e as any).structured_data._outbox.idempotency_key
      logger.warning(`[plur:outbox] could not save idempotency keys for ${keyless.length} queued write(s): ${(err as Error).message}`)
    }
  },
}
