import { afterEach, expect, it } from 'vitest'
import { enterpriseFixture } from '../helpers/enterprise-install.js'
let f: Awaited<ReturnType<typeof enterpriseFixture>> | undefined
afterEach(async () => { await f?.close() })
it('EFI-3 session status names the cached destination and waiting saves without contacting the server', async () => {
  f = await enterpriseFixture(); const p = f.open()
  expect(await p.serverSessionLines(f.repo), 'The session must name its authorized project').toEqual(['PLUR → server as fixture · saving to project:example/team/app'])
  f.stub.appendErrorResponse = { status: 401, body: 'rejected' }
  const saved = await p.learnRouted('Keep a rollout checklist while access is unavailable', { scope: f.scope })
  expect(p.deliveryOf(saved).delivery, 'The fixture must contain a real queued save').toBe('outbox')
  const before = [f.stub.meCalls, f.stub.recallCalls, f.stub.appendCalls]
  const lines = await p.serverSessionLines(f.repo)
  expect(lines, 'A configured server must produce a status line').toHaveLength(1)
  expect(lines[0], 'Waiting saves and the recovery command must be visible').toMatch(/1 save waiting since .*key rejected; run plur-enterprise init again/)
  expect([f.stub.meCalls, f.stub.recallCalls, f.stub.appendCalls], 'Reading cached status must make no network probe').toEqual(before)
})
