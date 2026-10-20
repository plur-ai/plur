import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Plur } from '../src/index.js'
import { StubServer } from './helpers/stub-server.js'
import yaml from 'js-yaml'

const scope = 'group:example/engineering'
const key = 'fixture-valid-key'
let root: string, plur: Plur, original: StubServer, replacement: StubServer
let originalUrl: string, replacementUrl: string
function configure(url: string, token: string) {
  writeFileSync(join(root, 'config.yaml'), JSON.stringify({
    index: false, embeddings: { enabled: false }, stores: [{ url, token, scope }],
  }))
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'plur-replacement-delivery-'))
  original = new StubServer(key)
  replacement = new StubServer(key)
  originalUrl = (await original.start()).url
  replacementUrl = (await replacement.start()).url
  configure(originalUrl, 'fixture-rejected-key')
  plur = new Plur({ path: root, autoDiscover: false })
})
afterEach(async () => {
  plur.close()
  await original.stop()
  await replacement.stop()
  rmSync(root, { recursive: true, force: true })
})
async function queue() {
  const saved = await plur.learnRouted('Canary releases need a rollback rehearsal', { scope, type: 'behavioral' })
  expect(plur.deliveryOf(saved).delivery).toBe('outbox')
  expect(await plur.listOutbox()).toHaveLength(1)
  return saved
}

it('hands a queued write to its authorized replacement once, without retiring the accepted copy', async () => {
  await queue()
  configure(replacementUrl, key)
  const first = await plur.flushOutbox()
  expect(first).toMatchObject({ flushed: 1, held: 0, failed: 0 })
  expect(first.expired_warnings).toEqual([])
  expect(await plur.listOutbox()).toHaveLength(0)
  const second = await plur.flushOutbox()
  expect(second).toMatchObject({ flushed: 0, failed: 0 })
  expect(second.expired_warnings).toEqual([])
  expect(replacement.appendCalls).toBe(1)
  expect(replacement.deleteCalls).toBe(0)
  expect(original.appendCalls).toBe(0)
  expect(original.deleteCalls).toBe(0)
})

it.each([404, 422])('keeps a recent HTTP %i hold when only the credential changes', async status => {
  configure(originalUrl, key)
  original.appendErrorResponse = { status, body: 'fixture non-credential refusal' }
  await queue()
  const calls = original.appendCalls
  configure(originalUrl, 'fixture-different-key')
  expect(await plur.flushOutbox()).toMatchObject({ held: 1, flushed: 0, failed: 0 })
  expect(original.appendCalls).toBe(calls)
  expect(await plur.listOutbox()).toHaveLength(1)
})

it.each([
  { status: undefined, message: 'Remote store append failed: 403 denied', held: 0 },
  { status: undefined, message: 'Remote store append failed: 422 invalid', held: 1 },
  { status: 422, message: 'Remote store append failed: 401 denied', held: 1 },
  { status: 401, message: 'Remote store append failed: 422 invalid', held: 0 },
])('uses explicit refusal status before legacy text: $status / $message', async ({ status, message, held }) => {
  await queue()
  plur.close()
  const file = join(root, 'engrams.yaml')
  const stored = yaml.load(readFileSync(file, 'utf8')) as { engrams: any[] }
  const entry = stored.engrams[0].structured_data._outbox
  if (status === undefined) delete entry.last_status
  else entry.last_status = status
  entry.last_error = message
  writeFileSync(file, yaml.dump(stored))
  configure(originalUrl, key)
  plur = new Plur({ path: root, autoDiscover: false })
  expect(await plur.flushOutbox()).toMatchObject({ held, flushed: 1 - held, failed: 0 })
  expect(original.appendCalls).toBe(1 - held)
  expect(await plur.listOutbox()).toHaveLength(held)
})

it('preserves a newer queued write while retiring only the copy accepted by the replacement server', async () => {
  await queue()
  configure(replacementUrl, key)
  replacement.appendHook = async () => {
    const file = join(root, 'engrams.yaml')
    const stored = yaml.load(readFileSync(file, 'utf8')) as { engrams: any[] }
    stored.engrams[0].structured_data._outbox.idempotency_key = 'fixture-new-logical-write'
    writeFileSync(file, yaml.dump(stored))
  }
  const first = await plur.flushOutbox()
  expect(first.expired_warnings.join(' ')).toContain('queued for retirement')
  // The listing has one pending write and one pending retirement.
  expect(await plur.listOutbox()).toHaveLength(2)
  const stored = yaml.load(readFileSync(join(root, 'engrams.yaml'), 'utf8')) as { engrams: any[] }
  expect(stored.engrams).toHaveLength(1)
  expect(stored.engrams[0].structured_data._outbox.idempotency_key).toBe('fixture-new-logical-write')
  expect(stored.engrams[0].structured_data._retireRemote.target_url).toBe(replacementUrl)
  replacement.appendHook = null
  await plur.flushOutbox({ force: true })
  expect(replacement.deleteCalls).toBe(1)
  expect(original.deleteCalls).toBe(0)
  expect(replacement.appendCalls).toBe(2)
  expect(await plur.listOutbox()).toHaveLength(0)
})

it('does not restore obsolete failure bookkeeping over a concurrently requeued logical write', async () => {
  await queue()
  configure(replacementUrl, key)
  let newer: Record<string, unknown> | undefined
  replacement.appendHook = async () => {
    const file = join(root, 'engrams.yaml')
    const stored = yaml.load(readFileSync(file, 'utf8')) as { engrams: any[] }
    newer = { ...stored.engrams[0].structured_data._outbox,
      idempotency_key: 'fixture-new-logical-write', attempt_count: 0, last_error: 'new writer bookkeeping' }
    stored.engrams[0].structured_data._outbox = newer
    writeFileSync(file, yaml.dump(stored))
  }
  replacement.appendErrorResponse = { status: 503, body: 'fixture transient refusal' }
  expect(await plur.flushOutbox()).toMatchObject({ failed: 1, flushed: 0 })
  const stored = yaml.load(readFileSync(join(root, 'engrams.yaml'), 'utf8')) as { engrams: any[] }
  expect(stored.engrams[0].structured_data._outbox).toEqual(newer)
  expect(await plur.listOutbox()).toHaveLength(1)
  expect(replacement.deleteCalls).toBe(0)
})
