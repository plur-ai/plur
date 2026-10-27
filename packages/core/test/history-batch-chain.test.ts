/**
 * appendHistoryBatch is one link per event in the same hash chain as
 * appendHistory: a batch must write exactly the prev/hash links that the same
 * events appended one by one would — including when the batch crosses into a
 * month file that already has events (formal finding F1,
 * spec/formal/findings/provenance-2026-10-27.md).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { appendHistory, appendHistoryBatch, clearChainHeadMemCache, type HistoryEvent } from '../src/history.js'
import { verifyChain } from '../src/verify-chain.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function fresh(): string {
  const d = mkdtempSync(join(tmpdir(), 'plur-batch-chain-'))
  dirs.push(d)
  return d
}

function ev(id: string, timestamp: string): HistoryEvent {
  return { event: 'engram_rekeyed', engram_id: id, timestamp, data: { from: `${id}-old` } }
}

function links(root: string): Array<[string, string | null | undefined, string | undefined]> {
  const dir = join(root, 'history')
  return readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort().flatMap(f =>
    readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map(l => {
      const e = JSON.parse(l) as HistoryEvent
      return [`${f}:${e.engram_id}`, e.prev, e.hash] as [string, string | null | undefined, string | undefined]
    }))
}

describe('appendHistoryBatch chains like single appends', () => {
  it('within one month', () => {
    const a = fresh(), b = fresh()
    for (const root of [a, b]) appendHistory(root, ev('seed', '2026-10-01T00:00:00.000Z'))
    const batch = [ev('e1', '2026-10-02T00:00:00.000Z'), ev('e2', '2026-10-02T00:00:00.000Z')]
    clearChainHeadMemCache()
    appendHistoryBatch(a, batch.map(e => ({ ...e, data: { ...e.data } })))
    for (const e of batch) appendHistory(b, { ...e, data: { ...e.data } })
    expect(links(a)).toEqual(links(b))
    expect(verifyChain(a).status).toBe('verified')
  })

  it('across a month boundary into a file that already has events', () => {
    const a = fresh(), b = fresh()
    for (const root of [a, b]) {
      appendHistory(root, ev('oct-seed', '2026-10-30T00:00:00.000Z'))
      appendHistory(root, ev('nov-seed', '2026-11-01T00:00:00.000Z'))
    }
    const batch = [ev('e1', '2026-10-31T23:59:59.000Z'), ev('e2', '2026-11-01T00:00:01.000Z')]
    clearChainHeadMemCache()
    appendHistoryBatch(a, batch.map(e => ({ ...e, data: { ...e.data } })))
    clearChainHeadMemCache()
    for (const e of batch) appendHistory(b, { ...e, data: { ...e.data } })
    expect(links(a), 'a batch crossing into a month with events linked differently from single appends').toEqual(links(b))
  })

  it('across a month boundary into an empty month: the chain just continues', () => {
    const a = fresh()
    appendHistory(a, ev('oct-seed', '2026-10-30T00:00:00.000Z'))
    appendHistoryBatch(a, [ev('e1', '2026-10-31T23:59:59.000Z'), ev('e2', '2026-11-01T00:00:01.000Z')])
    const l = links(a)
    expect(l[2][1], 'the first November event does not link to the last October event').toBe(l[1][2])
    expect(verifyChain(a).status).toBe('verified')
  })

  function same(seedTimes: string[], batchTimes: string[]) {
    const a = fresh(), b = fresh()
    for (const root of [a, b]) seedTimes.forEach((t, i) => appendHistory(root, ev(`seed${i}`, t)))
    const batch = batchTimes.map((t, i) => ev(`e${i}`, t))
    clearChainHeadMemCache()
    appendHistoryBatch(a, batch.map(e => ({ ...e, data: { ...e.data } })))
    clearChainHeadMemCache()
    for (const e of batch) appendHistory(b, { ...e, data: { ...e.data } })
    expect(links(a), `batch ${batchTimes.join(', ')} over ${seedTimes.join(', ')} linked differently from single appends`).toEqual(links(b))
  }

  it('returning to a month the batch already wrote (formal follow-up: revisit)', () => {
    same(['2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'],
      ['2026-10-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z', '2026-10-03T00:00:00.000Z'])
  })

  it('moving into an empty month while a later month has events (formal follow-up)', () => {
    same(['2026-10-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z'],
      ['2026-10-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z'])
  })
})
