import { describe, it, expect, vi } from 'vitest'
import { PlurPlugin } from '../src/index.js'

const fakePlur = () => ({
  injectHybrid: vi.fn().mockResolvedValue({ count: 1, directives: '[ENG-9] Keep it.', constraints: '', text: '' }),
  learnRouted: vi.fn().mockResolvedValue({}),
})

const partUpdated = (sessionID: string, messageID: string, text: string) => ({
  event: {
    type: 'message.part.updated',
    properties: {
      part: { id: 'prt_x', sessionID, messageID, type: 'text', text },
    },
  },
})

const sessionIdle = (sessionID: string) => ({
  event: { type: 'session.idle', properties: { sessionID } },
})

describe('learn before compaction', () => {
  it('pushes the memory block into compaction context', async () => {
    const plur = fakePlur()
    const hooks = await PlurPlugin({ directory: '/tmp/p', _plur: plur } as any)
    await hooks['chat.message']!({ sessionID: 'ses_1' } as any,
      { message: { id: 'msg_1' }, parts: [] } as any)

    const out: { context: string[]; prompt?: string } = { context: [] }
    await hooks['experimental.session.compacting']!({ sessionID: 'ses_1' } as any, out as any)

    expect(out.context.join('\n')).toContain('[ENG-9] Keep it.')
    expect(out.prompt).toBeUndefined() // never replace the host's prompt
  })

  it('does not throw when there is no cached block', async () => {
    const plur = fakePlur()
    const hooks = await PlurPlugin({ directory: '/tmp/p', _plur: plur } as any)
    const out: { context: string[] } = { context: [] }
    await expect(
      hooks['experimental.session.compacting']!({ sessionID: 'unknown' } as any, out as any),
    ).resolves.toBeUndefined()
    expect(out.context).toHaveLength(0)
  })

  it('learns from turn text when compacting', async () => {
    const plur = fakePlur()
    const hooks = await PlurPlugin({ directory: '/tmp/p', _plur: plur } as any)
    // Mark msg_1 as the user message
    await hooks['chat.message']!({ sessionID: 'ses_1' } as any,
      { message: { id: 'msg_1' }, parts: [] } as any)

    // Accumulate assistant text (msg_2, different from user message) into turn buffer
    await hooks['event']!(partUpdated('ses_1', 'msg_2', '---\n🧠 I learned:\n- Compaction preserves memory.') as any)

    // Trigger compaction
    const out: { context: string[] } = { context: [] }
    await hooks['experimental.session.compacting']!({ sessionID: 'ses_1' } as any, out as any)

    // Verify the turn text was learned
    await vi.waitFor(() => expect(plur.learnRouted).toHaveBeenCalledTimes(1))
    expect(plur.learnRouted).toHaveBeenCalledWith(
      'Compaction preserves memory.',
      expect.objectContaining({ source: 'opencode:self-report' }),
    )
  })

  it('enforces one-shot contract: compaction and session.idle do not double-learn', async () => {
    const plur = fakePlur()
    const hooks = await PlurPlugin({ directory: '/tmp/p', _plur: plur } as any)
    // Mark msg_1 as the user message
    await hooks['chat.message']!({ sessionID: 'ses_1' } as any,
      { message: { id: 'msg_1' }, parts: [] } as any)

    // Accumulate assistant text into turn buffer
    await hooks['event']!(partUpdated('ses_1', 'msg_2', '---\n🧠 I learned:\n- Only once, please.') as any)

    // Compaction consumes and learns the text
    const out: { context: string[] } = { context: [] }
    await hooks['experimental.session.compacting']!({ sessionID: 'ses_1' } as any, out as any)

    await vi.waitFor(() => expect(plur.learnRouted).toHaveBeenCalledTimes(1))

    // session.idle fires after compaction — turn buffer is already consumed
    await hooks['event']!(sessionIdle('ses_1') as any)

    // Wait for any accidental second write
    await new Promise((resolve) => setTimeout(resolve, 10))
    // Verify it was NOT called again (still exactly once)
    expect(plur.learnRouted).toHaveBeenCalledTimes(1)
  })
})
