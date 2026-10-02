/**
 * #1532 re-audit R6: plur_learn_batch reports, per item, where each save
 * landed — `delivery` remote/outbox/local and, when queued, the reason —
 * as plur_learn does. With the 10 s default server deadline, a hanging team
 * server now sends items to the outbox more often, and the batch result
 * reported them as a plain ADD with no sign they never left this machine.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createServer, type Server } from 'http'
import type { Socket } from 'net'
import { Plur } from '@plur-ai/core'
import { getToolDefinitions } from '../src/tools.js'
import { StubServer } from '../../core/test/helpers/stub-server.js'

const TEAM = 'group:test'
const batch = getToolDefinitions('full').find(t => t.name === 'plur_learn_batch')!

describe('plur_learn_batch reports per-item delivery (#1532 re-audit R6)', () => {
  let server: Server
  let url: string
  const sockets = new Set<Socket>()
  let dir: string

  beforeAll(async () => {
    server = createServer((_req, res) => { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":"expired"}') })
    server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    const a = server.address()
    if (!a || typeof a === 'string') throw new Error('no address')
    url = `http://127.0.0.1:${a.port}`
  })
  afterAll(async () => { for (const s of sockets) s.destroy(); await new Promise<void>(r => server.close(() => r())) })
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-batch-delivery-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('a team item refused with 401 is reported as outbox with the token reason; a local item as local', async () => {
    writeFileSync(join(dir, 'config.yaml'), `embeddings:\n  enabled: false\nstores:\n  - url: "${url}"\n    token: "t"\n    scope: "${TEAM}"\n`)
    const plur = new Plur({ path: dir })
    await plur.ready()
    const res = await batch.handler({
      engrams: [
        { statement: 'Team note the server refuses', scope: TEAM, domain: 'test.team' },
        { statement: 'Personal note that stays here', scope: 'global', domain: 'test.me' },
      ],
    }, plur) as any
    const byStatement = Object.fromEntries((res.results as any[]).map(r => [r.statement, r]))
    expect(byStatement['Team note the server refuses'].delivery).toBe('outbox')
    expect(byStatement['Team note the server refuses'].delivery_reason_code).toBe('auth_rejected')
    expect(byStatement['Personal note that stays here'].delivery).toBe('local')
  }, 60_000)

  it('a team item the server accepts is reported as remote', async () => {
    const stub = new StubServer('t')
    const { url: okUrl } = await stub.start()
    try {
      writeFileSync(join(dir, 'config.yaml'), `embeddings:\n  enabled: false\nstores:\n  - url: "${okUrl}"\n    token: "t"\n    scope: "${TEAM}"\n`)
      const plur = new Plur({ path: dir })
      await plur.ready()
      const res = await batch.handler({ engrams: [{ statement: 'Team note the server accepts', scope: TEAM, domain: 'test.team' }] }, plur) as any
      expect(res.results[0].delivery).toBe('remote')
      expect(stub.appendCalls).toBe(1)
    } finally { await stub.stop() }
  }, 60_000)
})
