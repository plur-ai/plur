import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, chmodSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * #1520 second re-audit H1: a write that fails partway (ENOSPC, EIO, a
 * dropped network filesystem) must never leave the user without their
 * original text. Before: writeFileSync truncated the target, failed, and the
 * cleanup then deleted the backup — an empty CLAUDE.md and no copy.
 *
 * `fail.mode` makes the next writeFileSync behave like a disk that fills up
 * after the file was opened: it writes the first few bytes, then throws.
 */
const fail = vi.hoisted(() => ({ mode: 'off' as 'off' | 'partial-write' | 'rename' }))
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  const enospc = () => Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
  return {
    ...real,
    writeFileSync: (p: any, data: any, ...rest: any[]) => {
      if (fail.mode === 'partial-write') {
        real.writeFileSync(p, String(data).slice(0, 5))
        throw enospc()
      }
      return (real.writeFileSync as any)(p, data, ...rest)
    },
    renameSync: (a: any, b: any) => {
      if (fail.mode === 'rename') throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' })
      return real.renameSync(a, b)
    },
  }
})

import { writeWithBackup } from '../src/instruction-section.js'

describe('writeWithBackup keeps the original when the write fails partway (#1520 re-audit H1)', () => {
  let dir: string
  const ORIGINAL = '# Mine\n\n' + 'user text\n'.repeat(500)
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-h1-')); fail.mode = 'off' })
  afterEach(() => { fail.mode = 'off'; rmSync(dir, { recursive: true, force: true }) })

  const recoverable = (p: string) => {
    const copies = [p, ...readdirSync(dir).filter(f => f.includes('plur-backup')).map(f => join(dir, f))]
    return copies.some(c => readFileSync(c, 'utf-8') === ORIGINAL)
  }

  it('a failure after the file was opened leaves the target untouched', () => {
    const p = join(dir, 'CLAUDE.md')
    writeFileSync(p, ORIGINAL)
    fail.mode = 'partial-write'
    expect(() => writeWithBackup(p, ORIGINAL + '\n## PLUR Memory\n\nnew\n')).toThrow(/ENOSPC/)
    fail.mode = 'off'
    expect(readFileSync(p, 'utf-8')).toBe(ORIGINAL)
    expect(recoverable(p)).toBe(true)
    // No temporary file is left beside it.
    expect(readdirSync(dir).filter(f => !f.startsWith('CLAUDE.md'))).toEqual([])
  })

  it('a failure while swapping the new file in leaves the target untouched and no temp file', () => {
    const p = join(dir, 'CLAUDE.md')
    writeFileSync(p, ORIGINAL)
    fail.mode = 'rename'
    expect(() => writeWithBackup(p, 'new content')).toThrow(/EIO/)
    fail.mode = 'off'
    expect(readFileSync(p, 'utf-8')).toBe(ORIGINAL)
    expect(readdirSync(dir).filter(f => !f.startsWith('CLAUDE.md'))).toEqual([])
  })

  it('a successful write keeps the file mode and leaves a backup of the original', () => {
    const p = join(dir, 'CLAUDE.md')
    writeFileSync(p, ORIGINAL)
    chmodSync(p, 0o640)
    const backup = writeWithBackup(p, 'new content')
    expect(readFileSync(p, 'utf-8')).toBe('new content')
    expect(statSync(p).mode & 0o777).toBe(0o640)
    expect(readFileSync(backup!, 'utf-8')).toBe(ORIGINAL)
  })
})
