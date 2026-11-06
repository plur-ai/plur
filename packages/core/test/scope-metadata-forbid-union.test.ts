/**
 * Security audit 2026-11-06: remote /me scope metadata may only tighten the
 * local sensitivity forbid list. A server answering forbid ['secrets'] must not
 * remove 'infra' from a local forbid of ['secrets','infra'], nor from the
 * default policy of an entry with no sensitivity block, so infra content keeps
 * being held back from the shared remote scope.
 *
 * globalThis.fetch is stubbed in-process: no network, no listening socket.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'

const SRV = 'https://srv.example.invalid'
const ENG = 'group:acme/eng'
const INFRA = 'the primary database is db01.internal:5432'
const ME = {
  username: 'bob', org_id: 'acme', role: 'dev', scopes: [ENG], scope_metadata_status: 'ok',
  scope_metadata: [{ scope: ENG, description: 'eng', covers: [], sensitivity: { forbid: ['secrets'] } }],
}
let dir: string
let home: string
let oldHome: string | undefined
let oldPlurPath: string | undefined
let posts: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plur-v30-'))
  home = mkdtempSync(join(tmpdir(), 'plur-v30-home-'))
  oldHome = process.env.HOME
  oldPlurPath = process.env.PLUR_PATH
  process.env.HOME = home
  process.env.PLUR_PATH = dir
  posts = []
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const u = String(input instanceof Request ? input.url : input)
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
    if ((init?.method ?? 'GET') !== 'GET') { posts.push(u); return json({ id: 'ENG-REMOTE-1' }, 201) }
    if (u.includes('/api/v1/me')) return json(ME)
    return json({ engrams: [] })
  }))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome
  if (oldPlurPath === undefined) delete process.env.PLUR_PATH; else process.env.PLUR_PATH = oldPlurPath
  rmSync(dir, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const engEntry = (): any => ((yaml.load(readFileSync(join(dir, 'config.yaml'), 'utf8')) as any).stores ?? []).find((s: any) => s.scope === ENG)

describe.each([
  ['an explicit local forbid of secrets + infra', { sensitivity: { forbid: ['secrets', 'infra'], allow: [] } }],
  ['no local sensitivity block (default policy)', {}],
])('a narrower server forbid never loosens %s', (_label, extra) => {
  it('keeps infra forbidden on disk and keeps infra content off the server', async () => {
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      index: false,
      stores: [{ url: SRV, token: 'dummy-token', scope: ENG, shared: true, readonly: false, ...extra }],
    }))
    const plur = new Plur({ path: dir })
    plur.persistScopeMetadata(await plur.discoverRemoteScopes())

    expect(engEntry().sensitivity?.forbid ?? ['secrets', 'infra']).toEqual(expect.arrayContaining(['secrets', 'infra']))

    const after = new Plur({ path: dir })
    await after.learn(INFRA, { scope: ENG })
    expect(posts.filter(p => p.includes('/api/v1/engrams'))).toEqual([])
    // Control: non-sensitive content to the same scope does reach the server,
    // so the assertion above is not passing because nothing is ever sent.
    await after.learn('code review needs two approvals', { scope: ENG })
    expect(posts.filter(p => p.includes('/api/v1/engrams')).length).toBe(1)
  })
})
