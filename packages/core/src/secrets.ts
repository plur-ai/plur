export interface SecretMatch {
  pattern: string
  match: string
}

const SECRET_PATTERNS: { name: string; regex?: RegExp; find?: (text: string) => string | null }[] = [
  // `AKIA` is a long-term access key id, `ASIA` a temporary (STS) one; both are
  // the four-letter prefix plus 16 uppercase letters or digits, 20 in all.
  //
  // The `AKIA` branch has no boundary. The `ASIA` branch is stricter, because
  // `ASIA` begins ordinary uppercase words ("ASIAPACIFICNORTHEAST1"). It must be exactly 20 characters between
  // non-alphanumerics and contain a digit. A real temporary key id with no
  // digit in its 16-character body is missed; for a uniformly random body
  // over A-Z and 0-9 that is (26/36)^16, about 0.5%, and the key id alone is
  // not a usable credential without its secret and session token.
  { name: 'aws_access_key', regex: /AKIA[0-9A-Z]{16}|(?<![A-Za-z0-9])ASIA(?=[A-Z0-9]{0,15}[0-9])[0-9A-Z]{16}(?![A-Za-z0-9])/ },
  // Vendor-prefixed tokens. Each follows the vendor's documented
  // prefix, charset and minimum length, and must not be glued onto the end of
  // a longer word, so prose that names a prefix ("use a ghp_ token") stays
  // clean. The guard only looks for a preceding LETTER: a token glued after a
  // digit ("1ghp_…") or after a percent-encoded `=` ("%3Dghp_…") is still a
  // token; the percent-decoded view below covers the latter too.
  //
  // GitHub: `ghp_` classic PAT, `gho_` OAuth, `ghu_` user-to-server,
  // `ghs_` server-to-server, `ghr_` refresh — 36 base62 characters today;
  // GitHub reserves the right to grow them, so longer bodies still match.
  { name: 'github_token', regex: /(?<![A-Za-z])gh[pousr]_[A-Za-z0-9]{36,}/ },
  // GitHub fine-grained PAT: `github_pat_`, 22 base62, `_`, 59 base62.
  { name: 'github_pat', regex: /(?<![A-Za-z])github_pat_[A-Za-z0-9]{22,}_[A-Za-z0-9]{40,}/ },
  // GitLab's documented token prefixes (docs.gitlab.com, "Token prefixes").
  // Bodies may contain `-` and `_`, so docs slugs like `glrt-runner-...` have
  // the right length; the body must also show case/digit structure (lower-or-
  // digit then upper, upper then upper-or-digit, or four digits), which slugs
  // lack. A seeded random-body test checks real tokens still match.
  // Lookahead runs are bounded to 64 characters to avoid quadratic time on
  // repeated prefixes (`glpat-glpat-…`).
  {
    name: 'gitlab_token',
    regex: /(?<![A-Za-z])(?:glpat|gloas|gldt|glrtr|glrt|glcbt|glptt|glft|glimt|glagent|glwt|glsoat|glffct)-(?=[A-Za-z0-9_-]{0,64}(?:[a-z0-9][A-Z]|[A-Z][A-Z0-9])|(?:[A-Za-z_-]{0,64}[0-9]){4})[A-Za-z0-9_-]{20,}/,
  },
  // Slack: `xoxb-`/`xoxp-`/`xoxs-` need a numeric id of 8+ digits; legacy
  // `xoxa-`/`xoxr-` need an unbroken run with letters and digits, so short
  // numbers followed by hyphenated words (prose) do not match.
  // App-level (`xapp-`) and rotation (`xoxe-`, `xoxe.xox[bp]-`) tokens are
  // separate shapes.
  {
    name: 'slack_token',
    regex: /(?<![A-Za-z])(?:xox[bps]-[0-9]{8,}-[A-Za-z0-9-]{10,}|xox[ar]-(?:[0-9]-)?(?=[A-Za-z]*[0-9])(?=[0-9]*[A-Za-z])[A-Za-z0-9]{16,}|xapp-[0-9]+-[A-Z0-9]{8,}-[0-9]{8,}-[A-Za-z0-9]{16,}|xoxe(?:\.xox[bp])?-[0-9]+-[A-Za-z0-9]{100,})/,
  },
  // npm access token: `npm_` plus 36 base62 characters.
  { name: 'npm_token', regex: /(?<![A-Za-z])npm_[A-Za-z0-9]{36,}/ },
  // Stripe live secret (`sk_live_`) and restricted (`rk_live_`) keys. The
  // generic `sk` shape below already catches `sk_live_`; the named pattern
  // covers `rk_live_` and says what the key is.
  { name: 'stripe_live_key', regex: /(?<![A-Za-z])[sr]k_live_[A-Za-z0-9]{24,}/ },
  { name: 'aws_secret_key', regex: /(?:aws_secret_access_key|secret_access_key)\s*[=:]\s*[A-Za-z0-9/+=]{40}/i },
  // Twenty or more characters after the prefix, and the segments MAY be
  // separated by hyphens or underscores, so keys that carry structure in
  // their prefix (e.g. `sk-ant-api03-…`) match too.
  //
  // The body must START alphanumeric, so a run of punctuation cannot make up
  // the length, and the prefix still has to be a real `sk`/`pk` token.
  { name: 'generic_api_key', regex: /(?:^|[^a-z])(sk|pk)[-_][a-z0-9][a-z0-9_-]{19,}/i },
  { name: 'api_key_assignment', regex: /(?:api[_-]?key|api[_-]?secret|secret[_-]?key)\s*[=:]\s*\S{20,}/i },
  { name: 'password_assignment', regex: /password\s*[=:]\s*\S{8,}/i },
  { name: 'connection_string', regex: /(?:postgres|mysql|mongodb|redis):\/\/\S+/ },
  // Matched in code, not by regex: see findJwt.
  { name: 'jwt', find: findJwt },
  { name: 'private_key', regex: /-----BEGIN\s+\S+\s+PRIVATE KEY-----/ },
  { name: 'bearer_token', regex: /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/ },
]

const isJwtSegmentChar = (c: number): boolean =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95

/**
 * The leftmost match of `eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}` in
 * `text`, or null, in linear time. As a regex it is quadratic, and bounding
 * the runs would cap real multi-kilobyte payloads. So this anchors on each
 * `.eyJ` and walks back/forward; runs end at a dot, so walks are disjoint.
 * Tests check it against the regex on seeded random inputs.
 */
function findJwt(text: string): string | null {
  for (let dot = text.indexOf('.eyJ'); dot !== -1; dot = text.indexOf('.eyJ', dot + 1)) {
    // Payload: `eyJ` then at least ten segment characters, as many as follow.
    let end = dot + 4
    while (end < text.length && isJwtSegmentChar(text.charCodeAt(end))) end++
    if (end - (dot + 4) < 10) continue
    // Header: the segment run ending at the dot.
    let runStart = dot
    while (runStart > 0 && isJwtSegmentChar(text.charCodeAt(runStart - 1))) runStart--
    const start = text.indexOf('eyJ', runStart)
    if (start === -1 || start + 13 > dot) continue
    return text.slice(start, end)
  }
  return null
}

/**
 * The raw text and, when it differs, the folded copy a reader would see.
 *
 * A zero-width joiner inside `AKIA…` splits the key for every regex and for no
 * human — the same evasion the injection detector folds away
 * (`foldForMatching`). Both views are scanned so nothing that matches the raw
 * text stops matching; a pattern is reported once whichever view found it.
 */
function scanViews(text: string): string[] {
  const folded = foldForMatching(text)
  return folded === text ? [text] : [text, folded]
}

/**
 * The text with percent-encoded ASCII decoded, or null when there is none:
 * URL-encoded credentials (`access_token%3Dghp_…`) otherwise hide separators.
 * Scanned IN ADDITION to the raw text; up to three passes; only `%00`–`%7F`;
 * malformed `%` left as is, so it never throws.
 * Credentials only: infra patterns keep the raw and folded views.
 */
function percentDecodedView(text: string): string | null {
  if (!/%[0-7][0-9A-Fa-f]/.test(text)) return null
  let out = text
  for (let pass = 0; pass < 3; pass++) {
    const next = out.replace(/%([0-7][0-9A-Fa-f])/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    if (next === out) break
    out = next
  }
  return out === text ? null : out
}

const ESCAPES: Record<string, string> = {
  n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '\\': '\\', '"': '"', '/': '/',
}

/**
 * The text with literal backslash escapes unfolded (JSON escapes and ASCII
 * `\u00XX`), or null when there are none. Escaped newlines put a letter `n`
 * before a token, which the vendor patterns' boundary rejects.
 * Scanned IN ADDITION to the raw text; up to three linear passes.
 */
function escapeUnfoldedView(text: string): string | null {
  if (!/\\(?:[nrtbf\\"/]|u00[0-7][0-9A-Fa-f])/.test(text)) return null
  let out = text
  for (let pass = 0; pass < 3; pass++) {
    const next = out.replace(/\\(?:([nrtbf\\"/])|u00([0-7][0-9A-Fa-f]))/g, (_, c: string | undefined, hex: string | undefined) =>
      c !== undefined ? ESCAPES[c] : String.fromCharCode(parseInt(hex as string, 16)))
    if (next === out) break
    out = next
  }
  return out === text ? null : out
}

/**
 * The part of each credential match that is a label, not a secret: the
 * vendor prefix, the keyword of an assignment, the URL scheme. A pattern
 * missing here shows its first four characters.
 */
const FINDING_PREFIX: Record<string, RegExp> = {
  aws_access_key: /^A[KS]IA/,
  github_token: /^gh[pousr]_/,
  github_pat: /^github_pat_/,
  gitlab_token: /^gl[a-z]+-/,
  slack_token: /^(?:xoxe(?:\.xox[bp])?|xox[a-z]|xapp)-/,
  npm_token: /^npm_/,
  stripe_live_key: /^[sr]k_live_/,
  aws_secret_key: /^[^=:]*[=:]\s*/,
  // The match includes the separator before `sk`/`pk`; group 1 leaves it out.
  generic_api_key: /^[^a-z]?((?:sk|pk)[-_])/i,
  api_key_assignment: /^[^=:]*[=:]\s*/,
  password_assignment: /^[^=:]*[=:]\s*/,
  connection_string: /^[a-z]+:\/\//,
  jwt: /^eyJ/,
  private_key: /^[\s\S]*/,
  bearer_token: /^Bearer\s+/,
}

/**
 * What a finding shows of the matched credential: its prefix, then `...`,
 * then the last four characters when at least 16 follow the prefix. The
 * finding reaches pack-scan issue details, so it must not echo enough of the
 * body to matter. Four trailing characters tell a reader which credential it
 * is, the way vendor dashboards identify keys; a value shorter than 16
 * characters, such as a password, is not shown at all.
 */
function maskFinding(name: string, matched: string): string {
  // A prefix pattern with a capture group shows only the group; the whole
  // match is still what is withheld from the tail.
  const m = FINDING_PREFIX[name]?.exec(matched)
  const prefix = m ? (m[1] ?? m[0]) : matched.slice(0, 4)
  const rest = matched.slice(m ? m[0].length : 4)
  if (rest.length === 0) return prefix
  return prefix + '...' + (rest.length >= 16 ? rest.slice(-4) : '')
}

/** Scan text for potential secrets. Returns empty array if clean. */
export function detectSecrets(text: string): SecretMatch[] {
  if (typeof text !== 'string') {
    throw new TypeError(`detectSecrets: expected string, got ${typeof text}`)
  }
  const matches: SecretMatch[] = []
  const found = new Set<string>()
  // Raw text first, then the percent-decoded and escape-unfolded copies,
  // each also folded (see scanViews).
  const bases = [text]
  const decoded = percentDecodedView(text)
  if (decoded !== null) bases.push(decoded)
  const unescaped = escapeUnfoldedView(text)
  if (unescaped !== null) bases.push(unescaped)
  const views = bases.flatMap(scanViews)
  for (const view of views) {
    for (const { name, regex, find } of SECRET_PATTERNS) {
      if (found.has(name)) continue
      const m = find ? find(view) : (view.match(regex as RegExp)?.[0] ?? null)
      if (m !== null) {
        found.add(name)
        matches.push({ pattern: name, match: maskFinding(name, m) })
      }
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

/**
 * Characters that look like Latin letters and are not.
 *
 * Only the pairs that are visually identical in ordinary type. A wider table
 * would fold letters a reader can tell apart and produce false positives.
 */
const LOOKALIKES: Record<string, string> = {
  // Cyrillic
  '\u0430': 'a', '\u0435': 'e', '\u043e': 'o', '\u0440': 'p', '\u0441': 'c',
  '\u0445': 'x', '\u0443': 'y', '\u0456': 'i', '\u0458': 'j', '\u04bb': 'h',
  '\u0410': 'A', '\u0412': 'B', '\u0415': 'E', '\u041a': 'K', '\u041c': 'M',
  '\u041d': 'H', '\u041e': 'O', '\u0420': 'P', '\u0421': 'C', '\u0422': 'T',
  '\u0425': 'X', '\u0406': 'I',
  // Greek
  '\u03bf': 'o', '\u03b1': 'a', '\u03b5': 'e', '\u03c1': 'p', '\u03c5': 'u',
  '\u0391': 'A', '\u0392': 'B', '\u0395': 'E', '\u0396': 'Z', '\u0397': 'H',
  '\u0399': 'I', '\u039a': 'K', '\u039c': 'M', '\u039d': 'N', '\u039f': 'O',
  '\u03a1': 'P', '\u03a4': 'T', '\u03a7': 'X',
}

/**
 * Fold text to the form a reader sees before matching, so lookalike letters,
 * zero-width characters or fullwidth forms cannot slip past every pattern.
 * NFKC collapses presentation forms, invisible formatting characters are
 * removed, then lookalikes are mapped.
 * Match on the folded copy but REPORT the original text.
 */
export function foldForMatching(text: string): string {
  // Pure ASCII has nothing to fold — no invisible characters, no lookalikes,
  // no presentation forms — and this runs on every write and every pack file,
  // up to the 1 MiB scan cap. One regex test spares the normalisation.
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7f]/.test(text)) return text
  const folded = text
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u00ad]/g, '')
  let out = ''
  for (const ch of folded) out += LOOKALIKES[ch] ?? ch
  return out
}

/** Scan text for prompt-injection / instruction-override patterns. Empty array if clean. */
export function detectPromptInjection(text: string): InjectionMatch[] {
  if (typeof text !== 'string') {
    throw new TypeError(`detectPromptInjection: expected string, got ${typeof text}`)
  }
  const matches: InjectionMatch[] = []
  const folded = foldForMatching(text)
  const wasDisguised = folded !== text
  for (const { name, regex } of INJECTION_PATTERNS) {
    const plain = text.match(regex)
    const hidden = plain ? null : folded.match(regex)
    const m = plain ?? hidden
    if (!m) continue
    // Report WHAT IT SAYS, from the folded copy, and say that it was hidden.
    // Quoting the raw bytes alone would show a reader something that looks
    // ordinary and give no hint why it was flagged; quoting only the folded
    // text would hide that somebody went to the trouble of disguising it.
    matches.push({
      pattern: hidden && wasDisguised ? `${name} (disguised)` : name,
      match: m[0].slice(0, 40),
    })
  }
  return matches
}

// Sensitive-but-not-classic-secret patterns. `detectSecrets` catches credentials
// and tokens; `detectSensitive` adds *infrastructure topology* — production
// IPs, internal hosts with basic-auth, deployment layout — which `detectSecrets`
// does not match. It gates the public engram set in the publish filter.
// Patterns are deliberately low-false-positive (an IP or a host:port in a
// *public* engram is the red flag).
const SENSITIVE_PATTERNS: { name: string; regex: RegExp }[] = [
  // user:pass@host credential URL, with or without scheme, username may be
  // empty. A password and `@host` are required, so `key:value` and `time:12:30`
  // do not match.
  //   A) With `scheme://`: unambiguous, so the host stays loose.
  //   B) Scheme-less: the host must look like one (dotted domain with TLD,
  //      localhost, IPv4, or host:port), so `5:30@cafe` does not match.
  // Every quantifier is bounded: unbounded ones backtrack quadratically.
  {
    name: 'basic_auth_url',
    regex:
      /(?:[a-z][a-z0-9+.-]{0,31}:\/\/[^/\s:@]{0,64}:[^/\s@]{1,128}@[a-z0-9.-]|[^/\s:@]{0,64}:[^/\s@]{1,128}@(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}|localhost|\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9-]+:\d{2,5}))/i,
  },
  // FQDN:port, e.g. db.internal:5432 (infra topology).
  // ReDoS: the host is one leading label plus bounded `\.label` groups, so every
  // `.` is a hard anchor and the scan is linear.
  // Code-ref gate: a negative lookahead excludes source/file extensions in the
  // TLD position so `inject.ts:49` is not host:port; it inherits the `i` flag.
  {
    name: 'fqdn_port',
    regex:
      /\b[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){0,7}\.(?!(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|rb|java|kt|c|cc|cpp|cxx|h|hpp|cs|php|swift|scala|clj|ex|exs|erl|hs|ml|md|mdx|json|jsonc|toml|ini|conf|cfg|lock|txt|csv|tsv|xml|html|htm|css|scss|sass|less|sh|bash|zsh|sql|vue|svelte|dart|lua|r|pl|pm|yaml|yml):)[a-z]{2,24}:\d{2,5}\b/i,
  },
  // IPv4:port — e.g. 203.0.113.82:8877
  { name: 'ipv4_port', regex: /\b\d{1,3}(?:\.\d{1,3}){3}:\d{2,5}\b/ },
]

// Any IPv4 that is NOT private/loopback/link-local/documentation is treated as a
// real (likely production) address.
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

// Portless internal/infra hostname detection (`fqdn_port` covers the ported
// form). Conservative, because a false match silently demotes an engram: flag
// a multi-label host that ends in an internal suffix (.local/.internal/.corp/
// .lan/.intranet, .svc[.cluster.local]) OR contains a `staging` label; never
// standalone words or public FQDNs.
// Two passes: INTERNAL_HOST finds host-shaped tokens (only the host is in the
// named group); isInternalHostFalsePositive is the sole FP gate (known-extension
// tail; config stem before an internal suffix). Use `matchInternalHost`, which
// iterates all global matches (named groups are undefined on non-global `.match()`).
const INTERNAL_HOST = new RegExp(
  // One `(?<host>...)` group wraps the host shapes (a-d): JS forbids duplicate
  // named groups, so the leading delimiter and trailing lookahead are shared
  // and `match.groups.host` is always set.
  // Delimiters include `.` `,` `;` `]` `=` and backtick, so hosts at sentence
  // end, in lists, backticks or assignments are caught.
  // ReDoS: quantifiers are bounded and every `.` is a hard anchor, keeping
  // the scan linear (this runs on every guarded write).
  "(?:^|[\\s/@'\"(`\\[=,;.\\]])(?<host>" +
    // a. internal-suffix label (.local/.internal/.corp/.lan/.intranet)
    '[a-z0-9-]{1,63}(?:\\.[a-z0-9-]{1,63}){0,7}\\.(?:local|internal|corp|lan|intranet)' +
    '|' +
    // b. k8s svc / svc.cluster.local
    '[a-z0-9-]{1,63}(?:\\.[a-z0-9-]{1,63}){0,7}\\.svc(?:\\.cluster\\.local)?' +
    '|' +
    // c. staging as a label fragment (hub-staging.example.com, staging-build.example.com)
    '[a-z0-9-]{0,30}staging[a-z0-9-]{0,30}(?:\\.[a-z0-9-]{1,63}){1,8}' +
    '|' +
    // d. staging as an inner label (api.staging.example.com)
    '[a-z0-9-]{1,63}(?:\\.[a-z0-9-]{1,63}){0,7}\\.staging(?:\\.[a-z0-9-]{1,63}){1,8}' +
    ")(?=$|[\\s:/?#)\\]'\"`,;.=])",
  'gi',
)

// PASS 2 — the SOLE false-positive gate over a PASS-1 host candidate. Returns
// true when the host-shaped token is actually a config/data file path or a
// known config-tool stem (so it should NOT be flagged as an internal host).
//
// RULE 1 (known-extension tail): a host ending in a config/data FILE extension
// is a filename, not a host — kills data-staging.csv, staging-build.yml,
// app.config.yml, tsconfig.json.
// RULE 2 (curated config-stem before an internal suffix): `.local`/`.internal`/
// etc. is NOT a file extension, so RULE 1 cannot catch config.local /
// vite.config.local. We reject when the host is a known config-tool stem
// immediately before an internal suffix.
const FILE_EXTENSION_TAIL =
  /\.(?:ya?ml|csv|md|mdx|js|jsx|ts|tsx|json|jsonc|toml|ini|conf|cfg|lock|txt|env|xml|html?|sh|py|rb|go|rs)$/i
// RULE 2 IS A KNOWN-INCOMPLETE ALLOWLIST. A config tool NOT listed here (e.g.
// myapp.config.local) WILL be falsely flagged and silently demoted. To add a
// tool: extend this alternation. This is the sole curated FP gate; there is no
// general "looks like a config file" heuristic by design: an over-broad
// heuristic would let real internal hosts through.
const CONFIG_STEM_BEFORE_INTERNAL_SUFFIX =
  /(?:^|\.)(?:vite\.config|jest\.config|eslint\.config|webpack\.config|rollup\.config|babel\.config|next\.config|tailwind\.config|postcss\.config|svelte\.config|astro\.config|vitest\.config|playwright\.config|tsconfig(?:\.[a-z0-9-]+)?|config)\.(?:local|internal|corp|lan|intranet)$/i

function isInternalHostFalsePositive(host: string): boolean {
  if (FILE_EXTENSION_TAIL.test(host)) return true // RULE 1
  if (CONFIG_STEM_BEFORE_INTERNAL_SUFFIX.test(host)) return true // RULE 2
  return false
}

/**
 * Two-pass internal-host detector: returns the first host-shaped token
 * (INTERNAL_HOST) that survives the FP gate, or null. Real internal hosts such
 * as app.corp or db.internal deliberately stay flagged.
 * Iterates every global match so an FP-gated token cannot hide a later real
 * host. INTERNAL_HOST is shared state: reset `lastIndex` and guard zero-width matches.
 */
function matchInternalHost(text: string): string | null {
  INTERNAL_HOST.lastIndex = 0
  for (let m: RegExpExecArray | null; (m = INTERNAL_HOST.exec(text)); ) {
    // Advance past zero-width matches so the loop always makes progress.
    if (m.index === INTERNAL_HOST.lastIndex) INTERNAL_HOST.lastIndex++
    // Named-group invariant: every PASS-1 alternative wraps the host token in
    // `(?<host>...)`, so a match always yields `m.groups.host`. If a future
    // engine path returns no named group, skip it (fail safe) rather than throw.
    const host = m.groups?.host
    if (!host) continue
    if (isInternalHostFalsePositive(host)) continue
    return host
  }
  return null
}

// Scan-input ceiling. Every pattern is linear-time, so a full 1 MiB pass costs
// at most a few hundred ms; 1 MiB is far above any realistic engram.
// Beyond it we do NOT truncate-and-pass: `detectSensitive` emits a synthetic
// `scan_truncated` hit so the write guard demotes and `scanPrivacy` blocks
// (fail-closed — an unscanned tail can't be certified clean).
const MAX_SCAN_BYTES = 1024 * 1024

/** Synthetic detector name emitted when input exceeded MAX_SCAN_BYTES. */
export const SCAN_TRUNCATED = 'scan_truncated'

export function truncateToScanLimit(text: string): string {
  // Buffer.byteLength avoids materializing a Buffer for the common (small) case.
  if (Buffer.byteLength(text, 'utf8') <= MAX_SCAN_BYTES) return text
  // Replace-mode decode (default) — a multi-byte char split at the boundary
  // becomes U+FFFD; no exception, no silent corruption, always valid UTF-8.
  return Buffer.from(text, 'utf8').subarray(0, MAX_SCAN_BYTES).toString('utf8')
}

/**
 * Scan for secrets AND infrastructure-sensitive content (public IPs, basic-auth
 * URLs, host:port, internal hostnames). Superset of `detectSecrets`; the gate
 * before an engram enters a public/shipped set, since the visibility tag alone
 * is not trustworthy. Returns [] only when clean.
 *
 * Input over MAX_SCAN_BYTES emits a synthetic `scan_truncated` hit (fail-closed);
 * the write guard and `scanPrivacy` inherit this bound.
 */
export function detectSensitive(text: string): SecretMatch[] {
  if (typeof text !== 'string') {
    throw new TypeError(`detectSensitive: expected string, got ${typeof text}`)
  }
  // Byte-aware: cap the scanned region at MAX_SCAN_BYTES and remember whether the
  // input was longer (so the tail goes UN-scanned). Buffer.byteLength avoids
  // materializing a Buffer for the common (small) case.
  const totalBytes = Buffer.byteLength(text, 'utf8')
  const truncated = totalBytes > MAX_SCAN_BYTES
  // The cut never throws and always yields valid text (see truncateToScanLimit).
  if (truncated) text = truncateToScanLimit(text)
  const matches = detectSecrets(text)
  // Same two views as detectSecrets, for the same reason: an invisible
  // character inside a host name or an address must not hide it.
  const found = new Set<string>()
  for (const view of scanViews(text)) {
    for (const { name, regex } of SENSITIVE_PATTERNS) {
      if (found.has(name)) continue
      const m = view.match(regex)
      if (m) { found.add(name); matches.push({ pattern: name, match: m[0].slice(0, 30) + '...' }) }
    }
    if (!found.has('public_ipv4')) {
      for (const ip of view.match(IPV4) ?? []) {
        if (isPublicIpv4(ip)) {
          found.add('public_ipv4')
          matches.push({ pattern: 'public_ipv4', match: ip })
          break
        }
      }
    }
    if (!found.has('public_ipv6')) {
      for (const candidate of view.match(IPV6_CANDIDATE) ?? []) {
        if (isPublicIpv6(candidate)) {
          found.add('public_ipv6')
          matches.push({ pattern: 'public_ipv6', match: candidate })
          break
        }
      }
    }
    if (!found.has('internal_host')) {
      const internalHost = matchInternalHost(view)
      if (internalHost) {
        found.add('internal_host')
        matches.push({ pattern: 'internal_host', match: internalHost.slice(0, 30) })
      }
    }
  }
  if (truncated) {
    // Fail-closed: the region past MAX_SCAN_BYTES was not scanned, so we
    // cannot certify it clean. Signal it so the write guard demotes and the pack
    // privacy scan blocks — a sensitive payload can't hide in the tail.
    matches.push({ pattern: SCAN_TRUNCATED, match: `${totalBytes} bytes (> ${MAX_SCAN_BYTES}B scan limit)` })
  }
  return matches
}

/**
 * Sensitivity family of a detector pattern, so per-scope policy
 * (ScopeMetadata.sensitivity) can forbid/allow 'secrets' (credentials) vs
 * 'infra' (IPs, internal hosts, host:port). Infra is exactly what
 * `detectSensitive` adds over `detectSecrets`; everything else is 'secrets'.
 */
// `basic_auth_url` is a password in a URL, so it is 'secrets', not 'infra':
// a `forbid:['secrets']` policy must catch it.
const INFRA_PATTERN_NAMES = new Set<string>([
  ...SENSITIVE_PATTERNS.map(p => p.name).filter(n => n !== 'basic_auth_url'),
  'public_ipv4',
  'public_ipv6',
  'internal_host',
])

export function sensitivityCategory(patternName: string): 'secrets' | 'infra' {
  return INFRA_PATTERN_NAMES.has(patternName) ? 'infra' : 'secrets'
}
