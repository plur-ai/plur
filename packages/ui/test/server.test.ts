import { describe, expect, it } from 'vitest'
import { request } from 'node:http'
import { createUiServer, startViewer } from '../src/server.js'

/** A GET with headers fetch refuses to set, notably `Host`. */
function rawGet(port: number, path: string, headers: Record<string, string>) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, res => {
      let body = ''
      res.on('data', chunk => { body += String(chunk) })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, body }) })
    })
    req.on('error', reject)
    req.end()
  })
}
import type { EngramRow } from '../src/query.js'

const ROWS: EngramRow[] = [
  { id: 'ENG-2026-0814-001', statement: 'Pin dsh deps.', scope: 'project:acme', status: 'active', activation: { frequency: 4 } },
]

describe('startViewer', () => {
  it('binds an ephemeral loopback port and returns a reachable URL', async () => {
    const viewer = await startViewer({ load: async () => ROWS, where: '~/.plur' })
    try {
      // port 0 means "whatever is free" — an embedded host must not fight over
      // a fixed number with whatever else the user is running.
      expect(viewer.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
      expect(viewer.url).not.toContain(':0/')
      const res = await fetch(viewer.url)
      expect(res.status).toBe(200)
      expect(await res.text()).toContain('Pin dsh deps.')
    } finally { await viewer.close() }
  })

  it('never binds anything but loopback, whatever the host asks for', async () => {
    // The viewer has no authentication. Reachable off-machine is a data leak,
    // so unlike `plur ui` there is deliberately no host option here at all.
    const viewer = await startViewer({ load: async () => ROWS, where: '' })
    try {
      expect(viewer.url.startsWith('http://127.0.0.1:')).toBe(true)
    } finally { await viewer.close() }
  })

  it('releases the port on close, so a restart does not collide', async () => {
    const first = await startViewer({ load: async () => ROWS, where: '' })
    const port = Number(/:(\d+)\//.exec(first.url)?.[1])
    await first.close()
    const again = await startViewer({ load: async () => ROWS, where: '', port })
    try {
      expect(again.url).toContain(`:${port}/`)
    } finally { await again.close() }
  })

  it('rejects rather than hanging when the port is taken', async () => {
    const held = await startViewer({ load: async () => ROWS, where: '' })
    const port = Number(/:(\d+)\//.exec(held.url)?.[1])
    try {
      await expect(startViewer({ load: async () => ROWS, where: '', port })).rejects.toThrow()
    } finally { await held.close() }
  })

  it('closes cleanly even if it was never hit', async () => {
    const viewer = await startViewer({ load: async () => ROWS, where: '' })
    await expect(viewer.close()).resolves.toBeUndefined()
  })
})

describe('the shared server', () => {
  it('is the same implementation the CLI serves', async () => {
    // Regression guard for the split: if this drifts from the CLI's route
    // table, one of the two hosts is serving a different viewer.
    const server = createUiServer({ load: async () => ROWS, where: '~/.plur' })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
    try {
      expect((await fetch(`${base}/`)).status).toBe(200)
      expect((await fetch(`${base}/admin`)).status).toBe(404)
      expect((await fetch(`${base}/`, { method: 'POST' })).status).toBe(405)
      expect((await fetch(`${base}/`)).headers.get('cache-control')).toMatch(/no-store/)
    } finally { await new Promise<void>(r => server.close(() => r())) }
  })

  it('serves Chinese when the browser asks for it, with no query param', async () => {
    const server = createUiServer({ load: async () => ROWS, where: '' })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
    try {
      const res = await fetch(`${base}/`, { headers: { 'accept-language': 'zh-CN,zh;q=0.9' } })
      expect(await res.text()).toContain('你的 agent 记住了')
    } finally { await new Promise<void>(r => server.close(() => r())) }
  })

  it('lets an explicit ?lang override the browser preference', async () => {
    const server = createUiServer({ load: async () => ROWS, where: '' })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
    try {
      const res = await fetch(`${base}/?lang=en`, { headers: { 'accept-language': 'zh-CN' } })
      expect(await res.text()).toContain('Your agents remember')
    } finally { await new Promise<void>(r => server.close(() => r())) }
  })
})

describe('the viewer refuses requests that are not its own page', () => {
  async function boot() {
    const server = createUiServer({ load: async () => ROWS, where: '~/.plur', openPath: '/tmp/store' })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    return { base: `http://127.0.0.1:${port}`, port, close: () => new Promise<void>(r => server.close(() => r())) }
  }

  it('rejects a cross-origin POST to /open-store — 25 of these spawned 25 file managers', async () => {
    // A cross-origin FORM post is a simple request: no preflight, no CORS to
    // stop it. "It is a POST, not an img tag" was not the protection the code
    // claimed. A loop of these is a desktop denial of service.
    const h = await boot()
    try {
      const res = await fetch(`${h.base}/open-store`, {
        method: 'POST',
        headers: { 'sec-fetch-site': 'cross-site' },
        redirect: 'manual',
      })
      expect(res.status).toBe(403)
    } finally { await h.close() }
  })

  it('still allows the viewer\'s own form to open the folder', async () => {
    const h = await boot()
    try {
      const res = await fetch(`${h.base}/open-store`, {
        method: 'POST',
        headers: { 'sec-fetch-site': 'same-origin' },
        redirect: 'manual',
      })
      expect(res.status).toBe(303)
    } finally { await h.close() }
  })

  it('rejects a rebound Host — binding loopback does not stop DNS rebinding', async () => {
    // Binding 127.0.0.1 keeps the network out, not a browser the attacker
    // controls. A short-TTL record pointing at 127.0.0.1 makes their page
    // same-origin with the viewer, and the whole store is readable.
    //
    // Raw node:http, not fetch: undici forbids overriding `Host`, so a fetch
    // with that header silently sends the real one and the test passes
    // against a server with no check at all.
    const h = await boot()
    try {
      const { status, body } = await rawGet(h.port, '/', { host: 'evil.example' })
      expect(status).toBe(403)
      expect(body).not.toContain('Pin dsh deps.')
    } finally { await h.close() }
  })

  it('accepts localhost and 127.0.0.1 by name', async () => {
    const h = await boot()
    try {
      for (const host of [`127.0.0.1:${h.port}`, `localhost:${h.port}`]) {
        expect((await rawGet(h.port, '/', { host })).status, host).toBe(200)
      }
    } finally { await h.close() }
  })

  it('forbids framing, the other half of the rebinding story', async () => {
    const h = await boot()
    try {
      const res = await fetch(`${h.base}/`)
      expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
      expect(res.headers.get('x-frame-options')).toBe('DENY')
    } finally { await h.close() }
  })

  it('rejects a cross-origin POST from a browser that sends no Sec-Fetch-Site', async () => {
    // The first fix allowed everything when the header was absent, which is
    // every pre-16.4 WebKit and every embedded webview: 15 cross-origin POSTs
    // still produced 15 file-manager spawns. Origin predates Sec-Fetch-Site
    // and is sent on every cross-origin POST.
    const h = await boot()
    try {
      const res = await fetch(`${h.base}/open-store`, {
        method: 'POST',
        headers: { origin: 'https://evil.example', referer: 'https://evil.example/x' },
        redirect: 'manual',
      })
      expect(res.status).toBe(403)
    } finally { await h.close() }
  })

  it('allows the page\'s own Origin', async () => {
    const h = await boot()
    try {
      const res = await fetch(`${h.base}/open-store`, {
        method: 'POST',
        headers: { origin: h.base },
        redirect: 'manual',
      })
      expect(res.status).toBe(303)
    } finally { await h.close() }
  })

  it('still allows a non-browser client, which sends neither header', async () => {
    const h = await boot()
    try {
      const res = await fetch(`${h.base}/open-store`, { method: 'POST', redirect: 'manual' })
      expect(res.status).toBe(303)
    } finally { await h.close() }
  })

  it('accepts an uppercase Host — hostnames are case-insensitive', async () => {
    const h = await boot()
    try {
      expect((await rawGet(h.port, '/', { host: `LOCALHOST:${h.port}` })).status).toBe(200)
    } finally { await h.close() }
  })

  it('refuses every Host spoof shape', async () => {
    const h = await boot()
    try {
      for (const host of [
        'memory.evil.example', '127.0.0.1.nip.io', 'localhost.', 'sub.localhost',
        '0.0.0.0', '127.0.0.2', '127.1', '2130706433', '0177.0.0.1', 'evil@127.0.0.1',
      ]) {
        const { status, body } = await rawGet(h.port, '/', { host })
        expect(status, host).toBe(403)
        expect(body, host).not.toContain('Pin dsh deps.')
      }
    } finally { await h.close() }
  })
})

describe('widened server (--host non-loopback)', () => {
  // Simulates the state after `plur ui --host 0.0.0.0`: the server is
  // intentionally bound to a non-loopback address. The Host-header rebinding
  // check is skipped — it would refuse every legitimate LAN client without
  // stopping anything, since the whole network can already reach the port.
  async function bootWide() {
    const server = createUiServer({ load: async () => ROWS, where: '~/.plur', widened: true })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    return { port, close: () => new Promise<void>(r => server.close(() => r())) }
  }

  it('accepts a non-loopback Host — the legitimate LAN client case', async () => {
    const h = await bootWide()
    try {
      const { status, body } = await rawGet(h.port, '/', { host: `192.168.1.50:${h.port}` })
      expect(status).toBe(200)
      expect(body).toContain('Pin dsh deps.')
    } finally { await h.close() }
  })

  it('accepts an mDNS hostname', async () => {
    const h = await bootWide()
    try {
      expect((await rawGet(h.port, '/', { host: `my-laptop.local:${h.port}` })).status).toBe(200)
    } finally { await h.close() }
  })

  it('still accepts loopback hosts', async () => {
    const h = await bootWide()
    try {
      for (const host of [`127.0.0.1:${h.port}`, `localhost:${h.port}`]) {
        expect((await rawGet(h.port, '/', { host })).status, host).toBe(200)
      }
    } finally { await h.close() }
  })
})

