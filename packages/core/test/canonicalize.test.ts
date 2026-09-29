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
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync, writeFileSync } from 'fs'
import { join, sep } from 'path'
import { tmpdir } from 'os'
import { canonicalize } from '../src/project-config.js'

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
