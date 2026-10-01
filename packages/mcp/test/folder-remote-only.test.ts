/**
 * The MCP server in a remote-only folder (folder map, owner decisions
 * 2026-10-01). The server binds to its folder (`createServer`'s `folder`
 * option, else process.cwd()) and core does the rest:
 *
 *   - plur_learn with no scope goes to the folder's team scope on the server;
 *   - a personal or local-only scope is refused, naming the folder and how to
 *     change it;
 *   - plur_recall reads the team scope (dialled) and never the personal store;
 *   - plur_session_start with the server down starts without memory and says
 *     so, once, in its response.
 *
 * Real-HTTP stub; temp PLUR home and HOME only.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { Plur } from '@plur-ai/core'
import { createServer } from '../src/server.js'
import { StubServer } from '../../core/test/helpers/stub-server.js'

const TOKEN = 'mcp-remote-only-token'
const TEAM = 'group:acme/client'

let stub: StubServer
let baseUrl: string
let base: string
let home: string
let root: string
let work: string
let prevHome: string | undefined
let clients: Client[] = []

beforeAll(async () => {
  stub = new StubServer(TOKEN)
  baseUrl = (await stub.start()).url
})
afterAll(async () => { await stub.stop() })

beforeEach(() => {
  stub.reset()
  base = realpathSync(mkdtempSync(join(tmpdir(), 'plur-mcp-remote-only-')))
  home = join(base, 'home')
  root = join(home, '.plur')
  work = join(home, 'client')
  mkdirSync(root, { recursive: true })
  mkdirSync(work, { recursive: true })
  prevHome = process.env.HOME
  process.env.HOME = home
  writeFileSync(join(root, 'config.yaml'),
    `index: false\nembeddings:\n  enabled: false\nstores:\n  - url: "${baseUrl}"\n    token: "${TOKEN}"\n    scope: "${TEAM}"\n`)
  writeFileSync(join(root, 'folders.yaml'), `version: 1\nfolders:\n  - path: ${work}\n    plur: remote-only\n    scope: ${TEAM}\n`)
})

afterEach(async () => {
  await Promise.all(clients.map(c => c.close().catch(() => {})))
  clients = []
  process.env.HOME = prevHome
  rmSync(base, { recursive: true, force: true })
})

async function client(): Promise<Client> {
  const server = await createServer(new Plur({ path: root }), { profile: 'full', folder: work })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  const c = new Client({ name: 'remote-only-test', version: '1.0.0' })
  await c.connect(ct)
  clients.push(c)
  return c
}

const result = (raw: Awaited<ReturnType<Client['callTool']>>): any => JSON.parse((raw.content as any)[0].text)

describe('MCP in a remote-only folder', () => {
  it('plur_learn with no scope goes to the team scope on the server', async () => {
    const c = await client()
    const res = result(await c.callTool({ name: 'plur_learn', arguments: { statement: 'client releases are tagged vYYYY.MM' } }))
    expect(res.scope).toBe(TEAM)
    expect(stub.appendStatements).toContain('client releases are tagged vYYYY.MM')
  })

  it('plur_learn with a personal scope is refused, naming the folder and how to change it', async () => {
    const c = await client()
    const raw = await c.callTool({ name: 'plur_learn', arguments: { statement: 'my private note', scope: 'user:alice' } })
    expect(raw.isError).toBe(true)
    const text = (raw.content as any)[0].text as string
    expect(text).toContain(work)
    expect(text).toContain('plur folders set')
    expect(stub.appendCalls).toBe(0)
  })

  it('plur_recall reads the team scope and not the personal store', async () => {
    await new Plur({ path: root }).learn('recall codeword PERSONALZEBRA is personal')
    stub.recallRows = [{ id: 'ENG-2026-1001-010', scope: TEAM, status: 'active', statement: 'recall codeword TEAMHERON is the team one', score: 1 }]
    const c = await client()
    const res = result(await c.callTool({ name: 'plur_recall', arguments: { query: 'recall codeword' } }))
    const text = JSON.stringify(res)
    expect(stub.recallCalls).toBeGreaterThan(0)
    expect(text).toContain('TEAMHERON')
    expect(text).not.toContain('PERSONALZEBRA')
  })

  it('plur_session_start with the server down starts without memory and says so', async () => {
    await new Plur({ path: root }).learn('session codeword PERSONALZEBRA is personal')
    stub.recallStatus = 503
    const c = await client()
    const res = result(await c.callTool({ name: 'plur_session_start', arguments: { task: 'session codeword' } }))
    const text = JSON.stringify(res)
    expect(text).not.toContain('PERSONALZEBRA')
    expect(res.remote_only).toBeDefined()
    expect(res.remote_only.scope).toBe(TEAM)
    expect(res.remote_only.served).toBe(false)
    expect(res.remote_only.notice).toMatch(/could not be reached|without memory/i)
  })
})

describe('owner decision 4 on #1521: no session timeline in a remote-only folder', () => {
  it('plur_capture is refused and writes no episode', async () => {
    const c = await client()
    const raw = await c.callTool({ name: 'plur_capture', arguments: { summary: 'client session CAPTUREOTTER' } })
    expect(raw.isError).toBe(true)
    expect((raw.content as any)[0].text).toContain(work)
    expect(existsSync(join(root, 'episodes.yaml')) ? readFileSync(join(root, 'episodes.yaml'), 'utf8') : '').not.toContain('CAPTUREOTTER')
  })

  it('plur_session_end captures no episode, and its suggestions still reach the team server', async () => {
    const c = await client()
    const res = result(await c.callTool({ name: 'plur_session_end', arguments: {
      summary: 'client session ENDOTTER summary', engram_suggestions: ['client deploys run on Tuesdays'],
    } }))
    expect(res.engrams_created).toBe(1)
    expect(stub.appendStatements).toContain('client deploys run on Tuesdays')
    expect(existsSync(join(root, 'episodes.yaml')) ? readFileSync(join(root, 'episodes.yaml'), 'utf8') : '').not.toContain('ENDOTTER')
  })
})

describe('audit of #1521: MCP binds from the client roots and fails closed', () => {
  it('S2: started outside the workspace, a client root in a remote-only folder binds it', async () => {
    const { pathToFileURL } = await import('url')
    const server = await createServer(new Plur({ path: root }), { profile: 'full', folder: home })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    const c = new Client({ name: 'roots-test', version: '1.0.0' }, { capabilities: { roots: { listChanged: true } } })
    c.setRequestHandler('roots/list', async () => ({ roots: [{ uri: pathToFileURL(work).href, name: 'ws' }] }))
    await c.connect(ct)
    clients.push(c)
    const res = result(await c.callTool({ name: 'plur_learn', arguments: { statement: 'rooted client fact ROOTOTTER' } }))
    expect(res.scope).toBe(TEAM)
    expect(stub.appendStatements).toContain('rooted client fact ROOTOTTER')
  })

  it('S3: a malformed folders.yaml refuses writes and reads nothing personal', async () => {
    await new Plur({ path: root }).learn('malformed codeword PERSONALZEBRA')
    writeFileSync(join(root, 'folders.yaml'), 'version: 1\nfolders: [[[\n')
    const c = await client()
    const raw = await c.callTool({ name: 'plur_learn', arguments: { statement: 'should not be kept' } })
    expect(raw.isError).toBe(true)
    expect((raw.content as any)[0].text).toContain('folders.yaml')
    const rec = await c.callTool({ name: 'plur_recall', arguments: { query: 'malformed codeword' } })
    expect(JSON.stringify(rec)).not.toContain('PERSONALZEBRA')
  })
})

describe('re-audit of #1521, B-2: roots discovery fails CLOSED', () => {
  async function rootsClient(handler: () => Promise<unknown>) {
    const server = await createServer(new Plur({ path: root }), { profile: 'full', folder: home })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    const c = new Client({ name: 'roots-fail', version: '1.0.0' }, { capabilities: { roots: { listChanged: true } } })
    c.setRequestHandler('roots/list', handler as never)
    await c.connect(ct)
    clients.push(c)
    return c
  }
  const engramsText = () => (existsSync(join(root, 'engrams.yaml')) ? readFileSync(join(root, 'engrams.yaml'), 'utf8') : '')

  it('roots/list throws: the call reads and writes nothing and says so', async () => {
    const c = await rootsClient(async () => { throw new Error('no roots for you') })
    const raw = await c.callTool({ name: 'plur_learn', arguments: { statement: 'ROOTSFAIL personal note', scope: 'global' } })
    expect(raw.isError).toBe(true)
    expect((raw.content as any)[0].text).toMatch(/workspace|roots/i)
    expect(engramsText()).not.toContain('ROOTSFAIL')
  })

  it('roots/list is too slow: same', async () => {
    const { pathToFileURL } = await import('url')
    const c = await rootsClient(async () => { await new Promise(r => setTimeout(r, 2600)); return { roots: [{ uri: pathToFileURL(work).href }] } })
    const raw = await c.callTool({ name: 'plur_learn', arguments: { statement: 'ROOTSSLOW personal note', scope: 'global' } })
    expect(raw.isError).toBe(true)
    expect(engramsText()).not.toContain('ROOTSSLOW')
  }, 30_000)

  it('two concurrent first calls both wait for the roots and are both bound', async () => {
    const { pathToFileURL } = await import('url')
    const c = await rootsClient(async () => { await new Promise(r => setTimeout(r, 400)); return { roots: [{ uri: pathToFileURL(work).href }] } })
    const [a, b] = await Promise.all([
      c.callTool({ name: 'plur_learn', arguments: { statement: 'RACEA personal note', scope: 'global' } }),
      c.callTool({ name: 'plur_learn', arguments: { statement: 'RACEB personal note', scope: 'global' } }),
    ])
    expect(a.isError).toBe(true)
    expect(b.isError).toBe(true)
    expect(engramsText()).not.toMatch(/RACEA|RACEB/)
  }, 30_000)
})
