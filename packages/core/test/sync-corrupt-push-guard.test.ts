/**
 * Regression tests for the sync corrupt-push guards (audit #794, issue #798).
 *
 * `plur sync` is what users are told is their backup, which makes these worse
 * than their severity suggests. Measured on 0.17 main by probes p06/p06b:
 *
 *   - an unparseable engrams.yaml silently DISABLED the scope strip, and the
 *     verbatim blob — conflict markers and scope:local engrams alike — was
 *     committed and pushed (`remote now has markers: true`)
 *   - `git add -A -f` on an unmerged path marked the conflict "resolved" with
 *     the markers still in it
 *   - sync reported `{action:'synced', message:'pulled 1 remote commit(s)'}`
 *     while still 1 commit behind
 *   - the push warning claimed the remote "receives all engrams" while a fresh
 *     clone saw 3 of 5
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as yaml from 'js-yaml'
import { sync, SyncStoreUnreadableError } from '../src/sync.js'
import { Plur } from '../src/index.js'
import { withAsyncLock } from '../src/store/async-lock.js'

let root: string
let remote: string

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function record(n: number, scope = 'global') {
  return {
    id: `ENG-2026-08-02-${String(n).padStart(3, '0')}`,
    statement: `fact ${n}`,
    type: 'behavioral',
    status: 'active',
    scope,
    visibility: 'private',
    version: 2,
    confidence: 0.5,
    created: '2026-08-02',
    tags: [],
  }
}

function writeStore(records: unknown[]): void {
  writeFileSync(join(root, 'engrams.yaml'), yaml.dump({ engrams: records }))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'plur-sync-guard-'))
  remote = mkdtempSync(join(tmpdir(), 'plur-sync-remote-'))
  git(['init', '--bare', '-b', 'main'], remote)
  writeStore([record(1), record(2), record(3)])
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(remote, { recursive: true, force: true })
})

describe('sync refuses an unreadable store instead of pushing it verbatim (F5)', () => {
  it('throws rather than committing a conflict-marked engrams.yaml', () => {
    sync(root, remote)
    const path = join(root, 'engrams.yaml')
    const good = readFileSync(path, 'utf8')
    writeFileSync(path, `<<<<<<< HEAD\n${good}=======\nengrams: []\n>>>>>>> origin/main\n`)

    expect(() => sync(root)).toThrow(SyncStoreUnreadableError)

    // The committed tree is untouched — nothing with markers reached it.
    expect(git(['show', 'HEAD:engrams.yaml'], root)).not.toContain('<<<<<<<')
  })

  it('throws on a store that parses but is not an engram store', () => {
    sync(root, remote)
    writeFileSync(join(root, 'engrams.yaml'), yaml.dump({ something_else: true }))
    expect(() => sync(root)).toThrow(SyncStoreUnreadableError)
  })

  it('names the stash in the error, since that is where the only complete copy may be', () => {
    sync(root, remote)
    writeFileSync(join(root, 'engrams.yaml'), '{{{ not yaml')
    try {
      sync(root)
      throw new Error('should have thrown')
    } catch (err) {
      const msg = (err as Error).message
      // The natural "fix my repo" reflex is `git reset --hard`, which makes an
      // autostash-held copy unrecoverable. The error has to get in front of it.
      expect(msg).toMatch(/git stash/i)
      expect(msg).toMatch(/before running/i)
    }
  })

  it('refuses to stage an unmerged store file', () => {
    sync(root, remote)
    // Manufacture a genuine unmerged index entry by conflicting two real
    // commits — the state an autostash pop or a failed merge actually leaves.
    //
    // The starting branch is read rather than assumed: `git init`'s default is
    // `master` on git older than 2.28 and wherever `init.defaultBranch` is
    // unset, so hardcoding `main` here passes locally and fails on CI runners.
    const base = git(['rev-parse', '--abbrev-ref', 'HEAD'], root)
    git(['checkout', '-b', 'other'], root)
    writeStore([record(1), record(9)])
    git(['add', '-f', 'engrams.yaml'], root)
    git(['commit', '-m', 'other side'], root)
    git(['checkout', base], root)
    writeStore([record(1), record(8)])
    git(['add', '-f', 'engrams.yaml'], root)
    git(['commit', '-m', 'this side'], root)
    try { git(['merge', 'other'], root) } catch { /* expected conflict */ }

    const unmerged = git(['diff', '--name-only', '--diff-filter=U'], root)
    expect(unmerged).toContain('engrams.yaml')
    expect(() => sync(root)).toThrow(/unmerged/i)
  })
})

describe('sync reports what actually happened (F6)', () => {
  it('does not claim a pull that did not happen', () => {
    sync(root, remote)
    // Branch name is read, not assumed — see the note in the unmerged test.
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], root)
    // A second clone pushes a commit, so `root` falls behind.
    const other = mkdtempSync(join(tmpdir(), 'plur-sync-other-'))
    try {
      git(['clone', '--branch', branch, remote, other], tmpdir())
      writeFileSync(join(other, 'engrams.yaml'), yaml.dump({ engrams: [record(1), record(2), record(3), record(4)] }))
      git(['add', '-f', 'engrams.yaml'], other)
      git(['commit', '-m', 'remote side'], other)
      git(['push', 'origin', branch], other)

      const result = sync(root)
      // Whatever the outcome, the message must not assert a pull that left us
      // behind. Either it pulled and we are current, or it says it did not.
      const behind = git(['rev-list', '--right-only', '--count', 'HEAD...@{u}'], root)
      if (behind !== '0') {
        expect(result.message).toMatch(/NOT pulled/i)
      } else {
        expect(result.message).not.toMatch(/NOT pulled/i)
      }
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })
})

describe('sync tells the truth about what it backs up (F7)', () => {
  it('names scope:local engrams as NOT backed up', () => {
    writeStore([record(1), record(2, 'local'), record(3, 'local')])
    const result = sync(root, remote)
    expect(result.warning).toMatch(/2 scope:local engram\(s\) are NOT pushed/i)
    // The old text claimed the remote "receives all engrams", which is the
    // sentence a user reads once when deciding whether they need real backups.
    expect(result.warning).not.toMatch(/receives all engrams/i)
  })

  it('says plainly when the remote backs up nothing at all', () => {
    writeStore([record(1, 'local'), record(2, 'local')])
    const result = sync(root, remote)
    expect(result.warning).toMatch(/backs up nothing/i)
  })

  it('still warns that private-visibility engrams ARE pushed', () => {
    writeStore([record(1), record(2)])
    const result = sync(root, remote)
    expect(result.warning).toMatch(/2 private-visibility engram\(s\) ARE pushed/i)
  })

  it('says nothing when there is nothing to warn about', () => {
    writeStore([{ ...record(1), visibility: 'public' }])
    const result = sync(root, remote)
    expect(result.warning).toBeUndefined()
  })
})

describe('sync serializes against the store lock (#811 audit, finding 2)', () => {
  it('waits for a writer holding the store lock instead of racing it', async () => {
    // git pull --rebase REPLACES engrams.yaml, so an unlocked sync races the
    // write path and the race is invisible to the shrink guard:
    //   writer reads N -> sync pulls R (file is N+R) -> writer saves N+L
    //   the guard sees the same COUNT before and after, so it passes
    //   the next sync commits and pushes the deletion of R
    // Both report success and R is gone. Measured before the fix, this test
    // produced "sync-done -> writer-released"; it now produces the reverse.
    const dir = mkdtempSync(join(tmpdir(), 'plur-sync-serialize-'))
    try {
      const plur = new Plur({ path: dir, autoDiscover: false })
      await plur.learn('a seed engram so the store exists', { scope: 'local' })

      const order: string[] = []
      const holder = withAsyncLock(join(dir, 'engrams.yaml'), async () => {
        await new Promise(r => setTimeout(r, 400))
        order.push('writer-released')
      })
      const syncing = plur.sync().then(() => order.push('sync-done'), () => order.push('sync-failed'))
      await Promise.all([holder, syncing])

      expect(order[0], 'sync ran while a writer held the store lock').toBe('writer-released')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
