export interface SecretMatch {
  pattern: string
  match: string
}

const SECRET_PATTERNS: { name: string; regex: RegExp }[] = [
  { name: 'aws_access_key', regex: /AKIA[0-9A-Z]{16}/ },
  { name: 'aws_secret_key', regex: /(?:aws_secret_access_key|secret_access_key)\s*[=:]\s*[A-Za-z0-9/+=]{40}/i },
  { name: 'generic_api_key', regex: /(?:^|[^a-z])(sk|pk)[-_][a-z0-9]{20,}/i },
  { name: 'api_key_assignment', regex: /(?:api[_-]?key|api[_-]?secret|secret[_-]?key)\s*[=:]\s*\S{20,}/i },
  { name: 'password_assignment', regex: /password\s*[=:]\s*\S{8,}/i },
  { name: 'connection_string', regex: /(?:postgres|mysql|mongodb|redis):\/\/\S+/ },
  { name: 'jwt', regex: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}/ },
  { name: 'private_key', regex: /-----BEGIN\s+\S+\s+PRIVATE KEY-----/ },
  { name: 'bearer_token', regex: /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/ },
]

/** Scan text for potential secrets. Returns empty array if clean. */
export function detectSecrets(text: string): SecretMatch[] {
  if (typeof text !== 'string') {
    throw new TypeError(`detectSecrets: expected string, got ${typeof text}`)
  }
  const matches: SecretMatch[] = []
  for (const { name, regex } of SECRET_PATTERNS) {
    const m = text.match(regex)
    if (m) {
      matches.push({ pattern: name, match: m[0].slice(0, 20) + '...' })
    }
  }
  return matches
}

/**
 * Prompt-injection / instruction-override patterns. Engram statements get
 * injected verbatim into future agent LLM contexts, so a third-party pack
 * carrying instruction-override text is a stored prompt-injection vector.
 * Curated for precision — this is a heuristic, not a guarantee; pattern lists
 * are inherently evadable, so it warns/blocks on the obvious, not the subtle.
 * (Security audit 2026-06-10, finding #2.)
 */
const INJECTION_PATTERNS: { name: string; regex: RegExp }[] = [
  { name: 'ignore_previous', regex: /\bignore\s+(?:all\s+|any\s+)?(?:previous|prior|earlier|the\s+above)\b/i },
  { name: 'disregard_above', regex: /\bdisregard\s+(?:all\s+|the\s+)?(?:previous|prior|earlier|above|instructions)\b/i },
  { name: 'forget_instructions', regex: /\bforget\s+(?:everything|all|your|the\s+(?:above|previous))\b/i },
  { name: 'override_instructions', regex: /\boverride\s+(?:your|the|all|previous|prior)\s+(?:instructions|rules|guidelines|safety|directives)\b/i },
  { name: 'reveal_system_prompt', regex: /\b(?:reveal|print|show|repeat|output)\s+(?:your|the)\s+system\s+prompt\b/i },
  { name: 'role_override', regex: /\byou\s+are\s+now\b|\bfrom\s+now\s+on,?\s+you\s+(?:are|will|must)\b/i },
  { name: 'bypass_safety', regex: /\b(?:bypass|disable|ignore|turn\s+off)\s+(?:the\s+)?(?:safety|guardrails?|restrictions?|guidelines|filters?)\b/i },
  { name: 'jailbreak_mode', regex: /\b(?:developer\s+mode|DAN\s+mode|jailbreak)\b/i },
  { name: 'system_tag_injection', regex: /<\/?system>|\[\/?system\]|^\s*system\s*:/im },
]

export interface InjectionMatch {
  pattern: string
  match: string
}

/** Scan text for prompt-injection / instruction-override patterns. Empty array if clean. */
export function detectPromptInjection(text: string): InjectionMatch[] {
  if (typeof text !== 'string') {
    throw new TypeError(`detectPromptInjection: expected string, got ${typeof text}`)
  }
  const matches: InjectionMatch[] = []
  for (const { name, regex } of INJECTION_PATTERNS) {
    const m = text.match(regex)
    if (m) {
      matches.push({ pattern: name, match: m[0].slice(0, 40) })
    }
  }
  return matches
}

// Sensitive-but-not-classic-secret patterns. `detectSecrets` catches credentials
// and tokens, but the 2026-06 engram leak was *infrastructure topology* — prod
// droplet IPs, an internal staging host with basic-auth, deployment layout — none
// of which `detectSecrets` matches. `detectSensitive` adds that layer; it gates
// the public engram set in the publish filter. Patterns are deliberately
// low-false-positive (an IP or a host:port in a *public* engram is the red flag).
const SENSITIVE_PATTERNS: { name: string; regex: RegExp }[] = [
  // user:pass@host inside a URL — e.g. https://team:secret@hub-staging.plur.ai
  { name: 'basic_auth_url', regex: /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i },
  // FQDN:port — e.g. hub-staging.plur.ai:443, db.internal:5432 (infra topology)
  { name: 'fqdn_port', regex: /\b(?:[a-z0-9-]+\.)+[a-z]{2,}:\d{2,5}\b/i },
  // IPv4:port — e.g. 139.59.155.82:8877
  { name: 'ipv4_port', regex: /\b\d{1,3}(?:\.\d{1,3}){3}:\d{2,5}\b/ },
]

// Any IPv4 that is NOT private/loopback/link-local/documentation is treated as a
// real (likely production) address — exactly the droplet-IP shape that leaked.
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
const NON_PUBLIC_IPV4 =
  /^(?:10\.|127\.|0\.|169\.254\.|192\.168\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|172\.(?:1[6-9]|2\d|3[01])\.|255\.)/

function isPublicIpv4(ip: string): boolean {
  const octets = ip.split('.').map(Number)
  if (octets.length !== 4 || octets.some(o => !Number.isInteger(o) || o < 0 || o > 255)) return false
  return !NON_PUBLIC_IPV4.test(ip)
}

// IPv6 — mirror isPublicIpv4's "public only" stance. We FLAG only a globally
// routable address (global unicast, 2000::/3) and exclude everything that is
// not internet-reachable: loopback (::1), link-local (fe80::/10), unique-local
// /ULA (fc00::/7, treated as private like 10.x), and the documentation prefix
// (2001:db8::/32). The candidate matcher is loose on purpose — `parseIpv6`
// then VALIDATES structurally (correct hextet count, at most one `::`), so a
// MAC address (00:11:22:33:44:55 — exactly six 2-hex groups, no `::`) or a
// generic colon-string fails to parse and is never flagged. Integer- or
// hex-encoded IPv4 (e.g. 2338339922) is deliberately NOT handled — too
// false-positive-prone — and is an accepted risk.
const IPV6_CANDIDATE = /\b(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}\b|\b(?:[0-9a-f]{1,4}:){1,7}:/gi

/**
 * Parse an IPv6 string into its 8 16-bit hextets, or return null if it is not
 * a structurally valid IPv6 address. Strictly validates `::` (at most one) and
 * the resulting hextet count (exactly 8), so non-IPv6 colon strings — MAC
 * addresses, `time:like:strings`, etc. — are rejected. A trailing embedded
 * IPv4 (e.g. `::ffff:192.0.2.1`) is intentionally NOT supported; such inputs
 * return null (accepted false negative, keeps the parser simple and strict).
 */
function parseIpv6(addr: string): number[] | null {
  if (addr.includes('.')) return null // no embedded-IPv4 form; keep it strict
  const dbl = addr.indexOf('::')
  if (dbl !== addr.lastIndexOf('::')) return null // more than one '::' is invalid

  const parseGroups = (s: string): number[] | null => {
    if (s === '') return []
    const out: number[] = []
    for (const g of s.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null
      out.push(parseInt(g, 16))
    }
    return out
  }

  if (dbl === -1) {
    const groups = parseGroups(addr)
    if (groups === null || groups.length !== 8) return null
    return groups
  }
  // One '::' — it expands to fill the missing hextets (at least one).
  const head = parseGroups(addr.slice(0, dbl))
  const tail = parseGroups(addr.slice(dbl + 2))
  if (head === null || tail === null) return null
  const fill = 8 - head.length - tail.length
  if (fill < 1) return null // '::' must stand in for >=1 omitted hextet
  return [...head, ...new Array(fill).fill(0), ...tail]
}

function isPublicIpv6(addr: string): boolean {
  const h = parseIpv6(addr)
  if (h === null) return false
  const [h0] = h
  // Loopback ::1  and unspecified ::  — not public.
  if (h.every(x => x === 0)) return false
  if (h.slice(0, 7).every(x => x === 0) && h[7] === 1) return false
  // Link-local fe80::/10  — top 10 bits = 1111111010.
  if ((h0 & 0xffc0) === 0xfe80) return false
  // Unique-local / ULA fc00::/7 (fc00::–fdff::) — treat as private like 10.x.
  if ((h0 & 0xfe00) === 0xfc00) return false
  // Documentation prefix 2001:db8::/32.
  if (h0 === 0x2001 && h[1] === 0x0db8) return false
  // Global unicast 2000::/3 (top 3 bits = 001) — the only range we flag.
  return (h0 & 0xe000) === 0x2000
}

// Targeted internal/infra hostname detection (portless variant — the ported
// form is already caught by `fqdn_port`). CONSERVATIVE by design: only
// high-signal forms, because a false match silently demotes a legitimate
// engram. We flag a multi-label hostname that EITHER ends in an unambiguous
// internal suffix label (.local/.internal/.corp/.lan/.intranet, or k8s
// .svc / .svc.cluster.local) OR contains a `staging` label. We do NOT flag
// standalone words (db/prod/redis alone) or ordinary public FQDNs
// (example.com, api.github.com). The leading `[a-z0-9-]+\.` requires at least
// two labels so a bare `internal` or `localhost` never trips it.
const INTERNAL_HOST = new RegExp(
  '\\b[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.' +
    '(?:local|internal|corp|lan|intranet|svc)\\b' + // unambiguous internal suffix label
    '|' +
    '\\b[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.svc\\.cluster\\.local\\b' + // k8s fully-qualified
    '|' +
    '\\b[a-z0-9-]*staging[a-z0-9-]*(?:\\.[a-z0-9-]+)+\\b' + // hostname with a staging label
    '|' +
    '\\b[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.staging(?:\\.[a-z0-9-]+)+\\b', // ...or staging as inner label
  'i',
)

/**
 * Scan text for secrets AND infrastructure-sensitive content (public IPv4/IPv6,
 * basic-auth URLs, host:port topology, internal/infra hostnames). Superset of
 * `detectSecrets` — this is the gate used before an engram is allowed into a
 * public/shipped set, because the visibility tag alone is not trustworthy (in
 * the 2026-06 leak, several of the worst engrams were mistagged `public`).
 * Returns [] only when clean.
 */
export function detectSensitive(text: string): SecretMatch[] {
  if (typeof text !== 'string') {
    throw new TypeError(`detectSensitive: expected string, got ${typeof text}`)
  }
  const matches = detectSecrets(text)
  for (const { name, regex } of SENSITIVE_PATTERNS) {
    const m = text.match(regex)
    if (m) matches.push({ pattern: name, match: m[0].slice(0, 30) + '...' })
  }
  for (const ip of text.match(IPV4) ?? []) {
    if (isPublicIpv4(ip)) {
      matches.push({ pattern: 'public_ipv4', match: ip })
      break
    }
  }
  for (const candidate of text.match(IPV6_CANDIDATE) ?? []) {
    if (isPublicIpv6(candidate)) {
      matches.push({ pattern: 'public_ipv6', match: candidate })
      break
    }
  }
  const internalHost = text.match(INTERNAL_HOST)
  if (internalHost) {
    matches.push({ pattern: 'internal_host', match: internalHost[0].slice(0, 30) })
  }
  return matches
}

/**
 * Sensitivity category a detector pattern belongs to. Lets per-scope policy
 * (ScopeMetadata.sensitivity) reason about `detectSensitive` hits in terms of
 * the broad families a scope forbids/allows — 'secrets' (credentials/tokens)
 * vs 'infra' (topology: IPs, internal hosts, host:port) — rather than the
 * fine-grained pattern names. The infra family is exactly the set introduced by
 * `detectSensitive` over `detectSecrets` (SENSITIVE_PATTERNS + public_ipv4 +
 * public_ipv6 + internal_host); everything else `detectSecrets` finds is a
 * credential, i.e. 'secrets'.
 */
const INFRA_PATTERN_NAMES = new Set<string>([
  ...SENSITIVE_PATTERNS.map(p => p.name),
  'public_ipv4',
  'public_ipv6',
  'internal_host',
])

export function sensitivityCategory(patternName: string): 'secrets' | 'infra' {
  return INFRA_PATTERN_NAMES.has(patternName) ? 'infra' : 'secrets'
}
