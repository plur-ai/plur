import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'http'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'

const TEAM = 'project:example/team/app'
let root: string, plur: Plur, server: Server, url: string
let requests: Array<Record<string, unknown>>, reply: 'sent' | 'dedup' | 'held' | '503' | '403'
let onAppend: (() => Promise<void>) | undefined
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'plur-upload-local-')))
  writeFileSync(join(root, 'config.yaml'), 'index: false\nembeddings:\n  enabled: false\n')
  plur = new Plur({ path: root, autoDiscover: false }); requests = []; reply = 'sent'; onAppend = undefined
  server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.method === 'POST' && req.url === '/api/v1/engrams') {
      let text = ''; for await (const chunk of req) text += chunk
      const body = JSON.parse(text); requests.push(body)
      await onAppend?.()
      if (reply === '503' || reply === '403') { res.statusCode = Number(reply); res.end(JSON.stringify({ error: 'fixture refusal' })); return }
      res.statusCode = 201
      res.end(JSON.stringify({ id: 'ENG-SERVER-001', deduplicated: reply === 'dedup', review_required: reply === 'held' })); return
    }
    if (req.url === '/api/v1/me') { res.end(JSON.stringify({ username: 'fixture', scopes: [TEAM] })); return }
    res.end(JSON.stringify({ engrams: [] }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterEach(async () => { vi.unstubAllEnvs(); plur.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }) })
async function local(statement = 'Release checks run before publishing', scope = TEAM) { return plur.learn(statement, { scope }) }
function register(extra: Record<string, unknown> = {}) {
  const previous = yaml.load(readFileSync(join(root, 'config.yaml'), 'utf8')) as { stores?: Array<Record<string, unknown>> }
  writeFileSync(join(root, 'config.yaml'), JSON.stringify({ index: false, embeddings: { enabled: false }, stores: [...(previous.stores ?? []).filter(s => s.path), { url, token: 'fixture-key', scopes: [TEAM], enterprise: {}, ...extra }] }))
}
const rows = () => (yaml.load(readFileSync(join(root, 'engrams.yaml'), 'utf8')) as { engrams: any[] }).engrams
it('proposes only authorized existing scopes and excludes retired or secondary-store rows', async () => {
  const team = await local(), other = await local('Other workspace uses a separate checklist', 'project:other/app'), global = await local('Prefer concise prose', 'global')
  const retired = await local('Retired guidance is no longer useful'); await plur.forget(retired.id, 'fixture', { force: true })
  const secondary = join(root, 'secondary'); mkdirSync(secondary)
  const secondaryPlur = new Plur({ path: secondary, autoDiscover: false }); await secondaryPlur.learn('Secondary store must not be offered'); secondaryPlur.close()
  plur.addStore(join(secondary, 'engrams.yaml'), 'project:secondary')
  register()
  const candidates = await plur.listUploadCandidates([TEAM])
  expect(candidates.map(x => ({ id: x.id, proposed: x.proposed }))).toEqual([
    { id: team.id, proposed: TEAM }, { id: other.id, proposed: null }, { id: global.id, proposed: null },
  ])
  expect(requests).toEqual([])
})
it.each([['sent', 'sent'], ['dedup', 'already_on_server'], ['held', 'held_for_review']] as const)('reports the server %s receipt accurately', async (answer, outcome) => {
  const row = await local(); register(); reply = answer
  const result = await plur.uploadLocal([row.id])
  expect(result.results).toEqual([{ id: row.id, outcome, new_id: 'ENG-SERVER-001' }])
  expect(requests).toHaveLength(1); expect(requests[0].idempotency_key).toEqual(expect.any(String))
  expect(rows().some(e => e.id === row.id)).toBe(false)
})
it.each([['503', 'queued'], ['403', 'failed']] as const)('keeps %s failures durable with the correct outcome', async (answer, outcome) => {
  const row = await local(); register(); reply = answer
  const result = await plur.uploadLocal([row.id])
  expect(result.results[0]).toMatchObject({ id: row.id, outcome })
  expect(rows()[0].structured_data._outbox.idempotency_key).toBe(requests[0].idempotency_key)
})
it('a retry keeps the durable idempotency key', async () => {
  const row = await local(); register(); reply = '503'
  await plur.uploadLocal([row.id]); reply = 'sent'
  expect((await plur.uploadLocal([row.id])).results[0].outcome).toBe('sent')
  expect(requests).toHaveLength(2); expect(requests[1].idempotency_key).toBe(requests[0].idempotency_key)
})
it('a dry run makes no request or store/queue change', async () => {
  const row = await local(); register(); const bytes = readFileSync(join(root, 'engrams.yaml'))
  await plur.uploadLocal([row.id], { dryRun: true })
  expect(requests).toEqual([]); expect(readFileSync(join(root, 'engrams.yaml'))).toEqual(bytes)
})
it('a malformed primary store never exposes its private YAML in the result', async () => {
  const row = await local(); register()
  const malformed = 'engrams: [private-fixture-sentinel: [\n'
  writeFileSync(join(root, 'engrams.yaml'), malformed)
  const result = await plur.uploadLocal([row.id])
  expect(result.results[0].outcome).toBe('failed')
  expect(JSON.stringify(result)).not.toContain('private-fixture-sentinel')
  expect(readFileSync(join(root, 'engrams.yaml'), 'utf8')).toBe(malformed)
})
it('preserves accepted receipt ids when local persistence fails after the POST', async () => {
  const row = await local(); register()
  onAppend = async () => { renameSync(join(root, 'engrams.yaml'), join(root, 'engrams.saved')); mkdirSync(join(root, 'engrams.yaml')) }
  const result = await plur.uploadLocal([row.id])
  expect(result.results[0]).toMatchObject({ id: row.id, outcome: 'failed', new_id: 'ENG-SERVER-001' })
  expect(result.results[0].error).toContain('bookkeeping')
})
it('refuses unknown ids, local-only scopes and readonly routes without sending', async () => {
  const row = await local('A local preference stays local', 'global'), team = await local(); register({ readonly: true })
  expect((await plur.uploadLocal([row.id, team.id, 'ENG-MISSING-001'])).results.every(r => r.outcome === 'failed')).toBe(true)
  expect(requests).toEqual([])
})
it('demotes sensitive content without a request', async () => {
  const row = await local(); register()
  const data = rows(); data[0].statement = 'Access key ' + 'AKIA' + 'IOSFODNN7EXAMPLE'
  writeFileSync(join(root, 'engrams.yaml'), yaml.dump({ engrams: data }))
  expect((await plur.uploadLocal([row.id])).results[0].outcome).toBe('demoted_secret')
  expect(requests).toEqual([]); expect(rows()[0]).toMatchObject({ scope: 'local', visibility: 'private' })
})
it('upload flushes only explicitly selected ids', async () => {
  const selected = await local(), other = await local('Unselected upload must stay pending')
  register(); reply = '503'; await plur.uploadLocal([other.id]); requests = []; reply = 'sent'
  await plur.uploadLocal([selected.id])
  expect(requests.map(r => r.statement)).toEqual([selected.statement])
  expect(rows().find(e => e.id === other.id).structured_data._outbox).toBeDefined()
})
it('a concurrent move back to local storage is reported instead of an unconditional successful upload', async () => {
  const row = await local(); register()
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve }), paused = new Promise<void>(resolve => { release = resolve })
  onAppend = async () => { entered(); await paused }
  const uploading = plur.uploadLocal([row.id])
  await started
  try { await plur.rescope(row.id, 'global') } finally { release() }
  const result = await uploading
  expect(result.results[0]).toMatchObject({ id: row.id, outcome: 'failed', new_id: 'ENG-SERVER-001' })
  expect(rows().find(e => e.id === row.id).scope).toBe('global')
})
it('a selected correction waits for its unselected queued supersedes target', async () => {
  const original = await local('Old deployment guidance awaits delivery'), correction = await local('New deployment guidance replaces the old rule')
  await plur.updateEngram({ ...correction, relations: { conflicts: [], broader: [], narrower: [], related: [], superseded_by: [], ...correction.relations, supersedes: [original.id] } })
  register(); reply = '503'; await plur.uploadLocal([original.id]); requests = []; reply = 'sent'
  expect((await plur.uploadLocal([correction.id])).results[0].outcome).toBe('queued')
  expect(requests).toEqual([])
  expect(rows().find(e => e.id === correction.id).relations.supersedes).toEqual([original.id])
})
it('remote-only binding cannot enumerate or upload personal primary rows', async () => {
  const row = await local(); register(); plur.bindFolderPolicy(root, { mode: 'remote-only', scope: TEAM, remoteAllowed: true, source: 'map' })
  await expect(plur.listUploadCandidates([TEAM])).rejects.toThrow()
  await expect(plur.uploadLocal([row.id])).rejects.toThrow()
  expect(requests).toEqual([])
})
it('enterprise registration disables default auto-discovery, including empty scopes, while explicit opt-ins win', () => {
  register({ scopes: [] })
  const make = (autoDiscover?: boolean) => { const p = new Plur({ path: root, autoDiscover }); const enabled = p.autoDiscoveryEnabled(); p.close(); return enabled }
  expect(make()).toBe(false); expect(make(true)).toBe(true)
  vi.stubEnv('PLUR_AUTO_DISCOVER', '1'); expect(make()).toBe(true)
  vi.stubEnv('PLUR_AUTO_DISCOVER', 'false'); expect(make()).toBe(false)
})
