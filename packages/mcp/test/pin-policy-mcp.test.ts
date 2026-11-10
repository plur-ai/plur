/**
 * MCP tools are agents (overhaul D2): with `pinning.agents: request` a pin
 * asked for through plur_learn / plur_learn_batch / plur_pin / plur_admin is
 * stored unpinned with a pin request and the reply says so; with `deny` it is
 * refused.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur, pinRequestOf } from '@plur-ai/core'
import { getToolDefinitions } from '../src/tools.js'

const tool = (name: string) => getToolDefinitions('full').find(t => t.name === name)!
const admin = () => getToolDefinitions('lean').find(t => t.name === 'plur_admin')!

const dirs: string[] = []
function open(agents: 'allow' | 'request' | 'deny'): Plur {
  const dir = mkdtempSync(join(tmpdir(), 'plur-mcp-pin-policy-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'config.yaml'), `embeddings:\n  enabled: false\nindex: false\npinning:\n  agents: ${agents}\n`)
  return new Plur({ path: dir, autoDiscover: false })
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('MCP pinning under pinning.agents (D2)', () => {
  it('request: plur_learn {pinned:true} stores it unpinned with a pin_request and says so', async () => {
    const plur = open('request')
    const res = await tool('plur_learn').handler({ statement: 'Always run the linter before committing', pinned: true, scope: 'global' }, plur) as any
    expect(res.pinned).toBe(false)
    expect(res.pin_request?.by).toBe('agent')
    expect(String(res.pin_note)).toMatch(/not pinned|unpinned/i)
    expect(String(res.pin_note)).toContain('plur pins review')
    const stored = (await plur.getById(res.id))!
    expect(stored.pinned).toBeUndefined()
    expect(pinRequestOf(stored)).not.toBeNull()
  })

  it('deny: plur_learn {pinned:true} is refused and nothing is stored', async () => {
    const plur = open('deny')
    const res = await tool('plur_learn').handler({ statement: 'Always run the linter before committing', pinned: true, scope: 'global' }, plur) as any
    expect(res.success).toBe(false)
    expect(res.error).toBe('pin_denied')
    expect(await plur.list()).toHaveLength(0)
  })

  it('request: plur_pin and the plur_admin route record a request instead of pinning', async () => {
    const plur = open('request')
    const e = await plur.learn('Use pnpm in this repository', { actor: 'owner' })
    const res = await tool('plur_pin').handler({ id: e.id, pinned: true }, plur) as any
    expect(res.pinned).toBe(false)
    expect(res.pin_request?.via).toBe('pin')
    const f = await plur.learn('Use vitest', { actor: 'owner' })
    const viaAdmin = await admin().handler({ action: 'plur_pin', args: { id: f.id, pinned: true } }, plur) as any
    const body = viaAdmin.result ?? viaAdmin
    expect(body.pinned).toBe(false)
    expect((await plur.getById(f.id))!.pinned).toBeUndefined()
  })

  it('deny: plur_pin is refused', async () => {
    const plur = open('deny')
    const e = await plur.learn('Use pnpm in this repository', { actor: 'owner' })
    const res = await tool('plur_pin').handler({ id: e.id, pinned: true }, plur) as any
    expect(res.success).toBe(false)
    expect(res.error).toBe('pin_denied')
    expect((await plur.getById(e.id))!.pinned).toBeUndefined()
  })

  it('request: plur_learn_batch pinned items become requests', async () => {
    const plur = open('request')
    const res = await tool('plur_learn_batch').handler({ engrams: [{ statement: 'Write tests first', pinned: true, scope: 'global' }] }, plur) as any
    const id = res.ids[0]
    expect(id).toBeTruthy()
    expect((await plur.getById(id))!.pinned).toBeUndefined()
    expect(res.pin_requests).toEqual([id])
  })

  it('allow (default): plur_learn {pinned:true} pins as today', async () => {
    const plur = open('allow')
    const res = await tool('plur_learn').handler({ statement: 'Always run the linter', pinned: true, scope: 'global' }, plur) as any
    expect(res.pinned).toBe(true)
    expect(res.pin_request).toBeUndefined()
  })
})
