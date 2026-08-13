/**
 * #845 — the embedding model cache directory must be placeable by the caller.
 *
 * transformers.js v3 derives its cache directory from the PACKAGE LOCATION
 * (`<package>/.cache`) and reads no environment variable — `HF_HOME` and
 * `TRANSFORMERS_CACHE` are both ignored (its `src/env.js`). The only lever is
 * `env.cacheDir`, assigned before the first `pipeline()` call, and that call
 * site is in core.
 *
 * So for any consumer installing from npm the model sits inside `node_modules`,
 * and every `npm ci` destroys it: ~128MB re-downloaded per deploy, and an
 * air-gapped host cannot work at all.
 *
 * The reason it stayed unnoticed is that the failure is silent by design —
 * `embed()` returning null is a DELIBERATE degradation, so hybrid recall drops
 * to BM25-only and new records are written without vectors, with nothing
 * raised. enterprise#662 reached production that way: every "hybrid" recall on
 * a containerised deployment had been BM25-only since the feature shipped, and
 * not one engram had ever been embedded.
 *
 * These tests exercise the wiring without downloading a model: the
 * `@huggingface/transformers` import is mocked, so what is asserted is that
 * core assigns `env.cacheDir` BEFORE calling `pipeline()`, and with the right
 * precedence.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/** Captures what the adapter did to the module before pipeline() was called. */
const seen: { cacheDirAtPipelineTime?: string; pipelineCalls: number } = { pipelineCalls: 0 }
const fakeEnv: { cacheDir?: string } = {}

vi.mock('@huggingface/transformers', () => ({
  env: fakeEnv,
  pipeline: async () => {
    // Record the value AS IT STOOD when pipeline ran — assigning after this
    // point would be useless, since the resolved paths are already baked.
    seen.cacheDirAtPipelineTime = fakeEnv.cacheDir
    seen.pipelineCalls++
    return async () => ({ data: new Float32Array(384) })
  },
}))

const ORIGINAL = { plur: process.env.PLUR_MODEL_CACHE_DIR, hf: process.env.HF_HOME }

async function loadOnce() {
  const mod = await import('../src/embedders/transformers-base.js')
  mod._resetTransformersPipelineCache()
  const adapter = mod.makeTransformersAdapter({
    name: 'stub', modelId: 'stub/model', dim: 384, pooling: 'mean',
  } as never)
  await adapter.embed('anything')
}

describe('model cache directory is configurable (#845)', () => {
  beforeEach(() => {
    seen.cacheDirAtPipelineTime = undefined
    seen.pipelineCalls = 0
    delete fakeEnv.cacheDir
    delete process.env.PLUR_MODEL_CACHE_DIR
    delete process.env.HF_HOME
  })
  afterEach(() => {
    if (ORIGINAL.plur === undefined) delete process.env.PLUR_MODEL_CACHE_DIR
    else process.env.PLUR_MODEL_CACHE_DIR = ORIGINAL.plur
    if (ORIGINAL.hf === undefined) delete process.env.HF_HOME
    else process.env.HF_HOME = ORIGINAL.hf
    vi.resetModules()
  })

  it('honours PLUR_MODEL_CACHE_DIR', async () => {
    process.env.PLUR_MODEL_CACHE_DIR = '/var/lib/plur/models'
    await loadOnce()
    expect(seen.cacheDirAtPipelineTime).toBe('/var/lib/plur/models')
  })

  it('sets it BEFORE pipeline() runs, which is the only moment it matters', async () => {
    process.env.PLUR_MODEL_CACHE_DIR = '/var/lib/plur/models'
    await loadOnce()
    // Not merely "the value ended up set" — it was set at the point of use.
    expect(seen.pipelineCalls).toBe(1)
    expect(seen.cacheDirAtPipelineTime).toBeDefined()
  })

  it('falls back to HF_HOME, which operators reasonably expect to work', async () => {
    process.env.HF_HOME = '/opt/hf'
    await loadOnce()
    expect(seen.cacheDirAtPipelineTime).toBe('/opt/hf')
  })

  it('prefers the explicit PLUR var over HF_HOME', async () => {
    process.env.PLUR_MODEL_CACHE_DIR = '/var/lib/plur/models'
    process.env.HF_HOME = '/opt/hf'
    await loadOnce()
    expect(seen.cacheDirAtPipelineTime).toBe('/var/lib/plur/models')
  })

  it('leaves the library default alone when neither is set', async () => {
    await loadOnce()
    // Unset, not empty-string: assigning '' would be a path, and a wrong one.
    expect(seen.cacheDirAtPipelineTime).toBeUndefined()
  })
})
