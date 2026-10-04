/**
 * Formal-verification replay (spec/formal/PlurSpec/WritePath.lean, candidate 4):
 * "private engrams stay local" (#90) across the write paths.
 *
 * learn() refuses to route an engram the caller explicitly marked
 * `visibility: 'private'` to a remote store (#90). learnRouted() — the primary
 * production path (plur_learn, CLI) — never checked, so the same input left the
 * machine or not depending on which method was called. The MCP schema describes
 * `visibility` as "Whether this memory may leave this machine".
 *
 * Fake remote via mocked fetch; nothing real is called.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'

const REMOTE = 'https://plur.example.com/sse'
const TEAM = 'group:acme/team'

describe('formal WritePath — explicit private stays local on every write path (candidate 4)', () => {
  let dir: string
  let originalFetch: typeof globalThis.fetch
  let posts: Array<Record<string, unknown>>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-formal-private-'))
    originalFetch = globalThis.fetch
    posts = []
    globalThis.fetch = vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
      if ((init?.method ?? 'GET') === 'POST') {
        posts.push(JSON.parse(String(init?.body ?? '{}')))
        return { ok: true, status: 201, json: async () => ({ id: `SRV-${posts.length}` }), text: async () => '' } as unknown as Response
      }
      return { ok: true, status: 200, json: async () => ({ rows: [], total_count: 0 }), text: async () => '' } as unknown as Response
    }) as never
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      stores: [{ url: REMOTE, token: 'tok', scope: TEAM, shared: true, readonly: false }],
      index: false,
    }))
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  })

  it('learn(): an explicitly private team-scope write is not POSTed (the #90 reference behaviour)', async () => {
    const plur = new Plur({ path: dir })
    await plur.learn('my private note about the team', { scope: TEAM, type: 'behavioral', visibility: 'private' })
    await new Promise(r => setTimeout(r, 50))
    expect(posts.length).toBe(0)
  })

  it('learnRouted(): the same input is not POSTed either', async () => {
    const plur = new Plur({ path: dir })
    const e = await plur.learnRouted('my private note about the team', { scope: TEAM, type: 'behavioral', visibility: 'private' })
    await new Promise(r => setTimeout(r, 50))
    expect(posts.length, 'learnRouted sent an explicitly private engram to the remote').toBe(0)
    expect(e.visibility).toBe('private')
    expect((await plur.getById(e.id))?.statement).toBe('my private note about the team')
  })

  it('good case: a team write that did not say private still reaches the remote via learnRouted', async () => {
    const plur = new Plur({ path: dir })
    await plur.learnRouted('a team fact for everyone', { scope: TEAM, type: 'behavioral' })
    expect(posts.length).toBe(1)
    expect(posts[0].scope).toBe(TEAM)
  })
})
