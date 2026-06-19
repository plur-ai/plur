/**
 * Stage 3b (#351): auto-route genuinely-unscoped writes via suggestScope, else
 * fall to `unscoped_default`. This is the BEHAVIOR FLIP that Stage 3a
 * (scope-routing.ts / suggestScope) deliberately left inert.
 *
 * The write path only auto-routes when the caller is TRULY unscoped — no
 * explicit `scope` AND no session/`.plur.yaml` default (both land in the
 * session scope). An explicit scope or a session default is honored UNCHANGED.
 * The sensitivity guard still runs AFTER scope selection, so an auto-routed
 * SHARED scope carrying sensitive content is still demoted to local.
 *
 * Confidence note: SCOPE_MATCH_THRESHOLD is 0.5, and squash(raw)=raw/(raw+1.5),
 * so a confident auto-route needs raw weight >= 1.5 — a domain-prefix hit (1.0)
 * alone is NOT enough; it must be reinforced (e.g. + a tag hit at 0.5). The
 * "confident match" stores below stack domain + tag (+ keyword) to clear it.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur, SCOPE_MATCH_THRESHOLD } from '../src/index.js'

const dirs: string[] = []

/** Build a Plur whose config carries the given stores + any extra config keys. */
function makePlur(config: Record<string, unknown>): Plur {
  const dir = mkdtempSync(join(tmpdir(), 'plur-route-unscoped-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'config.yaml'), yaml.dump({ index: false, ...config }, { noRefs: true }))
  return new Plur({ path: dir })
}

afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

describe('Stage 3b — auto-route un-scoped writes (#351)', () => {
  it('routes an un-scoped write to a covers-matched scope (confident), stamps _routed', () => {
    const plur = makePlur({
      stores: [
        { path: '/tmp/r-core.yaml', scope: 'group:plur/core', description: 'Core', covers: ['plur.*', 'embeddings', 'core'] },
      ],
    })
    // Domain-prefix hit (plur.core.embeddings ⊂ plur.*) + tag hit (embeddings) +
    // keyword hits push raw well above 1.5 → confidence >= threshold.
    const e = plur.learn('the embeddings index for the core engine', {
      domain: 'plur.core.embeddings',
      tags: ['embeddings'],
    }) as { scope: string; structured_data?: { _routed?: { scope: string; confidence: number; reason: string } } }

    expect(e.scope).toBe('group:plur/core')
    expect(e.structured_data?._routed).toBeDefined()
    expect(e.structured_data?._routed?.scope).toBe('group:plur/core')
    expect(e.structured_data?._routed?.confidence).toBeGreaterThanOrEqual(SCOPE_MATCH_THRESHOLD)
    expect(e.structured_data?._routed?.reason).toBeTruthy()
  })

  it('falls to global (the default, reverted in 0.10.0 #353) when no covers match', () => {
    const plur = makePlur({
      stores: [
        { path: '/tmp/r-core.yaml', scope: 'group:plur/core', description: 'Core', covers: ['plur.*', 'embeddings'] },
      ],
    })
    const e = plur.learn('completely unrelated note about lunch preferences') as {
      scope: string; structured_data?: { _routed?: unknown }
    }
    expect(e.scope).toBe('global')
    expect(e.structured_data?._routed).toBeUndefined()
  })

  it('unscoped_default: "global" sends an unmatched write to global (explicit; also the default)', () => {
    const plur = makePlur({
      unscoped_default: 'global',
      stores: [
        { path: '/tmp/r-core.yaml', scope: 'group:plur/core', description: 'Core', covers: ['plur.*'] },
      ],
    })
    const e = plur.learn('unrelated note that matches no covers') as {
      scope: string; structured_data?: { _routed?: unknown }
    }
    expect(e.scope).toBe('global')
    expect(e.structured_data?._routed).toBeUndefined()
  })

  it('unscoped_default: "local" sends an unmatched write to local (opt-out of global)', () => {
    const plur = makePlur({
      unscoped_default: 'local',
      stores: [
        { path: '/tmp/r-core.yaml', scope: 'group:plur/core', description: 'Core', covers: ['plur.*'] },
      ],
    })
    const e = plur.learn('unrelated note that matches no covers') as {
      scope: string; structured_data?: { _routed?: unknown }
    }
    expect(e.scope).toBe('local')
    expect(e.structured_data?._routed).toBeUndefined()
  })

  it('honors an explicit scope — NO auto-route, no _routed marker', () => {
    const plur = makePlur({
      stores: [
        // covers would confidently match, but the caller chose a scope explicitly.
        { path: '/tmp/r-core.yaml', scope: 'group:plur/core', description: 'Core', covers: ['plur.*', 'embeddings'] },
      ],
    })
    const e = plur.learn('the embeddings index for the core engine', {
      domain: 'plur.core.embeddings',
      tags: ['embeddings'],
      scope: 'local',
    }) as { scope: string; structured_data?: { _routed?: unknown } }
    expect(e.scope).toBe('local')
    expect(e.structured_data?._routed).toBeUndefined()
  })

  it('honors a session default_scope — NO auto-route, no _routed marker', () => {
    const plur = makePlur({
      stores: [
        { path: '/tmp/r-core.yaml', scope: 'group:plur/core', description: 'Core', covers: ['plur.*', 'embeddings'] },
      ],
    })
    plur.setSessionScope('project:my-app')
    const e = plur.learn('the embeddings index for the core engine', {
      domain: 'plur.core.embeddings',
      tags: ['embeddings'],
    }) as { scope: string; structured_data?: { _routed?: unknown } }
    expect(e.scope).toBe('project:my-app')
    expect(e.structured_data?._routed).toBeUndefined()
  })

  it('auto_route_scope:false disables routing — unscoped falls straight to default (global)', () => {
    const plur = makePlur({
      auto_route_scope: false,
      stores: [
        { path: '/tmp/r-core.yaml', scope: 'group:plur/core', description: 'Core', covers: ['plur.*', 'embeddings'] },
      ],
    })
    const e = plur.learn('the embeddings index for the core engine', {
      domain: 'plur.core.embeddings',
      tags: ['embeddings'],
    }) as { scope: string; structured_data?: { _routed?: unknown } }
    expect(e.scope).toBe('global')
    expect(e.structured_data?._routed).toBeUndefined()
  })

  it('auto-routed SHARED scope with sensitive content is still DEMOTED to local (3b + guard)', () => {
    const plur = makePlur({
      stores: [
        // A SHARED group scope (isSharedScope) whose covers confidently match infra content.
        { path: '/tmp/r-infra.yaml', scope: 'group:plur/infra', description: 'Infra', covers: ['plur.*', 'infra', 'deploy'] },
      ],
    })
    // Confident match (domain-prefix + tag) → would route to group:plur/infra,
    // but the statement carries a public IP, so the guard demotes to local/private.
    const e = plur.learn('deploy target for infra is 139.59.155.82', {
      domain: 'plur.infra.deploy',
      tags: ['infra'],
    }) as {
      scope: string; visibility: string
      structured_data?: {
        _routed?: { scope: string; confidence: number }
        _demoted?: { from: string; to: string; patterns: string }
      }
    }
    // Demoted, not routed-as-shared.
    expect(e.scope).toBe('local')
    expect(e.visibility).toBe('private')
    expect(e.structured_data?._demoted?.from).toBe('group:plur/infra')
    expect(e.structured_data?._demoted?.to).toBe('local')
    expect(e.structured_data?._demoted?.patterns).toMatch(/public_ipv4/)
    // The routing decision is preserved alongside the demotion — both facts are true.
    expect(e.structured_data?._routed?.scope).toBe('group:plur/infra')
  })
})
