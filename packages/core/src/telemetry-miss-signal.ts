// Failed-recall miss-signal: a hybrid recall with zero results or a top RRF score
// below the floor is a demand signal. This module only EMITS the anonymized
// miss (fire-and-forget POST); clustering happens downstream.
// Privacy invariants (shared with telemetry-counters / telemetry-flush):
//   1. Opt-in, default-off: every public function checks isTelemetryEnabled()
//      BEFORE any network call or file write.
//   2. Content- and identifier-free: only a SHA-256 of the normalized query, the
//      scope KIND, the domain's first segment, a reason code and UTC date.
//   3. Never throws: emit() resolves false on any failure.

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
  /** Domain filter the caller passed, if any. Only its first dotted segment is
   *  transmitted (see domainHead). */
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
  /** Scope KIND only (e.g. 'project', 'group', 'global'), never the user-defined
   *  scope path, which can carry private project/client names. */
  scope_type: string | null
  /** First dotted segment of the domain only (e.g. 'trading'), never the full
   *  user-defined path. */
  domain: string | null
  reason: MissReason
  result_count: number
  date: string
}

/** Recognized scope kinds. Anything else collapses to 'other' so no free-text
 *  label can ride along disguised as a kind. */
const KNOWN_SCOPE_KINDS = ['global', 'local', 'project', 'group', 'space', 'user', 'org', 'team']

/**
 * Reduce a scope label to its KIND, dropping the user-defined path.
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

// Below this top RRF score a non-empty result is a miss (PLUR_MISS_SCORE_THRESHOLD
// overrides). RRF rank r scores 1/(61 + r) per leg, summed over BM25 and
// embeddings. 0.025 sits between 1/61 and 2/61: a top hit found by only one
// leg is `low_score`; one found by both is a hit. Any value below 1/61 would
// make `low_score` unreachable. In BM25-only mode every weak top hit is `low_score`.
export const DEFAULT_MISS_SCORE_THRESHOLD = 0.025

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
 * same normalized phrasing produce the same fingerprint, which serves as a
 * clustering key with zero content disclosure.
 */
export function fingerprintQuery(query: string): string {
  const normalized = query.trim().toLowerCase().replace(/\s+/g, ' ')
  return createHash('sha256').update(normalized, 'utf8').digest('hex')
}

/**
 * Classify a recall result as a hit or a miss. Pure and gate-independent:
 * the telemetry gate is checked in emitMissSignal, so this stays unit-testable.
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

/**
 * Reduce a domain label to its FIRST dotted segment:
 * 'trading.client-foo.deal-42' → 'trading'. Domains are user-defined and can
 * carry private project/client names; the leading segment is the topic, which
 * is the demand signal. Absent or empty → null.
 */
export function domainHead(domain: string | undefined | null): string | null {
  if (!domain) return null
  const head = domain.split('.')[0].trim()
  return head === '' ? null : head
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
    domain: domainHead(input.domain),
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
