/**
 * Security audit 2026-11-06 (hardening): the model-presence check listed one
 * required file per external-data chunk a model's config.json declares
 * (`use_external_data_format`), with no bound. A config in the model cache
 * declaring millions of chunks made every presence check build millions of
 * paths. The count is now clamped to 64.
 *
 * Dummy model files only, in a temp cache dir; no download, no network.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { modelPresence, _setDefaultModelCacheDir } from '../src/embedders/transformers-base.js'

const MODEL = 'dummy-org/dummy-model'

describe('external-data chunk count is clamped (security audit 2026-11-06)', () => {
  let root: string
  let prevCache: string | undefined
  let prevHome: string | undefined

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plur-extdata-'))
    prevCache = process.env.PLUR_MODEL_CACHE_DIR
    prevHome = process.env.HOME
    process.env.HOME = join(root, 'home')
    process.env.PLUR_MODEL_CACHE_DIR = join(root, 'cache')
    _setDefaultModelCacheDir(join(root, 'default-cache'))
  })
  afterEach(() => {
    if (prevCache === undefined) delete process.env.PLUR_MODEL_CACHE_DIR
    else process.env.PLUR_MODEL_CACHE_DIR = prevCache
    process.env.HOME = prevHome
    _setDefaultModelCacheDir(undefined)
    rmSync(root, { recursive: true, force: true })
  })

  function modelWith(chunks: number, present: number): void {
    const dir = join(root, 'cache', MODEL)
    mkdirSync(join(dir, 'onnx'), { recursive: true })
    for (const f of ['tokenizer.json', 'tokenizer_config.json']) writeFileSync(join(dir, f), '{}')
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ 'transformers.js_config': { use_external_data_format: chunks } }))
    writeFileSync(join(dir, 'onnx', 'model.onnx'), 'dummy')
    for (let i = 0; i < present; i++) writeFileSync(join(dir, 'onnx', `model.onnx_data${i === 0 ? '' : '_' + i}`), 'dummy')
  }

  it('a config declaring millions of chunks is checked in under 200 ms', async () => {
    modelWith(3_000_000, 64)
    await modelPresence(MODEL, 'model.onnx') // warm the transformers.js import
    const t0 = performance.now()
    await modelPresence(MODEL, 'model.onnx')
    expect(performance.now() - t0).toBeLessThan(200)
  })

  it('an ordinary chunk count is still checked file by file', async () => {
    modelWith(2, 2)
    expect(await modelPresence(MODEL, 'model.onnx')).toBe(true)
    rmSync(join(root, 'cache', MODEL, 'onnx', 'model.onnx_data_1'))
    expect(await modelPresence(MODEL, 'model.onnx')).toBe(false)
  })
})
