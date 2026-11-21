// security audit 2026-11-06: a content edit or retarget of a queued outbox row is a new write with a new idempotency key.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { StubServer } from './helpers/stub-server.js'

const TOKEN = 'rekey-token'
const A = 'group:test'
const B = 'group:leads'

let server: StubServer
let baseUrl: string
beforeAll(async () => { server = new StubServer(TOKEN); baseUrl = (await server.start()).url })
afterAll(async () => { await server.stop() })

describe('outbox re-key (security audit 2026-11-06)', () => {
  let root: string
  let dir: string
  let prevHome: string | undefined

  beforeEach(() => {
    server.reset()
    server.setMe({ scopes: [A, B] })
    server.honourIdempotency = true
    root = mkdtempSync(join(tmpdir(), 'plur-rekey-'))
    prevHome = process.env.HOME
    process.env.HOME = join(root, 'home')
    dir = join(root, 'store')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      index: false,
      stores: [
        { url: baseUrl, token: TOKEN, scope: A, shared: true, readonly: false },
        { url: baseUrl, token: TOKEN, scope: B, shared: true, readonly: false },
      ],
    }))
  })
  afterEach(() => {
    process.env.HOME = prevHome
    rmSync(root, { recursive: true, force: true })
  })

  const rowOf = (id: string): any =>
    ((yaml.load(readFileSync(join(dir, 'engrams.yaml'), 'utf8')) as any)?.engrams ?? []).find((e: any) => e.id === id)
  const keyOf = (id: string): string | undefined => rowOf(id)?.structured_data?._outbox?.idempotency_key

  async function queue(plur: Plur, statement: string): Promise<string> {
    server.appendErrorResponse = { status: 503, body: 'down for the test' }
    const e = await plur.learnRouted(statement, { scope: A, type: 'behavioral' })
    server.appendErrorResponse = null
    return e.id
  }

  it('an edit while the flush is on the wire never pushes the pre-edit text and keeps the edited row queued', async () => {
    const plur = new Plur({ path: dir })
    const a = await queue(plur, 'Dummy alpha fact about builds')
    const b = await queue(plur, 'Dummy beta fact naming DummyCustomerX')
    const hold = server.holdNextAppend()
    const flushing = plur.flushOutbox({ force: true })
    const first = await hold.arrived
    const target = first.includes('DummyCustomerX') ? a : b
    const original = rowOf(target).statement
    expect(await plur.updateEngram({ ...(await plur.getById(target))!, statement: 'Dummy fact (redacted)' })).toBe(true)
    hold.release()
    await flushing

    expect(server.appendStatements).not.toContain(original)
    expect(rowOf(target)?.structured_data?._outbox, 'the edited row was dropped as delivered').toBeDefined()
    await plur.flushOutbox({ force: true })
    expect(server.appendStatements).toContain('Dummy fact (redacted)')
  })

  it('a retarget after a lost answer gets a new key, so the memory lands in the new scope', async () => {
    const plur = new Plur({ path: dir })
    const id = await queue(plur, 'Dummy retarget note')
    server.appendDelayMs = 10_000 // stored on receipt, answer never arrives in time
    await plur.flushOutbox({ force: true, timeoutMs: 200 })
    server.appendDelayMs = 0
    const k1 = keyOf(id)
    expect(server.engramCount).toBe(1)

    expect(await plur.updateEngram({ ...(await plur.getById(id))!, scope: B })).toBe(true)
    expect(keyOf(id)).not.toBe(k1)
    await plur.flushOutbox({ force: true })
    expect(server.engramCount, 'the old-scope copy was taken as delivery').toBe(2)
    expect(server.lastAppendBody?.scope).toBe(B)
  })

  it('a no-op update keeps the key; a content edit replaces it', async () => {
    const plur = new Plur({ path: dir })
    const id = await queue(plur, 'Dummy gamma fact')
    const k0 = keyOf(id)
    expect(k0).toBeTruthy()
    await plur.updateEngram({ ...(await plur.getById(id))! })
    expect(keyOf(id)).toBe(k0)
    await plur.updateEngram({ ...(await plur.getById(id))!, statement: 'Dummy gamma fact, revised' })
    expect(keyOf(id)).not.toBe(k0)
  })
})
