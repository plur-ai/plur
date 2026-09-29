/**
 * Formal-verification round 2 (spec/formal/PlurSpec/R2Persist.lean §6,
 * findings/r2-persist.md item 6, core-persistence#12): the save-side shrink
 * guard must not fail open.
 *
 * `countEngramsOnDisk` returned `null` — "nothing to compare against" — for an
 * EXISTING file it could not count (merge-conflict markers, unreadable,
 * zero bytes), and `assertShrinkAllowed` lets every write through on `null`.
 * So a whole-corpus write replaced a store whose size nobody knew: e.g. a
 * `git pull` in ~/.plur that left conflict markers holding both sides' engrams
 * was overwritten by a process's older in-memory corpus. The loader refuses
 * such a file (#766); the guard now refuses to write over it, by the same rule.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { saveEngrams, EngramStoreUnreadableError } from '../src/engrams.js'
import type { Engram } from '../src/schemas/engram.js'

// Conflict markers built at runtime so this file holds none literally (the
// pre-commit safety check refuses committed markers).
const OURS = '<'.repeat(7)
const SEP = '='.repeat(7)
const THEIRS = '>'.repeat(7)

function e(id: string): Engram {
  return {
    id, statement: `s ${id}`, type: 'behavioral', scope: 'global', status: 'active', tags: [],
    activation: { retrieval_strength: 1, storage_strength: 1, frequency: 0, last_accessed: '2026-09-26' },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
  } as unknown as Engram
}

const block = (ids: string[]) => yaml.dump({ engrams: ids.map(e) }).replace(/^engrams:\n/, '')

describe('formal-r2-persist: shrink guard on a store it cannot count', () => {
  let dir: string
  let file: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-r2shrink-')); file = join(dir, 'engrams.yaml') })
  afterEach(() => { try { chmodSync(file, 0o644) } catch { /* gone */ } rmSync(dir, { recursive: true, force: true }) })

  it('refuses to overwrite a merge-conflicted store', () => {
    const conflicted =
      'engrams:\n' + OURS + ' HEAD\n' + block(['ENG-A1', 'ENG-A2', 'ENG-A3']) +
      SEP + '\n' + block(['ENG-B1', 'ENG-B2', 'ENG-B3']) + THEIRS + ' origin/main\n'
    writeFileSync(file, conflicted)
    expect(() => saveEngrams(file, [e('ENG-A1')])).toThrow(EngramStoreUnreadableError)
    expect(readFileSync(file, 'utf8')).toBe(conflicted)
  })

  it('refuses to overwrite a zero-byte store', () => {
    writeFileSync(file, '')
    expect(() => saveEngrams(file, [e('ENG-A1')])).toThrow(EngramStoreUnreadableError)
  })

  it.skipIf(process.getuid?.() === 0)('refuses to overwrite a store it cannot read', () => {
    writeFileSync(file, yaml.dump({ engrams: ['ENG-1', 'ENG-2', 'ENG-3'].map(e) }))
    chmodSync(file, 0o000)
    expect(() => saveEngrams(file, [e('ENG-1')])).toThrow(EngramStoreUnreadableError)
    chmodSync(file, 0o644)
    expect((yaml.load(readFileSync(file, 'utf8')) as any).engrams).toHaveLength(3)
  })

  it('a deliberate shrink still goes through (the caller declared it)', () => {
    writeFileSync(file, 'engrams:\n' + OURS + ' HEAD\n' + block(['ENG-A1']) + SEP + '\n' + THEIRS + ' x\n')
    saveEngrams(file, [e('ENG-A1')], { allowShrink: true })
    expect((yaml.load(readFileSync(file, 'utf8')) as any).engrams).toHaveLength(1)
  })

  it('a missing store is still a first write', () => {
    saveEngrams(file, [e('ENG-1')])
    expect(existsSync(file)).toBe(true)
  })
})
