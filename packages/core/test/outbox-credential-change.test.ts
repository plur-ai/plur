import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { credentialChanged } from '../src/outbox-health.js'
import { tokenHealthKey } from '../src/remote-recall.js'
import { StubServer } from './helpers/stub-server.js'

const scope = 'group:example/eng'
const oldKey = 'fixture-old-key', newKey = 'fixture-new-key'
let root: string, plur: Plur, stub: StubServer, url: string
const config = (stores: unknown[]) => writeFileSync(join(root, 'config.yaml'), JSON.stringify({ index: false, embeddings: { enabled: false }, stores }))
function rows(): any[] {
  const raw = yaml.load(readFileSync(join(root, 'engrams.yaml'), 'utf8')) as any
  return Array.isArray(raw) ? raw : raw.engrams
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'plur-key-retry-'))
  stub = new StubServer(newKey); ({ url } = await stub.start())
  stub.meStatus = 200
  stub.meBody = { username: 'fixture-user', scopes: [scope], scopes_status: 'ok', org_id: 'example', key_expires_at: null }
  config([{ url, token: oldKey, scope, scopes: [scope], enterprise: {}, discovery: { org_id: 'example', status: 'ok' } }])
  plur = new Plur({ path: root, autoDiscover: false })
})
afterEach(async () => { plur.close(); await stub.stop(); rmSync(root, { recursive: true, force: true }) })
async function queue(target = scope, statement = "Canary deployments validate a release") {
  const result = await plur.learnRouted(statement, { scope: target, type: 'behavioral' })
  expect(plur.deliveryOf(result).delivery).toBe('outbox')
  expect((await plur.listOutbox()).some(e => e.id === result.id)).toBe(true)
  return result
}
it('retries a rejected-key save automatically after registration replaces the key', async () => {
  await queue()
  expect(rows()[0].structured_data._outbox.last_token_fp).toBe(tokenHealthKey(oldKey))
  expect(JSON.stringify(rows())).not.toContain(oldKey)
  await plur.registerEnterpriseServer(url, { token: newKey, personalScope: 'user:example:fixture-user' })
  await plur.refreshServerScopes({ url })
  const result = await plur.flushOutbox()
  expect(result).toMatchObject({ held: 0, flushed: 1 })
  expect(stub.appendCalls).toBe(1)
  expect(await plur.listOutbox()).toHaveLength(0)
})
it('keeps the automatic hold for the same rejected key', async () => {
  await queue()
  expect(await plur.flushOutbox()).toMatchObject({ held: 1, flushed: 0 })
  expect(stub.appendCalls).toBe(0)
})
it('an older queued row without a fingerprint keeps the automatic hold', async () => {
  await queue()
  const saved = rows(); delete saved[0].structured_data._outbox.last_token_fp
  plur.close(); writeFileSync(join(root, 'engrams.yaml'), yaml.dump({ engrams: saved }))
  config([{ url, token: newKey, scope }]); plur = new Plur({ path: root, autoDiscover: false })
  expect(await plur.flushOutbox()).toMatchObject({ held: 1, flushed: 0 })
  expect(stub.appendCalls).toBe(0)
})
it('a failed retry records the attempted key so it is held again until another change', async () => {
  await queue()
  config([{ url, token: newKey, scope }]); stub.appendErrorResponse = { status: 403, body: 'fixture refusal' }
  expect(await plur.flushOutbox()).toMatchObject({ held: 0, failed: 1 })
  expect(rows()[0].structured_data._outbox.last_token_fp).toBe(tokenHealthKey(newKey))
  const calls = stub.appendCalls
  expect(await plur.flushOutbox()).toMatchObject({ held: 1, flushed: 0 })
  expect(stub.appendCalls).toBe(calls)
})
it('a personal scope moved to a local path is held even while its old URL entry remains', async () => {
  const personal = 'user:fixture-user'
  config([{ url, token: oldKey, scope: personal }]); await plur.serverSessionLines(root)
  await queue(personal)
  const local = join(root, 'local-store'); mkdirSync(local)
  config([{ path: local, scope: personal }, { url, token: newKey, scope: personal }])
  const result = await plur.flushOutbox({ force: true })
  expect(result.flushed).toBe(0)
  expect(result.expired_warnings.join(' ')).toMatch(/local|path/)
  expect(stub.appendCalls).toBe(0)
  expect(await plur.listOutbox()).toHaveLength(1)
})
it('permits delivery to a replacement server authorized for the same scope', async () => {
  await queue()
  const replacement = new StubServer(newKey)
  const next = await replacement.start()
  try {
    config([{ url: next.url, token: newKey, scope }])
    expect(await plur.flushOutbox({ force: true })).toMatchObject({ flushed: 1 })
    expect(stub.appendCalls).toBe(0); expect(replacement.appendCalls).toBe(1)
  } finally { await replacement.stop() }
})
it('requires two known different fingerprints', () => {
  expect(credentialChanged(undefined, 'b')).toBe(false)
  expect(credentialChanged('a', undefined)).toBe(false)
  expect(credentialChanged('a', 'a')).toBe(false)
  expect(credentialChanged('a', 'b')).toBe(true)
})
it('records the attempted key when configuration changes while a push is in flight', async () => {
  config([{ url, token: newKey, scope }]); await plur.serverSessionLines(root)
  stub.appendErrorResponse = { status: 401, body: 'fixture refusal' }
  stub.appendHook = async () => {
    config([{ url, token: 'fixture-next-key', scope }]); await plur.serverSessionLines(root)
  }
  await queue()
  expect(rows()[0].structured_data._outbox.last_token_fp).toBe(tokenHealthKey(newKey))
})
it('marks actual enterprise recall failures for enterprise-specific recovery advice', async () => {
  await plur.recallHybrid('deployment', { scope })
  expect(plur.remoteStoreStatus()).toEqual([expect.objectContaining({ enterprise: true, status: 'auth_expired' })])
})
it('rechecks a local-path takeover between two queued pushes without an external reload', async () => {
  const personal = 'user:fixture-user'
  config([{ url, token: oldKey, scope: personal }]); await plur.serverSessionLines(root)
  await queue(personal)
  await queue(personal, 'Database backups need a restore rehearsal')
  config([{ url, token: newKey, scope: personal }])
  const local = join(root, 'local-store'); mkdirSync(local)
  stub.appendHook = async () => {
    config([{ path: local, scope: personal }, { url, token: newKey, scope: personal }])
  }
  const result = await plur.flushOutbox()
  expect(result.flushed).toBe(1)
  expect(result.expired_warnings.join(' ')).toContain('local path store')
  expect(stub.appendCalls).toBe(1)
  expect(await plur.listOutbox()).toHaveLength(1)
})
it('restores the hold if the failed key returns between selected queued pushes', async () => {
  await queue()
  await queue(scope, 'Database backups need a restore rehearsal')
  const before = rows()
  config([{ url, token: newKey, scope }])
  stub.appendHook = async () => { config([{ url, token: oldKey, scope }]) }
  expect(await plur.flushOutbox()).toMatchObject({ flushed: 1, held: 1, failed: 0 })
  const remaining = rows()
  expect(remaining).toHaveLength(1)
  expect(remaining[0].structured_data._outbox).toEqual(before.find(e => e.id === remaining[0].id).structured_data._outbox)
  expect(stub.appendCalls).toBe(1)
  // The held entry's claim is released: another explicit attempt can deliver it.
  stub.appendHook = null
  config([{ url, token: newKey, scope }])
  expect(await plur.flushOutbox()).toMatchObject({ flushed: 1, held: 0, failed: 0 })
})
it('does not label legacy recall failure as enterprise recovery on a mixed-key endpoint', async () => {
  const legacyScope = 'group:example/legacy'
  config([
    { url, token: oldKey, scope: legacyScope },
    { url, token: newKey, scopes: [], enterprise: {}, discovery: { status: 'ok' } },
  ])
  await plur.serverSessionLines(root)
  await plur.recallHybrid('deployment', { scope: legacyScope })
  const failed = plur.remoteStoreStatus().find(s => s.status === 'auth_expired')
  expect(failed).toBeDefined()
  expect(failed?.enterprise).not.toBe(true)
})
