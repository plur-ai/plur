import { describe, it, expect } from 'vitest'

/**
 * Sentinel: better-sqlite3 must load and execute under THIS Node.
 *
 * On 2026-08-28 a wrong-ABI rebuild of better_sqlite3.node (with a stale
 * code signature) killed every index-path suite for a full day — reported
 * only as anonymous "Worker exited unexpectedly" errors while the summary
 * said "0 failed". This test turns that failure mode into a named,
 * first-class failure: the ABI error is a catchable require-time throw, and
 * this file does almost nothing else, so when it fails, the message IS the
 * diagnosis. Fix: `pnpm rebuild better-sqlite3`.
 */
describe('native module ABI sentinel', () => {
  it('better-sqlite3 loads and runs under this Node ABI', async () => {
    const { default: Database } = await import('better-sqlite3')
    const db = new Database(':memory:')
    try {
      db.exec('CREATE TABLE t (x INTEGER)')
      db.prepare('INSERT INTO t (x) VALUES (?)').run(42)
      expect(db.prepare('SELECT x FROM t').get()).toEqual({ x: 42 })
    } finally {
      db.close()
    }
  })
})
