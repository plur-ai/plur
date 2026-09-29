/**
 * On-disk lease on outbox rows (formal WritePath §1c, decision D2).
 *
 * The in-memory in-flight claim (`Plur._outboxInFlight`) makes delivery
 * at-most-once within ONE process. Two processes flushing the same store (an
 * MCP server and a CLI hook) share neither that set nor anything else but the
 * store file, so both selected the same queued row and both POSTed it.
 *
 * The lease closes that. Before its network call, a pusher records
 * `structured_data._outboxLease = { holder, expires_at }` on each row it will
 * push or retire, under the store lock — so of two processes, the second to
 * take the lock sees the first one's lease. A row carrying a LIVE lease of
 * another holder is skipped; the lease is cleared when the pusher merges its
 * outcome back (success or failure); an EXPIRED lease may be taken over, so a
 * holder that crashed blocks its rows for at most one TTL.
 *
 * The guarantee is timed, as every lease is: a holder starts a push only while
 * at least `OUTBOX_LEASE_MARGIN_MS` of its lease remains, and that margin
 * covers everything between the start of a push and the merge-back that hands
 * the row off (audit of #1231, finding 2): one bounded request (30 s,
 * `RemoteStore.fetchBounded`), the wait for the store lock (bounded by the file
 * lock's own `DEFAULT_ACQUIRE_TIMEOUT`, 180 s — a holder past it fails every
 * other writer too), the write itself, and the clock skew tolerated between
 * processes. The merge-back runs once per batch, after the LAST push, and that
 * push started at least the margin before expiry, so the whole batch is handed
 * off inside the lease. Two assumptions remain, both stated in the model
 * (WritePath §1c): clocks of the processes sharing a store agree to within
 * `OUTBOX_LEASE_SKEW_MS`, and a holder that the remote accepted a push from
 * completes its merge-back inside that bound — it is not killed first, and its
 * wait for the store lock does not end in a timeout. Either failure re-delivers
 * after the TTL: the at-least-once edge the single-process path has always had
 * and warns about.
 *
 * Every holder reads its clock for the lease INSIDE the store lock, after the
 * load (audit of #1231, finding 1): a reading taken before a long lock wait
 * made another process's fresh lease look further out than any live holder
 * could write, and the far-future clause of `leaseFree` then treated it as free.
 *
 * Format: additive. A row without the field is unleased; an older client
 * ignores the field (and so is not excluded by it — the protection holds
 * between clients that know the lease).
 */
import { randomUUID } from 'crypto'
import { DEFAULT_ACQUIRE_TIMEOUT } from './store/async-lock.js'
import { LOAD_FETCH_TIMEOUT_MS } from './store/remote-store.js'

/** How long a lease lives. Generous: it only bounds how long a crashed holder blocks its rows. */
export const OUTBOX_LEASE_TTL_MS = 10 * 60_000

/** Clock skew tolerated between processes sharing a store. */
export const OUTBOX_LEASE_SKEW_MS = 60_000

/** The merge-back's own write (a full corpus save on YAML), with room to spare. */
export const OUTBOX_MERGE_WRITE_MS = 30_000

/**
 * A holder starts a push or retire only while at least this much of its lease
 * remains: one bounded request, the wait for the store lock, the merge-back
 * write, and the clock skew — 30 + 180 + 30 + 60 s = 5 min. Before the audit
 * of #1231 it was 2 min and left the lock wait out, so a merge-back that
 * queued behind a long lock holder landed after the lease had expired and
 * another process re-delivered rows the remote had already accepted.
 */
export const OUTBOX_LEASE_MARGIN_MS =
  LOAD_FETCH_TIMEOUT_MS + DEFAULT_ACQUIRE_TIMEOUT + OUTBOX_MERGE_WRITE_MS + OUTBOX_LEASE_SKEW_MS

// The margin must leave part of the lease to push in. Were it to reach the TTL
// (DEFAULT_ACQUIRE_TIMEOUT raised to ~8.5 min or more), `canStartPush` would
// never hold and no flush would push again — fail loudly at load instead.
export function assertLeaseMarginFits(marginMs: number, ttlMs: number): void {
  if (!(marginMs < ttlMs)) {
    throw new Error(`outbox lease margin (${marginMs} ms) must be shorter than its TTL (${ttlMs} ms)`)
  }
}
assertLeaseMarginFits(OUTBOX_LEASE_MARGIN_MS, OUTBOX_LEASE_TTL_MS)

/** The bookkeeping key the lease is stored under, in `structured_data`. */
export const OUTBOX_LEASE_KEY = '_outboxLease'

export interface OutboxLease {
  /** Opaque, unique per `Plur` instance. Carries no host name. */
  holder: string
  /** ISO timestamp. */
  expires_at: string
  /**
   * Opaque, unique per lease written. One instance can hold leases for two
   * pushes (learn()'s immediate push, then a flush's retry), so the holder id
   * alone cannot say WHICH lease a release is for — see `dropLease`. Absent on
   * a lease written by a client that predates it.
   */
  nonce?: string
}

/** A fresh holder id for one `Plur` instance. */
export function newLeaseHolder(): string {
  return `${process.pid}-${randomUUID()}`
}

export function makeLease(holder: string, nowMs: number, ttlMs: number = OUTBOX_LEASE_TTL_MS): OutboxLease {
  return { holder, expires_at: new Date(nowMs + ttlMs).toISOString(), nonce: randomUUID() }
}

/** The lease on a row's `structured_data`, or undefined when absent or malformed (= unleased). */
export function readLease(sd: unknown): OutboxLease | undefined {
  if (!sd || typeof sd !== 'object') return undefined
  const l = (sd as Record<string, unknown>)[OUTBOX_LEASE_KEY]
  if (!l || typeof l !== 'object') return undefined
  const { holder, expires_at, nonce } = l as Record<string, unknown>
  if (typeof holder !== 'string' || typeof expires_at !== 'string') return undefined
  return { holder, expires_at, ...(typeof nonce === 'string' ? { nonce } : {}) }
}

/**
 * May `holder` take (or keep) the row at `nowMs`? Yes when the row is
 * unleased, the lease is its own, or the lease has expired. A lease claiming
 * more than a TTL (plus the skew margin) into the future cannot have been
 * written by a live holder with a sane clock, so it does not block either —
 * otherwise one bad write would park the row forever. Sound only for a `nowMs`
 * read while the caller holds the store lock (finding 1 of the #1231 audit).
 */
export function leaseFree(sd: unknown, holder: string, nowMs: number): boolean {
  const lease = readLease(sd)
  if (!lease || lease.holder === holder) return true
  const exp = Date.parse(lease.expires_at)
  if (!Number.isFinite(exp)) return true
  if (exp - nowMs > OUTBOX_LEASE_TTL_MS + OUTBOX_LEASE_MARGIN_MS) return true
  return exp <= nowMs
}

/** May a holder whose lease ends at `leaseUntilMs` START a push at `nowMs`? */
export function canStartPush(leaseUntilMs: number, nowMs: number): boolean {
  return nowMs + OUTBOX_LEASE_MARGIN_MS <= leaseUntilMs
}

/**
 * Drop exactly `lease` — the one this push wrote — from a `structured_data`
 * copy. Returns whether it was there. Mutates `sd`.
 *
 * Release is per lease, not per holder (review of #1231). A release matched by
 * holder id alone let a failed learn() push delete the lease a flush in the
 * same instance had just written for its own POST; the row then sat unleased
 * while that POST was on the wire, and another process delivered it again.
 */
export function dropLease(sd: Record<string, unknown>, lease: OutboxLease): boolean {
  const onRow = readLease(sd)
  if (!onRow || onRow.holder !== lease.holder || onRow.nonce !== lease.nonce
    || onRow.expires_at !== lease.expires_at) return false
  delete sd[OUTBOX_LEASE_KEY]
  return true
}
