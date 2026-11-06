/**
 * Security audit 2026-11-06: a remote store (or a proxy in front of it) can
 * answer an error with a body that echoes the request's Authorization header.
 * Every RemoteStore error path must redact the caller's own token before the
 * body reaches an exception message — that message is persisted as
 * `_outbox.last_error` in engrams.yaml, returned by plur_outbox and pushed by
 * plur sync. Only writeCheck used to redact; me/append/delete/feedback/patch
 * embedded the raw body.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { RemoteStore } from '../src/store/remote-store.js'
import { tokenForms } from '../src/redact-token.js'

const TOKEN = 'plur_sk_DUMMY0123456789abcdefXYZ'

function echoingFetch() {
  return vi.fn(async (_url: string | URL, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get('authorization') ?? ''
    const body = JSON.stringify({ error: 'invalid credentials', received: auth, b64: Buffer.from(TOKEN).toString('base64') })
    return new Response(body, { status: 401, headers: { 'content-type': 'application/json' } })
  })
}

async function messageOf(p: Promise<unknown>): Promise<string> {
  try { await p } catch (err) { return String((err as Error).message) }
  throw new Error('expected the call to throw')
}

describe('RemoteStore error bodies never carry the bearer token', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  const cases: Array<[string, (s: RemoteStore) => Promise<unknown>]> = [
    ['me', s => s.me()],
    ['append', s => s.append({ id: 'ENG-2026-11-06-001', statement: 'x', scope: 'group:acme/team', type: 'behavioral', status: 'active' } as any)],
    ['removeIdempotent', s => s.removeIdempotent('ENG-2026-11-06-001')],
    ['feedback', s => (s as any).feedback('ENG-2026-11-06-001', 'positive')],
    ['patch', s => s.patch('ENG-2026-11-06-001', { statement: 'y' } as any)],
  ]

  for (const [name, call] of cases) {
    it(`${name}: thrown message has no form of the token`, async () => {
      vi.stubGlobal('fetch', echoingFetch())
      const store = new RemoteStore('https://plur.example.invalid', TOKEN, 'group:acme/team')
      const msg = await messageOf(call(store))
      for (const form of tokenForms(TOKEN)) expect(msg).not.toContain(form)
    })
  }
})
