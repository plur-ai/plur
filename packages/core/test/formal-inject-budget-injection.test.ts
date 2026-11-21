/**
 * Rules in plur/injection.ts that are about what gets recorded or reported:
 *  - the no-session marker is never recorded as a session id (`recordedSessionId`);
 *  - the workspace dial scope is never recorded as a session (`remotePromise.session`);
 *  - embeddings the user turned off are never flagged as degraded (`st`);
 *  - a remote-only folder whose team server did not serve the read says so
 *    (`InjectionMethods._remoteOnlyStatus`).
 * Local only: no remote is dialled, nothing real is called.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { tmpdir } from 'os'
import { Plur, NO_SESSION } from '../src/index.js'
import * as emb from '../src/embeddings.js'

let dir: string
let wasDisabled = false
beforeEach(() => {
  wasDisabled = emb.embedderStatus().disabled
  dir = fs.mkdtempSync(path.join(tmpdir(), 'plur-formal-inject-'))
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'index: false\nembeddings:\n  enabled: false\n')
})
afterEach(() => {
  emb.setEmbeddingsEnabled(!wasDisabled)
  fs.rmSync(dir, { recursive: true, force: true })
})

function coInjections(): Array<{ data: Record<string, unknown> }> {
  const historyDir = path.join(dir, 'history')
  if (!fs.existsSync(historyDir)) return []
  return fs.readdirSync(historyDir)
    .filter(f => f.endsWith('.jsonl'))
    .flatMap(f => fs.readFileSync(path.join(historyDir, f), 'utf8').split('\n').filter(Boolean))
    .map(l => JSON.parse(l))
    .filter(e => e.event === 'co_injection')
}

async function seeded(): Promise<Plur> {
  const plur = new Plur({ path: dir })
  await plur.learn('the deploy checklist lives in the release runbook', { type: 'behavioral', scope: 'global' })
  return plur
}

describe('injection history records real sessions only', () => {
  it('an inject with the no-session marker records no session id', async () => {
    const plur = await seeded()
    const r = await plur.inject('deploy checklist', { session_id: NO_SESSION })
    expect(r.count).toBeGreaterThan(0)
    const ev = coInjections()
    expect(ev).toHaveLength(1)
    expect(ev[0].data.session_id).toBeUndefined()
    expect(JSON.stringify(ev[0])).not.toContain(NO_SESSION)
  })

  it('good case: a real session id is recorded', async () => {
    const plur = await seeded()
    await plur.inject('deploy checklist', { session_id: 'sess-formal-1' })
    const ev = coInjections()
    expect(ev).toHaveLength(1)
    expect(ev[0].data.session_id).toBe('sess-formal-1')
  })

  it('the workspace dial scope is never recorded as a session', async () => {
    const plur = await seeded()
    const r = await plur.injectHybrid('deploy checklist', { dial_session: 'project:dial-only', remote: false } as never)
    expect(r.count).toBeGreaterThan(0)
    const ev = coInjections()
    expect(ev).toHaveLength(1)
    expect(ev[0].data.session_id).toBeUndefined()
    expect(JSON.stringify(ev[0])).not.toContain('project:dial-only')
  })
})

describe('embeddings turned off are a choice, not a degradation', () => {
  it('injectHybrid with embeddings disabled reports bm25-only and no degradation', async () => {
    const plur = await seeded()
    expect(emb.embedderStatus().disabled).toBe(true)
    const r = await plur.injectHybrid('deploy checklist', { remote: false })
    expect(r.count).toBeGreaterThan(0)
    expect(r.mode).toBe('bm25-only')
    expect((r as any).degraded_reason).toBeUndefined()
    expect((r as any).embedder_error).toBeUndefined()
  })
})

describe('a remote-only folder says when its team server did not serve the read', () => {
  const url = 'https://team.example.invalid'
  function remoteOnlyPlur(): Plur {
    const plur = new Plur({ path: dir })
    Object.defineProperty(plur, '_remoteOnly', { value: { folder: '/work/team', scope: 'group:acme/eng' }, configurable: true })
    ;(plur as any).config.stores = [{ url, scope: 'group:acme/eng', token: 'x', readonly: false }]
    return plur
  }

  it('not dialled, failed or missing outcomes are reported as not served', () => {
    const plur = remoteOnlyPlur()
    expect((plur as any)._remoteOnlyStatus(null).served).toBe(false)
    expect((plur as any)._remoteOnlyStatus({ engrams: [], outcomes: [] }).served).toBe(false)
    const timedOut = (plur as any)._remoteOnlyStatus({ engrams: [], outcomes: [{ url, state: 'timeout' }] })
    expect(timedOut).toMatchObject({ served: false, reason: 'timeout', scope: 'group:acme/eng' })
    const other = (plur as any)._remoteOnlyStatus({ engrams: [], outcomes: [{ url: 'https://other.example.invalid', state: 'ok' }] })
    expect(other).toMatchObject({ served: false, reason: 'not-dialled' })
  })

  it('good case: an ok outcome for the folder\'s store is served', () => {
    const plur = remoteOnlyPlur()
    expect((plur as any)._remoteOnlyStatus({ engrams: [], outcomes: [{ url, state: 'ok' }] }))
      .toMatchObject({ served: true, host: 'team.example.invalid' })
  })

  it('a folder with no scope is never reported as served', () => {
    const plur = remoteOnlyPlur()
    Object.defineProperty(plur, '_remoteOnly', { value: { folder: '/work/team', scope: undefined }, configurable: true })
    expect((plur as any)._remoteOnlyStatus({ engrams: [], outcomes: [{ url, state: 'ok' }] }))
      .toMatchObject({ served: false, reason: 'no-scope' })
  })
})
