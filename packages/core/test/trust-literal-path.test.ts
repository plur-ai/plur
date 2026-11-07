/** Security audit 2026-11-06: trusting a directory whose path contains * or ? must not trust its siblings. */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { trustDirectory, isDirectoryTrusted } from '../src/trust.js'

describe('trustDirectory records a literal path', () => {
  it('a glob-looking directory name does not cover siblings', () => {
    const base = mkdtempSync(join(tmpdir(), 'plur-trust-literal-'))
    try {
      const root = join(base, 'plurhome'); mkdirSync(root)
      const mine = join(base, 'work', 'proj*'); mkdirSync(mine, { recursive: true })
      const evil = join(base, 'work', 'project-evil'); mkdirSync(evil, { recursive: true })
      trustDirectory(mine, root)
      expect(isDirectoryTrusted(mine, root)).toBe(true)
      expect(isDirectoryTrusted(evil, root)).toBe(false)
    } finally { rmSync(base, { recursive: true, force: true }) }
  })
})
