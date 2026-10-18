/**
 * Gate review of #1663, Codex round 3: in a remote-only folder the semantic
 * paths use no embedder at all — a configured cloud embedder would receive
 * the query and the team's memory text, and a local one keeps their vectors
 * in this machine's embedding cache. Ranking there is by keyword.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'

const calls: string[] = []
vi.mock('../src/embeddings.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/embeddings.js')>()
  return {
    ...orig,
    semanticModelState: async () => 'ready',
    embed: async (...a: unknown[]) => { calls.push(`embed ${String(a[0]).slice(0, 40)}`); return null },
    embeddingSearch: async (engrams: unknown[], query: string) => { calls.push(`embeddingSearch ${query}`); return [] },
    embeddingSearchWithScores: async (engrams: unknown[], query: string) => { calls.push(`embeddingSearchWithScores ${query}`); return [] },
  }
})

const { Plur } = await import('../src/index.js')
const { StubServer } = await import('./helpers/stub-server.js')

const TOKEN = 'gate-1663-embed'
const TEAM = 'group:acme/client'
let server: InstanceType<typeof StubServer>
let base: string, root: string, work: string, prevHome: string | undefined

beforeAll(async () => {
  server = new StubServer(TOKEN)
  const { url } = await server.start()
  base = realpathSync(mkdtempSync(join(tmpdir(), 'plur-ro-embed-')))
  const home = join(base, 'home'); root = join(home, '.plur'); work = join(home, 'client')
  mkdirSync(root, { recursive: true }); mkdirSync(work, { recursive: true })
  prevHome = process.env.HOME; process.env.HOME = home
  writeFileSync(join(root, 'config.yaml'), yaml.dump({
    index: false,
    stores: [{ url, token: TOKEN, scope: TEAM, shared: true, readonly: false }],
  }))
  writeFileSync(join(root, 'folders.yaml'), yaml.dump({ version: 1, folders: [{ path: work, plur: 'remote-only', scope: TEAM }] }))
  server.recallRows = [{ id: 'ENG-2026-10-18-010', scope: TEAM, status: 'active', statement: 'client deploys go through the blue lane', score: 1 }]
})
afterAll(async () => {
  process.env.HOME = prevHome
  await server.stop()
  rmSync(base, { recursive: true, force: true })
})

describe('no embedder in a remote-only folder', () => {
  it('recallSemantic, recallHybrid and injectHybrid embed nothing', async () => {
    const plur = new Plur({ path: root })
    plur.bindFolder(work)
    calls.length = 0
    await plur.recallSemantic('how do client deploys go').catch(() => [])
    await plur.recallHybrid('how do client deploys go').catch(() => [])
    await plur.injectHybrid('how do client deploys go').catch(() => null)
    expect(calls).toEqual([])
  })
})

describe('Codex round 4 on #1663: every embedding entry point', () => {
  it('nearDuplicates and similaritySearch embed nothing in a remote-only folder', async () => {
    const plur = new Plur({ path: root })
    plur.bindFolder(work)
    calls.length = 0
    await plur.nearDuplicates('client deploys go through the blue lane').catch(() => null)
    await plur.similaritySearch('client deploys').catch(() => [])
    expect(calls).toEqual([])
  })
})

