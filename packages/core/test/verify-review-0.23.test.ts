/**
 * Code review of 0.23 before release (5-plur/1-tracks/engineering/reports/
 * 2026-10-28-plur-0.23-code-review-report.md), core half.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { verifyChain } from '../src/verify-chain.js'
import { appendHistory, emitCheckpoint, storeBucketOf, computeEventHash, type HistoryEvent } from '../src/history.js'
import { buildSessionManifest } from '../src/session-manifest.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
function fresh(): string {
  const d = mkdtempSync(join(tmpdir(), 'plur-review-023-'))
  dirs.push(d)
  return d
}
type Doc = { engrams: Array<Record<string, any>> }
const load = (root: string) => yaml.load(readFileSync(join(root, 'engrams.yaml'), 'utf8')) as Doc
const save = (root: string, doc: Doc) => writeFileSync(join(root, 'engrams.yaml'), yaml.dump(doc))

async function storeWith(n: number): Promise<{ root: string; plur: Plur }> {
  const root = fresh()
  const plur = new Plur({ path: root, autoDiscover: false })
  for (let i = 0; i < n; i++) await plur.learnAsync(`Distinct fact number ${i} about the release train`, { type: 'behavioral' })
  return { root, plur }
}

describe('review 1: a sync pull is a recorded change', () => {
  it('memories a pull brought in are named by a store_synced event and verify stays clean', async () => {
    const { root } = await storeWith(2)
    emitCheckpoint(root, join(root, 'engrams.yaml'), 'session_end')
    // What a pull does: engrams.yaml gains a memory learned on another machine…
    const doc = load(root)
    const pulled = { ...doc.engrams[0], id: 'ENG-2026-10-28-901', statement: 'Learned on the other laptop' }
    doc.engrams.push(pulled)
    save(root, doc)
    // …and sync records it (as pullRebase now does).
    appendHistory(root, { event: 'store_synced', engram_id: '', timestamp: new Date().toISOString(), data: { engram_ids: [pulled.id], cause: 'sync-pull' } })
    const out = verifyChain(root)
    expect(out.status, JSON.stringify(out)).toBe('verified')
  })

  it('without that record the same change is a break', async () => {
    const { root } = await storeWith(2)
    emitCheckpoint(root, join(root, 'engrams.yaml'), 'session_end')
    const doc = load(root)
    doc.engrams.push({ ...doc.engrams[0], id: 'ENG-2026-10-28-902', statement: 'Appeared from nowhere' })
    save(root, doc)
    expect(verifyChain(root).status).toBe('broken')
  })
})

describe('review 2: one recorded change does not excuse another', () => {
  it('a hand edit stays a break after an unrelated learn', async () => {
    const { root, plur } = await storeWith(12)
    emitCheckpoint(root, join(root, 'engrams.yaml'), 'session_end')
    await plur.learnAsync('A legitimate new memory after the checkpoint', { type: 'behavioral' })
    const doc = load(root)
    const learned = doc.engrams.find(e => e.statement === 'A legitimate new memory after the checkpoint')!
    // Edit a memory in a different group than the one just learned.
    const victim = doc.engrams.find(e => e.id !== learned.id && storeBucketOf(e.id) !== storeBucketOf(learned.id))
    expect(victim, 'precondition: a memory in another group exists').toBeTruthy()
    victim!.statement = 'Quietly rewritten by hand'
    save(root, doc)
    const out = verifyChain(root)
    expect(out.status, 'a hand edit was excused by an unrelated learn').toBe('broken')
    if (out.status === 'broken') expect(out.result.breaks.map(b => b.reason)).toContain('store_hash_mismatch')
  })

  it('the learn alone is ordinary use', async () => {
    const { root, plur } = await storeWith(12)
    emitCheckpoint(root, join(root, 'engrams.yaml'), 'session_end')
    await plur.learnAsync('A legitimate new memory after the checkpoint', { type: 'behavioral' })
    const out = verifyChain(root)
    expect(out.status, JSON.stringify(out)).toBe('verified')
    if (out.status === 'verified') expect(out.result.store_changed_since_checkpoint).toBeTruthy()
  })
})

describe('review 3: a checkpoint that was not written has no hash', () => {
  it('emitCheckpoint returns event_hash null when the history line could not be written', async () => {
    const { root } = await storeWith(1)
    const month = new Date().toISOString().slice(0, 7)
    const file = join(root, 'history', `${month}.jsonl`)
    rmSync(file, { force: true })
    mkdirSync(file, { recursive: true }) // a directory where the month file should be: the append fails
    const cp = emitCheckpoint(root, join(root, 'engrams.yaml'), 'cli')
    expect(cp.event_hash, 'an unwritten checkpoint was given a hash to anchor').toBeNull()
  })
})

describe('review 5: an event stamped before the newest month joins the newest month', () => {
  it('appends to the newest month file and links to its tail, so nothing forks', () => {
    const root = fresh()
    // Relative to today: the boundary between last month and this one.
    const now = new Date()
    const cur = now.toISOString().slice(0, 7)
    const prevDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 23, 59, 58))
    const prev = prevDate.toISOString().slice(0, 7)
    appendHistory(root, { event: 'engram_created', engram_id: 'ENG-PREV', timestamp: prevDate.toISOString(), data: {} })
    appendHistory(root, { event: 'engram_created', engram_id: 'ENG-CUR', timestamp: `${cur}-01T00:00:00.000Z`, data: {} })
    // A writer that took its timestamp before midnight and got the lock after.
    appendHistory(root, { event: 'engram_created', engram_id: 'ENG-LATE', timestamp: `${prev}-${String(prevDate.getUTCDate()).padStart(2, '0')}T23:59:59.999Z`, data: {} })
    const out = verifyChain(root)
    expect(out.status, JSON.stringify(out)).toBe('verified')
    const newest = readFileSync(join(root, 'history', `${cur}.jsonl`), 'utf8')
    expect(newest, 'the late event was not written after the newest month tail').toContain('ENG-LATE')
  })
})

describe('review 6: a checkpoint names its session', () => {
  it('a later manifest of that session includes the checkpoint', async () => {
    const { root } = await storeWith(1)
    appendHistory(root, { event: 'co_injection', engram_id: '', timestamp: new Date().toISOString(), data: { session_id: 'S-1', ids: [load(root).engrams[0].id] } })
    const cp = emitCheckpoint(root, join(root, 'engrams.yaml'), 'session_end', undefined, undefined, 'S-1')
    const engrams = load(root).engrams as any
    const m = buildSessionManifest({ root, sessionId: 'S-1', engrams, actor: 'agent:test' } as any)
    expect(m.checkpoint?.event_hash, 'the session checkpoint is missing from its manifest').toBe(cp.event_hash)
  })
})

describe('review 7: a torn tail that is still growing is not truncated', () => {
  it('a fragment left by a dead writer is still dropped', () => {
    const root = fresh()
    appendHistory(root, { event: 'engram_created', engram_id: 'ENG-A', timestamp: '2026-10-01T00:00:00.000Z', data: {} })
    const [f] = readdirSync(join(root, 'history')).filter(n => n.endsWith('.jsonl'))
    writeFileSync(join(root, 'history', f), readFileSync(join(root, 'history', f), 'utf8') + '{"event":"engr')
    appendHistory(root, { event: 'engram_created', engram_id: 'ENG-B', timestamp: '2026-10-01T00:00:01.000Z', data: {} })
    expect(verifyChain(root).status).toBe('verified')
  })
})

void computeEventHash
void ({} as HistoryEvent)

describe('review 1, end to end: two machines syncing through a git remote', () => {
  it('memories pulled from the other machine keep verify clean', async () => {
    const { execSync } = await import('node:child_process')
    const { sync } = await import('../src/sync.js')
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
    Object.assign(process.env, env)
    const remote = fresh(); execSync('git init --bare -q', { cwd: remote })
    const { root: a, plur: pa } = await storeWith(2)
    await sync(a, remote)
    const b = fresh()
    execSync(`git clone -q ${remote} .`, { cwd: b, env })
    const pb = new Plur({ path: b, autoDiscover: false })
    await pb.learnAsync('Learned on the other laptop, then synced', { type: 'behavioral' })
    await sync(b)
    emitCheckpoint(a, join(a, 'engrams.yaml'), 'session_end')
    await sync(a)
    expect(load(a).engrams.some(e => e.statement === 'Learned on the other laptop, then synced'), 'precondition: the pull brought the memory').toBe(true)
    const out = verifyChain(a)
    expect(out.status, JSON.stringify(out)).toBe('verified')
    void pa
  })
})

describe('second review of the fix branch', () => {
  it('R1: an un-retire through PLUR is a recorded change', async () => {
    const { root, plur } = await storeWith(3)
    const id = load(root).engrams[0].id
    await plur.forget(id)
    emitCheckpoint(root, join(root, 'engrams.yaml'), 'session_end')
    const row = load(root).engrams.find(e => e.id === id)!
    await plur.updateEngram({ ...(await plur.getById(id))!, ...row, status: 'active' } as any)
    expect(load(root).engrams.find(e => e.id === id)!.status, 'precondition: un-retired').toBe('active')
    const out = verifyChain(root)
    expect(out.status, JSON.stringify(out)).toBe('verified')
  })

  it('R2: compact() records the retired memories it removes', async () => {
    const { root, plur } = await storeWith(3)
    const id = load(root).engrams[0].id
    await plur.forget(id)
    emitCheckpoint(root, join(root, 'engrams.yaml'), 'session_end')
    await plur.compact()
    expect(load(root).engrams.some(e => e.id === id), 'precondition: compacted away').toBe(false)
    const out = verifyChain(root)
    expect(out.status, JSON.stringify(out)).toBe('verified')
  })

  it('R3: a future-stamped month file does not capture later appends', () => {
    const root = fresh()
    const now = new Date().toISOString()
    appendHistory(root, { event: 'engram_created', engram_id: 'ENG-NOW', timestamp: now, data: {} })
    appendHistory(root, { event: 'engram_created', engram_id: 'ENG-SKEW', timestamp: '2099-03-01T00:00:00.000Z', data: {} })
    appendHistory(root, { event: 'engram_created', engram_id: 'ENG-AFTER', timestamp: new Date().toISOString(), data: {} })
    const own = readFileSync(join(root, 'history', `${now.slice(0, 7)}.jsonl`), 'utf8')
    expect(own, 'an event stamped now went into the far-future file').toContain('ENG-AFTER')
  })

  it('R7: an event naming a memory under any key explains its group', async () => {
    const { root } = await storeWith(3)
    emitCheckpoint(root, join(root, 'engrams.yaml'), 'session_end')
    const doc = load(root)
    doc.engrams[1].statement = 'Changed by an operation that names it in a nested field'
    save(root, doc)
    appendHistory(root, { event: 'engram_updated', engram_id: '', timestamp: new Date().toISOString(), data: { detail: { moved: { to: doc.engrams[1].id } } } })
    const out = verifyChain(root)
    expect(out.status, JSON.stringify(out)).toBe('verified')
  })

  it('R9: a numeric id changed by a pull is still named', async () => {
    const { storeRecordMap, recordStoreSync } = await import('../src/history.js')
    const root = fresh()
    writeFileSync(join(root, 'engrams.yaml'), 'engrams:\n  - id: 12345\n    statement: numeric id\n    type: behavioral\n    status: active\n')
    const before = storeRecordMap(join(root, 'engrams.yaml'))
    writeFileSync(join(root, 'engrams.yaml'), 'engrams:\n  - id: 12345\n    statement: numeric id, edited on the other machine\n    type: behavioral\n    status: active\n')
    recordStoreSync(root, before, 'sync-pull')
    const month = readdirSync(join(root, 'history')).filter(f => f.endsWith('.jsonl'))[0]
    expect(readFileSync(join(root, 'history', month), 'utf8')).toContain('"12345"')
  })
})

describe('second review: a relative PLUR_KEYS_DIR (R10)', () => {
  it('resolves against the store, not the process working directory', async () => {
    const { keysDirFor } = await import('../src/actor-keys.js')
    const prev = process.env.PLUR_KEYS_DIR
    process.env.PLUR_KEYS_DIR = 'my-keys'
    try {
      expect(keysDirFor('/stores/a')).toBe(join('/stores/a', 'my-keys'))
    } finally {
      if (prev === undefined) delete process.env.PLUR_KEYS_DIR
      else process.env.PLUR_KEYS_DIR = prev
    }
  })
})
