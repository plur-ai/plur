/**
 * canonicalize() for paths that do not exist yet (#1319).
 *
 * realpath fails on a missing path, and the old fallback (path.resolve) kept
 * the caller's spelling of every symlinked ancestor — so `/var/…/missing` and
 * `/private/var/…/missing` compared unequal although they name the same
 * location. The deepest existing ancestor is resolved instead, and the missing
 * tail re-appended after normalising `.` and `..`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync, writeFileSync, existsSync } from 'fs'
import { join, sep } from 'path'
import { tmpdir } from 'os'
import { canonicalize, canonicalSpellings } from '../src/project-config.js'

describe('canonicalize', () => {
  let base: string
  let real: string
  let link: string

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'plur-canon-'))
    real = join(base, 'real')
    link = join(base, 'link')
    mkdirSync(join(real, 'present'), { recursive: true })
    symlinkSync(real, link, 'dir')
  })

  afterEach(() => { rmSync(base, { recursive: true, force: true }) })

  it('resolves an existing path through a symlink', () => {
    writeFileSync(join(real, 'present', 'f.yaml'), '')
    expect(canonicalize(join(link, 'present', 'f.yaml'))).toBe(realpathSync(join(real, 'present', 'f.yaml')))
  })

  it('resolves the symlinked ancestor of a missing path and keeps the missing tail', () => {
    const expected = join(realpathSync(real), 'missing', 'deeper', 'engrams.yaml')
    expect(canonicalize(join(link, 'missing', 'deeper', 'engrams.yaml'))).toBe(expected)
    expect(canonicalize(join(real, 'missing', 'deeper', 'engrams.yaml'))).toBe(expected)
  })

  it('normalises . and .. in the missing tail', () => {
    const raw = `${link}${sep}missing${sep}.${sep}gone${sep}..${sep}engrams.yaml`
    expect(canonicalize(raw)).toBe(join(realpathSync(real), 'missing', 'engrams.yaml'))
  })

  it('handles .. that climbs back into an existing directory', () => {
    const raw = `${link}${sep}gone${sep}..${sep}present`
    expect(canonicalize(raw)).toBe(realpathSync(join(real, 'present')))
  })

  it('makes both spellings of a missing file under a symlinked dir equal', () => {
    expect(canonicalize(join(link, 'x', 'engrams.yaml'))).toBe(canonicalize(join(real, 'x', 'engrams.yaml')))
  })
})

/**
 * Letter case on a case-insensitive filesystem (#1357). The JavaScript
 * `realpathSync` keeps the caller's case, so `…/Store` and `…/store` naming
 * the same folder compared unequal. Skipped where the filesystem is
 * case-sensitive (most Linux CI), since there the two are different paths.
 */
describe('canonicalize folds letter case on a case-insensitive filesystem', () => {
  let base: string
  let caseInsensitive: boolean

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'plur-canon-case-')))
    mkdirSync(join(base, 'MixedCase', 'Inner'), { recursive: true })
    caseInsensitive = existsSync(join(base, 'mixedcase'))
  })

  afterEach(() => { rmSync(base, { recursive: true, force: true }) })

  it('returns the on-disk case for an existing path', ({ skip }) => {
    if (!caseInsensitive) skip()
    writeFileSync(join(base, 'MixedCase', 'Inner', 'engrams.yaml'), '')
    const expected = join(base, 'MixedCase', 'Inner', 'engrams.yaml')
    expect(canonicalize(join(base, 'mixedcase', 'INNER', 'engrams.yaml'))).toBe(expected)
    expect(canonicalize(join(base, 'MIXEDCASE', 'inner'))).toBe(join(base, 'MixedCase', 'Inner'))
  })

  it('folds the existing ancestors of a missing path and keeps the missing tail', ({ skip }) => {
    if (!caseInsensitive) skip()
    expect(canonicalize(join(base, 'mixedcase', 'inner', 'missing', 'engrams.yaml')))
      .toBe(join(base, 'MixedCase', 'Inner', 'missing', 'engrams.yaml'))
  })

  it('canonicalSpellings keeps the case-preserving spelling next to the folded one', ({ skip }) => {
    if (!caseInsensitive) skip()
    const variant = join(base, 'mixedcase', 'inner')
    expect(canonicalSpellings(variant).sort()).toEqual([join(base, 'MixedCase', 'Inner'), variant].sort())
  })
})
