/**
 * Feedback is part of recall's own ranking (owner decision 2026-11-22), so
 * recall and unified injection — which takes recall's order — both feel it.
 * Two memories that match a query equally: the one with net positive
 * feedback ranks ahead of the one with net negative feedback, whatever their
 * insertion order. Without feedback the order is unchanged.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import { _setCachedEmbedder, resetEmbedder, setEmbeddingsEnabled } from '../src/embeddings.js'

const same = new Float32Array([1, 0, 0, 0])
function stubEmbedder() {
  const embed = async () => same
  _setCachedEmbedder({
    name: 'stub-same', dim: 4, modelId: 'stub',
    embed, embedBatch: async (ts: string[]) => Promise.all(ts.map(embed)),
  } as Parameters<typeof _setCachedEmbedder>[0])
}

describe('recall ranks with feedback', () => {
  let dir: string
  let plur: Plur

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-recall-fb-'))
    writeFileSync(join(dir, 'config.yaml'), 'backend: yaml\n')
    setEmbeddingsEnabled(true)
    resetEmbedder()
    stubEmbedder()
    plur = new Plur({ path: dir, autoDiscover: false })
    await plur.ready()
  })
  afterEach(() => { resetEmbedder(); rmSync(dir, { recursive: true, force: true }) })

  it('positive feedback ranks a memory ahead of an equal match with negative feedback', async () => {
    const k8s = await plur.learn('Use kubernetes for deployment', { scope: 'global' })
    const docker = await plur.learn('Use docker for deployment', { scope: 'global' })
    await plur.feedback(docker.id, 'positive')
    await plur.feedback(docker.id, 'positive')
    await plur.feedback(k8s.id, 'negative')
    await plur.feedback(k8s.id, 'negative')
    const ids = (await plur.recallHybrid('deployment', { limit: 10 })).map(e => e.id)
    expect(ids).toContain(k8s.id)
    expect(ids.indexOf(docker.id)).toBeLessThan(ids.indexOf(k8s.id))
  })

  it('without feedback, recall keeps its own order', async () => {
    const a = await plur.learn('Use kubernetes for deployment', { scope: 'global' })
    const b = await plur.learn('Use docker for deployment', { scope: 'global' })
    const first = (await plur.recallHybrid('deployment', { limit: 10 })).map(e => e.id)
    expect(new Set(first)).toEqual(new Set([a.id, b.id]))
    const again = (await plur.recallHybrid('deployment', { limit: 10 })).map(e => e.id)
    expect(again).toEqual(first)
  })
})
