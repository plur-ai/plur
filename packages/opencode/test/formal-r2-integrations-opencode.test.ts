/**
 * Formal verification round 2 (R2-Integrations, mcp-integrations#10).
 *
 * 1. One turn's memory block is injected at most once: when the chat.message
 *    fallback already pushed it, system.transform does not push it again.
 * 2. A late cumulative snapshot of a part already taken (after session.idle)
 *    does not re-arm the buffer, so a transcript is learned once.
 * 3. The recall in chat.message is time-bounded — a hung store never blocks
 *    the user's turn.
 *
 * Model: spec/formal/PlurSpec/R2Integrations.lean §6.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { PlurPlugin, INJECT_TIMEOUT_MS } from '../src/index.js'

const BLOCK_TEXT = '[ENG-1] Use pnpm.'
const fakePlur = () => ({
  injectHybrid: vi.fn().mockResolvedValue({ count: 1, directives: BLOCK_TEXT, constraints: '', text: '' }),
  learnRouted: vi.fn().mockResolvedValue({}),
})
const chat = (hooks: any, sessionID: string, messageID: string, text = 'what package manager?') => {
  const output = { message: { id: messageID }, parts: [{ type: 'text', text }] as any[] }
  return hooks['chat.message']({ sessionID, messageID }, output).then(() => output)
}
const transform = (hooks: any, sessionID: string) => {
  const output = { system: [] as string[] }
  return hooks['experimental.chat.system.transform']({ sessionID }, output).then(() => output)
}
const idle = (hooks: any, sessionID: string) => hooks.event({ event: { type: 'session.idle', properties: { sessionID } } })
const part = (hooks: any, sessionID: string, text: string, id = 'prt_x', messageID = 'msg_asst') =>
  hooks.event({ event: { type: 'message.part.updated', properties: { part: { id, sessionID, messageID, type: 'text', text } } } })

afterEach(() => { vi.useRealTimers() })

describe('render path: at most one injection per request', () => {
  it('fallback turn: when system.transform comes back, the block is not pushed twice', async () => {
    const plur = fakePlur()
    const hooks = await PlurPlugin({ directory: '/tmp/p', _plur: plur } as any)
    await chat(hooks, 's1', 'm1')
    await idle(hooks, 's1')                       // a turn with no render → latch
    const out = await chat(hooks, 's1', 'm2')     // fallback pushes the block as a part
    const pushed = out.parts.filter((p: any) => p.synthetic && String(p.text).includes(BLOCK_TEXT))
    expect(pushed).toHaveLength(1)
    const sys = await transform(hooks, 's1')      // transform fires again in this turn
    expect(sys.system.filter((s: string) => s.includes(BLOCK_TEXT))).toHaveLength(0)
  })

  it('good case: the next turn renders through system.transform again', async () => {
    const plur = fakePlur()
    const hooks = await PlurPlugin({ directory: '/tmp/p', _plur: plur } as any)
    await chat(hooks, 's1', 'm1')
    await idle(hooks, 's1')
    await chat(hooks, 's1', 'm2')
    await transform(hooks, 's1')                  // heals the latch
    const out3 = await chat(hooks, 's1', 'm3')
    expect(out3.parts.some((p: any) => p.synthetic)).toBe(false)
    const sys = await transform(hooks, 's1')
    expect(sys.system.filter((s: string) => s.includes(BLOCK_TEXT))).toHaveLength(1)
  })
})

describe('turn buffer: a late snapshot does not re-arm', () => {
  it('learns a transcript once even if its part updates after session.idle', async () => {
    const plur = fakePlur()
    const hooks = await PlurPlugin({ directory: '/tmp/p', _plur: plur } as any)
    const t = '---\n🧠 I learned:\n- Deploys need two approvals.'
    await part(hooks, 's1', t)
    await idle(hooks, 's1')
    await part(hooks, 's1', t)                    // late cumulative snapshot of the same part
    await idle(hooks, 's1')
    await new Promise(r => setTimeout(r, 20))
    expect(plur.learnRouted).toHaveBeenCalledTimes(1)
  })

  it('good case: the next turn (new part) is still learned', async () => {
    const plur = fakePlur()
    const hooks = await PlurPlugin({ directory: '/tmp/p', _plur: plur } as any)
    await part(hooks, 's1', '---\n🧠 I learned:\n- Fact one is here.', 'prt_1')
    await idle(hooks, 's1')
    await part(hooks, 's1', '---\n🧠 I learned:\n- Fact two is here.', 'prt_2')
    await idle(hooks, 's1')
    await vi.waitFor(() => expect(plur.learnRouted).toHaveBeenCalledTimes(2))
  })
})

describe('recall is time-bounded', () => {
  it('a hung injectHybrid does not block chat.message past the bound', async () => {
    vi.useFakeTimers()
    const plur = { ...fakePlur(), injectHybrid: vi.fn(() => new Promise(() => {})) }
    const hooks = await PlurPlugin({ directory: '/tmp/p', _plur: plur } as any)
    let done = false
    const p = chat(hooks, 's1', 'm1').then(() => { done = true })
    await vi.advanceTimersByTimeAsync(INJECT_TIMEOUT_MS + 10)
    await p
    expect(done).toBe(true)
  })
})
