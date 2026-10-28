/**
 * `plur verify` on histories nobody edited (0.23 release audit,
 * 5-plur/1-tracks/engineering/reports/2026-10-28-plur-0.23-release-audit-report.md).
 *
 * Every session end now writes a checkpoint, so whatever happens after one is
 * ordinary use, and ordinary use must verify: recalls (which rewrite usage
 * counters), learns, a crashed write, an event from an older PLUR still
 * running, a writer that timed out on the chain lock. Edits made behind PLUR's
 * back must still break.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync, readdirSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { verifyChain } from '../src/verify-chain.js'
import { appendHistory, computeEventHash, emitCheckpoint, readHistory, clearChainHeadMemCache, type HistoryEvent } from '../src/history.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
function fresh(): string {
  const d = mkdtempSync(join(tmpdir(), 'plur-verify-use-'))
  dirs.push(d)
  return d
}
function monthFiles(root: string): string[] {
  return readdirSync(join(root, 'history')).filter(f => f.endsWith('.jsonl')).sort().map(f => join(root, 'history', f))
}
async function storeWithCheckpoint(): Promise<{ root: string; plur: Plur }> {
  const root = fresh()
  const plur = new Plur({ path: root, autoDiscover: false })
  await plur.learnAsync('Release notes are written in plain language', { type: 'behavioral' })
  await plur.learnAsync('Use pnpm for the monorepo builds', { type: 'procedural' })
  emitCheckpoint(root, join(root, 'engrams.yaml'), 'session_end')
  expect(verifyChain(root).status, 'precondition: verified right after the checkpoint').toBe('verified')
  return { root, plur }
}
function ev(id: string, ts: string, prev?: string | null): HistoryEvent {
  const e: HistoryEvent = { event: 'engram_created', engram_id: id, timestamp: ts, data: {} }
  if (prev !== undefined) { e.prev = prev; e.hash = computeEventHash(e) }
  return e
}

describe('ordinary use after a checkpoint verifies', () => {
  it('a recall (usage counters rewritten) is not a break', async () => {
    const { root } = await storeWithCheckpoint()
    // What a recall, an injection or feedback writes back: usage, not content.
    const path = join(root, 'engrams.yaml')
    const doc = yaml.load(readFileSync(path, 'utf8')) as { engrams: Array<Record<string, any>> }
    for (const e of doc.engrams) {
      e.activation = { ...(e.activation ?? {}), frequency: 7, last_accessed: '2026-10-29', retrieval_strength: 0.9 }
      e.feedback_signals = { positive: 2, negative: 0, neutral: 1 }
      e.injection_count = 5
    }
    writeFileSync(path, yaml.dump(doc))
    const out = verifyChain(root)
    expect(out.status, JSON.stringify(out)).toBe('verified')
  })

  it('a learn after the checkpoint is reported as a store change history explains, not a break', async () => {
    const { root, plur } = await storeWithCheckpoint()
    await plur.learnAsync('Weekdays are never typed from memory', { type: 'behavioral' })
    const out = verifyChain(root)
    expect(out.status, JSON.stringify(out)).toBe('verified')
    if (out.status !== 'verified') return
    expect(out.result.store_changed_since_checkpoint, 'the change since the checkpoint was not reported').toBeTruthy()
  })

  it('editing and forgetting through PLUR after the checkpoint are changes history explains', async () => {
    const { root, plur } = await storeWithCheckpoint()
    const [first, second] = (yaml.load(readFileSync(join(root, 'engrams.yaml'), 'utf8')) as { engrams: Array<{ id: string }> }).engrams
    const row = await plur.getById(first.id)
    await plur.updateEngram({ ...row!, rationale: 'customers skim them' })
    await plur.forget(second.id)
    const out = verifyChain(root)
    expect(out.status, JSON.stringify(out)).toBe('verified')
    if (out.status === 'verified') expect(out.result.store_changed_since_checkpoint).toBeTruthy()
  })

  it('an edit behind PLUR\'s back with nothing in history still breaks', async () => {
    const { root } = await storeWithCheckpoint()
    const path = join(root, 'engrams.yaml')
    const doc = yaml.load(readFileSync(path, 'utf8')) as { engrams: Array<{ statement: string }> }
    doc.engrams[0].statement = 'Release notes are written in legalese'
    writeFileSync(path, yaml.dump(doc))
    const out = verifyChain(root)
    expect(out.status).toBe('broken')
    if (out.status === 'broken') expect(out.result.breaks.map(b => b.reason)).toContain('store_hash_mismatch')
  })

  it('a store deleted after a checkpoint that attested memories breaks', async () => {
    const { root } = await storeWithCheckpoint()
    unlinkSync(join(root, 'engrams.yaml'))
    const out = verifyChain(root)
    expect(out.status).toBe('broken')
    if (out.status === 'broken') expect(out.result.breaks.map(b => b.reason)).toContain('store_hash_mismatch')
  })

  it('an unparseable store after a checkpoint cannot be verified, never "verified"', async () => {
    const { root } = await storeWithCheckpoint()
    writeFileSync(join(root, 'engrams.yaml'), 'engrams: [ {statement: "unterminated\n')
    expect(verifyChain(root).status).toBe('cannot_verify')
  })
})

describe('a crashed write does not cost the next event', () => {
  it('a torn last line is dropped under the lock; the next appends land and verify', () => {
    const root = fresh()
    appendHistory(root, ev('ENG-A', '2026-10-01T00:00:00.000Z'))
    const [file] = monthFiles(root)
    appendFileSync(file, '{"event":"engram_created","engr')
    clearChainHeadMemCache()
    appendHistory(root, ev('ENG-B', '2026-10-01T00:00:01.000Z'))
    appendHistory(root, ev('ENG-C', '2026-10-01T00:00:02.000Z'))
    expect(readHistory(root, '2026-10').map(e => e.engram_id), 'an event after the torn line was lost').toEqual(['ENG-A', 'ENG-B', 'ENG-C'])
    const out = verifyChain(root)
    expect(out.status, JSON.stringify(out)).toBe('verified')
  })
})

describe('an event from an older PLUR (no hash) between chained events', () => {
  it('the next chained event links past it to the last chained event', () => {
    const root = fresh()
    appendHistory(root, ev('ENG-A', '2026-10-01T00:00:00.000Z'))
    const [file] = monthFiles(root)
    appendFileSync(file, JSON.stringify(ev('ENG-OLD', '2026-10-01T00:00:01.000Z')) + '\n')
    clearChainHeadMemCache()
    appendHistory(root, ev('ENG-B', '2026-10-01T00:00:02.000Z'))
    const out = verifyChain(root)
    expect(out.status, JSON.stringify(out)).toBe('verified')
    if (out.status !== 'verified') return
    expect(out.result.unprotected_legacy?.count).toBe(1)
    expect(out.result.forks).toHaveLength(0)
  })
})

describe('a writer that timed out on the chain lock', () => {
  it('its declared gap is the only finding: the lock holder\'s link past it is not a mismatch, and nothing forks', () => {
    const root = fresh()
    const a = ev('ENG-A', '2026-10-01T00:00:00.000Z', null)
    const t = ev('ENG-T', '2026-10-01T00:00:01.000Z', a.hash)
    const g = ev('ENG-GAP', '2026-10-01T00:00:02.000Z', null) // unlocked fallback
    const h = ev('ENG-H', '2026-10-01T00:00:03.000Z', t.hash) // holder read the tail before g landed
    const n = ev('ENG-N', '2026-10-01T00:00:04.000Z', h.hash)
    appendHistory(root, ev('seed', '2026-10-01T00:00:00.000Z')) // creates the dir
    writeFileSync(monthFiles(root)[0], [a, t, g, h, n].map(e => JSON.stringify(e)).join('\n') + '\n')
    const out = verifyChain(root)
    expect(out.status).toBe('broken')
    if (out.status !== 'broken') return
    expect(out.result.breaks.map(b => b.reason)).toEqual(['declared_gap'])
    expect(out.result.forks, 'a gap after a long chain was reported as a genesis fork').toHaveLength(0)
  })
})

describe('malformed lines', () => {
  it('a JSON null line is cannot_verify, not a crash', () => {
    const root = fresh()
    appendHistory(root, ev('ENG-A', '2026-10-01T00:00:00.000Z'))
    const [file] = monthFiles(root)
    appendFileSync(file, 'null\n')
    appendHistory(root, ev('ENG-B', '2026-10-01T00:00:01.000Z'))
    expect(() => verifyChain(root)).not.toThrow()
    expect(verifyChain(root).status).toBe('cannot_verify')
  })

  it('a checkpoint line without data does not crash verify', () => {
    const root = fresh()
    appendHistory(root, ev('ENG-A', '2026-10-01T00:00:00.000Z'))
    const cp: HistoryEvent = { event: 'checkpoint', engram_id: '', timestamp: '2026-10-01T00:00:01.000Z' } as unknown as HistoryEvent
    appendHistory(root, cp)
    expect(() => verifyChain(root)).not.toThrow()
  })
})
