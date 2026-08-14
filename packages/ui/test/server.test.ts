import { describe, expect, it } from 'vitest'
import { createUiServer, startViewer } from '../src/server.js'
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
