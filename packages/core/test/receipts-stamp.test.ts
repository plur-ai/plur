/**
 * `receipts.stamp_id`: a postage stamp the user bought (through the provenance
 * gateway's own stamp endpoints) is used for uploads instead of a short-lived
 * free stamp from the gateway pool. PLUR never buys stamps.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SwarmGatewayStore } from '../src/swarm-store.js'
import { anchorManifest } from '../src/anchor.js'
import { Plur } from '../src/index.js'
import type { SessionManifest } from '../src/session-manifest.js'

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
    await new SwarmGatewayStore('https://gw.test', { fetchImpl: f.impl }).put(Buffer.from('{}'))
    expect(f.calls[0]).toBe('POST /api/v1/pool/acquire')
  })

  it('with a stamp, the upload uses it and never touches the pool', async () => {
    const f = recordingFetch()
    await new SwarmGatewayStore('https://gw.test', { fetchImpl: f.impl, stampId: STAMP }).put(Buffer.from('{}'))
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

  it('config.yaml receipts.stamp_id is read; a malformed one is ignored, not fatal', async () => {
    const good = fresh()
    writeFileSync(join(good, 'config.yaml'), `receipts:\n  store: swarm\n  stamp_id: ${STAMP}\n`)
    expect(new Plur({ path: good, autoDiscover: false }).receiptsConfig()).toEqual({ store: 'swarm', stamp_id: STAMP })
    const bad = fresh()
    writeFileSync(join(bad, 'config.yaml'), `receipts:\n  store: swarm\n  stamp_id: not-a-stamp\n`)
    expect(new Plur({ path: bad, autoDiscover: false }).receiptsConfig()).toEqual({ store: 'swarm' })
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
      await expect(new SwarmGatewayStore(url, { timeoutMs: 300 }).document('ab'.repeat(32))).rejects.toThrow()
      expect(Date.now() - t0).toBeLessThan(3000)
    } finally {
      srv.closeAllConnections()
      srv.close()
    }
  })
})
