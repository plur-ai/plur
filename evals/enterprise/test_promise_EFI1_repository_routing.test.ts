import { afterEach, expect, it, vi } from 'vitest'
import { enterpriseFixture } from '../helpers/enterprise-install.js'
import { PlurPlugin } from '../../packages/opencode/src/index.js'

let f: Awaited<ReturnType<typeof enterpriseFixture>> | undefined
afterEach(async () => { await f?.close(); vi.unstubAllEnvs() })
it('EFI-1 an unrelated repository keeps recall and saves local, with an authorized repository as control', async () => {
  f = await enterpriseFixture(); vi.stubEnv('PLUR_REMOTE_RECALL', 'on')
  for (const mapped of [true, false]) {
    f.configure([{ ...f.entry, discovery: { ...f.entry.discovery,
      project_paths: { [f.scope]: mapped ? 'team/app' : 'team/another' } } }])
    const p = f.open(), before = f.stub.recallCalls
    const hooks = await PlurPlugin({ directory: f.repo, worktree: f.repo, _plur: p } as any)
    await hooks['chat.message']!({ sessionID: `fixture-${mapped}` } as any,
      { message: { id: `message-${mapped}` }, parts: [{ type: 'text', text: 'Which release checks apply?' }] } as any)
    expect(f.stub.recallCalls - before, 'Only the authorized repository may ask the server for memories').toBe(mapped ? 1 : 0)
    const saved = await p.learnRouted(`Release checklist for the ${mapped ? 'mapped' : 'unrelated'} repository`)
    expect(p.deliveryOf(saved).delivery, 'An unrelated repository must retain its unscoped save locally').toBe(mapped ? 'remote' : 'local')
  }
  expect(f.stub.appendCalls, 'The positive control must save once; the unrelated repository must not send').toBe(1)
})
