/**
 * Hardening H4: a rescope plan is a file a person can edit. The planner only
 * ever proposes moving GLOBAL rows (`from_scope: 'global'`), so apply must
 * refuse any item claiming another from_scope: a tampered plan must not move
 * a private project row into a shared scope.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import type { RescopePlan } from '../src/plur/types.js'

describe('applyRescopePlan refuses non-global from_scope (H4)', () => {
  let dir: string
  let plur: Plur
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-harden-rescope-'))
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      index: false,
      stores: [{ path: join(dir, 'eng.yaml'), scope: 'group:acme/engineering', covers: ['acme.engineering'] }],
    }))
    plur = new Plur({ path: dir, autoDiscover: false })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('a tampered item with from_scope project:private is refused and the row stays put', async () => {
    const priv = await plur.learn('Private project detail for alpha only', { scope: 'project:alpha', domain: 'acme.engineering.ci' })
    const plan: RescopePlan = {
      version: 1, kind: 'plur.rescope-plan', created_at: new Date().toISOString(), considered: 1,
      items: [{
        id: priv.id, from_scope: 'project:alpha' as 'global', to_scope: 'group:acme/engineering',
        route: 'local', confidence: 1, reason: 'tampered', statement: priv.statement,
      }],
      unmapped: { count: 0, ids: [] },
    }
    const res = await plur.applyRescopePlan(plan)
    expect(res.applied).toEqual([])
    expect(res.change).toBeNull()
    expect(res.refused.map(r => r.id)).toEqual([priv.id])
    expect(res.refused[0].reason).toMatch(/global/)
    expect((await plur.getById(priv.id))!.scope).toBe('project:alpha')
  })

  it('a planned global item still applies', async () => {
    const g = await plur.learn('Run the integration suite before tagging', { scope: 'global', domain: 'acme.engineering.ci' })
    const plan = await plur.planRescope()
    const res = await plur.applyRescopePlan(plan)
    expect(res.applied.map(a => a.id)).toEqual([g.id])
  })
})
