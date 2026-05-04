import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import { embedderStatus, setEmbeddingsEnabled, resetEmbedder } from '../src/embeddings.js'

/**
 * Embeddings opt-out — both runtime paths.
 *
 * Two ways to disable embeddings:
 *   1. PLUR_DISABLE_EMBEDDINGS=1 env var — picked up at module import time.
 *   2. config.yaml `embeddings.enabled: false` — wired by Plur constructor.
 *
 * In both cases:
 *   - getEmbedder() short-circuits to null without attempting to load the
 *     BGE model (no ~130MB download, no ONNX init).
 *   - embedderStatus() reports disabled=true with a human-readable reason.
 *   - recall_hybrid still works (degrades to BM25-only).
 *   - plur_doctor surfaces the disabled state distinctly from "broken".
 */

describe('embeddings opt-out', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-optout-'))
    // Module-level state may have been mutated by earlier tests in the
    // worker. Always re-enable + reset before each test.
    setEmbeddingsEnabled(true)
    resetEmbedder()
  })

  afterEach(() => {
    // Restore enabled state for downstream tests in the same worker.
    setEmbeddingsEnabled(true)
    resetEmbedder()
    rmSync(dir, { recursive: true })
  })

  describe('config.yaml opt-out', () => {
    it('honors embeddings.enabled=false from config.yaml', () => {
      writeFileSync(
        join(dir, 'config.yaml'),
        'embeddings:\n  enabled: false\n',
      )
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _plur = new Plur({ path: dir })
      const status = embedderStatus()
      expect(status.disabled).toBe(true)
      expect(status.disabledReason).toContain('config.yaml')
      expect(status.available).toBe(false)
    })

    it('leaves embeddings enabled when config has no embeddings section', () => {
      // No config.yaml at all — defaults apply
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _plur = new Plur({ path: dir })
      const status = embedderStatus()
      expect(status.disabled).toBe(false)
      expect(status.disabledReason).toBeNull()
    })

    it('leaves embeddings enabled when config explicitly opts in', () => {
      writeFileSync(
        join(dir, 'config.yaml'),
        'embeddings:\n  enabled: true\n',
      )
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _plur = new Plur({ path: dir })
      const status = embedderStatus()
      expect(status.disabled).toBe(false)
    })
  })

  describe('runtime toggle via setEmbeddingsEnabled', () => {
    it('toggles from enabled → disabled and back', () => {
      expect(embedderStatus().disabled).toBe(false)
      setEmbeddingsEnabled(false, 'test override')
      expect(embedderStatus().disabled).toBe(true)
      expect(embedderStatus().disabledReason).toBe('test override')
      setEmbeddingsEnabled(true)
      expect(embedderStatus().disabled).toBe(false)
      expect(embedderStatus().disabledReason).toBeNull()
    })

    it('uses default reason when none provided', () => {
      setEmbeddingsEnabled(false)
      expect(embedderStatus().disabledReason).toBe('embeddings disabled by config')
    })
  })

  describe('hybrid recall under opt-out', () => {
    it('recall_hybrid returns BM25 results when embeddings are disabled', async () => {
      writeFileSync(
        join(dir, 'config.yaml'),
        'embeddings:\n  enabled: false\n',
      )
      const plur = new Plur({ path: dir })
      plur.learn('The deploy script lives at scripts/deploy.sh', { type: 'procedural' })
      plur.learn('Production runs on Fly.io with autoscaling enabled', { type: 'architectural' })

      const results = await plur.recallHybrid('deploy')
      expect(Array.isArray(results)).toBe(true)
      expect(results.length).toBeGreaterThan(0)
      // Top hit should be the keyword match
      expect(results[0].statement.toLowerCase()).toContain('deploy')
    })

    it('recallHybridWithMeta reports bm25-only mode (not hybrid-degraded) when disabled', async () => {
      writeFileSync(
        join(dir, 'config.yaml'),
        'embeddings:\n  enabled: false\n',
      )
      const plur = new Plur({ path: dir })
      plur.learn('Production deploy uses blue/green via Fly machines', { type: 'architectural' })

      const meta = await plur.recallHybridWithMeta('deploy')
      // Disabled = by design, not a fault. Must NOT be hybrid-degraded
      // (which signals an embedder load failure to investigate).
      expect(meta.mode).toBe('bm25-only')
      expect(meta.embedderError).toBeNull()
    })

    it('reports hybrid mode when enabled (default config)', async () => {
      // Default config has no embeddings section → enabled. Mode should be
      // 'hybrid' (or 'hybrid-degraded' if the model failed to load in this
      // env — both are acceptable here, but never 'bm25-only' which is
      // reserved for the explicit-opt-out path.
      const plur = new Plur({ path: dir })
      plur.learn('Production deploy uses blue/green via Fly machines', { type: 'architectural' })
      const meta = await plur.recallHybridWithMeta('deploy')
      expect(['hybrid', 'hybrid-degraded']).toContain(meta.mode)
      expect(meta.mode).not.toBe('bm25-only')
    })
  })

  describe('mode reporting precedence', () => {
    it('disabled-by-config takes precedence over a separately-failing model', async () => {
      writeFileSync(
        join(dir, 'config.yaml'),
        'embeddings:\n  enabled: false\n',
      )
      const plur = new Plur({ path: dir })
      plur.learn('Anything that exercises the search path', { type: 'behavioral' })
      const meta = await plur.recallHybridWithMeta('anything')
      // Even if the model also could not load, disabled is the operative
      // truth — the user did not authorize a load attempt.
      expect(meta.mode).toBe('bm25-only')
    })
  })

  describe('PLUR_DISABLE_EMBEDDINGS env var (import-time path)', () => {
    // The env-var capture is unit-tested via the `readDisabledFromEnv` helper
    // below; the module-level `DISABLED_VIA_ENV` is just `readDisabledFromEnv(process.env)`
    // executed once at import. Testing the helper proves the parsing logic;
    // testing that the helper is wired to the export status is covered by the
    // runtime-toggle and config-yaml tests above.

    it('readDisabledFromEnv returns reason when env var is "1"', async () => {
      const { readDisabledFromEnv } = await import('../src/embeddings.js')
      const reason = readDisabledFromEnv({ PLUR_DISABLE_EMBEDDINGS: '1' })
      expect(reason).not.toBeNull()
      expect(reason).toContain('PLUR_DISABLE_EMBEDDINGS')
    })

    it('readDisabledFromEnv returns null when env var is unset', async () => {
      const { readDisabledFromEnv } = await import('../src/embeddings.js')
      expect(readDisabledFromEnv({})).toBeNull()
    })

    it('readDisabledFromEnv returns null when env var is "0" or other falsy', async () => {
      const { readDisabledFromEnv } = await import('../src/embeddings.js')
      expect(readDisabledFromEnv({ PLUR_DISABLE_EMBEDDINGS: '0' })).toBeNull()
      expect(readDisabledFromEnv({ PLUR_DISABLE_EMBEDDINGS: '' })).toBeNull()
      expect(readDisabledFromEnv({ PLUR_DISABLE_EMBEDDINGS: 'false' })).toBeNull()
    })

    it('readDisabledFromEnv accepts other truthy spellings', async () => {
      const { readDisabledFromEnv } = await import('../src/embeddings.js')
      // Accept '1', 'true', 'yes' (case-insensitive) for usability — env vars
      // are written by hand and "true" is at least as natural as "1".
      expect(readDisabledFromEnv({ PLUR_DISABLE_EMBEDDINGS: 'true' })).not.toBeNull()
      expect(readDisabledFromEnv({ PLUR_DISABLE_EMBEDDINGS: 'TRUE' })).not.toBeNull()
      expect(readDisabledFromEnv({ PLUR_DISABLE_EMBEDDINGS: 'yes' })).not.toBeNull()
    })
  })
})
