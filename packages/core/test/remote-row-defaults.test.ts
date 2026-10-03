/**
 * Team-store rows without `tags` or `activation` (#1563 review, T1).
 *
 * A row the server stored without them crashed every session start, inject
 * and recall for every user of that scope: inject walked `engram.tags`
 * ("engram.tags is not iterable"), recall read `activation.retrieval_strength`.
 * The remote-store client now gives such a row the defaults a local engram
 * gets: `tags: []` and a fresh activation record.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import { StubServer } from './helpers/stub-server.js'

const TEAM = 'group:test'
let stub: StubServer
let url: string
let dir: string

beforeAll(async () => {
  stub = new StubServer('t')
  url = (await stub.start()).url
  stub.setMe({ username: 'tester', org_id: 'test', role: 'developer', scopes: [TEAM] })
  dir = mkdtempSync(join(tmpdir(), 'plur-remote-defaults-'))
  writeFileSync(join(dir, 'config.yaml'), `embeddings:\n  enabled: false\nstores:\n  - url: "${url}"\n    token: "t"\n    scope: "${TEAM}"\n`)
  stub.seedEngram({ id: 'ENG-2026-01-01-901', scope: TEAM, status: 'active', data: { statement: 'zebra deploys go through the blue lane', type: 'behavioral' } })
  stub.seedEngram({ id: 'ENG-2026-01-01-902', scope: TEAM, status: 'active', data: { statement: 'zebra releases are cut on tuesday', type: 'procedural', tags: null, activation: { retrieval_strength: 'high' } } })
})
afterAll(async () => {
  await stub.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('team-store rows without tags or activation (#1563 review, T1)', () => {
  it('inject, hybrid inject and recall work and see the rows', async () => {
    const plur = new Plur({ path: dir })
    // As plur_session_start does: load the team rows into the cache inject and
    // hybrid recall read.
    await plur.warmRemoteCaches()
    const inj = await plur.inject('zebra deploys and releases')
    expect(`${inj.directives}\n${inj.consider}`).toMatch(/zebra/)
    const hy = await plur.injectHybrid('zebra deploys and releases')
    expect(hy).toBeDefined()
    const rec = await plur.recall('zebra deploys')
    expect(rec.length).toBeGreaterThan(0)
    const hyb = await plur.recallHybrid('zebra deploys')
    expect(hyb.length).toBeGreaterThan(0)
    for (const e of [...rec, ...hyb]) {
      expect(Array.isArray(e.tags)).toBe(true)
      expect(typeof e.activation.retrieval_strength).toBe('number')
    }
  })
})
