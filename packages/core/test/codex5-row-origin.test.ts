/**
 * Codex round 5, finding 2: the connection check (`plur-enterprise init`'s
 * hello) has to show that ONE server stored and returned an id. Two servers
 * can serve the same scope, and one server's ids can equal another's, so
 * neither the merged results nor the id shape say where a row came from.
 *
 * Two facts are now reported:
 *  - per recall call, each dialed host's report lists the ids THAT host
 *    returned (`remote.hosts[].ids`), before rows from several hosts merge;
 *  - a learn that reached a server says which one (`deliveryOf(..).host`),
 *    the normalized endpoint (no userinfo).
 *
 * Real HTTP against two stubs.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur, normalizeEndpointUrl } from '../src/index.js'
import { StubServer } from './helpers/stub-server.js'

const TOKEN = 'plur_sk_c5-origin'
const PERSONAL = 'user:acme:alice'

let a: StubServer
let b: StubServer
let urlA: string
let urlB: string
let dir: string

const row = (id: string, statement: string) => ({
  id, scope: PERSONAL, status: 'active', score: 1, statement, type: 'behavioral', domain: 'plur.connect', tags: [],
  activation: { retrieval_strength: 0.7, storage_strength: 1, frequency: 0, last_accessed: '2026-10-01' },
})
const write = (stores: unknown[]): void =>
  writeFileSync(join(dir, 'config.yaml'), yaml.dump({ index: false, embeddings: { enabled: false }, stores }))

beforeAll(async () => {
  a = new StubServer(TOKEN)
  b = new StubServer(TOKEN)
  ;({ url: urlA } = await a.start())
  ;({ url: urlB } = await b.start())
})
afterAll(async () => { await a.stop(); await b.stop() })
beforeEach(() => {
  a.reset(); b.reset()
  dir = mkdtempSync(join(tmpdir(), 'plur-c5-origin-'))
  write([
    { url: urlA, token: TOKEN, scope: PERSONAL },
    { url: urlB, token: TOKEN, scope: PERSONAL, dial: 'always' },
  ])
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('a recall reports the ids each host returned', () => {
  it('two hosts, one id each: each host lists its own, the merged results hold both', async () => {
    a.recallRows = [row('ENG-SRV-1', 'PLUR connected: from a')]
    b.recallRows = [row('ENG-SRV-2', 'PLUR connected: from b')]
    const plur = new Plur({ path: dir })
    const meta = await plur.recallWithMeta('PLUR connected', { scope: PERSONAL })
    const hosts = meta.remote!.hosts
    const ofA = hosts.find(h => h.host === normalizeEndpointUrl(urlA))!
    const ofB = hosts.find(h => h.host === normalizeEndpointUrl(urlB))!
    const resultIds = meta.engrams.map(e => e.id)
    expect(ofA.ids).toHaveLength(1)
    expect(ofB.ids).toHaveLength(1)
    expect(ofA.ids).not.toEqual(ofB.ids)
    expect(resultIds).toEqual(expect.arrayContaining([...ofA.ids, ...ofB.ids]))
  })

  it('the same id from both hosts: merged once, listed by both hosts', async () => {
    a.recallRows = [row('ENG-SRV-1', 'PLUR connected: a')]
    b.recallRows = [row('ENG-SRV-1', 'PLUR connected: b')]
    const plur = new Plur({ path: dir })
    const meta = await plur.recallWithMeta('PLUR connected', { scope: PERSONAL })
    const [ofA, ofB] = [urlA, urlB].map(u => meta.remote!.hosts.find(h => h.host === normalizeEndpointUrl(u))!)
    expect(ofA.ids).toEqual(ofB.ids)
    expect(ofA.ids).toHaveLength(1)
    expect(meta.engrams.filter(e => e.id === ofA.ids[0])).toHaveLength(1)
  })

  it('a failed host lists no ids', async () => {
    a.recallStatus = 500
    b.recallRows = [row('ENG-SRV-2', 'PLUR connected: b')]
    const plur = new Plur({ path: dir })
    const meta = await plur.recallWithMeta('PLUR connected', { scope: PERSONAL })
    const ofA = meta.remote!.hosts.find(h => h.host === normalizeEndpointUrl(urlA))!
    expect(ofA.state).not.toBe('ok')
    expect(ofA.ids).toEqual([])
  })
})

describe('a learn that reached a server says which one', () => {
  it('the first writable store took it: its endpoint is reported, without userinfo', async () => {
    write([
      { url: urlA.replace('http://', 'http://alice:FAKE_PASSWORD@'), token: TOKEN, scope: PERSONAL },
      { url: urlB, token: TOKEN, scope: PERSONAL, dial: 'always' },
    ])
    const plur = new Plur({ path: dir })
    const engram = await plur.learnRouted('PLUR connected: alice on a test device', { scope: PERSONAL })
    const d = plur.deliveryOf(engram, PERSONAL)
    expect(d.delivery).toBe('remote')
    expect(d.host).toBe(normalizeEndpointUrl(urlA))
    expect(d.host).not.toContain('FAKE_PASSWORD')
    expect(a.appendStatements).toHaveLength(1)
    expect(b.appendStatements).toHaveLength(0)
  })

  it('a save that went to the outbox names no server', async () => {
    a.appendErrorByScope[PERSONAL] = { status: 500, body: '{"error":"down"}' }
    const plur = new Plur({ path: dir })
    const engram = await plur.learnRouted('PLUR connected: alice, queued', { scope: PERSONAL })
    const d = plur.deliveryOf(engram, PERSONAL)
    expect(d.delivery).toBe('outbox')
    expect(d.host).toBeUndefined()
  })

  it('a save absorbed by a copy a server already holds names that server', async () => {
    const plur = new Plur({ path: dir })
    const statement = 'PLUR connected: alice, saved twice'
    const first = await plur.learnRouted(statement, { scope: PERSONAL })
    const again = await plur.learnRouted(statement, { scope: PERSONAL })
    // The second write matched the copy this process already holds from the server.
    expect(a.appendStatements).toEqual([statement])
    expect(plur.readIdFor(again)).toBe(plur.readIdFor(first))
    const d = plur.deliveryOf(again, PERSONAL)
    expect(d.delivery).toBe('remote')
    expect(d.host).toBe(normalizeEndpointUrl(urlA))
  })
})
