/**
 * The in-process lock queue must key on the RESOLVED path.
 *
 * `withAsyncLock` has two layers. The `O_EXCL` lock file excludes other
 * processes and gets normalisation for free — the kernel resolves the path. The
 * in-process queue is a plain `Map` keyed by string, and does not: `./engrams.yaml`
 * and `/abs/dir/engrams.yaml` are different strings for the same file.
 *
 * Split the key and two callers in ONE process each get their own queue and run
 * concurrently. They then race on the file lock, and the loser spins until it
 * times out or declares the lock stale — so the failure is a corrupted
 * read-modify-write or a hang, not an error anyone can trace back to here.
 *
 * `path.resolve` handles relative segments and `..`. It does NOT resolve
 * symlinks or normalise case, so two genuinely different spellings of one file
 * can still split the queue; the file lock is what covers that.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join, relative } from 'path'
import { withAsyncLock } from '../src/store/async-lock.js'

describe('withAsyncLock keys on the resolved path', () => {
  let dir: string
  let target: string
  let cwd: string

  beforeEach(() => {
    // realpath, deliberately: on macOS os.tmpdir() is a symlink (/var ->
    // /private/var), so after chdir the cwd and the raw temp path resolve to
    // different STRINGS for the same file. That is a real limitation of
    // path.resolve (see the header) but it is not what this test is about, and
    // leaving it in makes the fixture, not the lock, decide the outcome.
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'plur-lockkey-')))
    target = join(dir, 'engrams.yaml')
    writeFileSync(target, 'engrams: []\n')
    cwd = process.cwd()
    process.chdir(dir)
  })

  afterEach(() => {
    process.chdir(cwd)
    rmSync(dir, { recursive: true, force: true })
  })

  it('different spellings QUEUE in-process rather than racing on the lock file', async () => {
    // Choosing the observable carefully. Asserting "they never overlap" does
    // NOT test this: the O_EXCL lock file already prevents overlap whatever the
    // in-process key is, so that assertion passes with the normalisation
    // removed (verified by mutation). The difference a split key makes is that
    // the second caller reaches the FILE lock, finds it taken, and spins.
    //
    // `maxRetries: 0` turns that spin into a throw, which is observable:
    //   - one queue  -> the second waits its turn in-process, then acquires cleanly
    //   - two queues -> the second hits EEXIST with no retries left and throws
    const spellings = ['./engrams.yaml', join(dir, '.', 'engrams.yaml'), join(dir, 'sub', '..', 'engrams.yaml')]
    const body = async () => { await new Promise(r => setTimeout(r, 20)) }

    const results = await Promise.allSettled([
      withAsyncLock(target, body, { maxRetries: 0 }),
      ...spellings.map(p => withAsyncLock(p, body, { maxRetries: 0 })),
    ])
    const failed = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[]
    expect(
      failed.map(f => String(f.reason?.message ?? f.reason)),
      'a spelling of the same path got its own queue and collided on the lock file',
    ).toEqual([])
  })

  it('and they still never overlap', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    const body = async () => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise(r => setTimeout(r, 30))
      concurrent--
    }
    const spellings = [target, './engrams.yaml', join(dir, 'sub', '..', 'engrams.yaml')]
    await Promise.all(spellings.map(p => withAsyncLock(p, body, { maxRetries: 200, retryDelayMs: 5 })))
    expect(maxConcurrent).toBe(1)
  })

  it('a relative path and its absolute form share one queue', async () => {
    const order: string[] = []
    const rel = relative(dir, target) // "engrams.yaml"
    const a = withAsyncLock(target, async () => {
      order.push('abs-start')
      await new Promise(r => setTimeout(r, 40))
      order.push('abs-end')
    }, { maxRetries: 200, retryDelayMs: 5 })
    // Give the first a moment to take the lock, so this is a real queue test.
    await new Promise(r => setTimeout(r, 5))
    const b = withAsyncLock(rel, async () => {
      order.push('rel-start')
      order.push('rel-end')
    }, { maxRetries: 200, retryDelayMs: 5 })
    await Promise.all([a, b])

    // Interleaved would be abs-start, rel-start, ... — the whole point is that
    // the second waits for the first to finish.
    expect(order).toEqual(['abs-start', 'abs-end', 'rel-start', 'rel-end'])
  })

  it('DIFFERENT files still run concurrently — the key must not collapse everything', async () => {
    // Without this, keying every call on a constant would pass both tests above
    // while serialising the entire process.
    const other = join(dir, 'other.yaml')
    writeFileSync(other, 'engrams: []\n')
    let concurrent = 0
    let maxConcurrent = 0
    const body = async () => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise(r => setTimeout(r, 30))
      concurrent--
    }
    await Promise.all([
      withAsyncLock(target, body, { maxRetries: 200, retryDelayMs: 5 }),
      withAsyncLock(other, body, { maxRetries: 200, retryDelayMs: 5 }),
    ])
    expect(maxConcurrent, 'unrelated files were serialised against each other').toBe(2)
  })

  it('the result and thrown errors pass through unchanged', async () => {
    expect(await withAsyncLock(target, async () => 42)).toBe(42)
    await expect(withAsyncLock(target, async () => { throw new Error('boom') })).rejects.toThrow('boom')
    // And the lock is released after a throw — otherwise the next call hangs.
    expect(await withAsyncLock(target, async () => 'after')).toBe('after')
  })
})

describe('what path.resolve does NOT normalise', () => {
  // Honest boundary. `path.resolve` collapses `.`, `..` and relative segments;
  // it does not resolve symlinks. Two spellings that differ only by a symlink
  // therefore get separate in-process queues — and the FILE lock is what keeps
  // them correct. Pinned so nobody later "simplifies" the file lock away on the
  // grounds that the in-process queue already covers it.
  let real: string
  let target: string

  beforeEach(() => {
    real = realpathSync(mkdtempSync(join(tmpdir(), 'plur-lockkey-sym-')))
    target = join(real, 'engrams.yaml')
    writeFileSync(target, 'engrams: []\n')
  })

  afterEach(() => rmSync(real, { recursive: true, force: true }))

  it('a symlinked spelling still never overlaps, via the file lock', async () => {
    const viaSymlink = join(tmpdir(), relative(realpathSync(tmpdir()), target))
    let concurrent = 0
    let maxConcurrent = 0
    const body = async () => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise(r => setTimeout(r, 30))
      concurrent--
    }
    await Promise.all([
      withAsyncLock(target, body, { maxRetries: 200, retryDelayMs: 5 }),
      withAsyncLock(viaSymlink, body, { maxRetries: 200, retryDelayMs: 5 }),
    ])
    expect(maxConcurrent, 'the file lock did not cover the symlinked spelling').toBe(1)
  })
})
