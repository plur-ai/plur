/**
 * R2-Integrations NEEDS-FILE, applied by R2-CoreA (overlaps core-index#10): an
 * explicit write to a TEAM (remote-backed) scope must reach the team store even
 * when the same statement already exists locally under another scope.
 *
 * The remote route ran cross-scope recurrence (#176) against the local corpus:
 * `learnRouted(X, {scope:'project:alpha'})` then
 * `learnRouted(X, {scope:'group:acme/eng'})` returned the project:alpha engram,
 * POSTed nothing and queued nothing — the team never received it.
 *
 * `globalThis.fetch` is mocked; nothing real is called.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'

const REMOTE = 'https://plur.example.com/sse'
const TEAM = 'group:acme/eng'
const X = 'Every service exposes /healthz for the load balancer'

describe('an explicit team write is not swallowed by a local cross-scope match', () => {
  let dir: string
  let originalFetch: typeof globalThis.fetch
  const posted: any[] = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-r2corea-team-'))
    originalFetch = globalThis.fetch
    posted.length = 0
    globalThis.fetch = vi.fn(async (_u: string, init?: { method?: string; body?: string }) => {
      if ((init?.method ?? 'GET') === 'POST') {
        posted.push(JSON.parse(String(init?.body ?? '{}')))
        return { ok: true, status: 201, json: async () => ({ id: `SRV-${posted.length}` }), text: async () => '' } as unknown as Response
      }
      return { ok: true, status: 200, json: async () => ({ rows: [], total_count: 0 }), text: async () => '' } as unknown as Response
    }) as never
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      stores: [{ url: REMOTE, token: 'tok', scope: TEAM, shared: true, readonly: false }], index: false,
    }))
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  })

  const statementsPosted = () => posted.map(b => b.statement ?? b.data?.statement)

  it('learnRouted: the team store receives it', async () => {
    const plur = new Plur({ path: dir })
    const local = await plur.learnRouted(X, { scope: 'project:alpha' })
    const team = await plur.learnRouted(X, { scope: TEAM })
    expect(statementsPosted()).toContain(X)
    expect(team.id).not.toBe(local.id)
    // The local project engram is left as it was.
    expect((await plur.getById(local.id))?.scope).toBe('project:alpha')
  })

  it('learn: the team store receives it', async () => {
    const plur = new Plur({ path: dir })
    await plur.learn(X, { scope: 'project:alpha' })
    await plur.learn(X, { scope: TEAM })
    await new Promise(r => setTimeout(r, 50))
    expect(statementsPosted()).toContain(X)
  })

  it('good case: a same-scope repeat is still deduplicated (one POST)', async () => {
    const plur = new Plur({ path: dir })
    await plur.learnRouted(X, { scope: TEAM })
    await plur.learnRouted(X, { scope: TEAM })
    expect(statementsPosted().filter(s => s === X)).toHaveLength(1)
  })
})
