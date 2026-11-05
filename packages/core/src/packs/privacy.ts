import { userStructuredData } from '../content-fields.js'
import type { Engram } from '../schemas/engram.js'
import { detectPromptInjection, detectSensitive, truncateToScanLimit } from '../secrets.js'


export interface PrivacyScanResult {
  clean: boolean
  issues: PrivacyIssue[]
}


export interface PrivacyIssue {
  engram_id: string
  type: 'secret' | 'private_visibility' | 'personal_path' | 'email' | 'ip_address' | 'prompt_injection'
    /** A file the scan could not read as a plain file: a link, a special file, one past the size or count limit. Blocks install. */
    | 'unscannable'
  detail: string
  /**
   * Why an `unscannable` file could not be scanned (only on that type); the
   * install gate reads this, not `detail`. Links, special files or a truncated
   * walk mean the pack hides something: install refuses. Oversize or unreadable
   * plain files are reported and not copied; for `provenance/` records they must
   * not abort the install (provenance profile §5.4.2).
   */
  unscannable_reason?: 'symlink' | 'special' | 'entry_limit' | 'oversize' | 'read_error'
  /**
   * For `private_visibility` on a pack: `true` when the shipped file says
   * `visibility: private` itself (refused at install, §5.6.1 step 2); `false`
   * when the field was absent and the schema default made it private here.
   * Unset for scans that do not come from a pack file.
   */
  declared?: boolean
}


/**
 * Strip fields that let a third-party pack engram override the host's behavior:
 * `pinned` (bypasses the relevance gate: always injected) and a `locked`
 * commitment (resists dedup/correction). Returns sanitized engrams plus a count
 * for EACH field changed.
 *
 * Both counts exist because ENGRAM-STANDARD-v1 §5.6.1 step 3 and §5.6.5 require
 * a consumer to report how many engrams it neutralized AND which field it
 * changed.
 */
export function sanitizePackEngrams(engrams: Engram[]): {
  engrams: Engram[]
  pinnedStripped: number
  lockedDowngraded: number
  changed: boolean
} {
  let pinnedStripped = 0
  let lockedDowngraded = 0
  let changed = false
  const out = engrams.map(e => {
    const c = { ...e } as Record<string, unknown>
    if (c.pinned === true) { pinnedStripped++; changed = true }
    if ('pinned' in c) delete c.pinned
    // The tier and priority travel WITH `pinned` and must go with it. They are
    // inert while selection filters on `pinned === true`, but leaving a pack's
    // `pinned_tier: 'hard'` and `pinned_priority: 9999` in the store means the
    // next change that pins an engram for any other reason silently adopts a
    // third party's claim on the hard tier, which is guaranteed injection and
    // bypasses the per-pack and per-domain fairness caps. Any host-overriding
    // field added beside `pinned` must be added here too.
    if ('pinned_tier' in c) { delete c.pinned_tier; changed = true }
    if ('pinned_priority' in c) { delete c.pinned_priority; changed = true }
    if (c.commitment === 'locked') {
      c.commitment = 'decided'
      delete c.locked_at
      delete c.locked_reason
      lockedDowngraded++
      changed = true
    }
    return c as unknown as Engram
  })
  return { engrams: out, pinnedStripped, lockedDowngraded, changed }
}


export const PERSONAL_PATH_RE = /(?:\/Users\/\w+|\/home\/\w+|~\/|C:\\Users\\\w+)/

// Bounded quantifiers ({1,64}/{1,255}/{2,24}, within RFC limits) so the domain
// part can't backtrack catastrophically: an unbounded `+` is quadratic on a
// long dotted run after `@`. The cap in scanPrivacy bounds the input length
// and these bounds bound the per-start work.
export const EMAIL_RE = /[a-zA-Z0-9._%+-]{1,64}@[a-zA-Z0-9.-]{1,255}\.[a-zA-Z]{2,24}/

export const IP_RE = /\b(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b/


/**
 * Does the export privacy scan read this text as containing an email address?
 * Exposed so a surface can warn BEFORE a value is committed to: an identity
 * like `you@example.org` would make every export empty, and the place to say
 * so is the moment the identity is set, not the first empty pack.
 */
export function containsEmail(text: string): boolean {
  return EMAIL_RE.test(text)
}


// Fields excluded from the serialized secret/PII scan: exportPack strips these
// (relations/associations/knowledge_anchors never reach a pack), or they are
// internal/numeric bookkeeping that can't carry a meaningful credential and
// would only cause false rejections (local paths inside knowledge_anchors, the
// activation numbers, the id). EVERY other field, including future additions,
// is scanned, so the export gap can't silently reopen the way an enumerated
// field list would.
export const SECRET_SCAN_EXCLUDE = new Set<string>([
  'relations', 'associations', 'knowledge_anchors', 'activation',
  'embedding', 'id', 'created', 'updated', 'last_accessed',
])


/**
 * Serialize the secret/PII-bearing content of an engram for scanning. Scans the
 * SERIALIZED payload (not a hand-maintained field list) so a future caller-
 * settable field (tags, structured_data, contraindications, …) can't silently
 * reopen the export leak. PLUR-internal `_`-prefixed structured_data keys
 * (_outbox/_demoted) are dropped: they carry system host topology, never user
 * content, and would false-trip the scan.
 */
export function serializeForSecretScan(e: Engram): string {
  const scan: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(e as Record<string, unknown>)) {
    if (SECRET_SCAN_EXCLUDE.has(k)) continue
    // The same exemption the write guard applies, from the same list: PLUR's
    // own bookkeeping keys and nothing else, never any `_`-prefixed key a
    // caller cares to name.
    scan[k] = k === 'structured_data' ? (userStructuredData(v) ?? {}) : v
  }
  return JSON.stringify(scan)
}


export function scanPrivacy(engrams: Engram[]): PrivacyScanResult {
  const issues: PrivacyIssue[] = []

  for (const e of engrams) {
    // Check visibility: private engrams must never be exported, and a pack
    // that ships one is refused at install (§5.6.1 step 2). Record the flag but
    // DON'T skip the rest of the scan: the refusal names every finding at once,
    // and a pack must not be able to use visibility:private to keep secrets or
    // injection text out of the report.
    if (e.visibility === 'private') {
      issues.push({
        engram_id: e.id,
        type: 'private_visibility',
        detail: `Engram marked as private — excluded from export, still scanned`,
      })
    }

    // SECRET / PII scan covers the SERIALIZED engram payload (every caller-
    // settable, exported field), not a hand-picked list. exportPack serializes
    // the whole engram, so `tags`, `structured_data`, `contraindications` are
    // all exported verbatim, and a future field can't silently reopen the gap.
    // Cap the scan input BEFORE any regex touches it: the serialized JSON is
    // unbounded, and EMAIL_RE / IP_RE / PERSONAL_PATH_RE below run on
    // secretText directly, so a crafted pack could otherwise hang
    // preview/install/export on backtracking.
    const fullText = serializeForSecretScan(e)
    const secretText = truncateToScanLimit(fullText)

    // Secret AND infrastructure-sensitive patterns. detectSensitive is a superset
    // of detectSecrets that also catches public IPv4/IPv6, internal hosts,
    // basic-auth URLs and host:port, so an infra leak in summary/tags/source is
    // not exported clean.
    //
    // Pass the FULL serialized text, NOT the pre-truncated `secretText`.
    // detectSensitive caps its own regex work internally (ReDoS-safe) AND emits
    // the `scan_truncated` fail-closed hit when the input exceeds 1 MiB.
    // Pre-truncating would hide the over-cap, so a >1 MiB engram with sensitive
    // content past byte 1 MiB would pass CLEAN. The raw PII regexes below still
    // run on the bounded `secretText`.
    const secrets = detectSensitive(fullText)
    for (const s of secrets) {
      issues.push({
        engram_id: e.id,
        type: 'secret',
        detail: `${s.pattern}: ${s.match}`,
      })
    }

    // Prompt-injection / instruction-override is FIELD-based: only fields
    // rendered into agent context can carry an effective injection — statement +
    // rationale + source (formatLayer3), summary (formatLayer1), domain
    // (formatLayer3). Scanning arbitrary serialized metadata for injection would
    // add false positives without a real attack surface.
    const injectionText = truncateToScanLimit(
      [e.statement, e.rationale, e.source, e.summary, e.domain].filter(Boolean).join(' '),
    )
    const injections = detectPromptInjection(injectionText)
    for (const inj of injections) {
      issues.push({
        engram_id: e.id,
        type: 'prompt_injection',
        detail: `${inj.pattern}: "${inj.match}"`,
      })
    }

    // Personal paths
    if (PERSONAL_PATH_RE.test(secretText)) {
      issues.push({
        engram_id: e.id,
        type: 'personal_path',
        detail: `Contains personal path: ${secretText.match(PERSONAL_PATH_RE)?.[0]}`,
      })
    }

    // Email addresses
    const emailMatch = secretText.match(EMAIL_RE)
    if (emailMatch) {
      issues.push({
        engram_id: e.id,
        type: 'email',
        detail: `Contains email: ${emailMatch[0]}`,
      })
    }

    // Private IP addresses
    const ipMatch = secretText.match(IP_RE)
    if (ipMatch) {
      issues.push({
        engram_id: e.id,
        type: 'ip_address',
        detail: `Contains private IP: ${ipMatch[0]}`,
      })
    }
  }

  return { clean: issues.length === 0, issues }
}
