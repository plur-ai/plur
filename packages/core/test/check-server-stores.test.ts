import { afterEach, beforeEach, expect, it } from 'vitest'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Plur } from '../src/index.js'
import { RemoteStore } from '../src/store/remote-store.js'

const scope = 'project:example/team/app', token = 'fixture-device-key'
let root: string, url: string, server: Server, plur: Plur
let meStatus: number, me: any, writeStatus: number, answer: ((scopes: string[]) => unknown) | undefined
let bodies: string[][], requests: string[], stall: boolean
const config = (scopes = [scope], discovery: Record<string, unknown> = {}) => {
  writeFileSync(join(root, 'config.yaml'), JSON.stringify({ index: false, embeddings: { enabled: false }, stores: [{
    url, token, scopes, enterprise: {}, discovery: { status: 'ok', discovered_at: new Date().toISOString(), ...discovery },
  }] }))
  chmodSync(join(root, 'config.yaml'), 0o600)
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'plur-store-check-'))
  meStatus = writeStatus = 200; me = { username: 'fixture', org_id: 'example', scopes: [scope], scopes_status: 'ok' }
  bodies = []; requests = []; answer = undefined; stall = false
  server = createServer(async (req, res) => {
    requests.push(req.url!)
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end('{}'); return }
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/v1/me') { res.writeHead(meStatus); res.end(JSON.stringify(me)); return }
    if (req.url === '/api/v1/write-check') {
      let raw = ''; for await (const chunk of req) raw += chunk
      const scopes = JSON.parse(raw).scopes as string[]; bodies.push(scopes)
      res.writeHead(writeStatus)
      if (stall) { res.flushHeaders(); return }
      res.end(JSON.stringify(answer ? answer(scopes) : { results: scopes.map(scope => ({ scope, writable: true, review_held: false })) })); return
    }
    res.writeHead(401); res.end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  config(); plur = new Plur({ path: root, autoDiscover: false })
})
afterEach(async () => { plur.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }) })
const check = async () => (await plur.checkServerStores({ timeoutMs: 1000 }))[0]
const row = (result: Awaited<ReturnType<typeof check>>, name: string) => result.checks.find(c => c.name === name)!
it('checks all six facts without modifying configuration or memory', async () => {
  const before = readFileSync(join(root, 'config.yaml'), 'utf8')
  const result = await check()
  expect(result.ok).toBe(true)
  expect(result.checks.map(c => c.name).sort()).toEqual(['key', 'key-file', 'queue', 'reachable', 'scopes-fresh', 'write-path'])
  expect(result.checks.every(c => c.result === 'ok')).toBe(true)
  expect(requests).toEqual(['/api/v1/me', '/api/v1/write-check'])
  expect(readFileSync(join(root, 'config.yaml'), 'utf8')).toBe(before)
})
it('checks 120 project scopes in ordered chunks of fifty', async () => {
  const scopes = Array.from({ length: 120 }, (_, i) => `project:example/p${i}`)
  config(scopes); me.scopes = scopes
  expect((await check()).ok).toBe(true)
  expect(bodies.map(b => b.length)).toEqual([50, 50, 20]); expect(bodies.flat()).toEqual(scopes)
})
it.each(['userinfo', 'query'])('never exposes credentials from a configured %s URL', async kind => {
  const original = url
  url = kind === 'userinfo' ? url.replace('http://', 'http://fixture-user:fixture-password@') : `${url}?key=fixture-query-secret`
  config()
  const result = await check()
  expect(result.url).toBe(original)
  expect(JSON.stringify(result)).not.toMatch(/fixture-password|fixture-user|fixture-query-secret/)
})
it.each(['readonly', 'conflict'])('does not report a writable path when client routing has a %s restriction', async kind => {
  const path = join(root, 'config.yaml'), data = JSON.parse(readFileSync(path, 'utf8'))
  if (kind === 'readonly') data.stores[0].readonly = true
  else data.stores.push({ ...data.stores[0], url: `${url}/other` })
  writeFileSync(path, JSON.stringify(data))
  const result = await check()
  expect(result.ok).toBe(false)
  expect(row(result, 'write-path').result).toBe('fail')
  expect(bodies).toEqual([])
})
it('still diagnoses a server with no team scopes without a write-check request', async () => {
  config(['user:example:fixture']); me.scopes = ['user:example:fixture']
  expect(row(await check(), 'write-path')).toMatchObject({ result: 'ok', detail: 'nothing to check (no team or project scopes)' })
  expect(bodies).toEqual([]); expect(requests).toEqual(['/api/v1/me'])
})
it('does not mistake an older server for a successful permission check', async () => {
  writeStatus = 404
  const result = await check(); expect(result.ok).toBe(false)
  expect(row(result, 'write-path').result).toBe('could-not-check')
})
it('names a refused scope and reason', async () => {
  answer = scopes => ({ results: scopes.map(scope => ({ scope, writable: false, review_held: false, reason: 'no_write_access' })) })
  const result = await check(); expect(result.ok).toBe(false)
  expect(row(result, 'write-path')).toMatchObject({ result: 'fail' })
  expect(row(result, 'write-path').detail).toContain(scope); expect(row(result, 'write-path').detail).toContain('no_write_access')
})
it('explains that an accepted write is held for review', async () => {
  answer = scopes => ({ results: scopes.map(scope => ({ scope, writable: true, review_held: true })) })
  const result = await check(); expect(result.ok).toBe(true)
  expect(row(result, 'write-path').detail).toContain('held for review')
})
it.each([[], [{}], [{ scope, writable: 'true', review_held: false }], [{ scope: 'project:example/other', writable: true, review_held: false }]].map(results => ({ results })))('rejects malformed permission evidence $results', async ({ results }) => {
  answer = () => ({ results })
  expect(row(await check(), 'write-path').result).toBe('could-not-check')
})
it('rejects duplicate or reordered results that do not match the requested scopes', async () => {
  const next = 'project:example/team/next'; config([scope, next]); me.scopes.push(next)
  answer = scopes => ({ results: scopes.toReversed().map(scope => ({ scope, writable: true, review_held: false })) })
  expect(row(await check(), 'write-path').result).toBe('could-not-check')
  answer = () => ({ results: [scope, scope].map(scope => ({ scope, writable: true, review_held: false })) })
  expect(row(await check(), 'write-path').result).toBe('could-not-check')
})
it.each([401, 403])('reports HTTP %s as reachable with a rejected key', async status => {
  meStatus = status
  const result = await check(); expect(row(result, 'reachable').result).toBe('ok'); expect(row(result, 'key').result).toBe('fail')
  expect(result.ok).toBe(false)
})
it('distinguishes authenticated scope lookup failure from a generic service outage', async () => {
  meStatus = 503; me = { error: 'scope_lookup_failed' }
  const contract = await check(); expect(row(contract, 'key').result).toBe('ok'); expect(row(contract, 'scopes-fresh').result).toBe('fail')
  me = { error: 'proxy_unavailable' }
  const proxy = await check(); expect(row(proxy, 'reachable').result).toBe('ok'); expect(row(proxy, 'key').result).toBe('could-not-check')
})
it.each([{}, { scopes_status: 'not_synced', scopes: [] }])('does not accept malformed or unsynced identity evidence', async body => {
  me = body
  const result = await check(); expect(result.ok).toBe(false); expect(row(result, 'scopes-fresh').result).not.toBe('ok')
})
it.each(['2000-01-01T00:00:00Z', '2099-01-01T00:00:00Z', 'bad'])('rejects stale or invalid discovery time %s', async discovered_at => {
  config([scope], { discovered_at }); expect(row(await check(), 'scopes-fresh').result).toBe('fail')
})
it('shows saves queued for a server after its grant disappears', async () => {
  await plur.learnRouted('Backups need regular restore checks', { scope, type: 'behavioral' })
  config([]); me.scopes = []
  const result = await check()
  expect(row(result, 'queue').result).toBe('fail'); expect(row(result, 'queue').detail).toMatch(/1.*\d{4}-\d{2}-\d{2}/)
})
it('does not declare the whole queue empty through a remote-only folder view', async () => {
  await plur.learnRouted('Backups need regular restore checks', { scope, type: 'behavioral' })
  plur.bindFolderPolicy(root, { mode: 'remote-only', scope, remoteAllowed: true, source: 'map' })
  const result = await check()
  expect(result.ok).toBe(false)
  expect(row(result, 'queue').result).toBe('could-not-check')
})
it.each(['malformed', 'unreadable'])('reports %s configuration as missing evidence without leaking its contents', async mode => {
  if (mode === 'malformed') writeFileSync(join(root, 'config.yaml'), `stores: [${token}`)
  else { renameSync(join(root, 'config.yaml'), join(root, 'saved-config.yaml')); mkdirSync(join(root, 'config.yaml')) }
  const results = await plur.checkServerStores()
  expect(results.length).toBeGreaterThan(0)
  expect(results.every(r => !r.ok)).toBe(true)
  expect(JSON.stringify(results)).toContain('could-not-check')
  expect(JSON.stringify(results)).not.toContain(token)
  expect(requests).toEqual([])
})
it('reports a malformed enterprise entry instead of silently dropping its server', async () => {
  writeFileSync(join(root, 'config.yaml'), JSON.stringify({ stores: [{ url, token, enterprise: {}, scopes: scope }] }))
  const results = await plur.checkServerStores()
  expect(results.length).toBeGreaterThan(0)
  expect(results.every(r => !r.ok)).toBe(true)
  expect(JSON.stringify(results)).not.toContain(token)
  expect(requests).toEqual([])
})
it('bounds a write-check body that never finishes', async () => {
  stall = true; const started = Date.now()
  const [result] = await plur.checkServerStores({ timeoutMs: 60 })
  expect(row(result, 'write-path').result).toBe('could-not-check'); expect(Date.now() - started).toBeLessThan(1500)
})
it('never displays a reflected credential in a successful response reason', async () => {
  answer = scopes => ({ results: scopes.map(scope => ({ scope, writable: false, review_held: false, reason: `refused ${token}` })) })
  expect(JSON.stringify(await check())).not.toContain(token)
})
it('validates write-check input cardinality before contacting the server', async () => {
  const driver = new RemoteStore(url, token, scope)
  await expect(driver.writeCheck([])).rejects.toThrow()
  await expect(driver.writeCheck(Array(51).fill(scope))).rejects.toThrow()
  expect(requests).toEqual([])
})
it.skipIf(process.platform === 'win32')('does not silently repair broadly readable credential files', async () => {
  chmodSync(join(root, 'config.yaml'), 0o644)
  expect(row(await check(), 'key-file').result).toBe('fail')
})
