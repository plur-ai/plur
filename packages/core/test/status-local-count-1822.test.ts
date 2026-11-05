/**
 * #1822: status() splits its engram count into what is on this machine
 * (primary store, local path stores, packs) and what the remote (url) stores
 * have cached in this process. engram_count keeps its old meaning (both).
 */
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import { StubServer } from './helpers/stub-server.js'

const TOKEN = 'fixture-1822'
const SCOPE = 'group:acme/eng'
const dirs: string[] = []
const stubs: StubServer[] = []
afterAll(async () => {
  for (const s of stubs) await s.stop()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

async function setup(remoteRows: number, extraStores = '') {
  const stub = new StubServer(TOKEN)
  stubs.push(stub)
  const { url } = await stub.start()
  stub.setMe({ username: 'tester', org_id: 'acme', role: 'developer', scopes: [SCOPE] })
  for (let i = 1; i <= remoteRows; i++) {
    stub.seedEngram({ id: `ENG-SRV-${String(i).padStart(3, '0')}`, scope: SCOPE, status: 'active', data: { statement: `Team rule ${i}` } })
  }
  const root = mkdtempSync(join(tmpdir(), 'plur-status-1822-'))
  dirs.push(root)
  writeFileSync(join(root, 'config.yaml'), `embeddings:\n  enabled: false\nindex: false\nstores:\n  - url: ${url}\n    token: ${TOKEN}\n    scope: ${SCOPE}\n${extraStores}`)
  return { root, plur: new Plur({ path: root, autoDiscover: false }) }
}

describe('status() local and remote-cached engram counts (#1822)', () => {
  it('an empty local store reports 0 local engrams once the remote cache is warm', async () => {
    const { plur } = await setup(5)
    const cold = await plur.status()
    expect(cold.local_engram_count).toBe(0)
    expect(cold.remote_cached_engram_count).toBe(0)
    expect(cold.engram_count).toBe(0)

    await plur.warmRemoteCaches()
    const warm = await plur.status()
    expect(warm.local_engram_count).toBe(0)
    expect(warm.remote_cached_engram_count).toBe(5)
    // engram_count keeps its meaning for existing callers: everything loaded.
    expect(warm.engram_count).toBe(5)
    plur.close()
  })

  it('local count includes the primary store and local path stores, not the remote rows', async () => {
    const pathStoreDir = mkdtempSync(join(tmpdir(), 'plur-status-1822-path-'))
    dirs.push(pathStoreDir)
    const pathStore = join(pathStoreDir, 'engrams.yaml')
    const { plur } = await setup(3, `  - path: ${pathStore}\n    scope: project:fixture\n`)
    await plur.learn('Primary store rule for the fixture', { scope: 'global' })
    await plur.learn('Path store rule for the fixture', { scope: 'project:fixture' })
    await plur.warmRemoteCaches()

    const s = await plur.status()
    expect(s.remote_cached_engram_count).toBe(3)
    expect(s.local_engram_count).toBe(s.engram_count - 3)
    expect(s.local_engram_count).toBe(2)
    plur.close()
  })

  it('a retired local engram is not counted', async () => {
    const { plur } = await setup(0)
    const kept = await plur.learn('Kept rule for the fixture', { scope: 'global' })
    const gone = await plur.learn('Retired rule for the fixture', { scope: 'global' })
    expect(kept.id).not.toBe(gone.id)
    await plur.forget(gone.id, 'fixture', { scope: 'primary' })
    const s = await plur.status()
    expect(s.local_engram_count).toBe(1)
    expect(s.remote_cached_engram_count).toBe(0)
    plur.close()
  })
})
