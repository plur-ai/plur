/**
 * 0.23 release audit, findings 4 and 5.
 *  4: an id-less plur_session_end with one session open anchors THAT session
 *     when Swarm storage is on (it used to re-resolve after the session was
 *     dropped and silently upload nothing).
 *  5: recording what a recall returned is off the reply path: a held history
 *     lock must not hold up the recall.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { Plur } from '@plur-ai/core'
import { getToolDefinitions, _resetSessionTelemetry } from '../src/tools.js'

describe('session end and recall recording (audit findings 4, 5)', () => {
  let plur: Plur
  let dir: string
  let server: Server | undefined
  let hits: string[]
  let tools: ReturnType<typeof getToolDefinitions>

  const callTool = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find(t => t.name === name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    return tool.handler(args, plur) as Promise<any>
  }

  async function gateway(): Promise<string> {
    hits = []
    server = createServer((req, res) => {
      hits.push(`${req.method} ${(req.url ?? '').split('?')[0]}`)
      req.resume()
      req.on('end', () => {
        res.setHeader('content-type', 'application/json')
        if (req.url?.startsWith('/api/v1/pool/acquire')) return void res.end(JSON.stringify({ batch_id: 'ab'.repeat(32) }))
        if (req.url?.startsWith('/api/v1/data/')) return void res.end(JSON.stringify({ reference: 'cd'.repeat(32), signatures: [] }))
        res.statusCode = 404
        res.end('{}')
      })
    })
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', () => r()))
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-anchor-audit-'))
    tools = getToolDefinitions()
    _resetSessionTelemetry()
  })
  afterEach(async () => {
    await new Promise<void>(r => (server ? server.close(() => r()) : r()))
    server = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  it('an id-less session end with one session open uploads that session', async () => {
    const url = await gateway()
    writeFileSync(join(dir, 'config.yaml'), `receipts:\n  store: swarm\n  gateway_url: ${url}\n`)
    plur = new Plur({ path: dir, autoDiscover: false })
    await callTool('plur_session_start', { task: 'prepare the release notes' })
    const end = await callTool('plur_session_end', { summary: 'Wrote release notes.', engram_suggestions: [] })
    expect(end.anchor, `no anchor in the reply: ${JSON.stringify(end)}`).toBeDefined()
    expect(end.anchor.error).toBeUndefined()
    expect(end.anchor.reference).toBe('cd'.repeat(32))
    expect(hits).toContain('POST /api/v1/data/')
  })

  it('the upload reply says Swarm storage is experimental', async () => {
    const url = await gateway()
    writeFileSync(join(dir, 'config.yaml'), `receipts:\n  store: swarm\n  gateway_url: ${url}\n`)
    plur = new Plur({ path: dir, autoDiscover: false })
    await callTool('plur_session_start', { task: 'prepare the release notes' })
    const end = await callTool('plur_session_end', { summary: 'Wrote release notes.', engram_suggestions: [] })
    expect(end.anchor.experimental).toMatch(/experimental/i)
  })

  it('a held history lock does not hold up the recall reply', async () => {
    plur = new Plur({ path: dir, autoDiscover: false })
    const start = await callTool('plur_session_start', { task: 'release notes' })
    await callTool('plur_learn', { statement: 'Release notes are written in plain language', scope: 'global', session_id: start.session_id })
    mkdirSync(join(dir, 'history'), { recursive: true })
    // Another live process (this one) holds the chain lock.
    writeFileSync(join(dir, 'history', 'chain.lock'), String(process.pid))
    try {
      const t0 = Date.now()
      await callTool('plur_recall', { query: 'release notes', session_id: start.session_id, mode: 'keyword' })
      expect(Date.now() - t0, 'the recall waited on the history lock').toBeLessThan(3000)
    } finally {
      rmSync(join(dir, 'history', 'chain.lock'), { force: true })
    }
  }, 30_000)

  it('the recall is still recorded, after the reply', async () => {
    plur = new Plur({ path: dir, autoDiscover: false })
    const start = await callTool('plur_session_start', { task: 'release notes' })
    await callTool('plur_learn', { statement: 'Release notes are written in plain language', scope: 'global', session_id: start.session_id })
    await callTool('plur_recall', { query: 'release notes', session_id: start.session_id, mode: 'keyword' })
    await new Promise(r => setTimeout(r, 200))
    const hist = join(dir, 'history')
    const text = existsSync(hist) ? readdirSync(hist).filter(f => f.endsWith('.jsonl')).map(f => readFileSync(join(hist, f), 'utf8')).join('') : ''
    expect(text).toContain('recall_returned')
  })
})
