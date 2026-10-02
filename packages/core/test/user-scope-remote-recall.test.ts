/**
 * Personal `user:` scope remote recall.
 *
 * A recall (or a hybrid injection) whose dialing scope is a personal
 * `user:<org>:<name>` scope dials the configured url store whose own `scope`
 * is EXACTLY that user scope, and only that store entry. Before this, a
 * personal scope never established a dialing context, so `learn` to a
 * personal remote store landed on the server but `recall` with the same
 * scope never dialed it — personal remote memory was write-only.
 *
 * Boundaries pinned here:
 *   - exact match only: another user's store is never dialed;
 *   - no widening: the matched host is dialed with the user scope alone, not
 *     the host's other (shared or personal) entries;
 *   - `dial: never` still wins;
 *   - existing org-affinity (group/project) dialing is unchanged.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import type { RemoteRecallHost } from '../src/remote-recall.js'
import { StubServer } from './helpers/stub-server.js'

const TOKEN = 'user-scope-recall-token'
const ME = 'user:acme:me'
const SOMEONE_ELSE = 'user:acme:someone-else'

let server: StubServer
let baseUrl: string
const dirs: string[] = []

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function plurWith(storesYaml: string): Plur {
  const dir = tmp('plur-userscope-')
  writeFileSync(join(dir, 'config.yaml'), `embeddings:\n  enabled: false\nstores:\n${storesYaml}`)
  return new Plur({ path: dir })
}

const hostsOf = (plur: Plur, options?: Record<string, unknown>): RemoteRecallHost[] =>
  (plur as any)._remoteRecallHosts(options)

beforeAll(async () => {
  server = new StubServer(TOKEN)
  const info = await server.start()
  baseUrl = info.url
})

afterAll(async () => {
  await server.stop()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

beforeEach(() => {
  server.reset()
})

describe('dialing — personal user: scope (unit, _remoteRecallHosts)', () => {
  it('a recall scoped to user:org:me dials the store whose scope is exactly user:org:me', () => {
    const plur = plurWith(`  - url: "https://plur.example.com"\n    token: "t1"\n    scope: "${ME}"\n`)
    const hosts = hostsOf(plur, { scope: ME })
    expect(hosts).toHaveLength(1)
    expect(hosts[0].url).toBe('https://plur.example.com')
    expect(hosts[0].token).toBe('t1')
    expect(hosts[0].scopes).toEqual([ME])
    expect(hosts[0].entries).toEqual([{ scope: ME }])
  })

  it('does NOT dial a store holding another user\'s scope', () => {
    const plur = plurWith(`  - url: "https://plur.example.com"\n    token: "t1"\n    scope: "${SOMEONE_ELSE}"\n`)
    expect(hostsOf(plur, { scope: ME })).toHaveLength(0)
  })

  it('never widens: the matched host is dialed with the user scope only, not its other entries', () => {
    const plur = plurWith(
      `  - url: "https://plur.example.com"\n    token: "t1"\n    scope: "group:acme/eng"\n` +
      `  - url: "https://plur.example.com"\n    token: "t1"\n    scope: "${SOMEONE_ELSE}"\n` +
      `  - url: "https://plur.example.com"\n    token: "t1"\n    scope: "${ME}"\n` +
      `  - url: "https://other.example.com"\n    token: "t2"\n    scope: "group:acme/comms"\n`,
    )
    const hosts = hostsOf(plur, { scope: ME })
    expect(hosts).toHaveLength(1)
    expect(hosts[0].url).toBe('https://plur.example.com')
    expect(hosts[0].scopes).toEqual([ME])
  })

  it('a prefix or near-miss of the store scope does not match (exact only)', () => {
    const plur = plurWith(`  - url: "https://plur.example.com"\n    token: "t1"\n    scope: "${ME}"\n`)
    expect(hostsOf(plur, { scope: 'user:acme' })).toHaveLength(0)
    expect(hostsOf(plur, { scope: 'user:acme:me2' })).toHaveLength(0)
    expect(hostsOf(plur, { scope: 'user:me' })).toHaveLength(0)
  })

  // Owner decision (2026-10-01): matching folds case, the same way local-only
  // scope targets do (Decision E5, `isLocalOnlyScope`): only the comparison
  // folds; the store's configured scope string is what is sent.
  it('a differently-cased user scope dials the store (case-folded match)', () => {
    const plur = plurWith(`  - url: "https://plur.example.com"\n    token: "t1"\n    scope: "user:Acme:Me"\n`)
    const hosts = hostsOf(plur, { scope: 'USER:acme:me' })
    expect(hosts).toHaveLength(1)
    expect(hosts[0].scopes).toEqual(['user:Acme:Me'])
    const lower = plurWith(`  - url: "https://plur.example.com"\n    token: "t1"\n    scope: "${ME}"\n`)
    expect(hostsOf(lower, { scope: 'User:ACME:ME' }).map(h => h.scopes)).toEqual([[ME]])
  })

  it('a different user never matches, even after case folding', () => {
    const plur = plurWith(`  - url: "https://plur.example.com"\n    token: "t1"\n    scope: "user:Acme:Someone-Else"\n`)
    expect(hostsOf(plur, { scope: 'USER:ACME:ME' })).toHaveLength(0)
    expect(hostsOf(plur, { scope: 'user:acme:me' })).toHaveLength(0)
  })

  it('dial: never on the user store still wins', () => {
    const plur = plurWith(`  - url: "https://plur.example.com"\n    token: "t1"\n    scope: "${ME}"\n    dial: never\n`)
    expect(hostsOf(plur, { scope: ME })).toHaveLength(0)
  })

  it('the session default scope = user scope dials it too (injection path context)', () => {
    const plur = plurWith(`  - url: "https://plur.example.com"\n    token: "t1"\n    scope: "${ME}"\n`)
    plur.setSessionScope(ME, { session: 's-me' })
    expect(hostsOf(plur, { session: 's-me' }).map(h => h.scopes)).toEqual([[ME]])
    expect(hostsOf(plur, { session: 's-other' })).toHaveLength(0)
  })

  it('group/project behaviour is unchanged: org-affine context still dials shared + user:* entries', () => {
    const plur = plurWith(
      `  - url: "https://plur.example.com"\n    token: "t1"\n    scope: "group:acme/eng"\n` +
      `  - url: "https://plur.example.com"\n    token: "t1"\n    scope: "${ME}"\n` +
      `  - url: "https://df.example.com"\n    token: "t2"\n    scope: "group:other/x"\n`,
    )
    const hosts = hostsOf(plur, { scope: 'project:acme/app' })
    expect(hosts).toHaveLength(1)
    expect(hosts[0].scopes).toEqual(['group:acme/eng', ME])
    // A host holding only user:* is still not dialed from a shared-scope context.
    const onlyUser = plurWith(`  - url: "https://plur.example.com"\n    token: "t1"\n    scope: "${ME}"\n`)
    expect(hostsOf(onlyUser, { scope: 'project:acme/app' })).toHaveLength(0)
    // No context at all still dials nothing.
    expect(hostsOf(onlyUser)).toHaveLength(0)
  })
})

describe('dialing — audit follow-ups (F2, F4)', () => {
  // F2a: the personal-scope dial triggers only for a scope the caller passed
  // or the session's OWN registration — never the process-wide default an
  // unregistered session (or no session) inherits.
  it('an unregistered session does not dial a personal store through the process default', () => {
    const plur = plurWith(
      `  - url: "https://plur.example.com"\n    token: "ta"\n    scope: "${ME}"\n` +
      `  - url: "https://plur.example.com"\n    token: "tb"\n    scope: "${SOMEONE_ELSE}"\n`,
    )
    plur.setSessionScope(ME)
    plur.setSessionScope(ME, { session: 'A' })
    expect(hostsOf(plur, { session: 'B' })).toEqual([])
    expect(hostsOf(plur)).toEqual([])
    // The session's own registration still dials.
    expect(hostsOf(plur, { session: 'A' }).map(h => [h.token, h.scopes])).toEqual([['ta', [ME]]])
  })

  // F2b: `options.scopes` (the authorization allow-list) bounds dialing.
  it('options.scopes bounds the dialed set: [] or another scope dials nothing', () => {
    const plur = plurWith(`  - url: "https://plur.example.com"\n    token: "t1"\n    scope: "${ME}"\n`)
    expect(hostsOf(plur, { scope: ME, scopes: [] })).toEqual([])
    expect(hostsOf(plur, { scope: ME, scopes: [SOMEONE_ELSE] })).toEqual([])
    expect(hostsOf(plur, { scope: ME, scopes: [ME] }).map(h => h.scopes)).toEqual([[ME]])
  })

  it('options.scopes also bounds shared-scope dialing', () => {
    const plur = plurWith(
      `  - url: "https://plur.example.com"\n    token: "t1"\n    scope: "group:acme/eng"\n` +
      `  - url: "https://plur.example.com"\n    token: "t1"\n    scope: "group:acme/comms"\n` +
      `  - url: "https://plur.example.com"\n    token: "t1"\n    scope: "${ME}"\n`,
    )
    expect(hostsOf(plur, { scope: 'project:acme/app', scopes: ['group:acme/eng'] }).map(h => h.scopes))
      .toEqual([['group:acme/eng']])
    expect(hostsOf(plur, { scope: 'project:acme/app', scopes: [] })).toEqual([])
    // dial: always is bounded too.
    const always = plurWith(`  - url: "https://a.example.com"\n    token: "t1"\n    scope: "group:acme/eng"\n    dial: always\n`)
    expect(hostsOf(always, { scopes: [] })).toEqual([])
  })

  // F4: entries whose scopes differ only by case (or Unicode fold) dial at
  // most one, preferring the exact-case match.
  it('case-folded duplicates on one host: only one entry is dialed, the exact-case one', () => {
    const plur = plurWith(
      `  - url: "https://plur.example.com"\n    token: "t1"\n    scope: "${ME}"\n` +
      `  - url: "https://plur.example.com"\n    token: "t1"\n    scope: "USER:ACME:ME"\n`,
    )
    expect(hostsOf(plur, { scope: ME }).map(h => h.scopes)).toEqual([[ME]])
    expect(hostsOf(plur, { scope: 'USER:ACME:ME' }).map(h => h.scopes)).toEqual([['USER:ACME:ME']])
    // No exact match: still exactly one entry (first in config order).
    expect(hostsOf(plur, { scope: 'User:Acme:Me' }).map(h => h.scopes)).toEqual([[ME]])
  })

  it('case-folded duplicates on two hosts: only one host is dialed', () => {
    const plur = plurWith(
      `  - url: "https://a.example.com"\n    token: "ta"\n    scope: "User:Acme:Me"\n` +
      `  - url: "https://b.example.com"\n    token: "tb"\n    scope: "${ME}"\n`,
    )
    expect(hostsOf(plur, { scope: ME }).map(h => h.url)).toEqual(['https://b.example.com'])
    expect(hostsOf(plur, { scope: 'USER:ACME:ME' })).toHaveLength(1)
  })

  it('a Unicode-fold collision (Kelvin sign) dials at most one store, the exact one', () => {
    const plur = plurWith(
      `  - url: "https://a.example.com"\n    token: "ta"\n    scope: "user:acme:\u212A"\n` +
      `  - url: "https://b.example.com"\n    token: "tb"\n    scope: "user:acme:k"\n`,
    )
    expect(hostsOf(plur, { scope: 'user:acme:k' }).map(h => h.url)).toEqual(['https://b.example.com'])
  })
})

describe('dialing — re-audit follow-ups (N3, N4)', () => {
  // N3: the read picks the store the way the write does — exact case first,
  // across every configured store — and a selected `dial: never` store means
  // no dial; it never falls through to a case twin.
  it('dial: never on the selected store means no dial, not a fall-through to a case twin', () => {
    const plur = plurWith(
      `  - url: "https://a.example.com"\n    token: "ta"\n    scope: "${ME}"\n    dial: never\n` +
      `  - url: "https://b.example.com"\n    token: "tb"\n    scope: "USER:ACME:ME"\n`,
    )
    expect(hostsOf(plur, { scope: ME })).toEqual([])
    // No exact match: first fold match in config order is A (dial: never).
    expect(hostsOf(plur, { scope: 'User:Acme:Me' })).toEqual([])
    // The write with the same strings targets A as well.
    expect((plur as any)._canonicalPersonalScope('User:Acme:Me')).toBe(ME)
    expect((plur as any)._canonicalPersonalScope(ME)).toBe(ME)
  })

  it('a path-backed store with the exact scope wins the read too: its url case twin is not dialed', () => {
    const dir = tmp('plur-userscope-path-')
    const plur = plurWith(
      `  - path: "${join(dir, 'me.yaml')}"\n    scope: "${ME}"\n` +
      `  - url: "https://b.example.com"\n    token: "tb"\n    scope: "USER:ACME:ME"\n`,
    )
    expect(hostsOf(plur, { scope: ME })).toEqual([])
    expect(hostsOf(plur, { scope: 'USER:ACME:ME' }).map(h => h.url)).toEqual(['https://b.example.com'])
  })

  // N4: the allow-list admits a store that can hold an allowed scope's rows
  // (store scope equal to, or a parent of, an allowed scope — `isScopeWithin`,
  // the nesting every read filter uses). A store that is a CHILD of an allowed
  // scope is not dialed: its rows would fail the exact allow-list filter.
  it('allow-list: a parent store is dialed for an allowed child scope; a child store is not dialed for an allowed parent', () => {
    const parent = plurWith(`  - url: "https://plur.example.com"\n    token: "t1"\n    scope: "group:acme/eng"\n`)
    expect(hostsOf(parent, { scope: 'project:acme/app', scopes: ['group:acme/eng/x'] }).map(h => h.scopes))
      .toEqual([['group:acme/eng']])
    const child = plurWith(`  - url: "https://plur.example.com"\n    token: "t1"\n    scope: "group:acme/eng/x"\n`)
    expect(hostsOf(child, { scope: 'project:acme/app', scopes: ['group:acme/eng'] })).toEqual([])
    // A sibling-prefix scope is not "within" (segment-aware).
    expect(hostsOf(parent, { scope: 'project:acme/app', scopes: ['group:acme/engx'] })).toEqual([])
  })
})

describe('store selection — second re-audit (L1, ambiguity, ownership)', () => {
  // One entry is selected per scope and used for the dial, the write target
  // and the ownership check. Preference within the exact-case matches, then
  // within the case-folded ones: a LOCAL path-backed store, then a writable
  // url store, then a readonly url store; config order breaks ties. Fail
  // safe: an exact or ambiguous match never leaves the machine when a local
  // store matches it.
  it('identical scope on a path store and a url store: the write and the read both stay local (L1)', () => {
    const dir = tmp('plur-userscope-l1u-')
    for (const order of ['path-first', 'url-first']) {
      const pathEntry = `  - path: "${join(dir, order + '.yaml')}"\n    scope: "${ME}"\n`
      const urlEntry = `  - url: "https://b.example.com"\n    token: "tb"\n    scope: "${ME}"\n`
      const plur = plurWith(order === 'path-first' ? pathEntry + urlEntry : urlEntry + pathEntry)
      expect(hostsOf(plur, { scope: ME })).toEqual([])
      expect((plur as any)._resolveRemoteStoreForScope(ME)).toBeNull()
      expect((plur as any)._isRemoteWriteScope(ME)).toBe(false)
    }
  })

  it('ambiguous spelling (no exact match): the local store wins over a remote case twin, for read and write', () => {
    const dir = tmp('plur-userscope-amb-')
    const plur = plurWith(
      `  - url: "https://b.example.com"\n    token: "tb"\n    scope: "USER:ACME:OTHER"\n` +
      `  - path: "${join(dir, 'other.yaml')}"\n    scope: "user:acme:other"\n`,
    )
    expect((plur as any)._canonicalPersonalScope('User:Acme:Other')).toBe('user:acme:other')
    expect(hostsOf(plur, { scope: 'User:Acme:Other' })).toEqual([])
    // The exact remote spelling still reaches the remote store.
    expect(hostsOf(plur, { scope: 'USER:ACME:OTHER' }).map(h => h.url)).toEqual(['https://b.example.com'])
  })

  it('three stores sharing one scope: the ownership check examines the entry the write lands on', () => {
    const ro = `  - url: "https://a.example.com"\n    token: "ta"\n    scope: "${ME}"\n    readonly: true\n`
    const rw = `  - url: "https://b.example.com"\n    token: "tb"\n    scope: "${ME}"\n`
    const plur = plurWith(ro + rw)
    // The write lands on the writable store B.
    expect(((plur as any)._resolveRemoteStoreForScope(ME) as any)?.url).toBe('https://b.example.com')
    // Only A's identity is known to be "me": B, where the write lands, is
    // unknown, so the auto-route is refused (fail closed).
    ;(plur as any)._noteMeIdentity('https://a.example.com', 'ta', { username: 'me', org_id: 'acme' })
    expect((plur as any)._refuseRemotePersonalAutoRoute(ME)).toBe(true)
    // B's identity is "me": not refused.
    ;(plur as any)._noteMeIdentity('https://b.example.com', 'tb', { username: 'me', org_id: 'acme' })
    expect((plur as any)._refuseRemotePersonalAutoRoute(ME)).toBe(false)
    // With a local path store sharing the scope too, the write stays local.
    const dir = tmp('plur-userscope-3s-')
    const withLocal = plurWith(ro + rw + `  - path: "${join(dir, 'me.yaml')}"\n    scope: "${ME}"\n`)
    expect((withLocal as any)._resolveRemoteStoreForScope(ME)).toBeNull()
    expect((withLocal as any)._refuseRemotePersonalAutoRoute(ME)).toBe(false)
  })
})

describe('personal user: scope against a live (stub) remote store', () => {
  function plurFor(storeScope: string): Plur {
    const dir = tmp('plur-userscope-e2e-')
    writeFileSync(
      join(dir, 'config.yaml'),
      `embeddings:\n  enabled: false\nstores:\n  - url: "${baseUrl}"\n    token: "${TOKEN}"\n    scope: "${storeScope}"\n`,
    )
    return new Plur({ path: dir })
  }

  it('recall scoped to user:org:me dials the user store and returns its engram', async () => {
    server.recallRows = [{
      id: 'ENG-2026-1001-901', scope: ME, status: 'active',
      statement: 'personal remote codeword zebrafinch', score: 1,
    }]
    const plur = plurFor(ME)
    const results = await plur.recall('zebrafinch', { scope: ME })
    expect(server.recallCalls).toBe(1)
    expect(server.lastRecallBody?.scopes).toEqual([ME])
    expect(results.some(e => (e as any)._originalId === 'ENG-2026-1001-901')).toBe(true)
  })

  it('recallHybrid scoped to user:org:me returns the remote engram too', async () => {
    server.recallRows = [{
      id: 'ENG-2026-1001-902', scope: ME, status: 'active',
      statement: 'personal remote codeword kestrelpine', score: 1,
    }]
    const plur = plurFor(ME)
    const results = await plur.recallHybrid('kestrelpine', { scope: ME })
    expect(server.recallCalls).toBe(1)
    expect(results.some(e => (e as any)._originalId === 'ENG-2026-1001-902')).toBe(true)
  })

  it('recall scoped to user:org:me does NOT dial a store for user:org:someone-else', async () => {
    server.recallRows = [{
      id: 'ENG-2026-1001-903', scope: SOMEONE_ELSE, status: 'active',
      statement: 'someone else codeword marmotgale', score: 1,
    }]
    const plur = plurFor(SOMEONE_ELSE)
    const results = await plur.recall('marmotgale', { scope: ME })
    expect(server.recallCalls).toBe(0)
    expect(results.some(e => (e as any)._originalId === 'ENG-2026-1001-903')).toBe(false)
  })

  it('injectHybrid with a session scoped to user:org:me dials the user store and injects its engram', async () => {
    server.recallRows = [{
      id: 'ENG-2026-1001-904', scope: ME, status: 'active',
      statement: 'always brew the oolong at eighty five degrees', score: 1,
    }]
    const plur = plurFor(ME)
    plur.setSessionScope(ME, { session: 'sess-me' })
    const result = await plur.injectHybrid('brew the oolong', { session_id: 'sess-me' })
    expect(server.recallCalls).toBe(1)
    expect(result.injected_ids.some(id => id.endsWith('-2026-1001-904'))).toBe(true)
  })

  it('injectHybrid with an explicit user:org:me scope dials the user store', async () => {
    server.recallRows = [{
      id: 'ENG-2026-1001-905', scope: ME, status: 'active',
      statement: 'always water the fern on sundays', score: 1,
    }]
    const plur = plurFor(ME)
    const result = await plur.injectHybrid('water the fern', { scope: ME })
    expect(server.recallCalls).toBe(1)
    expect(result.injected_ids.some(id => id.endsWith('-2026-1001-905'))).toBe(true)
  })

  it('recall with a differently-cased user scope dials the user store and returns its engram', async () => {
    server.recallRows = [{
      id: 'ENG-2026-1001-907', scope: ME, status: 'active',
      statement: 'personal remote codeword lynxharbor', score: 1,
    }]
    const plur = plurFor(ME)
    const results = await plur.recall('lynxharbor', { scope: 'USER:Acme:ME' })
    expect(server.recallCalls).toBe(1)
    expect(server.lastRecallBody?.scopes).toEqual([ME])
    expect(results.some(e => (e as any)._originalId === 'ENG-2026-1001-907')).toBe(true)
  })

  it('recall and injectHybrid with scopes: [] send nothing to the user store (F2b)', async () => {
    server.recallRows = [{ id: 'ENG-2026-1001-908', scope: ME, status: 'active', statement: 'codeword otterquill', score: 1 }]
    const plur = plurFor(ME)
    await plur.recall('otterquill', { scope: ME, scopes: [] })
    await plur.injectHybrid('otterquill', { scope: ME, scopes: [] })
    expect(server.recallCalls).toBe(0)
  })

  it('learn with a differently-cased user scope routes to the matching user store (F5)', async () => {
    const plur = plurFor(ME)
    const e = await plur.learnRouted('personal fact routed by folded scope', { scope: 'USER:Acme:ME' })
    expect(e.scope).toBe(ME)
    expect(server.appendCalls).toBe(1)
  })

  // N1: a write naming a LOCAL path-backed personal store stays local even
  // when a url store has the same scope in another case (audit probe R1).
  it('learn naming a path-backed personal store stays local despite a url case twin (N1)', async () => {
    const dir = tmp('plur-userscope-n1-')
    writeFileSync(join(dir, 'config.yaml'),
      `embeddings:\n  enabled: false\nstores:\n` +
      `  - path: "${join(dir, 'other.yaml')}"\n    scope: "user:acme:other"\n` +
      `  - url: "${baseUrl}"\n    token: "${TOKEN}"\n    scope: "USER:ACME:OTHER"\n`)
    const plur = new Plur({ path: dir })
    const guarded = await (plur as any)._guardSensitiveScope('a harmless fact', { scope: 'user:acme:other' })
    expect(guarded.scope).toBe('user:acme:other')
    const e = await plur.learnRouted('a harmless fact about local notes', { scope: 'user:acme:other' })
    expect(e.scope).toBe('user:acme:other')
    expect(server.appendCalls).toBe(0)
  })

  it('an auto-routed write to a path-backed personal store is not redirected to its url case twin (N1)', async () => {
    const dir = tmp('plur-userscope-n1r-')
    writeFileSync(join(dir, 'config.yaml'),
      `embeddings:\n  enabled: false\nstores:\n` +
      `  - path: "${join(dir, 'other.yaml')}"\n    scope: "user:acme:other"\n    covers: ["acme.engineering"]\n` +
      `  - url: "${baseUrl}"\n    token: "${TOKEN}"\n    scope: "USER:ACME:OTHER"\n`)
    const plur = new Plur({ path: dir })
    const e = await plur.learnRouted('the build uses a pinned toolchain', { domain: 'acme.engineering.build' })
    expect(e.scope).toBe('user:acme:other')
    expect(server.appendCalls).toBe(0)
  })

  // Restores coverage of the post-retrieval allow-list filter (_filterRemoteRows):
  // the allowed store is dialed; a server row in a CHILD scope of it is
  // admitted by the host's containment guard but dropped by the exact
  // allow-list filter (scopeAllowFilter is exact membership).
  it('allow-list: dialed store returns rows in its scope and a child scope; only the exact allowed one is kept', async () => {
    server.recallRows = [
      { id: 'ENG-2026-1001-910', scope: 'group:plur/eng', status: 'active', statement: 'team codeword ibisfern one', score: 1 },
      { id: 'ENG-2026-1001-911', scope: 'group:plur/eng/x', status: 'active', statement: 'team codeword ibisfern two', score: 1 },
    ]
    const plur = plurFor('group:plur/eng')
    const results = await plur.recall('ibisfern', { scope: 'project:plur/app', scopes: ['group:plur/eng'] })
    expect(server.recallCalls).toBe(1)
    expect(results.some(e => (e as any)._originalId === 'ENG-2026-1001-910')).toBe(true)
    expect(results.some(e => (e as any)._originalId === 'ENG-2026-1001-911')).toBe(false)
  })

  // N5: learnAsync / learnBatch fold the scope before their hash dedup, so a
  // legacy local engram under another case does not swallow the write.
  it('learnAsync and learnBatch canonicalise a personal scope before dedup (N5)', async () => {
    const dir = tmp('plur-userscope-n5-')
    writeFileSync(join(dir, 'config.yaml'), `embeddings:\n  enabled: false\n`)
    const legacy = new Plur({ path: dir })
    await legacy.learn('the kettle descaler is citric acid', { scope: 'USER:ACME:ME' })
    await legacy.learn('the bike chain wax is paraffin', { scope: 'USER:ACME:ME' })
    writeFileSync(join(dir, 'config.yaml'),
      `embeddings:\n  enabled: false\nstores:\n  - url: "${baseUrl}"\n    token: "${TOKEN}"\n    scope: "${ME}"\n`)
    const plur = new Plur({ path: dir })
    const r = await plur.learnAsync('the kettle descaler is citric acid', { scope: 'USER:ACME:ME' })
    expect(r.decision).not.toBe('NOOP')
    expect(r.engram.scope).toBe(ME)
    const b = await plur.learnBatch([{ statement: 'the bike chain wax is paraffin', context: { scope: 'USER:ACME:ME' } }])
    expect(b.results[0].decision).not.toBe('NOOP')
    expect(b.results[0].engram.scope).toBe(ME)
  })

  // M1: a config edit by another process (a local store added) is seen by
  // learnRouted, learnAsync and learnBatch before the scope is folded.
  it('stale config: a local store added by another process keeps learnRouted, learnAsync and learnBatch local (M1)', async () => {
    const dir = tmp('plur-userscope-m1-')
    const cfg = join(dir, 'config.yaml')
    writeFileSync(cfg, `embeddings:\n  enabled: false\nstores:\n  - url: "${baseUrl}"\n    token: "${TOKEN}"\n    scope: "USER:ACME:ME"\n`)
    const plur = new Plur({ path: dir })
    // Another process adds a local path store with the exact scope.
    writeFileSync(cfg,
      `embeddings:\n  enabled: false\nstores:\n` +
      `  - url: "${baseUrl}"\n    token: "${TOKEN}"\n    scope: "USER:ACME:ME"\n` +
      `  - path: "${join(dir, 'me.yaml')}"\n    scope: "${ME}"\n`)
    const future = new Date(Date.now() + 5000)
    utimesSync(cfg, future, future)
    // Batch and routed run FIRST, so neither is warmed by learnAsync's own
    // reload (re-audit 3, I8): each must read the current config itself.
    const b = await plur.learnBatch([{ statement: 'the drill bits live in the blue case', context: { scope: ME } }])
    expect(b.results[0].engram.scope).toBe(ME)
    const r = await plur.learnRouted('the saw blades are in the top drawer', { scope: ME })
    expect(r.scope).toBe(ME)
    const a = await plur.learnAsync('the lathe chuck key hangs on the left hook', { scope: ME })
    expect(a.engram.scope).toBe(ME)
    expect(server.appendCalls).toBe(0)
  })

  it('identical scope on a path store and the url store: learnRouted stays local, 0 appends (L1)', async () => {
    const dir = tmp('plur-userscope-l1-')
    writeFileSync(join(dir, 'config.yaml'),
      `embeddings:\n  enabled: false\nstores:\n` +
      `  - url: "${baseUrl}"\n    token: "${TOKEN}"\n    scope: "${ME}"\n` +
      `  - path: "${join(dir, 'me.yaml')}"\n    scope: "${ME}"\n`)
    const plur = new Plur({ path: dir })
    const e = await plur.learnRouted('the router password card is in the safe', { scope: ME })
    expect(e.scope).toBe(ME)
    expect(server.appendCalls).toBe(0)
    await plur.recall('router', { scope: ME })
    expect(server.recallCalls).toBe(0)
  })

  it('shared-scope recall against a group store is unchanged (still dials, still merges)', async () => {
    server.recallRows = [{
      id: 'ENG-2026-1001-906', scope: 'group:acme/eng', status: 'active',
      statement: 'team codeword heronslate', score: 1,
    }]
    const plur = plurFor('group:acme/eng')
    const results = await plur.recall('heronslate', { scope: 'project:acme/app' })
    expect(server.recallCalls).toBe(1)
    expect(results.some(e => (e as any)._originalId === 'ENG-2026-1001-906')).toBe(true)
  })
})

// Re-audit 3 (M2, L2): the one-store selection decides ROUTING only. The secret
// scan still runs whenever content can reach a url store with this exact
// scope, and a cached remote row does not absorb a write that stays local.
describe('identical personal scope on a path store and a url store: scan and dedup (re-audit 3)', () => {
  // A GitHub-token-shaped string, built at runtime so no literal sits in source.
  const SECRET = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0'.repeat(2).slice(0, 36)
  const DEAD = 'http://127.0.0.1:9'
  const onServer = (): string =>
    JSON.stringify([...((server as any).engrams as Map<string, unknown>).values()]) + JSON.stringify(server.appendStatements)

  let bump = 0
  function writeConfig(cfg: string, stores: string) {
    writeFileSync(cfg, `embeddings:\n  enabled: false\nstores:\n${stores}`)
    bump += 2000
    const future = new Date(Date.now() + bump)
    utimesSync(cfg, future, future)
  }
  const urlStore = (url: string, scope: string) => `  - url: "${url}"\n    token: "${TOKEN}"\n    scope: "${scope}"\n`
  const pathStore = (file: string, scope: string) => `  - path: "${file}"\n    scope: "${scope}"\n`

  async function waitQueued(plur: Plur, id: string) {
    const deadline = Date.now() + 5000
    for (;;) {
      const rows = await (plur as any)._primaryStore.load() as any[]
      if (rows.find(r => r.id === id)?.structured_data?._outbox?.last_error) break
      if (Date.now() > deadline) throw new Error('never queued')
      await new Promise(r => setTimeout(r, 10))
    }
    await new Promise(r => setTimeout(r, 30))
  }

  it('M2: updating an engram already on the server refuses a secret even when a path store shares the scope', async () => {
    const dir = tmp('plur-userscope-m2u-')
    const cfg = join(dir, 'config.yaml')
    writeConfig(cfg, urlStore(baseUrl, ME))
    const plur = new Plur({ path: dir })
    const e = await plur.learnRouted('the shop wifi name is workshop5', { scope: ME })
    expect(server.appendCalls).toBe(1)
    // The user (or another process) then adds a local store with the identical scope.
    writeConfig(cfg, urlStore(baseUrl, ME) + pathStore(join(dir, 'me.yaml'), ME))
    await expect(plur.updateEngramAsync({ ...e, statement: `the shop token is ${SECRET}` })).rejects.toThrow(/sensitive/)
    expect(onServer()).not.toContain(SECRET)
  })

  it('M2: an update that moves a queued row to the scope does not retarget a secret to the url store', async () => {
    const dir = tmp('plur-userscope-m2r-')
    const cfg = join(dir, 'config.yaml')
    writeConfig(cfg,
      urlStore(DEAD, 'group:acme/team') + urlStore(baseUrl, ME) + pathStore(join(dir, 'me.yaml'), ME))
    const plur = new Plur({ path: dir })
    const e = await plur.learn('the team standup is at nine', { scope: 'group:acme/team' })
    await waitQueued(plur, e.id)
    const row = (await plur.getById(e.id))!
    await plur.updateEngram({ ...row, scope: ME, statement: `the deploy token is ${SECRET}` })
    await plur.flushOutbox()
    expect(onServer()).not.toContain(SECRET)
    expect(server.appendCalls).toBe(0)
  })

  it('an update that moves a queued row to the scope cancels its delivery: the selected store is local', async () => {
    const dir = tmp('plur-userscope-rt-')
    const cfg = join(dir, 'config.yaml')
    writeConfig(cfg,
      urlStore(DEAD, 'group:acme/team') + urlStore(baseUrl, ME) + pathStore(join(dir, 'me.yaml'), ME))
    const plur = new Plur({ path: dir })
    const e = await plur.learn('the team retro is on fridays', { scope: 'group:acme/team' })
    await waitQueued(plur, e.id)
    const row = (await plur.getById(e.id))!
    await plur.updateEngram({ ...row, scope: ME })
    const stored = ((await (plur as any)._primaryStore.load()) as any[]).find(r => r.id === e.id)
    expect(stored.scope).toBe(ME)
    expect(stored.structured_data?._outbox).toBeUndefined()
    await plur.flushOutbox()
    expect(server.appendCalls).toBe(0)
  })

  it('M2: the outbox flush scans a queued row before it reaches the url store', async () => {
    const dir = tmp('plur-userscope-m2f-')
    const cfg = join(dir, 'config.yaml')
    // 1. Queued for the personal url store while it is unreachable.
    writeConfig(cfg, urlStore(DEAD, ME))
    const plur = new Plur({ path: dir })
    const e = await plur.learn('the shop alarm code is set', { scope: ME })
    await waitQueued(plur, e.id)
    // 2. A local store with the identical scope is added; the queued row is edited.
    writeConfig(cfg, urlStore(DEAD, ME) + pathStore(join(dir, 'me.yaml'), ME))
    const row = (await plur.getById(e.id))!
    await plur.updateEngram({ ...row, statement: `the shop token is ${SECRET}` })
    // 3. The url store becomes reachable and the outbox is flushed.
    writeConfig(cfg, urlStore(baseUrl, ME) + pathStore(join(dir, 'me.yaml'), ME))
    await plur.flushOutbox()
    expect(onServer()).not.toContain(SECRET)
  })

  it('L2: a cached remote row does not swallow a write that the selection keeps local', async () => {
    const dir = tmp('plur-userscope-l2-')
    const mePath = join(dir, 'me.yaml')
    writeConfig(join(dir, 'config.yaml'), urlStore(baseUrl, ME) + pathStore(mePath, ME))
    const plur = new Plur({ path: dir })
    const S = 'the spare house key is under the blue pot'
    const seed = new Plur({ path: tmp('plur-userscope-l2seed-') })
    const s = await seed.learn(S, { scope: 'global' })
    const cached = { ...(await seed.getById(s.id)), id: 'ENG-2026-1002-001', scope: ME }
    ;(plur as any)._getRemoteDriver({ url: baseUrl, token: TOKEN, scope: ME }).cache = { ts: Date.now(), engrams: [cached] }
    const e = await plur.learnRouted(S, { scope: ME })
    expect(e.scope).toBe(ME)
    expect(server.appendCalls).toBe(0)
    // Saved locally: the path store (or the primary) holds the statement.
    const local = [
      ...((await (plur as any)._primaryStore.load()) as any[]),
      ...(await (plur as any)._loadSecondaryAndPacks() as any[]).filter((r: any) => !r._pack && !r._fromRemoteStore),
    ]
    expect(local.some(r => r.statement === S && r.status === 'active')).toBe(true)
  })
})
