import { type InjectionEventCounts } from '../history.js'
import { Plur } from '../index.js'
import { type OutboxSummary } from '../outbox-health.js'
import type { PlurConfig } from '../schemas/config.js'
import { type ScopeMetadata } from '../schemas/scope-metadata.js'
import { type DiscoveryStatus, type ScopeRejection } from '../server-discovery.js'
import { DEFAULT_REMOTE_WRITE_TIMEOUT_MS } from './helpers.js'


export interface IngestOptions {
  source?: string
  extract_only?: boolean
  scope?: string
  domain?: string
}


export interface IngestCandidate {
  statement: string
  type: 'behavioral' | 'architectural' | 'procedural'
  source?: string
}


/**
 * Last failure of a background index operation. The PGLite index refresh (and
 * the auto-embed/reembed pass that rides on it) runs in a fire-and-forget
 * promise, so failures are recorded and exposed via `lastIndexError()` /
 * `status().index_error` for CLI and MCP callers to surface. Cleared when the
 * next background pass succeeds.
 */
export interface IndexSyncError {
  /** Which background operation failed. */
  op: 'initial-sync' | 'sync-from-yaml' | 'reindex' | 'auto-embed'
  message: string
  /** ISO timestamp of when the failure was recorded. */
  at: string
}


export interface StatusResult {
  engram_count: number
  episode_count: number
  pack_count: number
  storage_root: string
  config: PlurConfig
  /**
   * The identity this instance records as `attribution.asserted_by` on every
   * engram it writes (`provenance.identity` in config.yaml). Surfaced so users
   * can see why engrams are attributed as they are.
   * `agent:unidentified` when none is configured.
   */
  provenance_identity: string

  locked_count?: number
  tension_count?: number
  versioned_engram_count?: number
  outbox_count?: number
  /** Queued writes a retry cannot deliver (401/403/404/422, refusal, no store). */
  outbox_needs_action?: number
  /** Present when `outbox_needs_action` > 0: one row per scope and reason, with its next step. */
  outbox_attention?: OutboxSummary['scopes']
  /** Queued writes held on this machine for a stated reason, e.g. a push claim
   *  that could not be recorded. Present only when there are some. */
  outbox_held?: OutboxSummary['held']
  /** Present when the most recent background index pass failed. */
  index_error?: IndexSyncError
  /** Injection-provenance event/label counts. */
  history_events?: InjectionEventCounts
  /**
   * Artifacts `status()` could not read, by name.
   *
   * `status()` is the command an operator reaches for WHEN something is wrong,
   * so it must REPORT a broken artifact rather than die on it. The
   * refuse-on-corrupt loaders protect the write paths (a write that proceeds
   * from a phantom-empty store destroys data), but propagating those throws out
   * of the diagnostic would take it down too. MCP `session_start` awaits
   * `status()`, so a single truncated file must not block session start.
   *
   * Keys are artifact names (`packs`, `episodes`, `tensions`); values are the
   * loader's message, which already carries the repair instructions.
   */
  store_errors?: Record<string, string>
  /** @deprecated Use `store_errors.packs`. Kept so existing readers still work. */
  pack_registry_error?: string
  /**
   * Spreading-activation association edges dropped since process start, by reason.
   * Accumulates across all `inject()` calls in this process — resets on restart.
   * `dropped_unresolvable`: target id absent from local engramMap (remote-only or
   * deleted engram). `dropped_retired`: target found but not active. Absent when
   * both counts are zero.
   */
  spread_drops?: { dropped_unresolvable: number; dropped_retired: number }
}


/**
 * One row of `listStores` / `listStoresAsync`. The primary local store plus
 * each configured `stores` entry. `description`/`covers` are present only when
 * the entry declares self-describing scope metadata.
 */
export interface StoreSummary {
  path?: string
  url?: string
  scope: string
  shared: boolean
  readonly: boolean
  engram_count: number
  /** Self-describing scope description, when the entry declares it. */
  description?: string
  /** Topics/domains this scope covers, when the entry declares it. */
  covers?: string[]
}


/**
 * Per-URL result of scope discovery against an enterprise server's `/api/v1/me`.
 * `unregistered` is the actionable set: scopes the token is authorized for but
 * that aren't yet in local config.
 */
export interface RemoteScopeDiscovery {
  url: string
  /** True when `/me` responded; false on network error, 401, etc. */
  ok: boolean
  username?: string
  org_id?: string
  role?: string
  /** All scopes the token is authorized for (from `/me`). Empty when `ok` is false. */
  authorized: string[]
  /** Scopes already registered in local config for this URL. */
  registered: string[]
  /** Authorized minus registered minus dismissed: the scopes a user could still add. */
  unregistered: string[]
  /**
   * Server-authoritative scope metadata for the authorized scopes, when the
   * remote serves it via `/api/v1/me` (`scope_metadata`). Each entry is a
   * validated {@link ScopeMetadata}. Empty when the server declares no
   * metadata; discovery still works, just without descriptions.
   */
  metadata: ScopeMetadata[]
  /** Present when `ok` is false. */
  error?: string
}


/**
 * Result of {@link Plur.refreshServerScopes} for one server entry.
 * `applied` is true when the answer replaced the cached `scopes` list.
 */
export interface ServerDiscoveryOutcome {
  url: string
  status: DiscoveryStatus
  applied: boolean
  /** The accepted list when `applied`, otherwise the cached list kept. */
  scopes: string[]
  rejected: ScopeRejection[]
  /** `pinned_scopes` the server's list does not name (they stay registered). */
  pinned_unlisted: string[]
  username?: string
  error?: string
}


/**
 * Health of one configured remote endpoint. Combines a live `/me`
 * probe with a local JWT-expiry read so callers can distinguish "auth
 * expired" (actionable: reauth) from "unreachable" (network), and warn
 * before a token expires rather than after.
 */
export interface RemoteHealth {
  url: string
  /** All entries at this endpoint use enterprise registration; false/absent for mixed legacy credentials. */
  enterprise?: boolean
  /** Scopes registered locally for this (url, token) group (for the report). */
  scopes: string[]
  /** 'ok' = /me succeeded; 'auth_expired' = 401/403 or JWT exp passed; 'unreachable' = network/timeout/5xx. */
  status: 'ok' | 'auth_expired' | 'unreachable'
  /** True only for status 'ok'. */
  ok: boolean
  /**
   * Set when the token comes from a `token_env` variable that is unset where
   * PLUR runs: the variable's name. No request was sent;
   * the fix is to set the variable, not to re-authenticate.
   */
  tokenEnvUnset?: string
  /** Human-readable reason when not ok. */
  reason?: string
  /** From the token's JWT `exp` claim, if decodable (opaque keys → null). */
  tokenExpiresAt?: string
  /** Whole days until token expiry (negative if past), or null if unknown. */
  tokenExpiresInDays?: number | null
  /** JWT `sub` claim, UNVERIFIED, display only. Absent for opaque keys. */
  tokenSubject?: string
  /** JWT org claim (`orgId`/`org_id`/`org`), UNVERIFIED, display only. */
  tokenOrg?: string
  /** Server-confirmed identity from the live `/me` probe (status 'ok' only). */
  username?: string
  /** Server-confirmed org from the live `/me` probe (status 'ok' only). */
  orgId?: string
  /** Number of scopes the server reports granted to this token (status 'ok' only). */
  grantedScopes?: number
}


export type CheckResult = 'ok' | 'fail' | 'could-not-check'

export interface ServerStoreCheck {
  url: string
  checks: Array<{ name: 'reachable' | 'key' | 'key-file' | 'scopes-fresh' | 'write-path' | 'queue'; result: CheckResult; detail: string }>
  ok: boolean
}


/** Outcome of registering discovered scopes for one URL. */
export interface RegisterDiscoveredResult {
  url: string
  ok: boolean
  added: string[]
  already_registered: string[]
  /** Scopes refused auto-registration: personal-family scopes a `/me` returned,
   *  scopes whose addStore threw, and dismissed scopes. */
  skipped: string[]
  error?: string
}


/** Options for {@link Plur.rescope}. */
export interface RescopeOptions {
  /**
   * After a successful REMOTE push, keep the local source engram active
   * instead of retiring it. Default false: the source is soft-retired with a
   * `superseded_by` link to the server copy, so it stops injecting and its
   * content hash cannot resurrect it (`_hashDedup` only matches active rows).
   * Ignored for local (in-place) rescopes — those move the row, nothing to keep.
   */
  keep_local?: boolean
  /** Report what WOULD happen without mutating anything, local or remote. */
  dry_run?: boolean
}


/** Per-engram outcome of {@link Plur.rescope}. */
export interface RescopeResult {
  /** Source engram id the caller passed. */
  id: string
  /**
   * 'rescoped'  — moved (or, with dry_run, would move).
   * 'deduped'   — an identical engram (content-hash + scope match) already
   *               exists at the target: idempotent success, nothing pushed;
   *               the source is still retired per keep_local.
   * 'noop'      — source already carries the target scope.
   * 'error'     — nothing was changed for this id; see `error`.
   */
  status: 'rescoped' | 'deduped' | 'noop' | 'error'
  /** Which path handled it: push to a configured remote store, or in-place scope rewrite. */
  action?: 'remote_push' | 'local_rewrite'
  from_scope?: string
  to_scope?: string
  /**
   * Where the engram lives after the rescope: the SERVER-assigned id for a
   * remote push, the unchanged id for a local rewrite, or the pre-existing
   * target engram's id on a dedup hit.
   */
  new_id?: string
  /** True when the local source stayed active (keep_local remote push). */
  kept_local?: boolean
  /** Echoed when options.dry_run was set — nothing was mutated. */
  dry_run?: boolean
  /**
   * Set when the source carried a PENDING outbox delivery that the rescope
   * cancelled.
   *
   * A failed remote write queues the engram with `structured_data._outbox`
   * naming the target url + scope. Leaving that entry in place would deliver
   * the engram to the store the user moved it away from once that store
   * recovers. Reported so the caller can tell a rescope that cancelled a
   * queued delivery from one that did not.
   */
  cancelled_outbox?: { target_url: string; target_scope: string }
  error?: string
}


/**
 * Where a learn result went. `remote`: a url store accepted it.
 * `outbox`: it is saved here and queued for a url store (the push is deferred,
 * or failed and will be retried). `local`: it exists on this machine only.
 */
export type LearnDelivery = 'remote' | 'outbox' | 'local'


/**
 * Why an engram went to the outbox instead of the server.
 * `auth_rejected`: the store answered 401/403 — the token is expired, revoked
 * or lacks rights, and retrying will not help until a person fixes it.
 * `unreachable`: no answer (network error or the caller's deadline passed).
 * `server_error`: the store answered with another error status.
 * `no_store`: no writable url store is registered for the scope.
 */
export type OutboxReasonCode = 'auth_rejected' | 'unreachable' | 'server_error' | 'no_store' | 'token_env_unset'


/** Options for {@link Plur.learnRouted}. */
export interface LearnRoutedOptions {
  /**
   * Deadline for the server request, in ms. When it passes, the engram is
   * saved locally and queued in the outbox — the save never fails because a
   * server is slow. Local work is never raced. Unset:
   * {@link DEFAULT_REMOTE_WRITE_TIMEOUT_MS}.
   */
  remoteTimeoutMs?: number
}


/** What {@link Plur.forget} and {@link Plur.feedback} did not refuse but want said. */
export interface MutationOutcome {
  /** Plain-language warnings, e.g. a remote whose token was rejected during the collision probe. */
  warnings: string[]
}


/** A dedup supersede target held in a writable secondary store. */
  export interface SecondarySupersede { id: string; path: string; originalId: string }


/** Per-store answer of the id-collision probe run by forget, feedback and setPinned. */
export interface CollisionProbe {
  scope: string
  url: string
  outcome: 'present' | 'absent' | 'auth_rejected' | 'unreachable'
  detail?: string
}
