/**
 * Agent pinning enforced in core's write path (overhaul D2).
 *
 * `pinning.agents: allow | request | deny` is consulted at write time by every
 * path that can turn an engram into a pin. The caller is an `actor`: `owner`
 * is never restricted; `agent` and an absent actor follow the config.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  Plur, importFrom, PinDeniedError, pinRequestOf, formatPendingPinRequestsLine,
} from '../src/index.js'

function store(agents?: 'allow' | 'request' | 'deny', extra = ''): string {
  const dir = mkdtempSync(join(tmpdir(), 'plur-pin-policy-'))
  writeFileSync(join(dir, 'config.yaml'),
    `embeddings:\n  enabled: false\nindex: false\n${agents ? `pinning:\n  agents: ${agents}\n` : ''}${extra}`)
  return dir
}

describe('pinning.agents in core (D2)', () => {
  const dirs: string[] = []
  const open = (agents?: 'allow' | 'request' | 'deny', opts?: { actor?: 'owner' | 'agent'; extra?: string }) => {
    const dir = store(agents, opts?.extra)
    dirs.push(dir)
    return { dir, plur: new Plur({ path: dir, autoDiscover: false, ...(opts?.actor ? { actor: opts.actor } : {}) }) }
  }
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

  it('default config (allow): an agent pin is written as today', async () => {
    const { plur } = open()
    const e = await plur.learn('Always run the linter before committing', { pinned: true, actor: 'agent' })
    expect(e.pinned).toBe(true)
    expect(pinRequestOf(e)).toBeNull()
  })

  it('request: an agent learn with pinned:true stores the engram unpinned with a pin_request', async () => {
    const { plur } = open('request')
    const e = await plur.learn('Always run the linter before committing', {
      pinned: true, pin_tier: 'soft', pinned_priority: 70, actor: 'agent',
    })
    expect(e.pinned).toBeUndefined()
    const stored = (await plur.getById(e.id))!
    expect(stored.pinned).toBeUndefined()
    expect((stored as any).pinned_priority).toBeUndefined()
    const req = pinRequestOf(stored)!
    expect(req.by).toBe('agent')
    expect(req.priority).toBe(70)
    expect(Number.isFinite(Date.parse(req.requested_at))).toBe(true)
    const pending = await plur.pendingPinRequests()
    expect(pending.map(p => p.id)).toEqual([e.id])
    expect(formatPendingPinRequestsLine(pending)).toMatch(/^1 pin request waiting/)
  })

  it('request: an absent actor follows the config too', async () => {
    const { plur } = open('request')
    const e = await plur.learn('Never push to main', { pinned: true })
    expect(e.pinned).toBeUndefined()
    expect(pinRequestOf(e)?.by).toBe('unknown')
  })

  it('request: the instance default actor applies when a call names none', async () => {
    const { plur } = open('request', { actor: 'owner' })
    expect((await plur.learn('Never push to main', { pinned: true })).pinned).toBe(true)
    plur.setDefaultActor('agent')
    expect((await plur.learn('Never force-push', { pinned: true })).pinned).toBeUndefined()
  })

  it('request: the owner pins directly', async () => {
    const { plur } = open('request')
    const e = await plur.learn('Never push to main', { pinned: true, actor: 'owner' })
    expect(e.pinned).toBe(true)
    expect(await plur.pendingPinRequests()).toEqual([])
  })

  it('deny: an agent learn with pinned:true is refused and nothing is stored', async () => {
    const { plur } = open('deny')
    await expect(plur.learn('Never push to main', { pinned: true, actor: 'agent' })).rejects.toBeInstanceOf(PinDeniedError)
    expect(await plur.list()).toHaveLength(0)
  })

  it('learnAsync and learnBatch go through the same policy', async () => {
    const { plur } = open('request')
    const r = await plur.learnAsync('Prefer small commits', { pinned: true, actor: 'agent' })
    expect(r.engram.pinned).toBeUndefined()
    expect(pinRequestOf(r.engram)).not.toBeNull()
    const b = await plur.learnBatch([{ statement: 'Write tests first', context: { pinned: true, actor: 'agent' } }])
    expect(b.results[0].engram.pinned).toBeUndefined()
    expect(pinRequestOf(b.results[0].engram)).not.toBeNull()
  })

  it('updateEngram cannot bypass: request records, deny refuses, an existing pin is left alone', async () => {
    const { dir, plur } = open('request')
    const e = await plur.learn('Use pnpm in this repository', { actor: 'agent' })
    await plur.updateEngram({ ...e, pinned: true } as any, { actor: 'agent' })
    let stored = (await plur.getById(e.id))!
    expect(stored.pinned).toBeUndefined()
    expect(pinRequestOf(stored)?.via).toBe('update')
    // An engram the owner pinned can be re-written by an agent without losing the pin.
    const owned = await plur.learn('Never name customers', { pinned: true, actor: 'owner' })
    await plur.updateEngram({ ...(await plur.getById(owned.id))!, tags: ['x'] } as any, { actor: 'agent' })
    expect((await plur.getById(owned.id))!.pinned).toBe(true)
    // deny
    writeFileSync(join(dir, 'config.yaml'), 'embeddings:\n  enabled: false\nindex: false\npinning:\n  agents: deny\n')
    const denied = new Plur({ path: dir, autoDiscover: false })
    const f = await denied.learn('Run the full test suite', { actor: 'agent' })
    await expect(denied.updateEngram({ ...f, pinned: true } as any, { actor: 'agent' })).rejects.toBeInstanceOf(PinDeniedError)
    stored = (await denied.getById(f.id))!
    expect(stored.pinned).toBeUndefined()
  })

  it('setPinned: an agent asks, the owner approves, the request is cleared', async () => {
    const { plur } = open('request')
    const e = await plur.learn('Use pnpm in this repository', { actor: 'agent' })
    const asked = (await plur.setPinned(e.id, true, { actor: 'agent' }))!
    expect(asked.pinned).toBeUndefined()
    expect(pinRequestOf(asked)?.via).toBe('pin')
    const approved = (await plur.approvePinRequest(e.id, { actor: 'owner' }))!
    expect(approved.pinned).toBe(true)
    expect((approved.structured_data as any)?.pin_request).toBeUndefined()
    expect(await plur.pendingPinRequests()).toEqual([])
  })

  it('rejecting a request clears it and leaves the engram unpinned', async () => {
    const { plur } = open('request')
    const e = await plur.learn('Use pnpm', { pinned: true, actor: 'agent' })
    const rejected = (await plur.rejectPinRequest(e.id, { actor: 'owner' }))!
    expect(rejected.pinned).toBeUndefined()
    expect(pinRequestOf(rejected)).toBeNull()
    expect(await plur.pendingPinRequests()).toEqual([])
  })

  it('setPinned under deny refuses an agent; unpinning is never restricted', async () => {
    const { plur } = open('deny')
    const e = await plur.learn('Never push to main', { pinned: true, actor: 'owner' })
    const g = await plur.learn('Use pnpm', { actor: 'agent' })
    await expect(plur.setPinned(g.id, true, { actor: 'agent' })).rejects.toBeInstanceOf(PinDeniedError)
    expect((await plur.setPinned(e.id, false, { actor: 'agent' }))!.pinned).toBeUndefined()
  })

  it('import cannot bypass: pinned records from an agent import become requests', async () => {
    const { dir, plur } = open('request')
    const file = join(dir, 'in.json')
    writeFileSync(file, JSON.stringify([{ statement: 'Never commit secrets', pinned: true }]))
    const report = await importFrom(plur, { from: 'generic', path: file, actor: 'agent' })
    expect(report.imported).toBe(1)
    const [e] = await plur.list()
    expect(e.pinned).toBeUndefined()
    expect(pinRequestOf(e)).not.toBeNull()
    // The owner's import pins.
    writeFileSync(file, JSON.stringify([{ statement: 'Never push to main', pinned: true }]))
    await importFrom(plur, { from: 'generic', path: file, actor: 'owner' })
    expect((await plur.list()).find(x => x.statement === 'Never push to main')!.pinned).toBe(true)
  })

  it('change journal staged rows cannot bypass: request rewrites the row, deny refuses the whole change', async () => {
    const { dir, plur } = open('request')
    const e = await plur.learn('Use pnpm', { actor: 'agent' })
    const rec = await plur.beginChange('test.pin', { actor: 'agent' }).apply(tx => { tx.put({ ...tx.get(e.id)!, pinned: true }) })
    expect(rec.rows[0].after?.pinned).toBeUndefined()
    expect(pinRequestOf((await plur.getById(e.id))!)?.via).toBe('change:test.pin')
    // The owner's change pins.
    await plur.beginChange('test.pin', { actor: 'owner' }).apply(tx => { tx.put({ ...tx.get(e.id)!, pinned: true }) })
    expect((await plur.getById(e.id))!.pinned).toBe(true)
    // Undo restores the before-snapshot as it was.
    writeFileSync(join(dir, 'config.yaml'), 'embeddings:\n  enabled: false\nindex: false\npinning:\n  agents: deny\n')
    const denied = new Plur({ path: dir, autoDiscover: false })
    const f = await denied.learn('Run the tests', { actor: 'agent' })
    const before = readFileSync(join(dir, 'engrams.yaml'), 'utf8')
    await expect(denied.beginChange('test.pin', { actor: 'agent' }).apply(tx => { tx.put({ ...tx.get(f.id)!, pinned: true }) }))
      .rejects.toBeInstanceOf(PinDeniedError)
    expect(readFileSync(join(dir, 'engrams.yaml'), 'utf8')).toBe(before)
  })

  it('pack pins and team-store pins are unaffected by the policy', async () => {
    const dir = store('deny')
    dirs.push(dir)
    const team = join(dir, 'team.yaml')
    writeFileSync(team, `engrams:
  - id: ENG-2026-0101-001
    statement: team rule that the team pinned
    type: behavioral
    scope: group:acme/eng
    status: active
    pinned: true
    activation: { retrieval_strength: 0.9, storage_strength: 1.0, frequency: 0, last_accessed: "2026-08-01" }
`)
    writeFileSync(join(dir, 'config.yaml'),
      `embeddings:\n  enabled: false\nindex: false\npinning:\n  agents: deny\nstores:\n  - path: ${team}\n    scope: group:acme/eng\n`)
    const packSource = join(dir, 'pack-src')
    mkdirSync(packSource)
    writeFileSync(join(packSource, 'SKILL.md'), '---\nname: pinned-pack\nversion: "1.0"\n---\n')
    writeFileSync(join(packSource, 'engrams.yaml'), `engrams:
  - id: ENG-2026-0101-100
    statement: pack rule the pack author pinned
    type: behavioral
    scope: global
    status: active
    pinned: true
    activation: { retrieval_strength: 0.9, storage_strength: 1.0, frequency: 0, last_accessed: "2026-08-01" }
`)
    const plur = new Plur({ path: dir, autoDiscover: false, actor: 'agent' })
    await plur.installPack(packSource)
    // Team pins load as before; pack pins are stripped at install, as before
    // (ENGRAM-STANDARD §5.6.1) — never turned into pin requests.
    const pinned = (await plur.listPinned()).map(e => e.statement).sort()
    expect(pinned).toEqual(['team rule that the team pinned'])
    const packRow = (await plur.list()).find(e => e.statement === 'pack rule the pack author pinned')!
    expect(packRow).toBeDefined()
    expect(pinRequestOf(packRow)).toBeNull()
    expect(await plur.pendingPinRequests()).toEqual([])
  })

  it('team-store update: a restricted pin is refused when the prior pin state cannot be read (S3)', async () => {
    const SCOPE = 'group:acme/team'
    const extra = `stores:\n  - url: https://plur.example.com/sse\n    token: t\n    scope: ${SCOPE}\n    shared: true\n    readonly: false\n`
    const { plur } = open('request', { extra })
    const row = { id: 'SRV-1', statement: 'Tag every release', scope: SCOPE, status: 'active' } as any
    for (const prior of [null, 'throw'] as const) {
      const fake = {
        getById: vi.fn(async () => { if (prior === 'throw') throw new Error('down'); return prior }),
        patch: vi.fn(async (id: string, u: Record<string, unknown>) => ({ ...row, id, ...u })),
      }
      vi.spyOn(plur as any, '_getRemoteDriver').mockReturnValue(fake)
      await expect(plur.updateEngram({ ...row, pinned: true }, { actor: 'agent' })).rejects.toBeInstanceOf(PinDeniedError)
      expect(fake.patch).not.toHaveBeenCalled()
    }
    // Already pinned on the server: an ordinary update goes through.
    const pinnedFake = {
      getById: vi.fn(async () => ({ ...row, pinned: true })),
      patch: vi.fn(async (id: string, u: Record<string, unknown>) => ({ ...row, id, ...u })),
    }
    vi.spyOn(plur as any, '_getRemoteDriver').mockReturnValue(pinnedFake)
    await plur.updateEngram({ ...row, pinned: true, statement: 'Tag every release in git' }, { actor: 'agent' })
    expect(pinnedFake.patch).toHaveBeenCalled()
  })

  it('approving or rejecting a pin request needs an explicit owner: the default actor is not assumed to be one (S4)', async () => {
    const { dir } = open('request')
    const agent = new Plur({ path: dir, autoDiscover: false, actor: 'agent' })
    const e = await agent.learn('Use pnpm in this repository', { pinned: true })
    expect(pinRequestOf((await agent.getById(e.id))!)).not.toBeNull()
    await expect(agent.approvePinRequest(e.id)).rejects.toBeInstanceOf(PinDeniedError)
    await expect(agent.rejectPinRequest(e.id)).rejects.toBeInstanceOf(PinDeniedError)
    // No actor at all on an install that restricts agents: not the owner either.
    const anon = new Plur({ path: dir, autoDiscover: false })
    await expect(anon.approvePinRequest(e.id)).rejects.toBeInstanceOf(PinDeniedError)
    const row = (await agent.getById(e.id))!
    expect(row.pinned).toBeUndefined()
    expect(pinRequestOf(row)).not.toBeNull()
    expect((await anon.approvePinRequest(e.id, { actor: 'owner' }))!.pinned).toBe(true)
  })
})
