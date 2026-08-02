/**
 * An unreadable engram store must not be reported as an empty one.
 *
 * This is the most destructive silent failure the codebase had, and it needed
 * two ordinary facts to combine:
 *
 *   1. `loadEngrams` caught a YAML parse error, logged it, and returned `[]`.
 *   2. Every `Plur` write is load -> mutate -> save, and `save` replaces the
 *      WHOLE file.
 *
 * So a corpus that would not parse was read as empty, and the very next
 * `learn()` wrote a one-engram file over it. Measured before the fix: 5 engrams
 * in, file corrupted, one write later the store contained exactly 1 and none of
 * the originals were recoverable.
 *
 * The `logger.error` on the way past was visible. It did not matter: the RETURN
 * VALUE said "empty", and the caller acted on the return value.
 *
 * The most plausible route in is not exotic. `plur sync` is git-backed, and a
 * merge conflict writes `<<<<<<<` markers straight into engrams.yaml.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Plur, EngramStoreUnreadableError } from '../src/index.js'
import { loadEngrams } from '../src/engrams.js'

describe('unreadable engram store', () => {
  let dir: string
  let path: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-unreadable-'))
    path = join(dir, 'engrams.yaml')
    const plur = new Plur({ path: dir })
    await plur.ready()
    for (let i = 0; i < 5; i++) {
      await plur.learn(`important memory number ${i}`, { scope: 'global' })
    }
  })

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('a truncated file throws rather than reading as empty', () => {
    const good = readFileSync(path, 'utf8')
    writeFileSync(path, good.slice(0, Math.floor(good.length / 2)) + '\n  - {{{ broken')
    expect(() => loadEngrams(path)).toThrow(EngramStoreUnreadableError)
  })

  it('a git merge conflict throws — the most likely route in', () => {
    // `plur sync` is git-backed, so this is what a conflicted engrams.yaml
    // actually looks like on disk.
    const good = readFileSync(path, 'utf8')
    writeFileSync(path, `<<<<<<< HEAD\n${good}=======\n${good}>>>>>>> origin/main\n`)
    expect(() => loadEngrams(path)).toThrow(EngramStoreUnreadableError)
  })

  it('the engrams SURVIVE a write attempt against a corrupted store', async () => {
    // The whole point. Before the fix this wrote a one-engram file over five.
    const good = readFileSync(path, 'utf8')
    writeFileSync(path, good.slice(0, Math.floor(good.length / 2)) + '\n  - {{{ broken')

    const plur = new Plur({ path: dir })
    await expect(plur.learn('a write against a corrupted store', { scope: 'global' })).rejects.toThrow()

    // The corrupted bytes are still there — nothing overwrote them, so the user
    // can fix the conflict or restore from git and keep everything.
    const after = readFileSync(path, 'utf8')
    expect(after, 'the corrupted file was overwritten — the originals are gone').toContain('important memory number')
  })

  it('the error names the likely cause and says what it refused to do', () => {
    writeFileSync(path, '{{{ not yaml')
    try {
      loadEngrams(path)
      throw new Error('should have thrown')
    } catch (err) {
      const msg = (err as Error).message
      // An error a user cannot act on is barely better than a silent failure.
      expect(msg).toMatch(/merge conflict/i)
      expect(msg).toMatch(/NOT being treated as empty/i)
      expect(msg).toContain(path)
    }
  })

  it('a MISSING file is still an empty store, not an error', () => {
    // The distinction the fix rests on: absent really is empty.
    expect(loadEngrams(join(dir, 'does-not-exist.yaml'))).toEqual([])
  })

  // The two cases below used to assert `[]`. Audit #794 (finding F1) measured
  // that contract destroying corpora: neither shape is something PLUR ever
  // writes, both are what a truncated or half-written file looks like, and
  // reporting them as "empty" meant the next write persisted the emptiness.
  // A comment-only store is a hypothetical; a truncated one is a Tuesday.
  it('a comment-only file is unreadable, not empty — PLUR never writes one', () => {
    writeFileSync(path, '# nothing here yet\n')
    expect(() => loadEngrams(path)).toThrow(EngramStoreUnreadableError)
  })

  it('a file with a valid shape but no engrams key is unreadable, not empty', () => {
    writeFileSync(path, 'something_else: true\n')
    expect(() => loadEngrams(path)).toThrow(EngramStoreUnreadableError)
  })

  it('an EXPLICITLY empty store still loads as empty', () => {
    // The shape `initFilesystemStore` writes. This is the one that has to keep
    // working, and it is unambiguous in a way the two above are not.
    writeFileSync(path, 'engrams: []\n')
    expect(loadEngrams(path)).toEqual([])
  })

  it('one malformed ENTRY among many is withheld, not fatal — and not deleted', () => {
    // Partial data is a different problem from an unreadable store: dropping a
    // single bad engram loses less than refusing to load the other four. But it
    // must not be DELETED either — see the quarantine tests in
    // store-corruption-guard.test.ts (audit #794, F2).
    const parsed = readFileSync(path, 'utf8')
    writeFileSync(path, parsed + '  - not_an_engram: true\n')
    const engrams = loadEngrams(path)
    expect(engrams.length).toBe(5)
  })
})
