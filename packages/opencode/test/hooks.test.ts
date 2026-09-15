import { describe, it, expect, vi } from 'vitest'
import { PlurPlugin } from '../src/index.js'

const fakePlur = () => ({
  injectHybrid: vi.fn().mockResolvedValue({ count: 1, directives: '[ENG-1] Use pnpm.', constraints: '', text: '' }),
})

describe('recall / render split', () => {
  it('chat.message runs recall but injects nothing into parts', async () => {
    const plur = fakePlur()
    const hooks = await PlurPlugin({ directory: '/tmp/p', _plur: plur } as any)
    const output = { message: { id: 'msg_1' }, parts: [{ id: 'prt_1', type: 'text', text: 'hi' }] }

    await hooks['chat.message']!({ sessionID: 'ses_1' } as any, output as any)

    expect(plur.injectHybrid).toHaveBeenCalledTimes(1)
    expect(output.parts).toHaveLength(1) // ← no accretion
  })

  it('system.transform pushes the cached block', async () => {
    const plur = fakePlur()
    const hooks = await PlurPlugin({ directory: '/tmp/p', _plur: plur } as any)
    await hooks['chat.message']!({ sessionID: 'ses_1' } as any,
      { message: { id: 'msg_1' }, parts: [] } as any)

    const out = { system: ['base prompt'] }
    await hooks['experimental.chat.system.transform']!({ sessionID: 'ses_1', model: {} } as any, out as any)

    expect(out.system).toHaveLength(2)
    expect(out.system[1]).toContain('[ENG-1] Use pnpm.')
  })

  it('renders the same cached block on repeated requests without re-running recall', async () => {
    const plur = fakePlur()
    const hooks = await PlurPlugin({ directory: '/tmp/p', _plur: plur } as any)
    await hooks['chat.message']!({ sessionID: 'ses_1' } as any,
      { message: { id: 'msg_1' }, parts: [] } as any)

    for (let i = 0; i < 3; i++) {
      const out = { system: ['base prompt'] }
      await hooks['experimental.chat.system.transform']!({ sessionID: 'ses_1', model: {} } as any, out as any)
      expect(out.system).toHaveLength(2) // always 1->2, never 1->3
    }
    expect(plur.injectHybrid).toHaveBeenCalledTimes(1)
  })

  it('a recall failure degrades to no memory rather than throwing', async () => {
    const plur = { injectHybrid: vi.fn().mockRejectedValue(new Error('store down')) }
    const hooks = await PlurPlugin({ directory: '/tmp/p', _plur: plur } as any)
    const output = { message: { id: 'msg_1' }, parts: [] }

    await expect(
      hooks['chat.message']!({ sessionID: 'ses_1' } as any, output as any),
    ).resolves.toBeUndefined()
  })
})
