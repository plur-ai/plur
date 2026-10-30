/**
 * Session memory manifest (#1657): which engrams an agent had in its context
 * during one session, as one canonical object that can be checked later.
 *
 * Three roles, each read from a record PLUR already keeps:
 *  - injected — `co_injection` history events carrying the session id;
 *  - recalled — `recall_returned` history events carrying the session id;
 *  - written  — engrams whose `sources[].session_id` is the session.
 *
 * Each listed engram carries `record_hash`, a SHA-256 over the canonical form
 * of its content fields, so `verifySessionManifest` can tell an edited
 * rationale from an untouched engram. There is deliberately no hash of the
 * bare statement (`content_hash`): it is unsalted, so a published one would
 * let anyone confirm a guessed memory text (0.23 audit, finding 3). The record
 * hash is unsalted too, but covers rationale, tags, provenance and attribution
 * (with their timestamps), which a guesser does not have.
 *
 * What a manifest says: these engrams were in the agent's context when it
 * acted. It never says they caused the action.
 *
 * What it never contains: engram text, scope names, tags or domains. Scope
 * names can carry customer names, and a manifest is made to be published.
 *
 * No network here. Uploading a manifest to write-once storage is done outside
 * core (the `WormStore` interface below), because core makes no external calls.
 */
import { createHash } from 'crypto'
import { readHistory, listHistoryMonths, sortKeysDeep, type HistoryEvent } from './history.js'
import type { Engram } from './schemas/engram.js'

export const SESSION_MANIFEST_SCHEMA = 'plur/session-manifest/v1'

/** The engram fields `record_hash` covers. Bookkeeping (counts, timestamps, activation) is excluded: it changes on every read. */
export const RECORD_HASH_FIELDS = [
  'statement', 'rationale', 'type', 'scope', 'domain', 'commitment', 'tags',
  'provenance', 'attribution', 'claim_class', 'polarity',
] as const

/**
 * SHA-256 over the canonical bytes (sorted keys, no whitespace) of the
 * engram's content fields. Computed, never stored: a hash kept in the file it
 * protects is a corruption check, not an edit check.
 */
export function computeRecordHash(engram: Partial<Engram> | Record<string, unknown>): string {
  const src = engram as Record<string, unknown>
  const picked: Record<string, unknown> = {}
  for (const f of RECORD_HASH_FIELDS) {
    const v = src[f]
    if (v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0)) picked[f] = v
  }
  return createHash('sha256').update(JSON.stringify(sortKeysDeep(picked))).digest('hex')
}

export type ManifestRole = 'injected' | 'recalled' | 'written'

export interface ManifestEntry {
  id: string
  role: ManifestRole
  /** null when the engram is not in the local store (a team store, or since removed). */
  record_hash: string | null
  reason?: 'not in local store'
}

export interface SessionManifest {
  schema: typeof SESSION_MANIFEST_SCHEMA
  session_id: string
  /** The configured identity (`provenance.identity`), or the unidentified marker. */
  actor: string
  window: { from: string | null; to: string | null }
  /** The newest checkpoint written in this session, when there is one (#1052): anchoring the manifest anchors it too. */
  checkpoint?: { event_hash: string; store_hash?: string; signer?: string; signature?: string }
  engrams: ManifestEntry[]
  created_at: string
}

export interface BuildManifestInput {
  root: string
  sessionId: string
  actor: string
  /** Every engram the local store holds, active or not. */
  engrams: readonly Engram[]
  /** A checkpoint the caller just wrote for this session; preferred over one found in the log. */
  checkpoint?: SessionManifest['checkpoint']
  now?: Date
}

function sessionOf(ev: HistoryEvent): string | undefined {
  // A history line can parse to JSON null or a scalar; it is no session's event.
  if (!ev || typeof ev !== 'object') return undefined
  const s = (ev.data as { session_id?: unknown } | undefined)?.session_id
  return typeof s === 'string' ? s : undefined
}

/**
 * Build the manifest for one session from the history log and the store.
 * Hashes are those of the engrams as they are now; a later edit shows up as
 * CHANGED when the manifest is verified.
 */
export function buildSessionManifest(input: BuildManifestInput): SessionManifest {
  const { root, sessionId, actor } = input
  const byId = new Map(input.engrams.map(e => [e.id, e]))
  const roles = new Map<string, ManifestRole>()
  const order: string[] = []
  const add = (id: string, role: ManifestRole): void => {
    if (!id || roles.has(id)) return
    roles.set(id, role)
    order.push(id)
  }
  let from: string | null = null
  let to: string | null = null
  let checkpoint: SessionManifest['checkpoint']
  const seen = (ts: string): void => {
    if (!from || ts < from) from = ts
    if (!to || ts > to) to = ts
  }

  for (const month of listHistoryMonths(root)) {
    for (const ev of readHistory(root, month)) {
      if (sessionOf(ev) !== sessionId) continue
      if (ev.event === 'co_injection' || ev.event === 'recall_returned') {
        seen(ev.timestamp)
        const ids = (ev.data as { ids?: unknown }).ids
        if (Array.isArray(ids)) {
          for (const id of ids) if (typeof id === 'string') add(id, ev.event === 'co_injection' ? 'injected' : 'recalled')
        }
      } else if (ev.event === 'checkpoint' && typeof ev.hash === 'string') {
        seen(ev.timestamp)
        const d = ev.data as { store_hash?: unknown }
        checkpoint = {
          event_hash: ev.hash,
          ...(typeof d.store_hash === 'string' ? { store_hash: d.store_hash } : {}),
          ...(ev.signer ? { signer: ev.signer } : {}),
          ...(ev.signature ? { signature: ev.signature } : {}),
        }
      }
    }
  }

  for (const e of input.engrams) {
    const sources = (e as unknown as { sources?: Array<{ session_id?: string | null; stored_at?: string }> }).sources ?? []
    const mine = sources.filter(s => s?.session_id === sessionId)
    if (mine.length === 0) continue
    for (const s of mine) if (s.stored_at) seen(s.stored_at)
    // A memory the session wrote is listed as written even if it was also injected.
    if (roles.has(e.id)) roles.set(e.id, 'written')
    else add(e.id, 'written')
  }

  const entries: ManifestEntry[] = order.map(id => {
    const e = byId.get(id)
    if (!e) return { id, role: roles.get(id)!, record_hash: null, reason: 'not in local store' }
    return { id, role: roles.get(id)!, record_hash: computeRecordHash(e) }
  })

  return {
    schema: SESSION_MANIFEST_SCHEMA,
    session_id: sessionId,
    actor,
    window: { from, to },
    ...((input.checkpoint ?? checkpoint) ? { checkpoint: input.checkpoint ?? checkpoint } : {}),
    engrams: entries,
    created_at: (input.now ?? new Date()).toISOString(),
  }
}

/** Canonical bytes of a manifest: what is uploaded and what its hash covers. */
export function canonicalManifestBytes(manifest: SessionManifest): Buffer {
  return Buffer.from(JSON.stringify(sortKeysDeep(manifest)), 'utf8')
}

export type ManifestCheck = 'MATCH' | 'CHANGED' | 'NOT AVAILABLE'

export interface ManifestVerification {
  session_id: string
  results: Array<{ id: string; role: ManifestRole; status: ManifestCheck; detail?: string }>
  counts: Record<ManifestCheck, number>
  /**
   * True when nothing CHANGED and, if any engram is listed, at least one
   * matched. NOT AVAILABLE entries are counted; a check in which every listed
   * engram is NOT AVAILABLE checked nothing, so it is not ok (audit finding 12).
   */
  ok: boolean
}

/** Re-hash each listed engram in the verifier's store. */
export function verifySessionManifest(manifest: SessionManifest, engrams: readonly Engram[]): ManifestVerification {
  if (manifest?.schema !== SESSION_MANIFEST_SCHEMA || !Array.isArray(manifest.engrams)) {
    throw new Error(`not a PLUR session manifest (expected schema "${SESSION_MANIFEST_SCHEMA}")`)
  }
  const byId = new Map(engrams.map(e => [e.id, e]))
  const counts: Record<ManifestCheck, number> = { MATCH: 0, CHANGED: 0, 'NOT AVAILABLE': 0 }
  const results = manifest.engrams.map(entry => {
    const e = byId.get(entry.id)
    let status: ManifestCheck
    let detail: string | undefined
    if (entry.record_hash === null) { status = 'NOT AVAILABLE'; detail = 'the manifest has no hash for it (not in the writer\'s local store)' }
    else if (!e) { status = 'NOT AVAILABLE'; detail = 'not in this store' }
    else if (computeRecordHash(e) === entry.record_hash) status = 'MATCH'
    else { status = 'CHANGED'; detail = 'edited since the manifest was made' }
    counts[status]++
    return { id: entry.id, role: entry.role, status, ...(detail ? { detail } : {}) }
  })
  const nothingChecked = results.length > 0 && counts.MATCH === 0 && counts.CHANGED === 0
  return { session_id: manifest.session_id, results, counts, ok: counts.CHANGED === 0 && !nothingChecked }
}

/**
 * Write-once storage for manifests (#1657, decision of 2026-10-17). Swarm is
 * the first and only implementation, outside core. The interface exists so a
 * second store can be added without touching callers; there is no registry.
 */
export interface WormPutResult {
  reference: string
  /** SHA-256 of the stored bytes, as the store reports it. */
  content_hash?: string
  signer?: string
  signature?: string
  timestamp?: string
  /** When the stamp used runs out, as the store estimates it; the data can disappear after. */
  expires_at?: string
  /** The signature could not be read back yet (rate limit); it is on the stored document. */
  signature_pending?: boolean
}

export interface WormStore {
  readonly name: string
  put(bytes: Buffer): Promise<WormPutResult>
  get(reference: string): Promise<{ bytes: Buffer; content_hash?: string; signer?: string; signature?: string; timestamp?: string }>
}
