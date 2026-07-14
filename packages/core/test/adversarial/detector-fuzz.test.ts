import { describe, it, expect, beforeAll } from 'vitest'
import { detectSensitive, detectSecrets, sensitivityCategory } from '../../src/secrets.js'

/**
 * ADVERSARIAL DETECTOR FUZZER — THIRD audit of the PLUR scope-security stack
 * before the 0.10.0 release.
 *
 * Goal: prove the leak-guard detectors in `secrets.ts` have zero FALSE
 * NEGATIVES on a large corpus of MUST-CATCH sensitive strings (the content that
 * must NEVER reach a shared/remote scope un-demoted) and zero FALSE POSITIVES on
 * a corpus of benign strings (legitimate engram content the guard must not
 * silently demote). Also bounds worst-case timing on ReDoS-bait inputs.
 *
 * The corpora encode the round-2 fixes as durable regression assertions:
 *  - internal-host two-pass scan-ALL-matches (a real host AFTER an FP-gated
 *    config token must still be caught),
 *  - trailing-punctuation terminators (. , ; ] = ` space EOL),
 *  - scheme-less basic-auth tightened to real host shapes (benign prose
 *    word:word@word no longer flagged),
 *  - public IPv4/IPv6 (global-unicast only) vs private/doc/loopback,
 *  - basic_auth categorised as 'secrets', infra topology as 'infra'.
 *
 * Per the audit charter the assertions are NOT weakened to make the suite pass.
 * If the detector is wrong, the corresponding case FAILS and that failure is the
 * finding.
 */

// ---------------------------------------------------------------------------
// MUST-CATCH corpus: detectSensitive(input) MUST return >=1 match.
// Each entry: [label, input].
// ---------------------------------------------------------------------------
const SENSITIVE: [string, string][] = []

// --- Public IPv4, every surrounding-punctuation position ---
const PUBLIC_IPV4 = ['139.59.155.82', '8.8.8.8', '1.1.1.1', '34.122.5.77', '52.0.0.1', '193.2.1.5']
for (const ip of PUBLIC_IPV4) {
  SENSITIVE.push([`ipv4 bare ${ip}`, `host ${ip} up`])
  SENSITIVE.push([`ipv4 parens ${ip}`, `resolver (${ip}) ok`])
  SENSITIVE.push([`ipv4 trailing period ${ip}`, `ping ${ip}.`])
  SENSITIVE.push([`ipv4 trailing comma ${ip}`, `use ${ip}, then go`])
  SENSITIVE.push([`ipv4 bracket ${ip}`, `nodes[${ip}]`])
  SENSITIVE.push([`ipv4 EOL ${ip}`, `the droplet is ${ip}`])
  SENSITIVE.push([`ipv4 backtick ${ip}`, `run \`${ip}\` now`])
}

// --- Public IPv6 (global-unicast 2000::/3), various forms ---
const PUBLIC_IPV6 = [
  '2606:4700:4700::1111',
  '2001:4860:4860::8888',
  '2a03:2880:f10c:83:face:b00c:0:25de',
  '2400:cb00:2048:1::c629:d7a2',
  '2620:0:ccc::2',
  '2001:0db9:0000:0000:0000:0000:0000:0001', // db9 (NOT db8 doc) — public
]
for (const ip of PUBLIC_IPV6) {
  SENSITIVE.push([`ipv6 bare ${ip}`, `addr ${ip} here`])
  SENSITIVE.push([`ipv6 EOL ${ip}`, `the v6 endpoint is ${ip}`])
}

// --- Internal hosts at every position, before every terminator ---
const INTERNAL_HOSTS = [
  'db.internal',
  'app.corp',
  'cache.lan',
  'gw.intranet',
  'svc-a.local',
  'dataset.internal',
  'db.internal.corp',
  'api.staging.example.com',
  'hub-staging.plur.ai',
  'staging-build.example.com',
  'kafka.svc',
  'redis.svc.cluster.local',
]
const TERMINATORS: [string, string][] = [
  ['period', `${'%H%'}.`],
  ['comma', `${'%H%'}, x`],
  ['semicolon', `${'%H%'}; x`],
  ['bracket', `[${'%H%'}]`],
  ['backtick', `\`${'%H%'}\``],
  ['space', `${'%H%'} x`],
  ['EOL', `${'%H%'}`],
  ['colon-path', `${'%H%'}:/x`],
  ['slash', `${'%H%'}/x`],
  ['question', `${'%H%'}?x`],
]
for (const host of INTERNAL_HOSTS) {
  for (const [tlabel, tmpl] of TERMINATORS) {
    SENSITIVE.push([`internal ${host} <${tlabel}>`, `connect to ${tmpl.replace('%H%', host)}`])
  }
}

// --- Real host hidden AFTER a benign FP-gated token (scan-all-matches fix) ---
SENSITIVE.push(['host after config.local', 'see config.local then ssh db.internal.corp'])
SENSITIVE.push(['host after vite.config.local', 'edit vite.config.local and deploy api.staging.example.com'])
SENSITIVE.push(['host after data-staging.csv', 'load data-staging.csv from db.internal'])
SENSITIVE.push(['host after tsconfig.json', 'check tsconfig.json then hit app.corp'])
SENSITIVE.push(['two FP tokens then host', 'config.local app.config.yml redis.svc.cluster.local'])

// --- host:port topology ---
SENSITIVE.push(['fqdn:port hub', 'endpoint hub-staging.plur.ai:443 live'])
SENSITIVE.push(['fqdn:port db', 'db.internal:5432 conn'])
SENSITIVE.push(['fqdn:port public', 'api.example.com:8080 svc'])
SENSITIVE.push(['ipv4:port', '139.59.155.82:8877 svc'])
SENSITIVE.push(['ipv4:port 2', '34.122.5.77:443 lb'])

// --- basic-auth URLs: full / scheme-less / empty-username ---
SENSITIVE.push(['basic-auth full https', 'url https://team:secret@hub-staging.plur.ai/x'])
SENSITIVE.push(['basic-auth full http', 'http://admin:p4ssw0rd@example.com/path'])
SENSITIVE.push(['basic-auth scheme-less host:port', 'creds user:pass@host:5432/db here'])
SENSITIVE.push(['basic-auth scheme-less dotted', 'admin:hunter2@db.internal connect'])
SENSITIVE.push(['basic-auth scheme-less domain', 'svc:tok3n@api.example.com call'])
SENSITIVE.push(['basic-auth scheme-less ipv4', 'root:toor@10.0.0.5 ssh'])
SENSITIVE.push(['basic-auth empty-username', 'https://:token1234abcd@host.example.com here'])
SENSITIVE.push(['basic-auth localhost', 'user:secretpw@localhost dev'])

// --- credentials (detectSecrets family) ---
SENSITIVE.push(['bearer', 'Authorization: Bearer abcdefghij1234567890XYZ'])
SENSITIVE.push(['jwt', 'token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0'])
SENSITIVE.push(['aws akia', 'key AKIAIOSFODNN7EXAMPLE used'])
SENSITIVE.push(['aws secret', 'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY1'])
SENSITIVE.push(['api_key assign', 'api_key=abcdef1234567890abcdef1234567890'])
SENSITIVE.push(['secret_key assign', 'secret_key: 9f8e7d6c5b4a39281706f5e4d3c2b1a0ffff'])
SENSITIVE.push(['password assign', 'password = hunter2secret'])
SENSITIVE.push(['private key', '-----BEGIN RSA PRIVATE KEY-----'])
SENSITIVE.push(['openai sk-', 'OPENAI_API_KEY=sk-1234567890abcdefghijklmn'])
SENSITIVE.push(['connection string', 'Connect to postgres://user:pass@host:5432/db'])

// ---------------------------------------------------------------------------
// MUST-NOT-FLAG corpus: detectSensitive(input) MUST return [].
// ---------------------------------------------------------------------------
const BENIGN: [string, string][] = [
  ['config.local alone', 'edit config.local file'],
  ['vite.config.local', 'open vite.config.local'],
  ['jest.config.local', 'see jest.config.local'],
  ['tsconfig.local', 'tsconfig.local here'],
  ['data-staging.csv', 'load data-staging.csv now'],
  ['staging-build.yml', 'see staging-build.yml'],
  ['app.config.yml', 'app.config.yml here'],
  ['tsconfig.json', 'check tsconfig.json'],
  ['next.config.local', 'next.config.local present'],
  ['semver 1.2.3', 'version 1.2.3 released'],
  ['semver 10.20.30', 'bump to 10.20.30 soon'],
  ['time 5:30', 'meet at 5:30 today'],
  ['time 12:30:45', 'at 12:30:45 exactly'],
  ['ratio 3:1@scale', 'use 3:1@scale ratio'],
  ['prose word:word@word', 'note name:value@scope here'],
  ['prose meet:me@noon', 'remember meet:me@noon plan'],
  ['email user@example.com', 'mail user@example.com please'],
  ['email a.b@c.io', 'contact a.b@c.io now'],
  ['example.com', 'visit example.com today'],
  ['api.github.com', 'call api.github.com endpoint'],
  ['docs.python.org', 'read docs.python.org guide'],
  ['uuid', 'id 550e8400-e29b-41d4-a716-446655440000 set'],
  ['uuid 2', 'run 123e4567-e89b-12d3-a456-426614174000 job'],
  // Code refs file:line — MUST NOT FLAG (per audit charter).
  ['code ref inject.ts:49', 'see inject.ts:49 for detail'],
  ['code ref index.ts:1', 'index.ts:1 is the entry'],
  ['code ref scope-util.ts:12', 'scope-util.ts:12 has it'],
  ['code ref app.py:100', 'app.py:100 line throws'],
  ['code ref file.go:42', 'file.go:42 panics'],
  ['code ref main.rs:55', 'main.rs:55 owns it'],
  ['code ref a.b.ts:10', 'a.b.ts:10 multi-dot'],
  // Private / doc / loopback IPs — never public.
  ['ipv4 private 10', 'lan 10.0.0.5 host'],
  ['ipv4 private 192.168', 'router 192.168.1.1 here'],
  ['ipv4 private 172.16', 'host 172.16.0.9 internal'],
  ['ipv4 loopback', 'bind 127.0.0.1 only'],
  ['ipv4 doc 203.0.113', 'doc 203.0.113.5 sample'],
  ['ipv4 doc 192.0.2', 'rfc 192.0.2.1 example'],
  ['ipv4 link-local', 'apipa 169.254.1.1 fallback'],
  ['ipv6 loopback', 'local ::1 only'],
  ['ipv6 unspecified', 'bind :: addr'],
  ['ipv6 link-local', 'iface fe80::1 link'],
  ['ipv6 ula fd00', 'fd00::1 private mesh'],
  ['ipv6 doc db8', '2001:db8::1 example'],
  ['mac address', 'mac 00:11:22:33:44:55 nic'],
  // Standalone infra words — must NOT flag alone.
  ['word prod', 'prod is down'],
  ['word redis', 'redis cache warm'],
  ['word staging (no host)', 'the staging env failed'],
]

describe('detector-fuzz: MUST-CATCH sensitive corpus (zero false negatives)', () => {
  const falseNegatives: string[] = []
  for (const [label, input] of SENSITIVE) {
    it(`catches: ${label}`, () => {
      const matches = detectSensitive(input)
      if (matches.length === 0) falseNegatives.push(`${label} :: ${JSON.stringify(input)}`)
      expect(matches.length, `FALSE NEGATIVE — leak escaped guard: ${label} :: ${JSON.stringify(input)}`).toBeGreaterThan(0)
    })
  }
})

describe('detector-fuzz: MUST-NOT-FLAG benign corpus (zero false positives)', () => {
  for (const [label, input] of BENIGN) {
    it(`ignores: ${label}`, () => {
      const matches = detectSensitive(input)
      expect(
        matches,
        `FALSE POSITIVE — benign content demoted: ${label} :: ${JSON.stringify(input)} -> ${JSON.stringify(matches.map(m => m.pattern))}`,
      ).toEqual([])
    })
  }
})

describe('detector-fuzz: sensitivityCategory routing', () => {
  it('basic_auth_url is a credential -> secrets', () => {
    expect(sensitivityCategory('basic_auth_url')).toBe('secrets')
  })
  it('jwt/bearer are credentials -> secrets', () => {
    expect(sensitivityCategory('jwt')).toBe('secrets')
    expect(sensitivityCategory('bearer_token')).toBe('secrets')
  })
  it('IP / host topology -> infra', () => {
    expect(sensitivityCategory('public_ipv4')).toBe('infra')
    expect(sensitivityCategory('public_ipv6')).toBe('infra')
    expect(sensitivityCategory('internal_host')).toBe('infra')
    expect(sensitivityCategory('fqdn_port')).toBe('infra')
    expect(sensitivityCategory('ipv4_port')).toBe('infra')
  })
})

describe('detector-fuzz: ReDoS bait timing (64KB, must stay linear)', () => {
  // What this guards: detectSensitive runs on serialized engrams at the publish
  // gate AND inside _guardSensitiveScope, so catastrophic backtracking on an
  // attacker-authored engram stalls every guard call — a stored DoS vector.
  //
  // ASSERT RATIO, NOT WALL-CLOCK. This used to assert `dt < 1000ms`, which
  // measures the machine, not the regex: under a full parallel `vitest run`
  // (BGE embedders + WASM Postgres saturating every core) a perfectly linear
  // scan was observed at 1019ms and failed the build. That made the release
  // gate unreliable — release.sh hard-aborts on any test failure — and the
  // tempting workaround is to bypass the gate, which is how unreviewed code has
  // shipped before.
  //
  // The signal we actually care about is *shape*: catastrophic backtracking is
  // superlinear, so an adversarial input runs orders of magnitude slower than a
  // benign string of the same length. Measured on an idle machine, every bait
  // here sits at 1.0-1.4x a benign 64KB baseline (~20ms). The original #389 bug
  // was 8-17s against milliseconds — thousands of times over. A 20x ceiling is
  // therefore enormous headroom for a healthy detector while still catching any
  // real blowup, and it holds on a loaded machine because the baseline is
  // measured on that same machine, under that same load.
  const N = 65536
  const BAITS: [string, string][] = [
    ['colon run (no @)', ':'.repeat(N)],
    ['a: run', 'a:'.repeat(N / 2)],
    ['userinfo word:word (no @)', 'word:word'.repeat(Math.floor(N / 9))],
    ['ipv6-ish hex:colon', '1234:'.repeat(N / 5)],
    ['dotted label run a.', 'a.'.repeat(N / 2)],
    ['dotted label run ab.', 'ab.'.repeat(Math.floor(N / 3))],
    ['scheme bait http://aaa', 'http://' + 'a'.repeat(N)],
    ['at-run', 'a@'.repeat(N / 2)],
  ]

  // A benign string of the SAME length. Anything the detector does to this is
  // the irreducible cost of walking 64KB on this machine right now.
  const BENIGN = 'x'.repeat(N)
  const RATIO_LIMIT = 20

  // Best-of-k: we want the floor (the cost when the scheduler let us run), not
  // an average polluted by preemption. A ReDoS blowup is present in every run,
  // so taking the minimum cannot hide one.
  const fastest = (input: string, k: number): number => {
    let best = Infinity
    for (let i = 0; i < k; i++) {
      const t0 = performance.now()
      detectSensitive(input)
      best = Math.min(best, performance.now() - t0)
    }
    return best
  }

  let benignMs = 0
  beforeAll(() => {
    detectSensitive(BENIGN) // warm: first call pays regex compile + JIT
    benignMs = Math.max(fastest(BENIGN, 5), 0.01) // floor guards against divide-by-zero
  })

  for (const [label, input] of BAITS) {
    it(`${label} stays within ${RATIO_LIMIT}x a benign 64KB scan`, () => {
      const dt = fastest(input, 3)
      const ratio = dt / benignMs
      expect(
        ratio,
        `ReDoS — 64KB '${label}' took ${dt.toFixed(1)}ms = ${ratio.toFixed(1)}x a benign ` +
          `64KB scan (${benignMs.toFixed(1)}ms) on this machine. Superlinear blowup means ` +
          `catastrophic backtracking, not a slow CPU.`,
      ).toBeLessThan(RATIO_LIMIT)
    })
  }
})

describe('detector-fuzz: input-type guard', () => {
  it('throws on non-string', () => {
    // @ts-expect-error intentional misuse
    expect(() => detectSensitive(123)).toThrow(TypeError)
    // @ts-expect-error intentional misuse
    expect(() => detectSecrets(null)).toThrow(TypeError)
  })
})
