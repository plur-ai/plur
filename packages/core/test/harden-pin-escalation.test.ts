/**
 * Hardening H5: raising the priority or tier of an engram that is ALREADY
 * pinned is a stronger pin. Under `pinning.agents: request` or `deny` an agent
 * (or an absent actor) must not do it; the owner may. Lowering is never
 * restricted, and the default config (`allow`) is unchanged.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Plur, PinDeniedError, isPinEscalation } from '../src/index.js'

describe('pin escalation follows pinning.agents (H5)', () => {
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
  async function setup(agents: 'allow' | 'request' | 'deny') {
    const dir = mkdtempSync(join(tmpdir(), 'plur-harden-pin-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'config.yaml'), `embeddings:\n  enabled: false\nindex: false\npinning:\n  agents: ${agents}\n`)
    const owner = new Plur({ path: dir, autoDiscover: false, actor: 'owner' })
    const e = await owner.learn('Always run the linter before committing', { scope: 'global' })
    await owner.setPinned(e.id, true)
    await owner.setPinPriority(e.id, 40)
    const agent = new Plur({ path: dir, autoDiscover: false, actor: 'agent' })
    return { owner, agent, id: e.id }
  }

  for (const mode of ['request', 'deny'] as const) {
    it(`${mode}: an agent cannot raise a pin's priority`, async () => {
      const { agent, id } = await setup(mode)
      await expect(agent.setPinPriority(id, 95)).rejects.toBeInstanceOf(PinDeniedError)
      expect((await agent.getById(id))!.pinned_priority).toBe(40)
    })

    it(`${mode}: an agent update cannot move a pin to the hard tier`, async () => {
      const { agent, id } = await setup(mode)
      const row = (await agent.getById(id))!
      await expect(agent.updateEngram({ ...row, pinned_tier: 'hard' } as any)).rejects.toBeInstanceOf(PinDeniedError)
      expect((await agent.getById(id))!.pinned_tier).not.toBe('hard')
    })

    it(`${mode}: a journalled change by an agent cannot raise a pin's priority`, async () => {
      const { agent, id } = await setup(mode)
      await expect(agent.beginChange('test.edit', { actor: 'agent' })
        .apply(tx => { tx.put({ ...tx.get(id)!, pinned_priority: 99 } as any) })).rejects.toBeInstanceOf(PinDeniedError)
      expect((await agent.getById(id))!.pinned_priority).toBe(40)
    })

    it(`${mode}: an agent may lower a pin's priority; the owner may raise it`, async () => {
      const { owner, agent, id } = await setup(mode)
      expect((await agent.setPinPriority(id, 10))!.pinned_priority).toBe(10)
      expect((await owner.setPinPriority(id, 90))!.pinned_priority).toBe(90)
    })
  }

  it('allow (default): an agent may raise a pin\'s priority as before', async () => {
    const { agent, id } = await setup('allow')
    expect((await agent.setPinPriority(id, 95))!.pinned_priority).toBe(95)
  })

  it('isPinEscalation: higher priority or soft→hard on a kept pin; never a new pin or an unpin', () => {
    expect(isPinEscalation({ pinned: true, pinned_priority: 40 }, { pinned: true, pinned_priority: 41 })).toBe(true)
    expect(isPinEscalation({ pinned: true }, { pinned: true, pinned_tier: 'hard' })).toBe(true)
    expect(isPinEscalation({ pinned: true }, { pinned: true, pinned_priority: 50 })).toBe(false)
    expect(isPinEscalation({ pinned: true, pinned_priority: 60 }, { pinned: true, pinned_priority: 20 })).toBe(false)
    expect(isPinEscalation(null, { pinned: true, pinned_priority: 90 })).toBe(false)
    expect(isPinEscalation({ pinned: true, pinned_priority: 10 }, { pinned_priority: 90 })).toBe(false)
  })
})
