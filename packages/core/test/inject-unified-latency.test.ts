/**
 * D6 (overhaul): p95 latency of the unified injection, cold (a new Plur
 * instance per call, as each hook process is) and warm (the same instance),
 * on a generated 3,000-engram store. The keyword path (`inject()`), which is
 * what the hook falls back to; no embedding model is needed.
 *
 * The 15k and 100k variants are skipped by default (they take minutes to
 * generate and run); set PLUR_LATENCY_LARGE=1 to run them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import { buildLargeFixture, writeFixtureStore, LARGE_QUERY } from './helpers/injection-fixture.js'

function p95(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]
}

async function measure(dir: string, runs: number, cold: boolean): Promise<number> {
  const times: number[] = []
  let warm: Plur | null = cold ? null : new Plur({ path: dir })
  if (warm) await warm.inject(LARGE_QUERY, { mode: 'unified' }) // load once
  for (let i = 0; i < runs; i++) {
    const plur = cold ? new Plur({ path: dir }) : warm!
    const t0 = performance.now()
    await plur.inject(`${LARGE_QUERY} ${i}`, { mode: 'unified' })
    times.push(performance.now() - t0)
  }
  warm = null
  return p95(times)
}

function suite(size: number, coldBudgetMs: number, warmBudgetMs: number, runs: number) {
  return () => {
    let dir: string
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), `plur-unified-lat-${size}-`))
      writeFixtureStore(dir, buildLargeFixture(size).engrams)
    }, 600_000)
    afterAll(() => rmSync(dir, { recursive: true, force: true }))

    it(`cold p95 under ${coldBudgetMs} ms`, async () => {
      const ms = await measure(dir, runs, true)
      expect(ms, `cold p95 ${Math.round(ms)} ms on ${size} engrams`).toBeLessThan(coldBudgetMs)
    }, 900_000)

    it(`warm p95 under ${warmBudgetMs} ms`, async () => {
      const ms = await measure(dir, runs, false)
      expect(ms, `warm p95 ${Math.round(ms)} ms on ${size} engrams`).toBeLessThan(warmBudgetMs)
    }, 900_000)
  }
}

describe('unified injection latency, 3k (D6)', suite(3000, 6000, 4000, 8))

const large = process.env.PLUR_LATENCY_LARGE === '1'
describe.skipIf(!large)('unified injection latency, 15k (D6, PLUR_LATENCY_LARGE=1)', suite(15_000, 20_000, 8000, 5))
describe.skipIf(!large)('unified injection latency, 100k (D6, PLUR_LATENCY_LARGE=1)', suite(100_000, 120_000, 60_000, 3))
