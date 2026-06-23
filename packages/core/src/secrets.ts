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
  // user:pass@host credential URL. Catches the full form
  // (https://team:secret@hub-staging.plur.ai), the scheme-less form
  // (user:pass@host:5432/db), and the empty-username form (https://:token@host).
  // The scheme is optional; the username may be empty; a password and an `@host`
  // are required so a bare `key:value` or a `time:12:30` (no `@host`) is NOT a
  // match. (#353 LOW-16.)
  //
  // SPEC-DEVIATION (bounded quantifiers): the plan's literal form used unbounded
  // `*`/`+` (`(?:[a-z][a-z0-9+.-]*:\/\/)?[^/\s:@]*:[^/\s@]+@`). Making the scheme
  // optional re-introduced O(n^2) backtracking — on 64KB of a `:`-free run the
  // userinfo class scans for a `:` that never comes at every start position
  // (~5.8s on a truncated 64KB input; the old `://`-anchored form was linear).
  // D3 keeps the 64KB length cap as defense-in-depth but 64KB is still far too
  // slow, so we bound each unbounded quantifier (the CHARACTER CLASSES are
  // unchanged from the plan — only `*`/`+` became bounded `{0,N}`/`{1,N}`). Real
  // basic-auth userinfo and passwords are short, so the bounds preserve every
  // functional case (full / scheme-less / empty-username) while restoring linear
  // time (~0.3ms on 64KB instead of ~5.8s).
  // SCHEME-LESS FP FIX (reaudit #6): the prior form required only a single
  // `[a-z0-9.-]` char after `@`, so benign `word:word@word` prose (`5:30@cafe`,
  // `3:1@ratio`, `name:value@scope`, `meet:me@noon`) false-matched and demoted
  // engrams as 'secrets'. We now split into two alternatives:
  //   A) SCHEME-PRESENT (`scheme://user:pass@<any host char>`) — unchanged from
  //      the prior form; a real `://` URL is unambiguous, so the host stays loose.
  //   B) SCHEME-LESS (`user:pass@<host>`) — the `@host` must LOOK like a host:
  //      a dotted domain with a TLD (covers `db.internal`, `hub.example.com`),
  //      `localhost`, a dotted-quad IPv4 (`10.0.0.5`), or a `host:port`
  //      (covers the PR-2 `user:pass@host:5432/db` form where the host has no
  //      dot). Benign `digit:digit@word` / `name:value@scope` no longer match.
  // The bounded quantifiers on userinfo/password are preserved (linear time on
  // the 64KB-capped scan input; verified <35ms on adversarial 64KB inputs).
  {
    name: 'basic_auth_url',
    regex:
      /(?:[a-z][a-z0-9+.-]{0,31}:\/\/[^/\s:@]{0,64}:[^/\s@]{1,128}@[a-z0-9.-]|[^/\s:@]{0,64}:[^/\s@]{1,128}@(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}|localhost|\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9-]+:\d{2,5}))/i,
  },
  // FQDN:port — e.g. hub-staging.plur.ai:443, db.internal:5432 (infra topology)
  //
  // BOUNDED QUANTIFIERS (reaudit #3, ReDoS fix): the prior form
  // `(?:[a-z0-9-]+\.)+[a-z]{2,}:\d{2,5}` had a `+`-over-`+` ambiguity — when the
  // trailing `:port` failed to match, the engine explored every partition of a
  // dotted run, giving catastrophic O(n^2) backtracking (~4s on a 64KB `a.a.a…`
  // run at the scan cap; the 64KB cap does NOT help because 64KB IS the worst
  // case). We rewrite the host as a single leading label followed by bounded
  // `\.label` groups — every `.` is a hard anchor, so there is no cross-label
  // backtracking — and bound each quantifier (label len {1,63}, up to 7 inner
  // `.label` groups, TLD {2,24}, port {2,5}), mirroring the basic_auth_url fix.
  // Now linear: the same 64KB inputs scan in <7ms.
  //
  // CODE-REF FP GATE (reaudit #3, FP fix): a code location of the form
  // `file.ext:line` (inject.ts:49, app.py:100, scope-util.ts:12, main.rs:55,
  // file.go:42, a.b.ts:10) previously matched as host:port — the extension looks
  // like a TLD and the line number like a port — silently demoting shareable
  // code-citing engrams out of shared scopes. We exclude a curated set of source/
  // file extensions in the TLD position via a negative lookahead anchored to the
  // `:port` boundary (`(?!(?:ts|py|rs|…):)`), so `file.ts:49` is NOT flagged while
  // a real `host.tld:port` (db.internal:5432, hub.example.com:443,
  // redis.prod.svc:6379) still is. The lookahead inherits the `i` flag, so
  // `Main.RS:55` and `Config.YAML:33` are excluded too.
  {
    name: 'fqdn_port',
    regex:
      /\b[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){0,7}\.(?!(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|rb|java|kt|c|cc|cpp|cxx|h|hpp|cs|php|swift|scala|clj|ex|exs|erl|hs|ml|md|mdx|json|jsonc|toml|ini|conf|cfg|lock|txt|csv|tsv|xml|html|htm|css|scss|sass|less|sh|bash|zsh|sql|vue|svelte|dart|lua|r|pl|pm|yaml|yml):)[a-z]{2,24}:\d{2,5}\b/i,
  },
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
// (example.com, api.github.com).
//
// TWO-PASS DESIGN (#353): the prior single-regex form silently demoted real,
// shareable content — `config.local`, `data-staging.csv`, `staging-build.yml`,
// `vite.config.local`, `app.config.yml`, `tsconfig.json` all matched as "infra".
// We now split the work:
//   PASS 1 (INTERNAL_HOST below): find host-SHAPED candidate tokens. Every
//     alternative wraps ONLY the host token in a `(?<host>...)` named group; the
//     leading delimiter lives in a NON-capturing `(?:^|[\s/@'"(])` prefix OUTSIDE
//     the group. PASS 2 then runs on `match.groups.host` — so each alternative
//     MUST have the named group, or PASS 2 silently no-ops for that branch.
//   PASS 2 (isInternalHostFalsePositive): the SOLE false-positive gate. Exactly
//     two rules (known-extension tail; curated config-stem before internal
//     suffix). No other heuristic. Host-shaped tokens that survive both rules are
//     flagged.
// Invoked via `matchInternalHost` which iterates ALL matches with the global
// flag (NOT `text.match()` — named groups are undefined on a non-global
// `.match()`); see that function for why a single candidate is NOT sufficient
// (reaudit #3: an FP-gated leading candidate must not hide a real host later).
const INTERNAL_HOST = new RegExp(
  // ONE `(?<host>...)` group wrapping the four host-SHAPE alternatives (a-d). JS
  // forbids duplicate named groups in a single regex (CI Node 20/22 throw
  // "Duplicate capture group name" on reuse), so the leading delimiter and the
  // trailing lookahead are factored out and SHARED; only the host shapes alternate
  // INSIDE the group, so `match.groups.host` is always set on a match. The single
  // named group is preserved with the `g` flag (no duplicate-name compile error).
  //
  // PUNCT FN FIX (reaudit #2, completed reaudit #3): the prior trailing lookahead
  // `(?=$|[\s:/?#)'"])` was far narrower than the original `\b` boundary — it
  // OMITTED `.` `,` `;` `]` `=` and backtick, so a real internal host at the end
  // of a sentence or before punctuation (`db.internal.`, `app.corp,`,
  // `` `db.internal` ``) escaped the guard entirely. The trailing lookahead gained
  // those terminators in reaudit #2. The LEADING delimiter, however, was left as
  // `(?:^|[\s/@'"(`\[])` — missing `=` `,` `;` — so the env-var assignment form
  // `host=db.internal` / `DATABASE_HOST=app.corp` and a comma-separated host list
  // `a,db.internal` still escaped PASS-1 (the host FOLLOWS the `=`/`,`, and the
  // engine never started a match). reaudit #3 adds `=` `,` `;` (and `.` `]` for
  // symmetry with the trailing class) to the leading delimiter, so both sides now
  // accept the same terminators and the assignment form is caught. The host SHAPE
  // consumes internal dots greedily (it prefers the longest host), so `.` in the
  // leading class only matches a separator BEFORE the host and does NOT truncate
  // `db.internal.corp`.
  //
  // BOUNDED QUANTIFIERS (reaudit #3, ReDoS fix): the prior host alternatives used
  // `(?:[a-z0-9-]+\.)+SUFFIX` — a `+`-over-`+` ambiguity identical to the old
  // fqdn_port. On a long dotted run that never ends in an internal suffix
  // (`ab.ab.ab…`, 64KB) the engine backtracked over every partition at every start
  // position (~8s at the scan cap — a write/publish DoS, since matchInternalHost
  // runs on every guarded write). We rewrite each alternative as a single leading
  // label `[a-z0-9-]{1,63}` followed by bounded `(?:\.[a-z0-9-]{1,63}){0,N}` inner
  // groups and a hard `\.` before the suffix — every `.` is an anchor, so there is
  // no cross-label backtracking. Linear now: the same 64KB run scans in <8ms.
  // Bounds (up to ~9 labels) cover every realistic internal hostname.
  "(?:^|[\\s/@'\"(`\\[=,;.\\]])(?<host>" +
    // a. internal-suffix label (.local/.internal/.corp/.lan/.intranet)
    '[a-z0-9-]{1,63}(?:\\.[a-z0-9-]{1,63}){0,7}\\.(?:local|internal|corp|lan|intranet)' +
    '|' +
    // b. k8s svc / svc.cluster.local
    '[a-z0-9-]{1,63}(?:\\.[a-z0-9-]{1,63}){0,7}\\.svc(?:\\.cluster\\.local)?' +
    '|' +
    // c. staging as a label fragment (hub-staging.plur.ai, staging-build.example.com)
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
// general "looks like a config file" heuristic by design (over-broad heuristics
// re-open the silent-demotion problem this rewrite exists to fix).
const CONFIG_STEM_BEFORE_INTERNAL_SUFFIX =
  /(?:^|\.)(?:vite\.config|jest\.config|eslint\.config|webpack\.config|rollup\.config|babel\.config|next\.config|tailwind\.config|postcss\.config|svelte\.config|astro\.config|vitest\.config|playwright\.config|tsconfig(?:\.[a-z0-9-]+)?|config)\.(?:local|internal|corp|lan|intranet)$/i

function isInternalHostFalsePositive(host: string): boolean {
  if (FILE_EXTENSION_TAIL.test(host)) return true // RULE 1
  if (CONFIG_STEM_BEFORE_INTERNAL_SUFFIX.test(host)) return true // RULE 2
  return false
}

/**
 * Run the two-pass internal-host detector over `text`. Returns the FIRST flagged
 * host token that survives the FP gate, or null if no host-shaped candidate does.
 *
 * PASS 1 finds host-shaped tokens (INTERNAL_HOST, named `host` group); PASS 2 is
 * the sole FP gate with exactly two rules (known-extension tail; curated
 * config-stem before internal suffix). DELIBERATELY accepts that real
 * internal-host shapes — app.corp, dataset.internal, db.internal — stay flagged.
 *
 * SCAN-ALL-MATCHES FN FIX (reaudit #3): the prior code did a single
 * non-global `INTERNAL_HOST.exec(text)` and bailed if that LEFTMOST candidate was
 * FP-gated — so a real internal host appearing AFTER an FP-gated config token
 * (e.g. `see config.local then ssh db.internal.corp`) was never seen. We now
 * iterate EVERY match with the global flag and return the first host the FP gate
 * lets through. INTERNAL_HOST is global, so we reset `lastIndex` before the loop
 * (the regex is module-level state) and guard zero-width matches to avoid an
 * infinite loop.
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

// Scan-input ceiling (#353, #386). The publish loop scans whole serialized
// engrams and `_guardSensitiveScope` scans statement + JSON.stringify(context),
// so an unbounded input is an unbounded scan. Every pattern is now bounded
// (basic_auth_url reaudit #1, fqdn_port reaudit #3 — both rewritten to linear-time
// forms with no `+`-over-`+` ambiguity). Benign filler is ~7ms/64KB under V8
// Irregexp, but adversarial regex-dense input is ~4x that: a full 1 MiB pass
// measured ~300-420ms worst case (#386 review). Still bounded and linear — this
// is a per-write CPU cost on >64KB engrams, not a DoS. We therefore scan a
// generous 1 MiB window — far above any realistic engram — instead of the old
// 64KB cap, which left infra-family content past byte 64KB UN-scanned and
// silently passed to shared/remote stores (the #386 blind spot).
//
// Beyond the ceiling we do NOT silently truncate-and-pass: `detectSensitive`
// emits a synthetic `scan_truncated` hit so the write guard demotes and
// `filterPublishable` excludes — fail-closed, since the unscanned tail can't be
// certified clean. Realistic engrams never approach 1 MiB, so this never falsely
// demotes ordinary content.
const MAX_SCAN_BYTES = 1024 * 1024

/** Synthetic detector name emitted when input exceeded MAX_SCAN_BYTES (#386). */
export const SCAN_TRUNCATED = 'scan_truncated'

/**
 * Scan text for secrets AND infrastructure-sensitive content (public IPv4/IPv6,
 * basic-auth URLs, host:port topology, internal/infra hostnames). Superset of
 * `detectSecrets` — this is the gate used before an engram is allowed into a
 * public/shipped set, because the visibility tag alone is not trustworthy (in
 * the 2026-06 leak, several of the worst engrams were mistagged `public`).
 * Returns [] only when clean.
 *
 * Scans at most the first 64KB of input. Inputs over the cap are truncated (a
 * leading credential is still caught); callers must NOT assume full-input
 * scanning. The cap is applied here, so all three call sites — `detectSensitive`
 * itself, the publish loop (publish.ts), and `_guardSensitiveScope`'s scanText
 * (index.ts) — inherit the bound.
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
  if (truncated) {
    // Replace-mode decode (default) — a multi-byte char split at the boundary
    // becomes U+FFFD; no exception, no silent corruption, always valid UTF-8.
    text = Buffer.from(text, 'utf8').subarray(0, MAX_SCAN_BYTES).toString('utf8')
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
  const internalHost = matchInternalHost(text)
  if (internalHost) {
    matches.push({ pattern: 'internal_host', match: internalHost.slice(0, 30) })
  }
  if (truncated) {
    // Fail-closed (#386): the region past MAX_SCAN_BYTES was not scanned, so we
    // cannot certify it clean. Signal it so the write guard demotes and
    // filterPublishable excludes — a sensitive payload can't hide in the tail.
    matches.push({ pattern: SCAN_TRUNCATED, match: `${totalBytes} bytes (> ${MAX_SCAN_BYTES}B scan limit)` })
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
// `basic_auth_url` is a credential-in-a-URL (a password), so it belongs to the
// 'secrets' family, NOT 'infra' — a custom `forbid:['secrets']` policy must catch
// a password-in-URL. It lives in SENSITIVE_PATTERNS (it surfaces only via
// `detectSensitive`), so we spread the rest of SENSITIVE_PATTERNS as infra but
// explicitly exclude it here. (#353 LOW-19.)
const INFRA_PATTERN_NAMES = new Set<string>([
  ...SENSITIVE_PATTERNS.map(p => p.name).filter(n => n !== 'basic_auth_url'),
  'public_ipv4',
  'public_ipv6',
  'internal_host',
])

export function sensitivityCategory(patternName: string): 'secrets' | 'infra' {
  return INFRA_PATTERN_NAMES.has(patternName) ? 'infra' : 'secrets'
}
