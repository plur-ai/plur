import { describe, it, expect } from 'vitest'
import { detectSecrets, detectSensitive, sensitivityCategory, SCAN_TRUNCATED } from '../src/secrets.js'

describe('detectSecrets', () => {
  it('detects AWS access keys', () => {
    const matches = detectSecrets('Use key AKIAIOSFODNN7EXAMPLE for S3 access')
    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0].pattern).toBe('aws_access_key')
  })

  it('detects AWS secret access keys', () => {
    const matches = detectSecrets('aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY1')
    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0].pattern).toBe('aws_secret_key')
  })

  it('detects api_key assignments', () => {
    const matches = detectSecrets('Set api_key=abcdef1234567890abcdef1234567890')
    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0].pattern).toBe('api_key_assignment')
  })

  it('detects generic API keys with sk- prefix', () => {
    const matches = detectSecrets('Set OPENAI_API_KEY=sk-1234567890abcdefghijklmn')
    expect(matches.length).toBeGreaterThan(0)
  })

  it('detects password assignments', () => {
    const matches = detectSecrets('database password = hunter2secret')
    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0].pattern).toBe('password_assignment')
  })

  it('detects connection strings', () => {
    const matches = detectSecrets('Connect to postgres://user:pass@host:5432/db')
    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0].pattern).toBe('connection_string')
  })

  it('detects JWTs', () => {
    const matches = detectSecrets('Token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature')
    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0].pattern).toBe('jwt')
  })

  it('detects private key blocks', () => {
    const matches = detectSecrets('-----BEGIN RSA PRIVATE KEY-----')
    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0].pattern).toBe('private_key')
  })

  it('detects bearer tokens', () => {
    const matches = detectSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234567890')
    expect(matches.length).toBeGreaterThan(0)
  })

  it('returns empty for clean statements', () => {
    const matches = detectSecrets('Always use HTTPS for API calls')
    expect(matches).toHaveLength(0)
  })

  it('returns empty for statements about keys without actual keys', () => {
    const matches = detectSecrets('Store API keys in environment variables, never in code')
    expect(matches).toHaveLength(0)
  })

  // Issue #231 — detectSecrets used to crash with cryptic
  // "Cannot read properties of undefined (reading 'match')" when called with
  // a non-string. Now throws a clear TypeError at the front door.
  it('throws TypeError when called with undefined (#231)', () => {
    expect(() => detectSecrets(undefined as unknown as string))
      .toThrow(/expected string, got undefined/)
  })

  it('throws TypeError when called with a number (#231)', () => {
    expect(() => detectSecrets(42 as unknown as string))
      .toThrow(/expected string, got number/)
  })
})

// Detector hardening — Stage 1.5b (#353). These detectors GATE the publish
// filter and trigger write-time scope-demotion, so the overriding constraint is
// LOW FALSE POSITIVES: a false match silently demotes a legitimate engram on
// every shared-scope write. The negative cases below are the load-bearing half.
describe('detectSensitive — public IPv6 (infra)', () => {
  const has = (text: string, pattern: string) =>
    detectSensitive(text).some(m => m.pattern === pattern)

  it('flags a globally-routable (global unicast 2000::/3) address', () => {
    expect(has('dns is at 2001:4860:4860::8888', 'public_ipv6')).toBe(true)
  })

  it('classifies public_ipv6 as infra', () => {
    expect(sensitivityCategory('public_ipv6')).toBe('infra')
  })

  it('does NOT flag loopback ::1', () => {
    expect(has('bind to ::1 for local only', 'public_ipv6')).toBe(false)
  })

  it('does NOT flag link-local fe80::/10', () => {
    expect(has('interface addr fe80::1', 'public_ipv6')).toBe(false)
  })

  it('does NOT flag unique-local / ULA fd00::/8', () => {
    expect(has('ula prefix fd00::1', 'public_ipv6')).toBe(false)
  })

  it('does NOT flag the documentation prefix 2001:db8::/32', () => {
    expect(has('example doc addr 2001:db8::1', 'public_ipv6')).toBe(false)
  })

  it('does NOT flag a MAC address (six 2-hex groups)', () => {
    expect(has('mac 00:11:22:33:44:55', 'public_ipv6')).toBe(false)
  })

  it('does NOT flag a clock time', () => {
    expect(has('meeting at 12:30:45 today', 'public_ipv6')).toBe(false)
  })
})

describe('detectSensitive — internal hosts (infra)', () => {
  const has = (text: string, pattern: string) =>
    detectSensitive(text).some(m => m.pattern === pattern)

  it('flags an .internal.corp suffix host', () => {
    expect(has('connect to db.internal.corp', 'internal_host')).toBe(true)
  })

  it('flags a k8s .svc.cluster.local host', () => {
    expect(has('svc.prod.svc.cluster.local is the target', 'internal_host')).toBe(true)
  })

  it('flags a bare .internal suffix host', () => {
    expect(has('redis.internal handles the cache', 'internal_host')).toBe(true)
  })

  it('flags a hostname with a staging label', () => {
    expect(has('the box is hub-staging.plur.ai', 'internal_host')).toBe(true)
  })

  it('flags staging as an inner label', () => {
    expect(has('api.staging.example.com is pre-prod', 'internal_host')).toBe(true)
  })

  it('classifies internal_host as infra', () => {
    expect(sensitivityCategory('internal_host')).toBe('infra')
  })

  it('does NOT flag ordinary public FQDNs', () => {
    expect(has('see example.com for details', 'internal_host')).toBe(false)
    expect(has('docs at https://google.com/path', 'internal_host')).toBe(false)
    expect(has('the api.github.com endpoint', 'internal_host')).toBe(false)
  })

  it('does NOT flag an email address', () => {
    expect(has('email user@example.com', 'internal_host')).toBe(false)
  })

  it('does NOT flag localhost or standalone infra words', () => {
    expect(has('runs on localhost', 'internal_host')).toBe(false)
    expect(has('check the db and redis on prod', 'internal_host')).toBe(false)
  })

  it('does NOT flag staging as a bare prose word', () => {
    expect(has('the staging build failed', 'internal_host')).toBe(false)
  })
})

describe('detectSensitive — false-positive safety (must stay clean)', () => {
  // The single most important assertion set: none of these benign strings may
  // produce ANY detectSensitive hit, or the leak guard demotes legitimate
  // engrams on every shared-scope write.
  const clean = [
    '::1',
    'fe80::1',
    'fd00::1',
    '2001:db8::1', // IPv6 documentation prefix
    '00:11:22:33:44:55', // MAC address
    '12:30:45', // clock time
    '1.2.3', // semver
    'example.com',
    'https://google.com/path',
    'api.github.com',
    'user@example.com',
    'localhost',
    '550e8400-e29b-41d4-a716-446655440000', // UUID
  ]
  for (const text of clean) {
    it(`stays clean: ${text}`, () => {
      expect(detectSensitive(text)).toHaveLength(0)
    })
  }
})

// PR-2 (#353) — INTERNAL_HOST two-pass rewrite. The single-regex form silently
// demoted real, shareable content (config.local, data-staging.csv,
// staging-build.yml, vite.config.local, app.config.yml, tsconfig.json all
// matched). The rewrite is a CORRECTNESS fix on FALSE-POSITIVE grounds (the
// "17s ReDoS" was empirically ~2.6ms under V8 Irregexp and DOWNGRADED to MEDIUM
// in D3 — the length cap below is cheap defense-in-depth, not a DoS fix).
describe('detectSensitive — INTERNAL_HOST two-pass FP correctness (#353)', () => {
  const flagged = (text: string) =>
    detectSensitive(text).some(m => m.pattern === 'internal_host')

  // PASS 1 — each of the four alternatives carries a `(?<host>...)` named group.
  // We expose the matched token via the `internal_host` hit (sliced to 30 chars,
  // long enough for these tokens) so a per-branch assertion proves the named
  // group is the HOST TOKEN, not the full match. If any alternative lost its
  // named group, PASS 2 would no-op and the FP negatives below would regress.
  describe('PASS 1 — every alternative wraps the host in a named (?<host>...) group', () => {
    const hostHit = (text: string): string | undefined =>
      detectSensitive(text).find(m => m.pattern === 'internal_host')?.match

    it('alt (a) internal-suffix label: groups.host === host token', () => {
      expect(hostHit('connect to db.internal.corp here')).toBe('db.internal.corp')
    })
    it('alt (b) k8s svc/svc.cluster.local: groups.host === host token', () => {
      expect(hostHit('target is redis.prod.svc.cluster.local now')).toBe(
        'redis.prod.svc.cluster.local',
      )
    })
    it('alt (c) staging label fragment: groups.host === host token', () => {
      expect(hostHit('the box is hub-staging.plur.ai now')).toBe('hub-staging.plur.ai')
    })
    it('alt (d) staging inner label: groups.host === host token', () => {
      expect(hostHit('api.staging.example.com is pre-prod')).toBe('api.staging.example.com')
    })
  })

  // POSITIVES — real internal hosts must still be flagged. DELIBERATELY KEPT:
  // app.corp / dataset.internal / db.internal have real internal-host shape, so
  // PASS 2 (the sole FP gate) does NOT exempt them.
  describe('positives preserved (real internal-host shapes)', () => {
    const cases = [
      'hub-staging.plur.ai',
      'db.internal',
      'foo.svc.cluster.local',
      'x.corp',
      'dataset.internal',
      'app.corp',
      'db.internal.corp',
      'redis.prod.svc.cluster.local',
      'api.staging.example.com',
    ]
    for (const host of cases) {
      it(`flags ${host}`, () => {
        expect(flagged(`see ${host} for the deploy`)).toBe(true)
      })
    }
  })

  // REAUDIT #2 — trailing-punctuation FN. A real internal host at end-of-sentence
  // or before punctuation (`. , ; ] = ` backtick) must still be flagged; the prior
  // trailing lookahead `(?=$|[\s:/?#)'"])` omitted these terminators, so a host
  // followed by any of them escaped the guard. One positive per terminator.
  describe('reaudit #2 — trailing-punctuation terminators still flag a real host', () => {
    const terminators: [string, string][] = [
      ['period', '.'],
      ['comma', ','],
      ['semicolon', ';'],
      ['close-bracket', ']'],
      ['equals', '='],
      ['backtick', '`'],
    ]
    for (const host of ['db.internal', 'app.corp']) {
      for (const [label, ch] of terminators) {
        it(`flags ${host} followed by ${label} (${ch})`, () => {
          expect(flagged(`reach ${host}${ch} then continue`)).toBe(true)
        })
      }
    }
    it('flags a backtick-delimited host `db.internal`', () => {
      expect(flagged('the `db.internal` host is internal')).toBe(true)
    })
    it('still yields the FULL host token when followed by a period', () => {
      const host = detectSensitive('connect to db.internal.corp. done').find(
        m => m.pattern === 'internal_host',
      )?.match
      expect(host).toBe('db.internal.corp')
    })
  })

  // REAUDIT #3 — scan-all-matches FN. An FP-gated leading candidate
  // (config.local) must NOT hide a real internal host later in the same text; the
  // detector iterates ALL matches and returns the first surviving the FP gate.
  describe('reaudit #3 — an FP-gated leading token does not hide a real host', () => {
    it('flags db.internal.corp after the FP-gated config.local', () => {
      const host = detectSensitive('see config.local then ssh db.internal.corp').find(
        m => m.pattern === 'internal_host',
      )?.match
      expect(host).toBe('db.internal.corp')
    })
    it('flags a real host after a data-staging.csv filename FP', () => {
      expect(flagged('load data-staging.csv into redis.internal cache')).toBe(true)
    })
    it('stays clean when ALL candidates are FP-gated', () => {
      expect(flagged('config.local and vite.config.local and tsconfig.json')).toBe(false)
    })
  })

  // NEGATIVES — the whole point of the rewrite. None of these legitimate,
  // shareable strings may produce an internal_host hit (each embedded in prose).
  describe('false positives eliminated (config/data files)', () => {
    const cases = [
      'config.local',
      'vite.config.local',
      'jest.config.local',
      'next.config.local',
      'postcss.config.local',
      'my.config.local',
      'deep.jest.config.internal',
      'tsconfig.base.local',
      'data-staging.csv',
      'staging-build.yml',
      'app.config.yml',
      'tsconfig.json',
    ]
    for (const token of cases) {
      it(`does NOT flag ${token}`, () => {
        expect(flagged(`the file ${token} is shared content`)).toBe(false)
      })
    }
  })

  // RULE-2 BOTH BRANCHES (curated config-stem before internal suffix).
  describe('RULE 2 — curated config-stem allowlist', () => {
    it('does NOT flag jest.config.internal (stem in list)', () => {
      expect(flagged('see jest.config.internal in the repo')).toBe(false)
    })
    it('does NOT flag my-app.jest.config.internal (stem in list, extra labels)', () => {
      expect(flagged('see my-app.jest.config.internal in the repo')).toBe(false)
    })
    // ACCEPTED-FP / documented boundary. RULE 2 is a deliberately-incomplete
    // allowlist. SPEC-AMBIGUITY NOTE: the plan's literal RULE-2 regex (line 98)
    // includes a bare `config` stem to kill `config.local`, which by the
    // `(?:^|\.)` anchor ALSO kills any `X.config.local` — so the plan's stated
    // accepted-FP `myapp.config.local` is in fact suppressed by the literal
    // regex, an internal inconsistency. We keep the authoritative literal regex
    // and demonstrate the SAME boundary the plan intends with a config-shaped
    // host that genuinely escapes both rules: `myapp.settings.local` is not a
    // known stem and has no file-extension tail, so it IS (falsely) flagged.
    // To fix such a case in production, add the tool to the allowlist.
    it('DOES flag myapp.settings.local (config-shaped, stem NOT in list — accepted FP)', () => {
      expect(flagged('see myapp.settings.local for details')).toBe(true)
    })
  })

  describe('classification', () => {
    it('classifies internal_host as infra', () => {
      expect(sensitivityCategory('internal_host')).toBe('infra')
    })
  })
})

// PR-2 (#353) — basic_auth_url: recategorized 'secrets' (#19), extended to catch
// scheme-less and empty-username credential URLs (#16).
describe('detectSensitive — basic_auth_url (#353)', () => {
  const flagged = (text: string) =>
    detectSensitive(text).some(m => m.pattern === 'basic_auth_url')

  it('classifies basic_auth_url as secrets (not infra) so forbid:[secrets] catches it', () => {
    expect(sensitivityCategory('basic_auth_url')).toBe('secrets')
  })

  it('flags the full form https://team:secret@hub-staging.plur.ai', () => {
    expect(flagged('use https://team:secret@hub-staging.plur.ai')).toBe(true)
  })

  it('flags the scheme-less form user:pass@host:5432/db (#16)', () => {
    expect(flagged('connect via user:pass@host:5432/db')).toBe(true)
  })

  it('flags the empty-username form https://:token@host (#16)', () => {
    expect(flagged('endpoint https://:tok@host.example.com')).toBe(true)
  })

  it('does NOT flag a bare key:value (no @host)', () => {
    expect(flagged('config key:value pair')).toBe(false)
  })

  it('does NOT flag a clock time:12:30 (no @)', () => {
    expect(flagged('meeting time:12:30 today')).toBe(false)
  })

  // REAUDIT #6 — scheme-less FP. The scheme-less `user:pass@host` form must only
  // fire on a genuine credential-bearing URL shape (dotted domain / localhost /
  // IPv4 / host:port), not benign `word:word@word` prose. The real DB-scheme and
  // internal-host credential forms PR-2 added must still be caught.
  describe('reaudit #6 — scheme-less form does not false-positive on benign prose', () => {
    it('does NOT flag a time@place note (5:30@cafe)', () => {
      expect(flagged('lunch at 5:30@cafe tomorrow')).toBe(false)
    })
    it('does NOT flag a ratio@place note (3:1@ratio)', () => {
      expect(flagged('mix 3:1@ratio for the batch')).toBe(false)
    })
    it('does NOT flag a handle@scope note (meet:me@noon)', () => {
      expect(flagged('lets meet:me@noon today')).toBe(false)
    })
    it('does NOT flag name:value@scope prose', () => {
      expect(flagged('the name:value@scope binding')).toBe(false)
    })
    it('still flags a real scheme-less credential user:pass@db.internal', () => {
      expect(flagged('creds are user:pass@db.internal for the box')).toBe(true)
    })
    it('still flags a real scheme-less credential admin:secret@10.0.0.5', () => {
      expect(flagged('login admin:secret@10.0.0.5 to the host')).toBe(true)
    })
  })
})

// #386 — scan-input ceiling raised 64KB → 1 MiB, and FAIL-CLOSED past it.
// Previously detectSensitive truncated to 64KB and silently passed the tail, so
// infra-family content past byte 64KB leaked to shared/remote stores. Now the
// window is 1 MiB (far above any realistic engram) and anything larger emits a
// `scan_truncated` signal so the guard demotes / publish excludes. Total scan
// work is bounded at 1 MiB regardless of input size. Asserted structurally.
describe('detectSensitive — 1 MiB scan ceiling, fail-closed (#386)', () => {
  const CAP = 1024 * 1024

  it('detects a secret within the scanned window', () => {
    const head = 'AKIAIOSFODNN7EXAMPLE is the key. '
    const big = head + 'x'.repeat(200 * 1024)
    expect(detectSensitive(big).some(m => m.pattern === 'aws_access_key')).toBe(true)
  })

  it('#386 detects infra content past the OLD 64KB cap (now inside the 1 MiB window)', () => {
    const filler = 'x'.repeat(70 * 1024) // past 64KB, well under 1 MiB
    expect(detectSensitive(`${filler} 139.59.155.82`).some(m => m.pattern === 'public_ipv4')).toBe(true)
    expect(detectSensitive(`${filler} https://t:p@hub-staging.plur.ai`).some(m => m.pattern === 'basic_auth_url')).toBe(true)
  })

  it('#386 fail-closed: an input larger than the ceiling reports scan_truncated even when the scanned prefix is clean', () => {
    const big = 'x'.repeat(CAP + 1024) // benign filler, but > ceiling
    expect(detectSensitive(big).some(m => m.pattern === SCAN_TRUNCATED)).toBe(true)
  })

  it('a secret ENTIRELY past the ceiling is not directly detected, but the input is flagged truncated', () => {
    const big = 'x'.repeat(CAP) + ' AKIAIOSFODNN7EXAMPLE'
    const matches = detectSensitive(big)
    expect(matches.some(m => m.pattern === 'aws_access_key')).toBe(false) // past the window
    expect(matches.some(m => m.pattern === SCAN_TRUNCATED)).toBe(true)     // but fail-closed
  })

  it('truncation at the ceiling produces valid UTF-8 even when it splits a multibyte char (no throw)', () => {
    const big = 'a'.repeat(CAP - 1) + 'é' + 'b'.repeat(1024) // 'é' is 2 bytes, split at the cap
    expect(() => detectSensitive(big)).not.toThrow()
    expect(detectSensitive(big).some(m => m.pattern === SCAN_TRUNCATED)).toBe(true)
  })
})

// PR-2 (#353) test #21 — a secrets-category credential hidden ONLY in a context
// field (rationale/source/...), reaching a SHARED scope under DEFAULT config
// (allow_secrets:false), must be demoted to local/private with _demoted.patterns
// naming the credential. _guardSensitiveScope already scans
// `statement + JSON.stringify(context)` (index.ts:1038); this exercises it.
describe('context-field credential demotion at shared scope (#353 #21)', () => {
  it('demotes a shared-scope engram whose credential is only in a context field', async () => {
    const { Plur } = await import('../src/index.js')
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const dir = mkdtempSync(join(tmpdir(), 'plur-pr2-ctx-'))
    const sharedPath = mkdtempSync(join(tmpdir(), 'plur-pr2-shared-'))
    const plur = new Plur({
      path: dir,
      stores: [{ scope: 'group:eng', shared: true, path: sharedPath }],
    })

    // Credential lives ONLY in the context (source field), not the statement.
    const engram = plur.learn('deployment runbook for the staging cluster', {
      scope: 'group:eng',
      source: 'https://team:supersecret@hub.example.com/runbook',
    })

    // Demoted off the shared scope to local/private, with the credential named.
    expect(engram.scope).toBe('local')
    expect((engram as { visibility?: string }).visibility).toBe('private')
    const demoted = (engram as { structured_data?: { _demoted?: { patterns?: string } } })
      .structured_data?._demoted
    expect(demoted).toBeDefined()
    expect(demoted?.patterns).toContain('basic_auth_url')
  })
})

// #386 end-to-end: infra content PAST the old 64KB cap must now be demoted on a
// shared-scope write and excluded from a publishable set. Before the ceiling was
// raised it was silently passed — the exact 2026-06-leak class.
describe('infra content past 64KB is demoted / excluded (#386)', () => {
  const FILLER = 'x'.repeat(70 * 1024) // past the old 64KB cap, inside the 1 MiB window

  it('demotes a shared-scope learn whose infra payload sits past byte 64KB', async () => {
    const { Plur } = await import('../src/index.js')
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const dir = mkdtempSync(join(tmpdir(), 'plur-386-'))
    const sharedPath = mkdtempSync(join(tmpdir(), 'plur-386-shared-'))
    const plur = new Plur({ path: dir, stores: [{ scope: 'group:eng', shared: true, path: sharedPath }] })

    const engram = plur.learn(`benign runbook ${FILLER} deploy droplet 139.59.155.82`, { scope: 'group:eng' })
    expect(engram.scope).toBe('local')
    expect((engram as { visibility?: string }).visibility).toBe('private')
  })

  it('filterPublishable excludes a public engram with infra past byte 64KB', async () => {
    const { filterPublishable } = await import('../src/publish.js')
    const { EngramSchema } = await import('../src/schemas/engram.js')
    const e = EngramSchema.parse({
      id: 'ENG-2026-0101-386',
      statement: `notes ${FILLER} https://t:p@hub-staging.plur.ai`,
      type: 'behavioral', scope: 'global', status: 'active', visibility: 'public',
    })
    const { publishable, rejected } = filterPublishable([e])
    expect(publishable).toHaveLength(0)
    expect(rejected).toHaveLength(1)
  })
})
