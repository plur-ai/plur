import { describe, it, expect, vi } from 'vitest'
import { PlurPlugin } from '../src/index.js'

const fakePlur = () => ({
  injectHybrid: vi.fn().mockResolvedValue({ count: 1, directives: '[ENG-1] Use pnpm.', constraints: '', text: '' }),
  learnRouted: vi.fn().mockResolvedValue({}),
})

const partUpdated = (sessionID: string, text: string, messageID = 'msg_a') => ({
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

const sessionDeleted = (sessionID: string) => ({
  event: { type: 'session.deleted', properties: { info: { id: sessionID } } },
})

describe('event hook — turn accumulation and debounced learning', () => {
  it('harvests a 🧠 I learned: self-report on session.idle, fire-and-forget', async () => {
    const plur = fakePlur()
    const hooks = await PlurPlugin({ directory: '/tmp/p', _plur: plur } as any)

    await hooks['event']!(partUpdated('ses_1', '---\n🧠 I learned:\n- Deploys need sudo access.') as any)
    await hooks['event']!(sessionIdle('ses_1') as any)

    await vi.waitFor(() => expect(plur.learnRouted).toHaveBeenCalledTimes(1))
    expect(plur.learnRouted).toHaveBeenCalledWith(
      'Deploys need sudo access.',
      expect.objectContaining({ source: 'opencode:self-report' }),
    )
  })

  it('does not double-learn when session.idle fires twice for one turn', async () => {
    const plur = fakePlur()
    const hooks = await PlurPlugin({ directory: '/tmp/p', _plur: plur } as any)

    await hooks['event']!(partUpdated('ses_1', '---\n🧠 I learned:\n- Only learn this once please.') as any)
    await hooks['event']!(sessionIdle('ses_1') as any)
    await hooks['event']!(sessionIdle('ses_1') as any) // real binary fires this twice per turn

    await vi.waitFor(() => expect(plur.learnRouted).toHaveBeenCalledTimes(1))
    // Give any accidental second write a chance to land before asserting it didn't.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(plur.learnRouted).toHaveBeenCalledTimes(1)
  })

  it('session.deleted clears the turn buffer for that session', async () => {
    const plur = fakePlur()
    const hooks = await PlurPlugin({ directory: '/tmp/p', _plur: plur } as any)

    await hooks['event']!(partUpdated('ses_1', '---\n🧠 I learned:\n- This should never be learned.') as any)
    await hooks['event']!(sessionDeleted('ses_1') as any)
    await hooks['event']!(sessionIdle('ses_1') as any)

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(plur.learnRouted).not.toHaveBeenCalled()
  })

  it('session.deleted clears the cached memory block for that session', async () => {
    const plur = fakePlur()
    const hooks = await PlurPlugin({ directory: '/tmp/p', _plur: plur } as any)

    await hooks['chat.message']!({ sessionID: 'ses_1' } as any, { message: { id: 'msg_1' }, parts: [] } as any)
    await hooks['event']!(sessionDeleted('ses_1') as any)

    const out = { system: ['base prompt'] }
    await hooks['experimental.chat.system.transform']!({ sessionID: 'ses_1', model: {} } as any, out as any)
    expect(out.system).toHaveLength(1) // nothing pushed — the cache was cleared
  })

  it('wires the correction path: chat.message passes the user text to learnFromUserText', async () => {
    const plur = fakePlur()
    const hooks = await PlurPlugin({ directory: '/tmp/p', _plur: plur } as any)
    const output = { message: { id: 'msg_1' }, parts: [{ id: 'prt_1', type: 'text', text: 'No, always use pnpm not npm.' }] }

    await hooks['chat.message']!({ sessionID: 'ses_1' } as any, output as any)

    await vi.waitFor(() => expect(plur.learnRouted).toHaveBeenCalled())
    const [, context] = plur.learnRouted.mock.calls[0]
    expect(context).toMatchObject({ source: 'opencode:chat.message' })
  })
})

describe('fallback end-to-end — the RenderPath latch actually injects', () => {
  it('pushes a real part with the shape the real binary requires once the fallback latches', async () => {
    const plur = fakePlur()
    const hooks = await PlurPlugin({ directory: '/tmp/p', _plur: plur } as any)

    // Turn 1: recall runs, but system.transform never fires (simulating a
    // host build that no longer supports the experimental hook).
    const output1 = { message: { id: 'msg_1' }, parts: [] }
    await hooks['chat.message']!({ sessionID: 'ses_1', messageID: 'msg_1' } as any, output1 as any)
    expect(output1.parts).toHaveLength(0)

    // The turn ends — this is the only place markTurn() is wired.
    await hooks['event']!(sessionIdle('ses_1') as any)

    // Turn 2: system.transform still hasn't fired since the latch check
    // above, so chat.message should now inject directly. `input.messageID`
    // is undefined here — matches the real binary's chat.message input,
    // where the message id only lives on `output.message.id`.
    const output2 = { message: { id: 'msg_2' }, parts: [] }
    await hooks['chat.message']!({ sessionID: 'ses_1', messageID: undefined } as any, output2 as any)

    expect(output2.parts).toHaveLength(1)
    const part = output2.parts[0] as any
    expect(part.id).toMatch(/^prt_/)
    expect(typeof part.messageID).toBe('string')
    expect(part.messageID).toBe('msg_2')
    expect(part.type).toBe('text')
  })
})
