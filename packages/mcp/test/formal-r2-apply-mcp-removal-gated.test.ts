/**
 * Formal R2, decision I_tensions_resolve (owner, 2026-09-27):
 * "Every removal needs an explicit, gated act."
 *
 * A tool that can retire or delete memory is annotated `destructiveHint: true`,
 * so plur_admin's generic dispatch refuses it (as it refuses plur_forget), and
 * it is exposed DIRECTLY in every profile so it stays reachable with its real
 * annotation visible to the client.
 *
 *   - plur_tensions: action:"resolve" retires the losing engram — forget's effect.
 *   - plur_validate_meta: a third failed validation of a non-top meta-engram
 *     sets its status to 'retired' (core meta/validation.ts) and the handler
 *     persists it — found by the audit the decision asked for.
 *   - plur_rescope stays non-destructive: a rescope always leaves a copy (a
 *     pushed remote copy with a superseded_by link, or the same engram
 *     rewritten in place), so it is a move, not a removal.
 *
 * Model: spec/formal/PlurSpec/R2Integrations.lean §1 (`admin_never_retires_fixed`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '@plur-ai/core'
import { getToolDefinitions, CURSOR_CORE_TOOL_NAMES } from '../src/tools.js'

const full = getToolDefinitions('full')
const byName = (n: string) => full.find(t => t.name === n)!

/** Every tool whose handler can retire or delete memory (audited 2026-09-27). */
const REMOVERS = ['plur_forget', 'plur_packs_uninstall', 'plur_tensions_purge', 'plur_tensions', 'plur_validate_meta']

describe('decision I: removal tools are destructive and direct', () => {
  it('every remover is annotated destructiveHint:true', () => {
    for (const name of REMOVERS) {
      expect(byName(name).annotations?.destructiveHint, name).toBe(true)
    }
  })

  it('every destructive tool is a direct tool in the lean and cursor profiles', () => {
    for (const profile of ['lean', 'cursor'] as const) {
      const names = getToolDefinitions(profile).map(t => t.name)
      for (const t of full.filter(x => x.annotations?.destructiveHint === true)) {
        expect(names, `${t.name} in ${profile}`).toContain(t.name)
        expect(CURSOR_CORE_TOOL_NAMES.has(t.name)).toBe(true)
      }
    }
  })

  it('lean profile grows by the two gated removers: 11 + 2 direct tools + plur_admin = 14', () => {
    expect(getToolDefinitions('lean').length).toBe(14)
  })

  it('plur_rescope stays a move: not destructive, still dispatchable through plur_admin', () => {
    expect(byName('plur_rescope').annotations?.destructiveHint).toBe(false)
    expect(CURSOR_CORE_TOOL_NAMES.has('plur_rescope')).toBe(false)
  })
})

describe('decision I replay: plur_admin refuses removal, the direct call still works', () => {
  let dir: string
  let plur: Plur
  const admin = () => getToolDefinitions('lean').find(t => t.name === 'plur_admin')!
  const lean = (n: string) => getToolDefinitions('lean').find(t => t.name === n)!

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-r2-apply-removal-'))
    plur = new Plur({ path: dir })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    rmSync(dir, { recursive: true, force: true })
  })

  it('plur_tensions resolve: refused via plur_admin (loser stays active); direct call retires it', async () => {
    const a = await plur.learn('Use PostgreSQL for the database')
    const b = await plur.learn('Use MySQL for the database instead of PostgreSQL')
    const { records } = await plur.recordTensions([{
      id_a: a.id, id_b: b.id, statement_a: a.statement, statement_b: b.statement,
      confidence: 0.9, reason: 'Mutually exclusive database choices.',
    }])
    const viaAdmin = await admin().handler({ action: 'plur_tensions', args: { action: 'resolve', id: records[0].id, winner: a.id } }, plur) as any
    expect(viaAdmin.success).toBe(false)
    expect(viaAdmin.error).toContain('destructive')
    expect((await plur.getById(b.id))?.status).toBe('active')

    const direct = await lean('plur_tensions').handler({ action: 'resolve', id: records[0].id, winner: a.id }, plur) as any
    expect(direct.retired).toBe(b.id)
    expect((await plur.getById(b.id))?.status).toBe('retired')
  })

  it('plur_validate_meta: a third failed validation retires the meta-engram — refused via plur_admin, works directly', async () => {
    const meta = {
      id: 'META-r2-apply-gated',
      version: 2, status: 'active', consolidated: false,
      type: 'behavioral', scope: 'global',
      statement: 'When safety margins assume independence between correlated variables, real risk is underestimated.',
      tags: ['meta-engram'], domain: 'meta',
      activation: { retrieval_strength: 0.5, storage_strength: 1.0, frequency: 0, last_accessed: '2026-09-27' },
      pack: null, abstract: null, derived_from: null, polarity: null,
      knowledge_anchors: [], associations: [],
      feedback_signals: { positive: 0, negative: 0, neutral: 0 },
      derivation_count: 2, visibility: 'private', write_count: 1, injection_count: 0,
      sources: [{ scope: 'global', session_id: null, stored_at: '2026-09-27T00:00:00.000Z' }],
      recurrence_count: 0, engram_version: 1, episode_ids: [],
      structured_data: { meta: {
        structure: {
          goal_type: 'risk-assessment', constraint_type: 'assumed-independence', outcome_type: 'understated-risk',
          template: '[risk-assessment] + [assumed-independence] → [understated-risk]', structure_type: 'goal-constraint-outcome',
        },
        evidence: [],
        domain_coverage: { validated: [], failed: ['law', 'music'], predicted: [] },
        falsification: { expected_conditions: 'x', expected_exceptions: 'y' },
        confidence: { evidence_count: 2, domain_count: 2, structural_depth: 3, validation_ratio: 0, composite: 0.5 },
        hierarchy: { level: 'mop', parent: null, children: [] },
        pipeline_version: '1.0.0',
      } },
    }
    await plur.saveMetaEngrams([meta as any])
    await plur.learn('Aspirin interacts with warfarin', { domain: 'medicine' } as any)
    // The judge says "prediction failed" — the third failure. No network: fetch is stubbed.
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ prediction_held: false, matching_engram_id: null, alignment_score: 0, rationale: 'no match' }) } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const args = { meta_engram_id: meta.id, test_domain: 'medicine', llm_base_url: 'http://127.0.0.1:9', llm_api_key: 'test-key' }

    const viaAdmin = await admin().handler({ action: 'plur_validate_meta', args }, plur) as any
    expect(viaAdmin.success).toBe(false)
    expect(viaAdmin.error).toContain('destructive')
    expect((await plur.getById(meta.id))?.status).toBe('active')

    const direct = await lean('plur_validate_meta').handler(args, plur) as any
    expect((await plur.getById(meta.id))?.status).toBe('retired')
    // Never silent (coordinator gap closure, 2026-09-27): the response says so.
    expect(direct.retired).toBe(true)
    expect(String(direct.note ?? '')).toMatch(/retired/i)
  })
})
