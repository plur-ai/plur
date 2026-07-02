/**
 * sync() background index-error surfacing — closes #272 (iter-1 audit gap
 * M-11, Critic F-CRIT-006).
 *
 * Plur.sync() kicks the PGLite index refresh — and the auto-embed/reembed
 * work that rides on it — into a background promise whose .catch logs a
 * warning and swallows the failure. The CLI awaits waitForIndex() but the
 * catch has already absorbed the rejection, so a failed refresh reports
 * "Sync: ok" and plur_status shows nothing.
 *
 * Contract under test (the issue's "store a _lastReembedError and expose via
 * status()" option, generalized to every background index op on current main):
 *
 *   - a failed background syncFromYaml / reindex / auto-embed pass is
 *     recorded and exposed via lastIndexError() and status().index_error
 *     ({ op, message, at })
 *   - a subsequent successful pass clears the recorded error
 *   - waitForIndex() still resolves (never rejects) — surfacing is via
 *     state, not a thrown rejection, so existing callers keep working
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'

const PGLITE_TIMEOUT = 30_000

describe('sync() surfaces background index failures (#272)', () => {
  let dir: string
  const originalBackend = process.env.PLUR_BACKEND

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-index-error-'))
    process.env.PLUR_BACKEND = 'pglite'
  })

  afterEach(() => {
    if (originalBackend === undefined) delete process.env.PLUR_BACKEND
    else process.env.PLUR_BACKEND = originalBackend
    rmSync(dir, { recursive: true, force: true })
  })

  it('records a failed incremental syncFromYaml and clears it on the next success', async () => {
    const plur = new Plur({ path: dir })
    await plur.waitForIndex() // let the constructor's initial sync settle
    expect(plur.lastIndexError()).toBeNull()

    const adapter = (plur as any).pgliteAdapter
    const realSyncFromYaml = adapter.syncFromYaml.bind(adapter)
    adapter.syncFromYaml = () => Promise.reject(new Error('disk on fire'))

    const result = plur.sync()
    expect(result.action).toBeTruthy() // git SyncResult shape unchanged
    await plur.waitForIndex() // must resolve, not reject

    const err = plur.lastIndexError()
    expect(err).not.toBeNull()
    expect(err!.op).toBe('sync-from-yaml')
    expect(err!.message).toContain('disk on fire')
    expect(new Date(err!.at).getTime()).not.toBeNaN()
    expect(plur.status().index_error).toEqual(err)

    // Recovery: the next successful pass clears the recorded error.
    adapter.syncFromYaml = realSyncFromYaml
    plur.sync()
    await plur.waitForIndex()
    expect(plur.lastIndexError()).toBeNull()
    expect(plur.status().index_error).toBeUndefined()
  }, PGLITE_TIMEOUT)

  it('records a failed full reindex under op "reindex"', async () => {
    const plur = new Plur({ path: dir })
    await plur.waitForIndex()

    const adapter = (plur as any).pgliteAdapter
    adapter.reindex = () => Promise.reject(new Error('rebuild exploded'))

    plur.sync(undefined, { full: true })
    await plur.waitForIndex()

    const err = plur.lastIndexError()
    expect(err).not.toBeNull()
    expect(err!.op).toBe('reindex')
    expect(err!.message).toContain('rebuild exploded')
  }, PGLITE_TIMEOUT)

  it('records a failed auto-embed pass under op "auto-embed"', async () => {
    const plur = new Plur({ path: dir })
    // Seed one active engram so the auto-embed pass has work to attempt.
    plur.learn('index errors must be surfaced, not swallowed', {
      type: 'behavioral',
      scope: 'global',
    })
    await plur.waitForIndex()

    const adapter = (plur as any).pgliteAdapter
    // getVectorColumnDim runs at the top of _autoEmbedNewEngrams, before the
    // dim-mismatch skip — rejecting here fails the embed pass itself while
    // the preceding syncFromYaml still succeeds.
    adapter.getVectorColumnDim = () => Promise.reject(new Error('vector column gone'))

    plur.sync()
    await plur.waitForIndex()

    const err = plur.lastIndexError()
    expect(err).not.toBeNull()
    expect(err!.op).toBe('auto-embed')
    expect(err!.message).toContain('vector column gone')
  }, PGLITE_TIMEOUT)
})
