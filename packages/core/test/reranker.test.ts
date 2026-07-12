/**
 * Reranker adapter contract tests — Sprint 0 cross-encoder reranker (#220).
 *
 * The hybrid recall stage takes the top-K of an RRF-fused list and rescores
 * each (query, document) pair through a cross-encoder. The contract is:
 *
 *   interface RerankerAdapter {
 *     readonly name: string
 *     readonly modelId: string
 *     score(query: string, document: string): Promise<number>
 *     scoreBatch(query: string, documents: string[]): Promise<number[]>
 *   }
 *
 * Tests in this file exercise:
 *   - The factory returns the right adapter for each known name.
 *   - Each adapter reports name + modelId matching the spec.
 *   - The "off" sentinel is detectable via isRerankerOff().
 *   - resolveRerankerName respects PLUR_RERANKER + falls back to the default (ms-marco-minilm-l6 since #451).
 *   - Unknown reranker names throw at the factory.
 *
 * Real model loads can hit the network and pull ~300 MB of weights for
 * bge-reranker-v2-m3 (q8). Live tests are gated behind
 * PLUR_RERANKER_NETWORK_TESTS=1 so CI stays offline-safe.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  getReranker,
  isRerankerOff,
  resolveRerankerName,
  RERANKER_NAMES,
  DEFAULT_RERANKER,
  _resetRerankerCache,
  _resetResolveWarnings,
  classifyRerankerFailure,
  rerankerStatus,
  recordRerankerFailure,
  recordRerankerEngaged,
  resetRerankerStatus,
  hfCacheDirName,
  type RerankerAdapter,
  type RerankerName,
} from '../src/rerankers/index.js'
import { BGE_RERANKER_V2_M3_MODEL_ID } from '../src/rerankers/bge-reranker-v2-m3.js'
import { MS_MARCO_MINILM_L6_MODEL_ID } from '../src/rerankers/ms-marco-minilm-l6.js'

const NETWORK = process.env.PLUR_RERANKER_NETWORK_TESTS === '1'

/** Expected metadata per adapter — checked even when the network is offline. */
const EXPECTED: Record<RerankerName, { modelId: string }> = {
  'bge-reranker-v2-m3':  { modelId: BGE_RERANKER_V2_M3_MODEL_ID },
  'ms-marco-minilm-l6':  { modelId: MS_MARCO_MINILM_L6_MODEL_ID },
  'off':                 { modelId: '<off>' },
}

describe('RerankerAdapter factory — metadata contract', () => {
  beforeEach(() => {
    _resetRerankerCache()
    _resetResolveWarnings()
  })

  it('exports the three expected names', () => {
    expect([...RERANKER_NAMES].sort()).toEqual(['bge-reranker-v2-m3', 'ms-marco-minilm-l6', 'off'])
  })

  it('defaults to ms-marco-minilm-l6 — per-store eval gate shipped (#451)', () => {
    expect(DEFAULT_RERANKER).toBe('ms-marco-minilm-l6')
  })

  it('throws on unknown reranker names', () => {
    expect(() => getReranker('nope' as RerankerName)).toThrow(/unknown reranker/i)
  })

  for (const name of RERANKER_NAMES) {
    describe(`adapter "${name}"`, () => {
      it('reports the expected name and modelId', () => {
        const adapter = getReranker(name)
        expect(adapter.name).toBe(name)
        expect(adapter.modelId).toBe(EXPECTED[name].modelId)
      })

      it('exposes score and scoreBatch as async functions', () => {
        const adapter = getReranker(name)
        expect(typeof adapter.score).toBe('function')
        expect(typeof adapter.scoreBatch).toBe('function')
      })
    })
  }
})

describe('the "off" sentinel', () => {
  it('isRerankerOff returns true for the off adapter', () => {
    const off = getReranker('off')
    expect(isRerankerOff(off)).toBe(true)
  })

  it('isRerankerOff returns false for the bge adapter', () => {
    const real = getReranker('bge-reranker-v2-m3')
    expect(isRerankerOff(real)).toBe(false)
  })

  it('isRerankerOff returns false for the ms-marco tiny-tier adapter', () => {
    const real = getReranker('ms-marco-minilm-l6')
    expect(isRerankerOff(real)).toBe(false)
  })

  it('off.scoreBatch returns one zero per document, preserving order semantics', async () => {
    const off = getReranker('off')
    const out = await off.scoreBatch('q', ['a', 'b', 'c'])
    expect(out).toEqual([0, 0, 0])
  })

  it('off.scoreBatch on empty array returns empty array', async () => {
    const off = getReranker('off')
    const out = await off.scoreBatch('q', [])
    expect(out).toEqual([])
  })
})

describe('resolveRerankerName — env var handling', () => {
  beforeEach(() => {
    _resetResolveWarnings()
  })

  it('falls back to default when PLUR_RERANKER is unset', () => {
    const name = resolveRerankerName({} as NodeJS.ProcessEnv)
    expect(name).toBe(DEFAULT_RERANKER)
  })

  it('respects a recognised PLUR_RERANKER value', () => {
    const name = resolveRerankerName({ PLUR_RERANKER: 'bge-reranker-v2-m3' } as NodeJS.ProcessEnv)
    expect(name).toBe('bge-reranker-v2-m3')
  })

  it('respects the tiny-tier name (#451)', () => {
    const name = resolveRerankerName({ PLUR_RERANKER: 'ms-marco-minilm-l6' } as NodeJS.ProcessEnv)
    expect(name).toBe('ms-marco-minilm-l6')
  })

  it('respects "off" explicitly', () => {
    const name = resolveRerankerName({ PLUR_RERANKER: 'off' } as NodeJS.ProcessEnv)
    expect(name).toBe('off')
  })

  it('falls back to default on an unrecognised value', () => {
    const name = resolveRerankerName({ PLUR_RERANKER: 'totally-made-up' } as NodeJS.ProcessEnv)
    expect(name).toBe(DEFAULT_RERANKER)
  })

  it('trims whitespace', () => {
    const name = resolveRerankerName({ PLUR_RERANKER: '  bge-reranker-v2-m3  ' } as NodeJS.ProcessEnv)
    expect(name).toBe('bge-reranker-v2-m3')
  })
})

// #341 — reranker non-engagement must be observable at runtime, not just a
// per-call logger.warning. The module tracks engaged/failed counts and
// classifies the last failure (corrupt-cache vs unavailable) so plur_doctor
// and the MCP recall path can surface it.
describe('reranker runtime status + failure classification (#341)', () => {
  beforeEach(() => {
    resetRerankerStatus()
  })

  it('classifies corrupt-model failures as corrupt-cache', () => {
    // The observed #340 shape: a truncated Xet download fails protobuf parsing.
    expect(classifyRerankerFailure('Protobuf parsing failed.')).toBe('corrupt-cache')
    expect(classifyRerankerFailure('unexpected end of file while reading model.onnx')).toBe('corrupt-cache')
    expect(classifyRerankerFailure('model file appears corrupt')).toBe('corrupt-cache')
    expect(classifyRerankerFailure('Download truncated at 12MB of 300MB')).toBe('corrupt-cache')
  })

  it('classifies everything else as unavailable', () => {
    expect(classifyRerankerFailure('fetch failed: getaddrinfo ENOTFOUND huggingface.co')).toBe('unavailable')
    expect(classifyRerankerFailure('404 Not Found')).toBe('unavailable')
    expect(classifyRerankerFailure('some novel error')).toBe('unavailable')
  })

  it('starts clean and records failures with classification', () => {
    expect(rerankerStatus()).toMatchObject({
      engaged_count: 0,
      failure_count: 0,
      lastError: null,
      lastErrorKind: null,
      lastFailedReranker: null,
    })
    const rec = recordRerankerFailure('bge-reranker-v2-m3', 'Protobuf parsing failed.')
    expect(rec.kind).toBe('corrupt-cache')
    expect(rec.firstFailure).toBe(true)
    expect(rerankerStatus()).toMatchObject({
      failure_count: 1,
      lastError: 'Protobuf parsing failed.',
      lastErrorKind: 'corrupt-cache',
      lastFailedReranker: 'bge-reranker-v2-m3',
    })
  })

  it('flags repeats of the same message as not-first (loud-once, no per-query flood)', () => {
    expect(recordRerankerFailure('x', 'same error').firstFailure).toBe(true)
    expect(recordRerankerFailure('x', 'same error').firstFailure).toBe(false)
    expect(recordRerankerFailure('x', 'same error').firstFailure).toBe(false)
    // A different message is news again.
    expect(recordRerankerFailure('x', 'different error').firstFailure).toBe(true)
    expect(rerankerStatus().failure_count).toBe(4)
  })

  it('records engagements', () => {
    recordRerankerEngaged()
    recordRerankerEngaged()
    expect(rerankerStatus().engaged_count).toBe(2)
  })

  it('resetRerankerStatus clears everything', () => {
    recordRerankerEngaged()
    recordRerankerFailure('x', 'boom')
    resetRerankerStatus()
    expect(rerankerStatus()).toMatchObject({
      engaged_count: 0,
      failure_count: 0,
      lastError: null,
      lastErrorKind: null,
      lastFailedReranker: null,
    })
  })

  it('hfCacheDirName maps a model id to its HF hub cache directory (purge target)', () => {
    expect(hfCacheDirName('onnx-community/bge-reranker-v2-m3-ONNX'))
      .toBe('models--onnx-community--bge-reranker-v2-m3-ONNX')
  })
})

describe.skipIf(!NETWORK)(
  'BGE reranker — live model (PLUR_RERANKER_NETWORK_TESTS=1)',
  () => {
    // Live tests share state across the suite because the model is ~300 MB.
    const LIVE_TIMEOUT = 180_000
    let adapter: RerankerAdapter

    beforeEach(() => {
      adapter = getReranker('bge-reranker-v2-m3')
    })

    it('score returns a finite number', async () => {
      const s = await adapter.score('what is the capital of France?', 'Paris is the capital of France.')
      expect(Number.isFinite(s)).toBe(true)
    }, LIVE_TIMEOUT)

    it('scoreBatch returns one score per document, in input order', async () => {
      const docs = [
        'Paris is the capital of France.',
        'Tokyo is the capital of Japan.',
        'My cat is named Whiskers.',
      ]
      const scores = await adapter.scoreBatch('what is the capital of France?', docs)
      expect(scores.length).toBe(docs.length)
      // The matching document should score highest.
      const top = scores.indexOf(Math.max(...scores))
      expect(top).toBe(0)
    }, LIVE_TIMEOUT)
  },
)

describe.skipIf(!NETWORK)(
  'ms-marco tiny-tier reranker — live model (PLUR_RERANKER_NETWORK_TESTS=1)',
  () => {
    // The tiny tier is ~23 MB quantized — loads far faster than bge, but the
    // first call may still download, so keep a generous timeout.
    const LIVE_TIMEOUT = 180_000
    let adapter: RerankerAdapter

    beforeEach(() => {
      adapter = getReranker('ms-marco-minilm-l6')
    })

    it('score returns a finite number', async () => {
      const s = await adapter.score('what is the capital of France?', 'Paris is the capital of France.')
      expect(Number.isFinite(s)).toBe(true)
    }, LIVE_TIMEOUT)

    it('scoreBatch returns one score per document, in input order', async () => {
      const docs = [
        'Paris is the capital of France.',
        'Tokyo is the capital of Japan.',
        'My cat is named Whiskers.',
      ]
      const scores = await adapter.scoreBatch('what is the capital of France?', docs)
      expect(scores.length).toBe(docs.length)
      // The matching document should score highest.
      const top = scores.indexOf(Math.max(...scores))
      expect(top).toBe(0)
    }, LIVE_TIMEOUT)

    it('scoreBatch on empty array returns empty array without loading trouble', async () => {
      const out = await adapter.scoreBatch('q', [])
      expect(out).toEqual([])
    }, LIVE_TIMEOUT)
  },
)
