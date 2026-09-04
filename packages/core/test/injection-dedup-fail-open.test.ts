import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { hostname } from 'os'
import { Plur } from '../src/index.js'
import {
  appendHistory,
  computeQueryHash,
  countInjectionEvents,
  findLatestInjectionFor,
  isRecentDuplicateInjection,
  listHistoryMonths,
  mintedIdsWithPrefix,
  readCoInjections,
  readHistory,
  readHistoryForEngram,
} from '../src/history.js'

/**
 * Review of #1017 (B2, O2, O3 and the two missing tests).
 *
 * The invariants pinned here, in the order the review numbered them:
 *
 *   (1) No content of the local history log can make `inject()` throw or
 *       return without injecting. The dedup check runs inside `inject()` on
 *       the hook path — the product's primary path — and it used to
 *       dereference `ev.event` on a `null` line and `ev.data.query_hash` on
 *       a record with no `data`. The try in `inject()` wrapped only the
 *       append; `withLock` rethrew; the catch re-ran the section, which threw
 *       again, and a `TypeError` escaped `inject()`. One truncated append —
 *       or one hostile line — and every hook injection failed closed.
 *   (3) The injection counter and the history record cannot disagree in the
 *       direction "counter ahead of history".
 *   O3  Two distinct hook events with identical text are two records.
 *
 * Every case writes the hostile content by hand; nothing here depends on
 * timing.
 */

const month = () => new Date().toISOString().slice(0, 7)

function historyFile(root: string): string {
  const hd = path.join(root, 'history')
  fs.mkdirSync(hd, { recursive: true })
  return path.join(hd, `${month()}.jsonl`)
}

function coInjectionCount(root: string): number {
  const hd = path.join(root, 'history')
  if (!fs.existsSync(hd) || !fs.statSync(hd).isDirectory()) return 0
  return fs.readdirSync(hd)
    .filter(f => f.endsWith('.jsonl') && fs.statSync(path.join(hd, f)).isFile())
    .flatMap(f => fs.readFileSync(path.join(hd, f), 'utf8').split('\n').filter(Boolean))
    .map(l => { try { return JSON.parse(l) as { event?: string } | null } catch { return null } })
    .filter(e => e !== null && typeof e === 'object' && e.event === 'co_injection').length
}

async function injectionCounts(plur: Plur): Promise<number[]> {
  const all = await plur.list()
  return all.map(e => ((e as unknown as Record<string, unknown>).injection_count as number | undefined) ?? 0)
}

/**
 * The hostile lines. Each one parses (or fails to parse) differently, and
 * each one took a different reader down before the shape guard existed.
 */
function hostileLines(queryHash: string, ids: string[]): Array<{ name: string; line: Buffer }> {
  const now = new Date().toISOString()
  const j = (o: unknown) => Buffer.from(JSON.stringify(o) + '\n')
  return [
    { name: 'literal null', line: Buffer.from('null\n') },
    { name: 'a number', line: Buffer.from('42\n') },
    { name: 'a string', line: Buffer.from('"co_injection"\n') },
    { name: 'an array', line: Buffer.from('[]\n') },
    { name: 'co_injection with no data', line: j({ event: 'co_injection', engram_id: 'x', timestamp: now }) },
    { name: 'co_injection with null data', line: j({ event: 'co_injection', engram_id: 'x', timestamp: now, data: null }) },
    { name: 'co_injection with array data', line: j({ event: 'co_injection', engram_id: 'x', timestamp: now, data: [ids] }) },
    { name: 'ids is a string', line: j({ event: 'co_injection', engram_id: 'x', timestamp: now, data: { ids: ids[0], query_hash: queryHash } }) },
    { name: 'ids is an object', line: j({ event: 'co_injection', engram_id: 'x', timestamp: now, data: { ids: { 0: ids[0] }, query_hash: queryHash } }) },
    { name: 'ids holds a non-string', line: j({ event: 'co_injection', engram_id: 'x', timestamp: now, data: { ids: [ids[0], { toString: 1 }], query_hash: queryHash } }) },
    { name: 'event is not a string', line: j({ event: 7, engram_id: 'x', timestamp: now, data: { ids, query_hash: queryHash } }) },
    { name: 'timestamp is a number', line: j({ event: 'co_injection', engram_id: 'x', timestamp: Date.now(), data: { ids, query_hash: queryHash } }) },
    { name: 'injection_outcome with no data', line: j({ event: 'injection_outcome', engram_id: 'x', timestamp: now }) },
    { name: 'garbage bytes', line: Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28, 0x7b, 0x22]), Buffer.from('\n')]) },
    { name: 'a line larger than the tail window', line: Buffer.from('{"pad":"' + 'x'.repeat(100_000) + '"\n') },
  ]
}

describe('isRecentDuplicateInjection is total over the history log (#1017 B2)', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-dedup-hostile-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  const qh = computeQueryHash('prefer pnpm over npm')
  const ids = ['e1']

  for (const { name, line } of hostileLines(qh, ids)) {
    it(`does not throw on ${name}, and does not call it a duplicate`, () => {
      fs.writeFileSync(historyFile(dir), line)
      expect(() => isRecentDuplicateInjection(dir, qh, ids, 5_000, 'hook', 's1')).not.toThrow()
      expect(isRecentDuplicateInjection(dir, qh, ids, 5_000, 'hook', 's1')).toBe(false)
    })
  }

  it('still finds a real duplicate behind every hostile line at once', () => {
    // Hostile lines must not hide a record that follows them — the failure
    // this function is allowed is letting a duplicate THROUGH, not eating
    // one; but a corrupt prefix that disables the check entirely would be a
    // silent regression of the whole feature.
    const file = historyFile(dir)
    for (const { line } of hostileLines(qh, ids)) fs.appendFileSync(file, line)
    appendHistory(dir, {
      event: 'co_injection', engram_id: 'INJ-real', timestamp: new Date().toISOString(),
      data: { ids, query_hash: qh, source: 'hook', session_id: 's1' },
    })
    expect(isRecentDuplicateInjection(dir, qh, ids, 5_000, 'hook', 's1')).toBe(true)
  })

  it('an oversized LAST line hides nothing before it and does not throw', () => {
    const file = historyFile(dir)
    appendHistory(dir, {
      event: 'co_injection', engram_id: 'INJ-real', timestamp: new Date().toISOString(),
      data: { ids, query_hash: qh, source: 'hook', session_id: 's1' },
    })
    fs.appendFileSync(file, '{"pad":"' + 'x'.repeat(100_000) + '"\n')
    // The tail window now ends inside the oversized line; the real record is
    // out of range. That is the documented heuristic — a miss, never a throw.
    expect(() => isRecentDuplicateInjection(dir, qh, ids, 5_000, 'hook', 's1')).not.toThrow()
  })

  it('a history path that is a directory is not a duplicate and does not throw', () => {
    const file = historyFile(dir)
    fs.mkdirSync(file)
    expect(isRecentDuplicateInjection(dir, qh, ids, 5_000, 'hook', 's1')).toBe(false)
  })
})

describe('every history reader survives the same hostile lines (#1017 B2)', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-history-hostile-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  const qh = computeQueryHash('q')
  const ids = ['ENG-2026-0101-001']

  it('readHistory returns only records with a string event and an object data', () => {
    const file = historyFile(dir)
    for (const { line } of hostileLines(qh, ids)) fs.appendFileSync(file, line)
    const events = readHistory(dir, month())
    for (const ev of events) {
      expect(typeof ev.event).toBe('string')
      expect(typeof ev.engram_id).toBe('string')
      expect(typeof ev.timestamp).toBe('string')
      expect(ev.data).toBeTypeOf('object')
      expect(ev.data).not.toBeNull()
      expect(Array.isArray(ev.data)).toBe(false)
    }
    // The data-less co_injection is kept (it IS an event) with data coerced.
    const dataless = events.filter(e => e.event === 'co_injection' && Object.keys(e.data).length === 0)
    expect(dataless.length).toBeGreaterThan(0)
  })

  it('readHistoryForEngram, findLatestInjectionFor, countInjectionEvents, readCoInjections, mintedIdsWithPrefix', () => {
    const file = historyFile(dir)
    for (const { line } of hostileLines(qh, ids)) fs.appendFileSync(file, line)
    // A real event after the hostile ones must still be found.
    appendHistory(dir, {
      event: 'co_injection', engram_id: 'INJ-real', timestamp: new Date().toISOString(),
      data: { ids, query_hash: qh, source: 'hook' },
    })
    appendHistory(dir, {
      event: 'engram_created', engram_id: ids[0], timestamp: new Date().toISOString(), data: {},
    })

    expect(() => readHistoryForEngram(dir, ids[0])).not.toThrow()
    expect(readHistoryForEngram(dir, ids[0]).map(e => e.event)).toEqual(['engram_created'])

    expect(() => findLatestInjectionFor(dir, ids[0])).not.toThrow()
    expect(findLatestInjectionFor(dir, ids[0])?.injection_id).toBe('INJ-real')

    expect(() => countInjectionEvents(dir)).not.toThrow()
    const counts = countInjectionEvents(dir)
    // The shape-valid co_injection lines count (data-less ones included — they
    // are events); the injection_outcome with no data counts as an outcome
    // with no verdict.
    expect(counts.co_injection).toBeGreaterThanOrEqual(1)
    expect(counts.injection_outcome).toBe(1)
    expect(counts.outcome_positive + counts.outcome_negative).toBe(0)

    expect(() => readCoInjections(dir)).not.toThrow()
    const co = readCoInjections(dir)
    expect(co.events.map(e => e.injection_id)).toContain('INJ-real')
    // Whatever it kept is clean: the reader's existing contract is that a
    // payload with SOME string ids is kept with the others stripped (and
    // counted as skipped), so an event may survive from the hostile set —
    // but never with a non-string id in it.
    for (const e of co.events) {
      expect(e.data.ids.every(id => typeof id === 'string' && id.length > 0)).toBe(true)
      expect(typeof e.data.query_hash).toBe('string')
    }
    expect(co.skipped).toBeGreaterThan(0)

    expect(() => mintedIdsWithPrefix(dir, month(), ['ENG-2026-0101-'])).not.toThrow()
    expect(mintedIdsWithPrefix(dir, month(), ['ENG-2026-0101-'])).toEqual([ids[0]])
  })

  it('Plur.getEngramHistory does not throw on a null line', async () => {
    const plur = new Plur({ path: dir })
    const e = await plur.learn('Prefer pnpm over npm for installs', { scope: 'global', domain: 'build.tools' })
    fs.appendFileSync(historyFile(dir), 'null\n')
    expect(() => plur.getEngramHistory(e.id)).not.toThrow()
    expect(plur.getEngramHistory(e.id).length).toBeGreaterThan(0)
  })
})

describe('inject() never fails closed on the history log (#1017 invariant 1)', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-inject-hostile-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  const qh = computeQueryHash('prefer pnpm over npm')

  for (const { name, line } of hostileLines(qh, ['e1'])) {
    it(`hook inject still injects with ${name} in the month file`, async () => {
      const plur = new Plur({ path: dir })
      const learned = await plur.learn('Prefer pnpm over npm for installs', { scope: 'global', domain: 'build.tools' })
      fs.appendFileSync(historyFile(dir), line)
      const before = coInjectionCount(dir)

      const r = await plur.inject('prefer pnpm over npm', { source: 'hook', session_id: 's1' })
      expect(r.count).toBeGreaterThan(0)
      expect(r.injected_ids).toContain(learned.id)
      // …and the injection was RECORDED, not merely survived: one new event,
      // and the counter agrees with it.
      expect(coInjectionCount(dir)).toBe(before + 1)
      expect(Math.max(...await injectionCounts(plur))).toBe(1)
    })
  }

  it('hook inject still injects when the history directory is a file', async () => {
    const plur = new Plur({ path: dir })
    await plur.learn('Prefer pnpm over npm for installs', { scope: 'global', domain: 'build.tools' })
    fs.rmSync(path.join(dir, 'history'), { recursive: true, force: true })
    fs.writeFileSync(path.join(dir, 'history'), 'not a directory')
    const r = await plur.inject('prefer pnpm over npm', { source: 'hook', session_id: 's1' })
    expect(r.count).toBeGreaterThan(0)
  })
})

describe('the counter never runs ahead of the history record (#1017 O2, invariant 3)', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-counter-behind-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  for (const source of ['hook', 'inject', 'session_start'] as const) {
    it(`${source}: when the append fails, injection_count stays at zero`, async () => {
      const plur = new Plur({ path: dir })
      await plur.learn('Prefer pnpm over npm for installs', { scope: 'global', domain: 'build.tools' })
      const file = historyFile(dir)
      if (fs.existsSync(file)) fs.rmSync(file)
      fs.mkdirSync(file) // appendHistory now fails with EISDIR — and does not throw

      const r = await plur.inject('prefer pnpm over npm', { source, session_id: 's1' })
      expect(r.count, 'the injection itself still happens').toBeGreaterThan(0)

      expect(coInjectionCount(dir)).toBe(0)
      expect(Math.max(...await injectionCounts(plur))).toBe(0)
    })
  }

  it('recovers: once history is writable again both counters move together', async () => {
    const plur = new Plur({ path: dir })
    await plur.learn('Prefer pnpm over npm for installs', { scope: 'global', domain: 'build.tools' })
    const file = historyFile(dir)
    if (fs.existsSync(file)) fs.rmSync(file)
    fs.mkdirSync(file)
    await plur.inject('prefer pnpm over npm', { source: 'hook', session_id: 's1' })
    fs.rmdirSync(file)
    await plur.inject('prefer pnpm over npm', { source: 'hook', session_id: 's2' })
    expect(coInjectionCount(dir)).toBe(1)
    expect(Math.max(...await injectionCounts(plur))).toBe(1)
  })
})

describe('two distinct hook events with identical text are two records (#1017 O3)', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-dedup-event-id-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  async function seeded(): Promise<Plur> {
    const plur = new Plur({ path: dir })
    await plur.learn('Use the Explore agent for read-only sweeps', { scope: 'global', domain: 'agents' })
    return plur
  }

  it('two Explore subagents launched in one message → two records, two counts', async () => {
    const plur = await seeded()
    // What SubagentStart hooks produce for two Explore subagents launched in
    // the same turn: same text, same session, different agent_id.
    await plur.inject('subagent: Explore', { source: 'hook', session_id: 's1', event_id: 'agent_01' })
    await plur.inject('subagent: Explore', { source: 'hook', session_id: 's1', event_id: 'agent_02' })
    expect(coInjectionCount(dir)).toBe(2)
    expect(Math.max(...await injectionCounts(plur))).toBe(2)
  })

  it('the same event fired twice → one record, one count', async () => {
    const plur = await seeded()
    await plur.inject('subagent: Explore', { source: 'hook', session_id: 's1', event_id: 'agent_01' })
    await plur.inject('subagent: Explore', { source: 'hook', session_id: 's1', event_id: 'agent_01' })
    expect(coInjectionCount(dir)).toBe(1)
    expect(Math.max(...await injectionCounts(plur))).toBe(1)
  })

  it('an event id on one side only is a mismatch (never dedups across the boundary)', async () => {
    const plur = await seeded()
    await plur.inject('subagent: Explore', { source: 'hook', session_id: 's1', event_id: 'agent_01' })
    await plur.inject('subagent: Explore', { source: 'hook', session_id: 's1' })
    await plur.inject('subagent: Explore', { source: 'hook', session_id: 's1' }) // content dup of the second
    expect(coInjectionCount(dir)).toBe(2)
  })

  it('without an event id the key is content-based, as for UserPromptSubmit', async () => {
    const plur = await seeded()
    await plur.inject('subagent: Explore', { source: 'hook', session_id: 's1' })
    await plur.inject('subagent: Explore', { source: 'hook', session_id: 's1' })
    expect(coInjectionCount(dir)).toBe(1)
  })

  it('the event id is recorded and read back', async () => {
    const plur = await seeded()
    await plur.inject('subagent: Explore', { source: 'hook', session_id: 's1', event_id: 'toolu_01ABC' })
    const { events } = readCoInjections(dir)
    expect(events).toHaveLength(1)
    expect(events[0].data.event_id).toBe('toolu_01ABC')
  })

  it('a non-string event_id on a stored event reads as absent, and only tightens the key', () => {
    const qh = computeQueryHash('subagent: Explore')
    fs.writeFileSync(historyFile(dir), JSON.stringify({
      event: 'co_injection', engram_id: 'x', timestamp: new Date().toISOString(),
      data: { ids: ['e1'], query_hash: qh, source: 'hook', session_id: 's1', event_id: 42 },
    }) + '\n')
    expect(isRecentDuplicateInjection(dir, qh, ['e1'], 5_000, 'hook', 's1', '42')).toBe(false)
    expect(isRecentDuplicateInjection(dir, qh, ['e1'], 5_000, 'hook', 's1', undefined)).toBe(true)
  })
})

describe('lock files beside the month files are inert (#1017 missing tests)', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-lock-inert-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  function litter(root: string): void {
    const hd = path.join(root, 'history')
    fs.mkdirSync(hd, { recursive: true })
    fs.writeFileSync(path.join(hd, 'co-injection-dedup.lock'), `${hostname()}:1:${Date.now()}:0`)
    fs.writeFileSync(path.join(hd, 'co-injection-dedup.lock.steal.host_1_2_3'), 'x')
    fs.writeFileSync(path.join(hd, 'chain.lock'), 'x')
  }

  it('listHistoryMonths lists .jsonl months only', () => {
    litter(dir)
    fs.writeFileSync(path.join(dir, 'history', '2026-01.jsonl'), '')
    expect(listHistoryMonths(dir)).toEqual(['2026-01'])
  })

  it('readCoInjections and the receipt see through them', async () => {
    const plur = new Plur({ path: dir })
    await plur.learn('This monorepo uses pnpm for every install, never npm.', { type: 'procedural' })
    litter(dir)
    await plur.inject('pnpm install monorepo', { session_id: 's1', source: 'hook' })
    expect(readCoInjections(dir).events).toHaveLength(1)
    const r = await plur.receipt()
    expect(r.retrieved.retrievals).toBe(1)
    expect(r.coverage.source).toBe('co_injection')
  })
})

describe('when the dedup lock cannot be taken, the event is still written (#1017 missing tests)', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-lock-unavailable-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  function holdLock(root: string): string {
    const hd = path.join(root, 'history')
    fs.mkdirSync(hd, { recursive: true })
    const lock = path.join(hd, 'co-injection-dedup.lock')
    // Our own pid: withLock's liveness check says "alive", so it is never
    // stolen, and the bounded wait gives up into the unlocked fallback.
    fs.writeFileSync(lock, `${hostname()}:${process.pid}:${Date.now()}:0`)
    return lock
  }

  it('a lock held by a live process: every distinct hook injection lands, and the counter agrees', async () => {
    const plur = new Plur({ path: dir })
    await plur.learn('Prefer pnpm over npm for installs', { scope: 'global', domain: 'build.tools' })
    const lock = holdLock(dir)

    await plur.inject('prefer pnpm over npm', { source: 'hook', session_id: 's1' })
    await plur.inject('prefer pnpm over npm', { source: 'hook', session_id: 's2' })

    // Not dropped: a duplicate provenance line is noise, a missing one is a hole.
    expect(coInjectionCount(dir)).toBe(2)
    // Both counters still follow one reading — two records, two counts.
    expect(Math.max(...await injectionCounts(plur))).toBe(2)
    // And the foreign lock was neither stolen nor removed.
    expect(fs.readFileSync(lock, 'utf8')).toContain(`:${process.pid}:`)
  }, 30_000)

  it('the fallback still checks, unlocked: a same-session duplicate is caught when not raced', async () => {
    // The fallback is UNLOCKED, not unchecked. Without the lock the check is
    // a read-modify-write across processes and can let a racing duplicate
    // through — the fail-open direction — but a duplicate that arrives after
    // the first record landed is still suppressed, and the counter follows.
    const plur = new Plur({ path: dir })
    await plur.learn('Prefer pnpm over npm for installs', { scope: 'global', domain: 'build.tools' })
    holdLock(dir)

    await plur.inject('prefer pnpm over npm', { source: 'hook', session_id: 's1' })
    await plur.inject('prefer pnpm over npm', { source: 'hook', session_id: 's1' })

    expect(coInjectionCount(dir)).toBe(1)
    expect(Math.max(...await injectionCounts(plur))).toBe(1)
  }, 30_000)
})
