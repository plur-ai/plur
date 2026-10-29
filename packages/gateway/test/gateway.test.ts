/**
 * `receipts.stamp_id`: a postage stamp the user bought (through the provenance
 * gateway's own stamp endpoints) is used for uploads instead of a short-lived
 * free stamp from the gateway pool. PLUR never buys stamps.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ProvenanceGateway, isDefaultGateway, expectedNotaryFor, DEFAULT_GATEWAY_URL, DEFAULT_NOTARY_ADDRESS } from '../src/client.js'
import { anchorManifest } from '../src/anchor.js'
import type { SessionManifest, WormStore } from '@plur-ai/core'

const STAMP = 'cd'.repeat(32)

function recordingFetch() {
  const calls: string[] = []
  const impl = async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    calls.push(`${init?.method ?? 'GET'} ${u.replace(/^https?:\/\/[^/]+/, '')}`)
    const body = u.includes('/pool/acquire') ? { batch_id: 'ab'.repeat(32) } : { reference: 'ef'.repeat(32), signatures: [] }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { calls, impl: impl as typeof fetch }
}

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
function fresh(): string {
  const d = mkdtempSync(join(tmpdir(), 'plur-receipts-stamp-'))
  dirs.push(d)
  return d
}

const manifest = { schema: 'plur/session-manifest/v1', session_id: 's1', engrams: [] } as unknown as SessionManifest

describe('receipts.stamp_id', () => {
  it('without a stamp, an upload takes one from the gateway pool', async () => {
    const f = recordingFetch()
    await new ProvenanceGateway('https://gw.test', { fetchImpl: f.impl }).put(Buffer.from('{}'))
    expect(f.calls[0]).toBe('POST /api/v1/pool/acquire')
  })

  it('with a stamp, the upload uses it and never touches the pool', async () => {
    const f = recordingFetch()
    await new ProvenanceGateway('https://gw.test', { fetchImpl: f.impl, stampId: STAMP }).put(Buffer.from('{}'))
    expect(f.calls.some(c => c.includes('/pool/')), `pool was used: ${f.calls}`).toBe(false)
    expect(f.calls).toEqual([`POST /api/v1/data/?stamp_id=${STAMP}&sign=notary`])
  })

  it('anchorManifest passes the configured stamp to the gateway', async () => {
    const f = recordingFetch()
    const real = globalThis.fetch
    globalThis.fetch = f.impl
    try {
      await anchorManifest(fresh(), manifest, { gateway_url: 'https://gw.test', stamp_id: STAMP })
    } finally {
      globalThis.fetch = real
    }
    expect(f.calls).toEqual([`POST /api/v1/data/?stamp_id=${STAMP}&sign=notary`])
  })

})

describe('gateway body read is bounded (0.23 audit, finding 18)', () => {
  it('a gateway that sends headers and then stalls the body times out', async () => {
    const { createServer } = await import('http')
    const srv = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{') })
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()))
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`
    const t0 = Date.now()
    try {
      await expect(new ProvenanceGateway(url, { timeoutMs: 300 }).document('ab'.repeat(32))).rejects.toThrow()
      expect(Date.now() - t0).toBeLessThan(3000)
    } finally {
      srv.closeAllConnections()
      srv.close()
    }
  })
})

describe('the default gateway', () => {
  it('is recognised with or without a trailing slash; any other address is not', () => {
    expect(isDefaultGateway(undefined)).toBe(true)
    expect(isDefaultGateway(DEFAULT_GATEWAY_URL + '/')).toBe(true)
    expect(isDefaultGateway('https://gw.example.org')).toBe(false)
  })
})

describe('which notary a downloaded manifest must be signed by (0.23 review, finding 9)', () => {
  it('a pinned notary always wins', () => {
    expect(expectedNotaryFor('https://gw.example.org', '0xabc')).toEqual({ address: '0xabc', source: 'pinned' })
    expect(expectedNotaryFor(DEFAULT_GATEWAY_URL, '0xabc')).toEqual({ address: '0xabc', source: 'pinned' })
  })
  it('the default gateway means the default notary, never what the gateway says about itself', () => {
    expect(expectedNotaryFor(DEFAULT_GATEWAY_URL, undefined)).toEqual({ address: DEFAULT_NOTARY_ADDRESS, source: 'default' })
  })
  it('any other gateway has no known notary unless the user pins one', () => {
    expect(expectedNotaryFor('https://gw.example.org', undefined)).toBeNull()
  })
})

describe('receipt file names (0.23 audit, finding 17)', () => {
  it('receipt file names do not collide for a.b and a_b', async () => {
    const root = fresh()
    const store: WormStore = { name: 'stub', put: async () => ({ reference: 'ef'.repeat(32) }), get: async () => ({ bytes: Buffer.alloc(0) }) }
    const m = (s: string) => ({ schema: 'plur/session-manifest/v1', session_id: s, actor: 'unidentified', window: { from: null, to: null }, engrams: [], created_at: 'x' }) as unknown as SessionManifest
    await anchorManifest(root, m('a.b'), {}, store)
    await anchorManifest(root, m('a_b'), {}, store)
    await anchorManifest(root, m('a:b'), {}, store)
    const files = readdirSync(join(root, 'receipts'))
    expect(files).toHaveLength(3)
    expect(files.some(f => f.includes(':'))).toBe(false)
  })
})

describe('the real gateway answers an upload with the reference only (0.23 smoke, scene 2)', () => {
  it('the notary signature and the stamp expiry are read back from the stored document', async () => {
    const sig = { type: 'notary', signer: '0x' + '11'.repeat(20), signature: '0x' + '22'.repeat(65), timestamp: '2026-10-29T00:00:00Z', data_hash: 'aa' }
    const calls: string[] = []
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url).replace(/^https?:\/\/[^/]+/, '')
      calls.push(`${init?.method ?? 'GET'} ${u.split('?')[0]}`)
      const body = (init?.method ?? 'GET') === 'POST'
        ? { reference: 'ef'.repeat(32), message: 'Data uploaded successfully', expires_at: '2026-10-30T11:14:25Z' }
        : { data: 'e30=', content_hash: 'x', stamp_id: 'cd'.repeat(32), signatures: [sig] }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const put = await new ProvenanceGateway('https://gw.test', { fetchImpl: impl, stampId: 'cd'.repeat(32) }).put(Buffer.from('{}'))
    expect(put.signer, 'the signer was not read back').toBe(sig.signer)
    expect(put.timestamp).toBe(sig.timestamp)
    expect(put.expires_at, 'the stamp expiry was dropped').toBe('2026-10-30T11:14:25Z')
    expect(calls).toEqual(['POST /api/v1/data/', `GET /api/v1/data/${'ef'.repeat(32)}`])
  })
})
