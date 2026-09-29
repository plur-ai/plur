/**
 * Formal verification round 2 (R2-Integrations, mcp-integrations#6):
 * a tool's MCP annotations must not claim less risk than its handler has.
 *
 *   writes (locally or remotely)      ⇒ readOnlyHint is not true
 *   a repeat call can add new effects ⇒ idempotentHint is not true
 *
 * Model: spec/formal/PlurSpec/R2Integrations.lean §1.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '@plur-ai/core'
import { getToolDefinitions } from '../src/tools.js'

const full = getToolDefinitions('full')
const byName = (n: string) => full.find(t => t.name === n)!

describe('R2 annotations: tools that write are not read-only', () => {
  it('plur_session_start registers the session and flushes the outbox (remote writes) — not readOnlyHint', () => {
    expect(byName('plur_session_start').annotations?.readOnlyHint).not.toBe(true)
  })

  it('plur_tensions scan persists new detections, and an LLM judge may detect new pairs on a repeat — not idempotentHint', () => {
    expect(byName('plur_tensions').annotations?.idempotentHint).not.toBe(true)
    expect(byName('plur_tensions').annotations?.readOnlyHint).not.toBe(true)
  })

  it('no tool that is annotated readOnlyHint is in the known writer set', () => {
    // Every tool whose handler writes engrams, sessions, tension records,
    // outbox state, config or a remote store.
    const writers = [
      'plur_session_start', 'plur_session_end', 'plur_session_scope', 'plur_learn', 'plur_learn_batch',
      'plur_forget', 'plur_feedback', 'plur_pin', 'plur_capture', 'plur_ingest', 'plur_packs_install',
      'plur_packs_uninstall', 'plur_sync', 'plur_outbox', 'plur_extract_meta', 'plur_validate_meta',
      'plur_stores_add', 'plur_promote', 'plur_rescope', 'plur_tensions', 'plur_tensions_purge',
      'plur_episode_to_engram', 'plur_report_failure', 'plur_packs_export',
    ]
    for (const name of writers) {
      const t = full.find(x => x.name === name)
      if (!t) continue
      expect(t.annotations?.readOnlyHint, name).not.toBe(true)
    }
  })
})

// Before owner decision I_tensions_resolve (2026-09-27) this case pinned the
// NEEDS-OWNER evidence: resolve through plur_admin retired the loser. The
// decision ("every removal needs an explicit, gated act") made plur_tensions
// destructive, so the same call is now refused and the loser stays active.
// The direct-call path is covered in formal-r2-apply-mcp-removal-gated.test.ts.
describe('R2 replay: plur_admin no longer retires through tensions resolve (decision I)', () => {
  let dir: string
  let plur: Plur
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-r2-admin-'))
    plur = new Plur({ path: dir })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('plur_tensions action:"resolve" through plur_admin is refused like plur_forget; the loser stays active', async () => {
    const admin = getToolDefinitions('lean').find(t => t.name === 'plur_admin')!
    const a = await plur.learn('Use PostgreSQL for the database')
    const b = await plur.learn('Use MySQL for the database instead of PostgreSQL')
    const { records } = await plur.recordTensions([{
      id_a: a.id, id_b: b.id, statement_a: a.statement, statement_b: b.statement,
      confidence: 0.9, reason: 'Mutually exclusive database choices.',
    }])
    const forget = await admin.handler({ action: 'plur_forget', args: { id: b.id } }, plur) as any
    expect(forget.success).toBe(false)
    const res = await admin.handler({ action: 'plur_tensions', args: { action: 'resolve', id: records[0].id, winner: a.id } }, plur) as any
    expect(res.success).toBe(false)
    expect(res.error).toContain('destructive')
    expect((await plur.getById(b.id))?.status).toBe('active')
  })
})
