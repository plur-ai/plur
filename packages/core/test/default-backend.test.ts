/**
 * Default backend resolution — Sprint 0 iter-2 audit M-3.
 *
 * ADR-0001 (#226, "Accepted v2", 2026-05-23) reads: "single backend family
 * across all shapes — PGLite + pgvector + AGE locally." The implementation
 * in PR 2 left the default at 'sqlite' (better-sqlite3 IndexedStorage), which
 * contradicted the accepted ADR (Archivist F-ARCH-001).
 *
 * Iter-2 audit M-3 fixes the drift: when neither PLUR_BACKEND nor
 * config.backend is set, the resolver returns 'pglite'. The 'sqlite' path
 * stays as a deprecation flag for one minor version.
 *
 * The suite-level setup-env.ts pins PLUR_BACKEND=sqlite for hermeticity (PGLite
 * is 30-100x slower per test under heavy parallelism). This test deletes the
 * env var locally to exercise the actual default.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'

describe('default backend (iter-2 audit M-3 — ADR-0001 alignment)', () => {
  let dir: string
  const originalBackend = process.env.PLUR_BACKEND

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-default-backend-'))
  })

  afterEach(() => {
    if (originalBackend === undefined) delete process.env.PLUR_BACKEND
    else process.env.PLUR_BACKEND = originalBackend
    rmSync(dir, { recursive: true, force: true })
  })

  it('Plur constructor defaults to PGLite when PLUR_BACKEND is unset', async () => {
    delete process.env.PLUR_BACKEND
    const plur = new Plur({ path: dir })
    plur.learn('the default backend is pglite', { type: 'behavioral', scope: 'global' })
    // PGLite's store.pglite/ directory is created lazily but the constructor
    // triggers an initial syncFromYaml; wait for it.
    await plur.waitForIndex()
    expect(existsSync(join(dir, 'store.pglite'))).toBe(true)
  }, 30_000)

  it('PLUR_BACKEND=sqlite keeps the legacy IndexedStorage path', () => {
    process.env.PLUR_BACKEND = 'sqlite'
    const plur = new Plur({ path: dir })
    plur.learn('legacy sqlite path still works', { type: 'behavioral', scope: 'global' })
    // SQLite path creates engrams.db, not store.pglite.
    expect(existsSync(join(dir, 'store.pglite'))).toBe(false)
  })
})
