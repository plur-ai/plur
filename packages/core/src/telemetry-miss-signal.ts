// Failed-recall miss-signal (WS5 demand flywheel).
//
// When a hybrid recall returns zero engrams OR a top RRF score below a
// configurable relevance floor, that is a *demand signal*: the user asked
// memory something it could not answer. Aggregated across installs, the shape
// of those misses tells us what knowledge the ecosystem is hungry for — the
// input to the WS5 demand flywheel (pack bounties, gap clustering). This module
// only EMITS the anonymized miss; clustering/bounty logic lives downstream and
// is deliberately out of scope here.
//
// Privacy invariants (shared with telemetry-counters / telemetry-flush):
//   1. Opt-in, default-off. Every public function short-circuits on
//      !isTelemetryEnabled() BEFORE any network call. A default-off install
//      makes zero network calls and writes zero files for miss-signals.
//   2. Content-free AND identifier-free. The raw query NEVER leaves the process
//      — we ship a SHA-256 fingerprint of the normalized query (irreversible).
//      The scope is reduced to its KIND only (#312): 'project:acme-secret'
//      becomes 'project', so a user's private project/client name in the scope
//      path is never transmitted. The domain (a generic topic label such as
//      'trading' — the actual demand signal) and a reason code and UTC date
//      round out the payload. No query text, no engram text, no result bodies,
//      no scope paths, no identity beyond the opaque install id.
//   3. Never throws. On any failure (network, timeout, non-2xx) emit() resolves
//      to false; the caller's recall path is never disturbed.
//
// Transport mirrors telemetry-flush's heartbeat: a single small JSON POST to a
// documented endpoint, AbortController timeout, errors swallowed. Unlike the
// daily counter heartbeat, a miss is emitted at the moment it happens (fire-
// and-forget) because the signal is the event, not a daily aggregate.

import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { isTelemetryEnabled } from './telemetry.js'
import { readOrCreateInstallId } from './telemetry-counters.js'

/** Why a recall counted as a miss. */
export type MissReason = 'no_results' | 'low_score'

export type MissSignalOpts = {
  env?: NodeJS.ProcessEnv
  configPath?: string
  installIdPath?: string
  fetch?: typeof globalThis.fetch
  endpoint?: string
  timeoutMs?: number
  now?: () => Date
}

export type MissSignalInput = {
  /** Raw query — hashed locally, NEVER transmitted. */
  query: string
  /** Scope filter the caller passed, if any (coarse routing label). */
  scope?: string
  /** Domain filter the caller passed, if any (coarse routing label). */
  domain?: string
  /** Number of engrams the recall returned (0 ⇒ no_results). */
  resultCount: number
  /** Top RRF score, or null when no engrams matched. */
  topScore: number | null
}

/** Exact wire shape — these fields and nothing else. */
export type MissSignalPayload = {
  install_id: string
  query_fingerprint: string
  /** Scope KIND only (e.g. 'project', 'group', 'global') — never the user-defined
   *  scope path, which can carry private project/client names (#312). */
  scope_type: string | null
  domain: string | null
  reason: MissReason
  result_count: number
  date: string
}

/** Recognized scope kinds. Anything else collapses to 'other' so no free-text
 *  label can ride along disguised as a kind. */
const KNOWN_SCOPE_KINDS = ['global', 'local', 'project', 'group', 'space', 'user', 'org', 'team']

/**
 * Reduce a scope label to its KIND, dropping the user-defined path (#312).
 * 'project:acme-secret' → 'project'; 'global' → 'global'. The scope path has no
 * analytics value (only the kind matters for routing), but it can identify a
 * user's private projects or clients, so only the kind is transmitted.
 */
export function scopeType(scope: string | undefined | null): string | null {
  if (!scope) return null
  const kind = (scope.includes(':') ? scope.slice(0, scope.indexOf(':')) : scope).trim().toLowerCase()
  return KNOWN_SCOPE_KINDS.includes(kind) ? kind : 'other'
}

const DEFAULT_ENDPOINT = 'https://plur.ai/v1/miss-signal'
const DEFAULT_TIMEOUT_MS = 5000

// Below this top RRF score we treat a non-empty result set as a miss: the
// engrams that came back are too weakly related to the query to be a real hit.
// Tunable via PLUR_MISS_SCORE_THRESHOLD. RRF scores are small (1/(k+rank+1),
// k=60 ⇒ a single top-1 hit scores ~0.0164; the floor sits just under that so a
// lone weak match still registers as a miss while genuine multi-list hits pass.
export const DEFAULT_MISS_SCORE_THRESHOLD = 0.015

function resolveThreshold(env: NodeJS.ProcessEnv): number {
  const raw = env.PLUR_MISS_SCORE_THRESHOLD
  if (raw === undefined) return DEFAULT_MISS_SCORE_THRESHOLD
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) ? parsed : DEFAULT_MISS_SCORE_THRESHOLD
}

function resolveEndpoint(opts: MissSignalOpts, env: NodeJS.ProcessEnv): string {
  if (opts.endpoint) return opts.endpoint
  return env.PLUR_MISS_SIGNAL_ENDPOINT ?? DEFAULT_ENDPOINT
}

function defaultInstallIdPath(): string {
  return join(homedir(), '.plur', 'install-id')
}

function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/**
 * Normalize then SHA-256-hash the query. Irreversible: there is no way to
 * recover the query from the fingerprint, but two installs that miss on the
 * same normalized phrasing produce the same fingerprint — which is exactly the
 * clustering key WS5 needs, with zero content disclosure.
 */
export function fingerprintQuery(query: string): string {
  const normalized = query.trim().toLowerCase().replace(/\s+/g, ' ')
  return createHash('sha256').update(normalized, 'utf8').digest('hex')
}

/**
 * Classify a recall result as a hit or a miss. Pure, side-effect-free, gate-
 * independent — the gate is checked in emitMissSignal, not here, so this stays
 * unit-testable in isolation.
 */
export function classifyMiss(
  input: Pick<MissSignalInput, 'resultCount' | 'topScore'>,
  threshold: number = DEFAULT_MISS_SCORE_THRESHOLD,
): MissReason | null {
  if (input.resultCount === 0) return 'no_results'
  if (input.topScore === null) return 'no_results'
  if (input.topScore < threshold) return 'low_score'
  return null
}

export function buildMissSignalPayload(
  input: MissSignalInput,
  reason: MissReason,
  installId: string,
  now: Date,
): MissSignalPayload {
  return {
    install_id: installId,
    query_fingerprint: fingerprintQuery(input.query),
    scope_type: scopeType(input.scope),
    domain: input.domain ?? null,
    reason,
    result_count: input.resultCount,
    date: utcDate(now),
  }
}

async function postMissSignal(
  payload: MissSignalPayload,
  opts: MissSignalOpts,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const endpoint = resolveEndpoint(opts, env)
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchImpl = opts.fetch ?? globalThis.fetch
  if (!fetchImpl) return false

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Emit a failed-recall miss-signal if (a) telemetry is opted-in AND (b) the
 * recall classifies as a miss. Returns true only when a signal was actually
 * sent and acknowledged; false in every other case (opted-out, hit, or send
 * failure). Never throws.
 *
 * Fire-and-forget from the recall path: callers do `void emitMissSignal(...)`.
 */
export async function emitMissSignal(
  input: MissSignalInput,
  opts: MissSignalOpts = {},
): Promise<boolean> {
  const env = opts.env ?? process.env
  // Privacy invariant 1: opted-out ⇒ no fingerprinting, no install-id read,
  // no network. Short-circuit before touching anything.
  if (!isTelemetryEnabled({ env, configPath: opts.configPath })) return false

  const threshold = resolveThreshold(env)
  const reason = classifyMiss(input, threshold)
  if (reason === null) return false // a hit — nothing to signal

  try {
    const installId = readOrCreateInstallId(opts.installIdPath ?? defaultInstallIdPath())
    const now = (opts.now ?? (() => new Date()))()
    const payload = buildMissSignalPayload(input, reason, installId, now)
    return await postMissSignal(payload, opts, env)
  } catch {
    // Never disturb the recall path.
    return false
  }
}
