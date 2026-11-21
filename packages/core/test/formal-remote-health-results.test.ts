/**
 * An answer never claims completeness when an implicated team server was not
 * reached, even when the remote leg itself fails.
 * Model: spec/formal/PlurSpec/RemoteHealth.lean (Completeness). Findings: spec/formal/findings/remote-health.md.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../src/remote-recall.js', async (orig) => {
  const real = await orig<typeof import('../src/remote-recall.js')>()
  return { ...real, remoteRecall: vi.fn(() => Promise.reject(new Error('remote leg failed'))) }
})

const { Plur } = await import('../src/index.js')

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function plurWithStore(): InstanceType<typeof Plur> {
  const dir = mkdtempSync(join(tmpdir(), 'plur-remote-results-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'config.yaml'),
    'embeddings:\n  enabled: false\nstores:\n  - url: "http://127.0.0.1:9"\n    token: "t"\n    scope: "group:plur/plur-ai/engineering"\n')
  return new Plur({ path: dir })
}

describe('a failed remote leg is reported, never read as not dialed', () => {
  it('recallWithMeta: results_complete is false and the host is named', async () => {
    const plur = plurWithStore()
    await plur.learn('local fact about harbours', { scope: 'project:plur/anything' })
    const res = await plur.recallWithMeta('harbours', { scope: 'project:plur/anything', deadline_ms: 2000 })
    expect(res.engrams.length).toBeGreaterThan(0)
    expect(res.remote.state).not.toBe('not_dialed')
    expect(res.remote.state).not.toBe('ok')
    expect(res.remote.hosts.map(h => h.host)).toEqual(['http://127.0.0.1:9'])
    expect(res.results_complete).toBe(false)
  })
})
