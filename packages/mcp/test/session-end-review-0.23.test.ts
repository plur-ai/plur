/**
 * 0.23 code review, findings 4 and 6 (session-end side).
 *  4: memories saved from engram_suggestions at session end record THAT
 *     session in sources[].session_id, so the session's own manifest lists
 *     them as written.
 *  6: the session-end checkpoint carries the session id, so a later
 *     `plur manifest --session` finds it in the log.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { Plur } from '@plur-ai/core'
import { getToolDefinitions, _resetSessionTelemetry } from '../src/tools.js'

describe('session end: suggestions and checkpoint belong to the session (review findings 4, 6)', () => {
  let plur: Plur
  let dir: string
  let server: Server | undefined
  let uploaded: Record<string, any>[]
  let tools: ReturnType<typeof getToolDefinitions>

  const callTool = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find(t => t.name === name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    return tool.handler(args, plur) as Promise<any>
  }

  async function gateway(): Promise<string> {
    uploaded = []
    server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', c => chunks.push(c))
      req.on('end', () => {
        res.setHeader('content-type', 'application/json')
        if (req.url?.startsWith('/api/v1/pool/acquire')) return void res.end(JSON.stringify({ batch_id: 'ab'.repeat(32) }))
        if (req.url?.startsWith('/api/v1/data/')) {
          const text = Buffer.concat(chunks).toString('utf8')
          const doc = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
          uploaded.push(JSON.parse(Buffer.from(doc.data, 'base64').toString('utf8')))
          return void res.end(JSON.stringify({ reference: 'cd'.repeat(32), signatures: [] }))
        }
        res.statusCode = 404
        res.end('{}')
      })
    })
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', () => r()))
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-se-review-'))
    tools = getToolDefinitions()
    _resetSessionTelemetry()
  })
  afterEach(async () => {
    await new Promise<void>(r => (server ? server.close(() => r()) : r()))
    server = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  it('a suggestion saved at session end is recorded under that session and is on its uploaded list', async () => {
    const url = await gateway()
    writeFileSync(join(dir, 'config.yaml'), `receipts:\n  store: swarm\n  gateway_url: ${url}\n`)
    plur = new Plur({ path: dir, autoDiscover: false })
    const start = await callTool('plur_session_start', { task: 'prepare the release notes' })
    const end = await callTool('plur_session_end', {
      session_id: start.session_id,
      summary: 'Wrote release notes.',
      engram_suggestions: ['Release notes lead with what the user can now do'],
    })
    const id = end.engram_results?.[0]?.id
    expect(id, `no suggestion saved: ${JSON.stringify(end)}`).toBeTruthy()
    const saved = await plur.getById(id)
    const sessionIds = ((saved as any)?.provenance?.sources ?? (saved as any)?.sources ?? []).map((s: any) => s.session_id)
    expect(sessionIds, `sources: ${JSON.stringify(saved)}`).toContain(start.session_id)
    expect(uploaded.length, 'nothing was uploaded').toBe(1)
    expect(uploaded[0].engrams.map((e: any) => e.id), 'the suggestion is missing from the session\'s uploaded list').toContain(id)
  })

  it('the session-end checkpoint carries the session id', async () => {
    plur = new Plur({ path: dir, autoDiscover: false })
    const start = await callTool('plur_session_start', { task: 'prepare the release notes' })
    await callTool('plur_learn', { statement: 'Release notes are written in plain language', scope: 'global', session_id: start.session_id })
    const end = await callTool('plur_session_end', { session_id: start.session_id, summary: 'Wrote release notes.', engram_suggestions: [] })
    expect(end.checkpoint_hash, 'no checkpoint written').toBeTruthy()
    const hist = join(dir, 'history')
    const events = readdirSync(hist).filter(f => f.endsWith('.jsonl')).flatMap(f => readFileSync(join(hist, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)))
    const cp = events.filter(e => e.event === 'checkpoint').at(-1)
    expect(cp?.data?.session_id, `checkpoint: ${JSON.stringify(cp)}`).toBe(start.session_id)
  })
})
