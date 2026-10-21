import { afterEach, expect, it } from 'vitest'
import { enterpriseFixture } from '../helpers/enterprise-install.js'
import { StubServer } from '../../packages/core/test/helpers/stub-server.js'
let f: Awaited<ReturnType<typeof enterpriseFixture>> | undefined, replacement: StubServer | undefined
afterEach(async () => { await f?.close(); await replacement?.stop() })
it('EFI-5 a new authorized server receives a queued save once without deleting the accepted memory', async () => {
  f = await enterpriseFixture(); f.configure([{ ...f.entry, token: 'rejected-fixture-key' }]); const p = f.open()
  const saved = await p.learnRouted('Keep release approval with the deployment record', { scope: f.scope })
  expect(p.deliveryOf(saved).delivery, 'The rejected save must really be queued before retry').toBe('outbox')
  replacement = new StubServer(f.token); const next = await replacement.start()
  f.configure([{ ...f.entry, url: next.url }])
  expect(await p.flushOutbox(), 'The changed authorized destination must accept one queued save').toMatchObject({ flushed: 1, held: 0, failed: 0 })
  expect(await p.listOutbox(), 'Acknowledged delivery must leave no queued duplicate or false retirement').toHaveLength(0)
  await p.flushOutbox()
  expect(replacement.appendCalls, 'A second flush must not send the accepted memory again').toBe(1)
  expect(replacement.deleteCalls, 'Changing to an authorized server must not delete its accepted memory').toBe(0)
})
it.each([404, 422])('EFI-5 changing credentials does not lift a non-authentication refusal (%i)', async status => {
  f = await enterpriseFixture(); const p = f.open(); f.stub.appendErrorResponse = { status, body: 'refused' }
  const saved = await p.learnRouted('Keep the refused deployment note for correction', { scope: f.scope })
  expect(p.deliveryOf(saved).delivery, 'The refusal must leave an actual queued item').toBe('outbox')
  const calls = f.stub.appendCalls; f.configure([{ ...f.entry, token: 'different-fixture-key' }])
  expect(await p.flushOutbox(), 'A changed key cannot repair missing routes or invalid content').toMatchObject({ held: 1, flushed: 0 })
  expect(f.stub.appendCalls, 'The held write must not be retried automatically').toBe(calls)
})
