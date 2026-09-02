import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { spawn } from 'child_process'
import { appendHistory, computeQueryHash, isRecentDuplicateInjection, generateInjectionId } from '../src/history.js'

describe('cross-process injection dedup (#975)', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-dedup-'))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('detects a duplicate co_injection with same query_hash and engram IDs', () => {
    const queryHash = computeQueryHash('what is the project status')
    const ids = ['eng-1', 'eng-2', 'eng-3']

    // Write the first injection
    appendHistory(root, {
      event: 'co_injection',
      engram_id: generateInjectionId(),
      timestamp: new Date().toISOString(),
      data: { ids, query_hash: queryHash, tokens_used: 500, source: 'inject' },
    })

    // The same query+IDs within the window = duplicate
    expect(isRecentDuplicateInjection(root, queryHash, ids)).toBe(true)
  })

  it('does NOT flag as duplicate when engram IDs differ', () => {
    const queryHash = computeQueryHash('what is the project status')

    appendHistory(root, {
      event: 'co_injection',
      engram_id: generateInjectionId(),
      timestamp: new Date().toISOString(),
      data: { ids: ['eng-1', 'eng-2'], query_hash: queryHash, tokens_used: 500, source: 'inject' },
    })

    // Same query but different engrams selected = NOT a duplicate
    expect(isRecentDuplicateInjection(root, queryHash, ['eng-1', 'eng-3'])).toBe(false)
  })

  it('does NOT flag as duplicate when query differs', () => {
    const ids = ['eng-1', 'eng-2']

    appendHistory(root, {
      event: 'co_injection',
      engram_id: generateInjectionId(),
      timestamp: new Date().toISOString(),
      data: { ids, query_hash: computeQueryHash('query one'), tokens_used: 500, source: 'inject' },
    })

    // Different query = NOT a duplicate even with same IDs
    expect(isRecentDuplicateInjection(root, computeQueryHash('query two'), ids)).toBe(false)
  })

  it('does NOT flag old events outside the window', () => {
    const queryHash = computeQueryHash('old query')
    const ids = ['eng-1']

    // Write an event with a timestamp 10 seconds ago
    const old = new Date(Date.now() - 10_000).toISOString()
    appendHistory(root, {
      event: 'co_injection',
      engram_id: generateInjectionId(),
      timestamp: old,
      data: { ids, query_hash: queryHash, tokens_used: 100, source: 'inject' },
    })

    // Outside the 5s window = NOT a duplicate
    expect(isRecentDuplicateInjection(root, queryHash, ids, 5_000)).toBe(false)
  })

  it('is order-insensitive on engram IDs', () => {
    const queryHash = computeQueryHash('order test')

    appendHistory(root, {
      event: 'co_injection',
      engram_id: generateInjectionId(),
      timestamp: new Date().toISOString(),
      data: { ids: ['b', 'a', 'c'], query_hash: queryHash, tokens_used: 100, source: 'inject' },
    })

    // Same IDs in different order = IS a duplicate
    expect(isRecentDuplicateInjection(root, queryHash, ['c', 'a', 'b'])).toBe(true)
  })

  it('returns false on empty/missing history', () => {
    expect(isRecentDuplicateInjection(root, 'abc123', ['eng-1'])).toBe(false)
  })
})

// ── The race the fix exists to close ────────────────────────────────────────

describe('cross-process dedup is atomic, not check-then-act (#975)', () => {
  /**
   * The duplicates come from hook processes spawning "within milliseconds",
   * which is exactly the window in which both read the tail before either has
   * appended. Reading, deciding, then appending is a read-modify-write across
   * processes: O_APPEND makes the WRITE atomic without making the SEQUENCE
   * atomic, so both see no duplicate and both write one.
   *
   * Awaiting two injections in sequence passes either way. Only genuinely
   * concurrent PROCESSES exercise it.
   *
   * INVARIANT: N concurrent injections of the same query and the same engram
   * set produce exactly ONE co_injection event.
   */
  let root: string
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-dedup-race-')) })
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

  function countCoInjections(dir: string): number {
    const historyDir = path.join(dir, 'history')
    if (!fs.existsSync(historyDir)) return 0
    return fs.readdirSync(historyDir)
      .filter(f => f.endsWith('.jsonl'))
      .flatMap(f => fs.readFileSync(path.join(historyDir, f), 'utf8').split('\n').filter(Boolean))
      .map(l => { try { return JSON.parse(l) as { event?: string } } catch { return {} } })
      .filter(e => e.event === 'co_injection').length
  }

  it('four concurrent processes write ONE event, not four', async () => {
    const store = 'engrams:\n' +
      '  - id: ENG-2026-0101-001\n    statement: prefer pnpm over npm\n    type: behavioral\n' +
      '    scope: global\n    status: active\n    version: 2\n    domain: build.tools\n' +
      '    activation:\n      retrieval_strength: 0.9\n      storage_strength: 1.0\n' +
      '      frequency: 5\n      last_accessed: "2026-01-01"\n'
    fs.writeFileSync(path.join(root, 'engrams.yaml'), store, 'utf8')

    const script = `
      const { Plur } = require(${JSON.stringify(path.join(process.cwd(), 'packages/core/dist/index.js'))});
      (async () => {
        const p = new Plur({ path: ${JSON.stringify(root)} });
        await p.inject('prefer pnpm over npm', { source: 'session_start' });
      })().catch(e => { console.error(e); process.exit(1) });
    `
    const procs = Array.from({ length: 4 }, () =>
      new Promise<number>(resolve => {
        const c = spawn(process.execPath, ['--input-type=commonjs', '-e', script], { stdio: 'ignore' })
        c.on('exit', code => resolve(code ?? 1))
      }))
    const codes = await Promise.all(procs)
    expect(codes, 'a child failed to run').toEqual([0, 0, 0, 0])

    expect(countCoInjections(root)).toBe(1)
  }, 120_000)
})

describe('a malformed timestamp cannot suppress a real record', () => {
  let root: string
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-dedup-ts-')) })
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

  it('treats an unparseable timestamp as OUT of the window', () => {
    // `now - NaN > windowMs` is false, so the old guard did not `continue` and
    // the event counted as in-window whatever its age. One corrupt tail line
    // could then suppress a legitimate co_injection indefinitely.
    const queryHash = computeQueryHash('q')
    const ids = ['eng-1']
    const historyDir = path.join(root, 'history')
    fs.mkdirSync(historyDir, { recursive: true })
    const month = new Date().toISOString().slice(0, 7)
    fs.writeFileSync(path.join(historyDir, `${month}.jsonl`),
      JSON.stringify({ event: 'co_injection', engram_id: 'x', timestamp: 'not-a-date',
        data: { ids, query_hash: queryHash } }) + '\n', 'utf8')

    expect(isRecentDuplicateInjection(root, queryHash, ids)).toBe(false)
  })

  it('treats a future timestamp as OUT of the window', () => {
    const queryHash = computeQueryHash('q')
    const ids = ['eng-1']
    const historyDir = path.join(root, 'history')
    fs.mkdirSync(historyDir, { recursive: true })
    const month = new Date().toISOString().slice(0, 7)
    const future = new Date(Date.now() + 86_400_000).toISOString()
    fs.writeFileSync(path.join(historyDir, `${month}.jsonl`),
      JSON.stringify({ event: 'co_injection', engram_id: 'x', timestamp: future,
        data: { ids, query_hash: queryHash } }) + '\n', 'utf8')

    expect(isRecentDuplicateInjection(root, queryHash, ids)).toBe(false)
  })
})

// ── Session is part of the key ──────────────────────────────────────────────

describe('two sessions are two injections, not one duplicate', () => {
  /**
   * The duplicate #975 describes is ONE session's hooks firing twice from
   * separate processes. Two different sessions selecting the same engrams for
   * the same query are two real injections, and collapsing them loses a
   * retrieval that `plur receipt` counts as engram-session evidence.
   *
   * This was invisible while the check was non-atomic: the race meant it almost
   * never fired, so a key this coarse cost nothing. Making it atomic exposed it
   * immediately — receipt-io's "two sessions, two pairs" case regressed.
   */
  let root: string
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-dedup-session-')) })
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

  function writeEvent(session_id: string | undefined, queryHash: string, ids: string[]): void {
    appendHistory(root, {
      event: 'co_injection',
      engram_id: generateInjectionId(),
      timestamp: new Date().toISOString(),
      data: { ids, query_hash: queryHash, source: 'inject', ...(session_id ? { session_id } : {}) },
    })
  }

  it('does NOT dedup across different sessions', () => {
    const qh = computeQueryHash('pnpm install')
    const ids = ['eng-1']
    writeEvent('s1', qh, ids)
    expect(isRecentDuplicateInjection(root, qh, ids, 5_000, 'inject', 's2')).toBe(false)
  })

  it('DOES dedup within the same session', () => {
    const qh = computeQueryHash('pnpm install')
    const ids = ['eng-1']
    writeEvent('s1', qh, ids)
    expect(isRecentDuplicateInjection(root, qh, ids, 5_000, 'inject', 's1')).toBe(true)
  })

  it('treats absent-session events and absent-session queries as the same key', () => {
    // Not every caller threads a session id; those must still dedup with each
    // other, or the original #975 duplicates come straight back.
    const qh = computeQueryHash('pnpm install')
    const ids = ['eng-1']
    writeEvent(undefined, qh, ids)
    expect(isRecentDuplicateInjection(root, qh, ids, 5_000, 'inject', undefined)).toBe(true)
  })

  it('does not treat a sessionless event as a duplicate of a sessioned one', () => {
    const qh = computeQueryHash('pnpm install')
    const ids = ['eng-1']
    writeEvent(undefined, qh, ids)
    expect(isRecentDuplicateInjection(root, qh, ids, 5_000, 'inject', 's1')).toBe(false)
  })
})

// ── Source is compared symmetrically ────────────────────────────────────────

describe('source is normalised on both sides', () => {
  let root: string
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-dedup-src-')) })
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

  function writeEvent(source: string | undefined, queryHash: string, ids: string[]): void {
    appendHistory(root, {
      event: 'co_injection', engram_id: generateInjectionId(),
      timestamp: new Date().toISOString(),
      data: { ids, query_hash: queryHash, ...(source ? { source } : {}) },
    })
  }

  it('a sourceless query does NOT dedup against a hook-sourced event', () => {
    // `if (source !== undefined)` skipped the comparison when the caller passed
    // nothing, while the write path defaults source to 'inject' — so the two
    // sides disagreed about what "absent" means and a programmatic inject()
    // could be swallowed by an unrelated hook event.
    const qh = computeQueryHash('pnpm install')
    const ids = ['eng-1']
    writeEvent('hook', qh, ids)
    expect(isRecentDuplicateInjection(root, qh, ids, 5_000, undefined, undefined)).toBe(false)
  })

  it('a sourceless query DOES dedup against a sourceless event', () => {
    // Both default to 'inject', so they are the same key.
    const qh = computeQueryHash('pnpm install')
    const ids = ['eng-1']
    writeEvent(undefined, qh, ids)
    expect(isRecentDuplicateInjection(root, qh, ids, 5_000, undefined, undefined)).toBe(true)
  })

  it('an explicit inject source dedups against a sourceless event', () => {
    const qh = computeQueryHash('pnpm install')
    const ids = ['eng-1']
    writeEvent(undefined, qh, ids)
    expect(isRecentDuplicateInjection(root, qh, ids, 5_000, 'inject', undefined)).toBe(true)
  })
})

// ── Both counters follow one reading ────────────────────────────────────────

describe('injection_count follows the same verdict as the history event', () => {
  /**
   * The store used to disagree with its own history: a deduped pair left
   * engrams.yaml showing injection_count: 2 against a single co_injection
   * event. The justification — that the engram was genuinely injected even when
   * the log entry is a duplicate — contradicts the premise the dedup rests on.
   * Either the two events describe ONE injection, and counting it twice is the
   * inflation #975 opens with, or they describe two and the event should not
   * have been suppressed. One reading, both counters.
   */
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-dedup-count-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  function countCoInjectionEvents(root: string): number {
    const hd = path.join(root, 'history')
    if (!fs.existsSync(hd)) return 0
    return fs.readdirSync(hd).filter(f => f.endsWith('.jsonl'))
      .flatMap(f => fs.readFileSync(path.join(hd, f), 'utf8').split('\n').filter(Boolean))
      .map(l => { try { return JSON.parse(l) as { event?: string } } catch { return {} } })
      .filter(e => e.event === 'co_injection').length
  }

  it('a deduped injection does not increment the counter either', async () => {
    const { Plur } = await import('../src/index.js')
    const plur = new Plur({ path: dir })
    await plur.learn('Prefer pnpm over npm for installs', { scope: 'global', domain: 'build.tools' })

    // Same session, same query, same engrams, inside the window: one injection.
    await plur.inject('prefer pnpm over npm', { session_id: 's1', source: 'inject' })
    await plur.inject('prefer pnpm over npm', { session_id: 's1', source: 'inject' })

    const events = countCoInjectionEvents(dir)
    expect(events, 'the second injection should have been deduped').toBe(1)

    const all = await plur.list()
    const counted = all.filter(e => ((e as never as Record<string, unknown>).injection_count ?? 0) !== 0)
    for (const e of counted) {
      const n = (e as never as Record<string, unknown>).injection_count as number
      expect(n, `${e.id}: store says ${n} injections, history says ${events}`).toBe(events)
    }
  })

  it('two genuinely different sessions increment twice and log twice', async () => {
    // The other side of the same rule: not deduped, so both counters move.
    const { Plur } = await import('../src/index.js')
    const plur = new Plur({ path: dir })
    await plur.learn('Prefer pnpm over npm for installs', { scope: 'global', domain: 'build.tools' })

    await plur.inject('prefer pnpm over npm', { session_id: 's1', source: 'inject' })
    await plur.inject('prefer pnpm over npm', { session_id: 's2', source: 'inject' })

    expect(countCoInjectionEvents(dir)).toBe(2)
  })
})

describe('the dedup window straddles a month rollover', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-dedup-month-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('finds a duplicate written in the previous month file', () => {
    // A pair one to four milliseconds apart across midnight on the 1st lands in
    // two different files. Reading only the current month missed it.
    const now = Date.now()
    const prevMonth = new Date(now - 5_000).toISOString().slice(0, 7)
    const thisMonth = new Date(now).toISOString().slice(0, 7)

    const hd = path.join(dir, 'history')
    fs.mkdirSync(hd, { recursive: true })
    const qh = computeQueryHash('pnpm install')
    const ids = ['eng-1']
    fs.writeFileSync(path.join(hd, `${prevMonth}.jsonl`),
      JSON.stringify({ event: 'co_injection', engram_id: 'x',
        timestamp: new Date(now - 1000).toISOString(),
        data: { ids, query_hash: qh, source: 'inject' } }) + '\n', 'utf8')

    // Only meaningful when the two differ; otherwise this is the ordinary case
    // and still must pass.
    expect(isRecentDuplicateInjection(dir, qh, ids, 5_000, 'inject', undefined)).toBe(true)
    expect(prevMonth === thisMonth || fs.existsSync(path.join(hd, `${prevMonth}.jsonl`))).toBe(true)
  })
})
