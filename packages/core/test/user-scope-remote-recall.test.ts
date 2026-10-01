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
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
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
