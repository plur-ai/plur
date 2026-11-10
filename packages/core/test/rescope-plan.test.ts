/**
 * Overhaul W7: plan scopes for global engrams from the existing deterministic
 * routing (`covers` + the domain convention), apply a plan through the change
 * journal, undo it exactly.
 *
 *  - The plan uses `rankScopes` + `decideAutoRoute` — the router the write
 *    path uses — with shared targets allowed, since a human reviews the plan.
 *    Engrams it cannot place stay global and are counted.
 *  - Apply moves locally owned rows to scopes this client keeps on this
 *    machine (local-family or a path store), journalled. A target backed by a
 *    team server is refused with a message naming `plur rescope --to`: the
 *    remote push is not undoable and is not reimplemented here.
 *  - Undo restores the store byte for byte.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'

describe('rescope plan / apply / undo (W7)', () => {
  let dir: string
  let plur: Plur
  const storeBytes = () => readFileSync(join(dir, 'engrams.yaml'), 'utf8')

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-rescope-plan-'))
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      index: false,
      stores: [
        { path: join(dir, 'eng.yaml'), scope: 'group:acme/engineering', covers: ['acme.engineering'] },
        { path: join(dir, 'research.yaml'), scope: 'group:acme/research', covers: ['acme.research'] },
        { url: 'http://127.0.0.1:9/', token: 't', scope: 'group:acme/comms', covers: ['acme.comms'] },
      ],
    }))
    plur = new Plur({ path: dir, autoDiscover: false })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  async function seed() {
    const eng = await plur.learn('Run the integration suite before tagging', { scope: 'global', domain: 'acme.engineering.ci' })
    const res = await plur.learn('The recall benchmark uses fifty questions', { scope: 'global', domain: 'acme.research.bench' })
    const comms = await plur.learn('Release posts go out on Tuesdays', { scope: 'global', domain: 'acme.comms.release' })
    const loose = await plur.learn('Prefer short sentences in replies', { scope: 'global', domain: 'personal.style' })
    const none = await plur.learn('A memory with no domain at all', { scope: 'global' })
    const local = await plur.learn('Already scoped somewhere', { scope: 'project:alpha', domain: 'acme.engineering.ci' })
    return { eng, res, comms, loose, none, local }
  }

  it('plan maps domains to the expected scopes and counts the unmapped, changing nothing', async () => {
    const s = await seed()
    const before = storeBytes()
    const plan = await plur.planRescope()
    expect(storeBytes()).toBe(before)
    const byId = Object.fromEntries(plan.items.map(i => [i.id, i]))
    expect(byId[s.eng.id].to_scope).toBe('group:acme/engineering')
    expect(byId[s.eng.id].route).toBe('local')
    expect(byId[s.res.id].to_scope).toBe('group:acme/research')
    expect(byId[s.comms.id].to_scope).toBe('group:acme/comms')
    expect(byId[s.comms.id].route).toBe('remote')
    // Unmapped stay global and are counted; non-global rows are not considered.
    expect(byId[s.loose.id]).toBeUndefined()
    expect(byId[s.none.id]).toBeUndefined()
    expect(byId[s.local.id]).toBeUndefined()
    expect(plan.unmapped.count).toBe(2)
    expect(plan.unmapped.ids).toEqual(expect.arrayContaining([s.loose.id, s.none.id]))
    expect(plan.considered).toBe(5)
    for (const i of plan.items) expect(i.from_scope).toBe('global')
  })

  it('apply --limit 1 changes exactly one engram, journalled; undo restores the store byte for byte', async () => {
    const s = await seed()
    // Normalise key order with one whole-corpus write, as the journal tests do.
    await plur.updateEngramAsync((await plur.getById(s.none.id))!)
    const before = storeBytes()
    const plan = await plur.planRescope()
    const result = await plur.applyRescopePlan(plan, { limit: 1 })
    expect(result.applied).toHaveLength(1)
    expect(result.change).not.toBeNull()
    expect(result.change!.kind).toBe('rescope.apply')
    const moved = (await plur.getById(result.applied[0].id))!
    expect(moved.scope).toBe(result.applied[0].to_scope)
    expect(moved.id).toBe(result.applied[0].id)
    const stillGlobal = (await plur.list()).filter(e => e.scope === 'global')
    expect(stillGlobal).toHaveLength(4)

    await plur.undoChange(result.change!.id)
    expect(storeBytes()).toBe(before)
  })

  it('refuses a target held on a team server and rows that changed since the plan', async () => {
    const s = await seed()
    const plan = await plur.planRescope()
    // The engineering row is moved by hand after the plan was written.
    await plur.rescope(s.eng.id, 'project:beta')
    const result = await plur.applyRescopePlan(plan)
    const refused = Object.fromEntries(result.refused.map(r => [r.id, r.reason]))
    expect(refused[s.comms.id]).toMatch(/team server/)
    expect(refused[s.comms.id]).toMatch(/plur rescope/)
    expect(refused[s.eng.id]).toMatch(/no longer global|changed/)
    expect(result.applied.map(a => a.id)).toEqual([s.res.id])
    expect((await plur.getById(s.comms.id))!.scope).toBe('global')
  })

  it('applying the same plan twice changes nothing the second time', async () => {
    await seed()
    const plan = await plur.planRescope()
    await plur.applyRescopePlan(plan)
    const after = storeBytes()
    const again = await plur.applyRescopePlan(plan)
    expect(again.applied).toHaveLength(0)
    expect(again.change).toBeNull()
    expect(storeBytes()).toBe(after)
  })
})
