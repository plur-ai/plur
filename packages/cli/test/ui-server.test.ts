import { describe, expect, it } from 'vitest'
import { createUiServer, parseUiArgs } from '../src/commands/ui-server.js'

const ROWS = [
  { id: 'ENG-2026-0814-001', statement: 'Pin dsh deps.', scope: 'project:acme', status: 'active', activation: { frequency: 4 } },
  { id: 'ENG-2026-0813-002', statement: 'Deploy with pnpm.', scope: 'project:acme', status: 'active', activation: { frequency: 0 } },
]

/** Boot the server on an ephemeral port and return its base URL. */
async function boot(rows = ROWS) {
  const server = createUiServer({ load: async () => rows, where: '~/.plur' })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return { server, url: `http://127.0.0.1:${port}`, close: () => new Promise<void>(r => server.close(() => r())) }
}

describe('parseUiArgs', () => {
  it('defaults to port 7777 on loopback', () => {
    expect(parseUiArgs([])).toMatchObject({ port: 7777, host: '127.0.0.1', open: true })
  })

  it('accepts --port', () => {
    expect(parseUiArgs(['--port', '9100']).port).toBe(9100)
  })

  it('rejects a port outside the valid range rather than binding something odd', () => {
    expect(() => parseUiArgs(['--port', '0'])).toThrow()
    expect(() => parseUiArgs(['--port', '99999'])).toThrow()
    expect(() => parseUiArgs(['--port', 'abc'])).toThrow()
  })

  it('--no-open suppresses launching a browser', () => {
    expect(parseUiArgs(['--no-open']).open).toBe(false)
  })

  it('binds loopback only unless --host is given explicitly', () => {
    // The viewer serves an entire memory store with no auth. Defaulting to
    // 0.0.0.0 would expose it to the local network.
    expect(parseUiArgs([]).host).toBe('127.0.0.1')
    expect(parseUiArgs(['--host', '0.0.0.0']).host).toBe('0.0.0.0')
  })
})

describe('the ui server', () => {
  it('serves the browse page at /', async () => {
    const h = await boot()
    try {
      const res = await fetch(`${h.url}/`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toMatch(/text\/html/)
      const html = await res.text()
      expect(html).toContain('Pin dsh deps.')
      expect(html.startsWith('<!doctype html>')).toBe(true)
    } finally { await h.close() }
  })

  it('passes the search term through to the record list', async () => {
    const h = await boot()
    try {
      const html = await (await fetch(`${h.url}/?q=pnpm&mode=all`)).text()
      // Assert on the RECORD LIST. The stat strip and widgets describe the whole
      // store by design and do not narrow with the search, the same way the
      // enterprise Overview does not.
      const list = html.slice(html.indexOf('<div class="records">'))
      expect(list).toContain('Deploy with pnpm.')
      expect(list).not.toContain('Pin dsh deps.')
    } finally { await h.close() }
  })

  it('honours the mode switch', async () => {
    const h = await boot()
    try {
      const top = await (await fetch(`${h.url}/?mode=top`)).text()
      // 'Deploy with pnpm.' has zero recalls, so it is absent from the top slice.
      expect(top.split('<details class="rec"').length - 1).toBe(1)
      const all = await (await fetch(`${h.url}/?mode=all`)).text()
      expect(all.split('<details class="rec"').length - 1).toBe(2)
    } finally { await h.close() }
  })

  it('404s anything that is not the one route', async () => {
    const h = await boot()
    try {
      expect((await fetch(`${h.url}/../../etc/passwd`)).status).toBe(404)
      expect((await fetch(`${h.url}/admin`)).status).toBe(404)
    } finally { await h.close() }
  })

  it('refuses methods other than GET', async () => {
    const h = await boot()
    try {
      const res = await fetch(`${h.url}/`, { method: 'POST' })
      expect(res.status).toBe(405)
    } finally { await h.close() }
  })

  it('sends no-store, so a memory page is never cached to disk', async () => {
    const h = await boot()
    try {
      expect((await fetch(`${h.url}/`)).headers.get('cache-control')).toMatch(/no-store/)
    } finally { await h.close() }
  })

  it('reloads the store on every request, so new memory shows up on refresh', async () => {
    let calls = 0
    const server = createUiServer({ load: async () => { calls++; return ROWS }, where: '~/.plur' })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    try {
      await fetch(`http://127.0.0.1:${port}/`)
      await fetch(`http://127.0.0.1:${port}/`)
      expect(calls).toBe(2)
    } finally { await new Promise<void>(r => server.close(() => r())) }
  })

  it('reports a store failure as a 500 page rather than hanging or crashing', async () => {
    const server = createUiServer({ load: async () => { throw new Error('store unreadable') }, where: '~/.plur' })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`)
      expect(res.status).toBe(500)
      const body = await res.text()
      expect(body).toContain('store unreadable')
      expect(body).not.toContain('<script')
    } finally { await new Promise<void>(r => server.close(() => r())) }
  })

  it('escapes the error message — a store path is not trusted markup', async () => {
    const server = createUiServer({ load: async () => { throw new Error('<img src=x onerror=alert(1)>') }, where: '' })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    try {
      const body = await (await fetch(`http://127.0.0.1:${port}/`)).text()
      expect(body).not.toContain('<img src=x')
      expect(body).toContain('&lt;img src=x')
    } finally { await new Promise<void>(r => server.close(() => r())) }
  })
})
