/**
 * OpenAI embedder hardening — closes #269 (iter-1 audit gap M-9, CTO
 * F-CTO-006, Critic F-CRIT-008).
 *
 * The openai-3-large adapter previously shipped a bare fetch: a hung request
 * blocked forever, a single 429 killed a 10k-engram reembed run, an oversize
 * statement 400'd mid-migration, and embedBatch sent arbitrarily large input
 * arrays. Contract under test:
 *
 *   - AbortController timeout: embed() rejects after `timeoutMs` instead of
 *     hanging.
 *   - 429/503 retry with Retry-After respect (exponential backoff fallback),
 *     bounded by `maxRetries`. Non-retryable statuses (400) fail immediately.
 *   - embedBatch chunks requests to `maxBatchSize` inputs and
 *     `maxTokensPerRequest` estimated tokens, preserving output order.
 *   - Inputs over the 8191-token API limit are truncated before the request
 *     so one long statement can't 400 an entire migration.
 *
 * All tests inject a mock fetch via the adapter options — no network, no
 * OPENAI billing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  makeOpenAI3LargeAdapter,
  parseRetryAfterMs,
  OPENAI_3_LARGE_DIM,
  OPENAI_3_LARGE_MAX_INPUT_TOKENS,
} from '../src/embedders/openai.js'

type FetchLike = typeof globalThis.fetch

const originalKey = process.env.OPENAI_API_KEY

beforeEach(() => {
  process.env.OPENAI_API_KEY = 'sk-test-not-real'
})

afterEach(() => {
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = originalKey
})

/** Build a 200 response embedding each input as [marker, 0, 0, ...]. */
function okResponse(inputs: string[]): Response {
  const data = inputs.map((text, i) => {
    const vec = new Array(OPENAI_3_LARGE_DIM).fill(0)
    // Marker digits let order tests trace each vector back to its input.
    const m = /^t(\d+)/.exec(text)
    vec[0] = m ? Number(m[1]) : i
    return { embedding: vec }
  })
  return new Response(JSON.stringify({ data }), { status: 200 })
}

/** Record every request body's `input` array while delegating to `respond`. */
function recordingFetch(
  calls: string[][],
  respond: (inputs: string[], call: number) => Response,
): FetchLike {
  return (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] }
    calls.push(body.input)
    return respond(body.input, calls.length)
  }) as FetchLike
}

describe('openai-3-large hardening (#269) — timeout', () => {
  it('embed() aborts a hung request after timeoutMs', async () => {
    const hangingFetch: FetchLike = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted', 'AbortError')),
        )
      })) as FetchLike
    const adapter = makeOpenAI3LargeAdapter({ fetch: hangingFetch, timeoutMs: 30 })
    await expect(adapter.embed('hello')).rejects.toThrow(/timed out after 30ms/)
  })
})

describe('openai-3-large hardening (#269) — retry', () => {
  it('retries a 429 and succeeds on the next attempt', async () => {
    const calls: string[][] = []
    const fetch = recordingFetch(calls, (inputs, call) =>
      call === 1
        ? new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } })
        : okResponse(inputs),
    )
    const adapter = makeOpenAI3LargeAdapter({ fetch, retryBaseMs: 1 })
    const vec = await adapter.embed('t7 hello')
    expect(vec).toBeInstanceOf(Float32Array)
    expect(vec.length).toBe(OPENAI_3_LARGE_DIM)
    expect(calls.length).toBe(2)
  })

  it('retries a 503 and succeeds on the next attempt', async () => {
    const calls: string[][] = []
    const fetch = recordingFetch(calls, (inputs, call) =>
      call === 1 ? new Response('overloaded', { status: 503 }) : okResponse(inputs),
    )
    const adapter = makeOpenAI3LargeAdapter({ fetch, retryBaseMs: 1 })
    await adapter.embed('hello')
    expect(calls.length).toBe(2)
  })

  it('does not retry a 400 — fails on the first attempt', async () => {
    const calls: string[][] = []
    const fetch = recordingFetch(calls, () =>
      new Response('maximum context length exceeded', { status: 400 }),
    )
    const adapter = makeOpenAI3LargeAdapter({ fetch, retryBaseMs: 1 })
    await expect(adapter.embed('hello')).rejects.toThrow(/HTTP 400/)
    expect(calls.length).toBe(1)
  })

  it('gives up after maxRetries and surfaces the HTTP error', async () => {
    const calls: string[][] = []
    const fetch = recordingFetch(calls, () =>
      new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } }),
    )
    const adapter = makeOpenAI3LargeAdapter({ fetch, maxRetries: 2, retryBaseMs: 1 })
    await expect(adapter.embed('hello')).rejects.toThrow(/HTTP 429/)
    // First attempt + 2 retries.
    expect(calls.length).toBe(3)
  })

  it('parseRetryAfterMs handles seconds, HTTP-dates, and garbage', () => {
    expect(parseRetryAfterMs('2')).toBe(2000)
    expect(parseRetryAfterMs('0')).toBe(0)
    // HTTP-date ~5s in the future — allow scheduling slack.
    const date = new Date(Date.now() + 5000).toUTCString()
    const ms = parseRetryAfterMs(date)
    expect(ms).not.toBeNull()
    expect(ms!).toBeGreaterThan(2000)
    expect(ms!).toBeLessThanOrEqual(5000)
    // A date in the past clamps to 0, not negative.
    expect(parseRetryAfterMs(new Date(Date.now() - 5000).toUTCString())).toBe(0)
    expect(parseRetryAfterMs('soon')).toBeNull()
    expect(parseRetryAfterMs(null)).toBeNull()
    // Absurd server values are capped so a bad header can't stall a migration.
    expect(parseRetryAfterMs('86400')).toBe(60_000)
  })
})

describe('openai-3-large hardening (#269) — batching', () => {
  it('embedBatch chunks to maxBatchSize and preserves order', async () => {
    const calls: string[][] = []
    const fetch = recordingFetch(calls, (inputs) => okResponse(inputs))
    const adapter = makeOpenAI3LargeAdapter({ fetch, maxBatchSize: 2 })
    const texts = ['t0', 't1', 't2', 't3', 't4']
    const vecs = await adapter.embedBatch(texts)
    expect(calls.map(c => c.length)).toEqual([2, 2, 1])
    expect(vecs.length).toBe(5)
    for (let i = 0; i < 5; i++) expect(vecs[i][0]).toBe(i)
  })

  it('embedBatch splits chunks on the per-request token budget', async () => {
    const calls: string[][] = []
    const fetch = recordingFetch(calls, (inputs) => okResponse(inputs))
    // 200 chars ≈ 50 estimated tokens each; budget 100 fits two per request.
    const adapter = makeOpenAI3LargeAdapter({ fetch, maxTokensPerRequest: 100 })
    const texts = ['t0', 't1', 't2'].map(t => t.padEnd(200, 'x'))
    const vecs = await adapter.embedBatch(texts)
    expect(calls.map(c => c.length)).toEqual([2, 1])
    expect(vecs.length).toBe(3)
  })

  it('embedBatch returns [] for empty input without a request', async () => {
    const calls: string[][] = []
    const fetch = recordingFetch(calls, (inputs) => okResponse(inputs))
    const adapter = makeOpenAI3LargeAdapter({ fetch })
    expect(await adapter.embedBatch([])).toEqual([])
    expect(calls.length).toBe(0)
  })
})

describe('openai-3-large hardening (#269) — 8191-token pre-check', () => {
  it('truncates an oversize input instead of sending it', async () => {
    const calls: string[][] = []
    const fetch = recordingFetch(calls, (inputs) => okResponse(inputs))
    const adapter = makeOpenAI3LargeAdapter({ fetch })
    const maxChars = OPENAI_3_LARGE_MAX_INPUT_TOKENS * 4
    const oversize = 'y'.repeat(maxChars + 100)
    const vec = await adapter.embed(oversize)
    expect(vec.length).toBe(OPENAI_3_LARGE_DIM)
    expect(calls[0][0].length).toBe(maxChars)
  })

  it('one oversize statement does not kill the rest of a batch', async () => {
    const calls: string[][] = []
    const fetch = recordingFetch(calls, (inputs) => okResponse(inputs))
    const adapter = makeOpenAI3LargeAdapter({ fetch })
    const maxChars = OPENAI_3_LARGE_MAX_INPUT_TOKENS * 4
    const texts = ['t0', 't1'.padEnd(maxChars + 500, 'z'), 't2']
    const vecs = await adapter.embedBatch(texts)
    expect(vecs.length).toBe(3)
    const sent = calls.flat()
    expect(sent[1].length).toBe(maxChars)
    // Untouched inputs pass through verbatim.
    expect(sent[0]).toBe('t0')
    expect(sent[2]).toBe('t2')
  })
})
