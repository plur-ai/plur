import { describe, it, expect, vi, afterEach } from 'vitest'
import { makeHttpLlm, llmFromEnv } from '../src/llm.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('makeHttpLlm', () => {
  it('posts one user message to <base>/chat/completions and returns the first choice', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const out = await makeHttpLlm('https://llm.example.com/v1/', 'k', 'm')('hello')
    expect(out).toBe('ok')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://llm.example.com/v1/chat/completions')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k')
    expect(JSON.parse(init.body as string)).toEqual({ model: 'm', messages: [{ role: 'user', content: 'hello' }], temperature: 0.1 })
  })

  it('throws on a non-2xx response and returns an empty string when there is no choice', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429, statusText: 'Too Many Requests' })))
    await expect(makeHttpLlm('https://x', 'k')('p')).rejects.toThrow('LLM API error: 429 Too Many Requests')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    expect(await makeHttpLlm('https://x', 'k')('p')).toBe('')
  })
})

describe('llmFromEnv', () => {
  it('prefers OpenRouter, falls back to OpenAI, and is undefined with neither key', async () => {
    const fetchMock = vi.fn(async () => new Response('{"choices":[{"message":{"content":""}}]}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('OPENROUTER_API_KEY', '')
    vi.stubEnv('OPENAI_API_KEY', '')
    expect(llmFromEnv()).toBeUndefined()
    vi.stubEnv('OPENAI_API_KEY', 'oa')
    await llmFromEnv()!('p')
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('https://api.openai.com/v1/chat/completions')
    vi.stubEnv('OPENROUTER_API_KEY', 'or')
    await llmFromEnv()!('p')
    expect((fetchMock.mock.calls[1] as unknown as [string])[0]).toBe('https://openrouter.ai/api/v1/chat/completions')
  })
})
