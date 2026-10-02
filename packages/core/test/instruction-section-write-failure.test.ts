import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, chmodSync, linkSync, symlinkSync, lstatSync, existsSync, constants } from 'fs'
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
const fail = vi.hoisted(() => ({
  mode: 'off' as 'off' | 'partial-write' | 'rename' | 'edit-before-rename',
  copies: [] as Array<{ dest: string; mode: number | undefined }>,
  events: [] as string[],
  target: '',
}))
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
      fail.events.push(`rename ${String(a).split('/').pop()}`)
      return real.renameSync(a, b)
    },
    copyFileSync: (src: any, dest: any, mode?: number) => {
      fail.copies.push({ dest: String(dest), mode })
      return (real.copyFileSync as any)(src, dest, mode)
    },
    fsyncSync: (fd: number) => {
      // Simulates the user saving the file after PLUR wrote its temp file and
      // before it swaps it in.
      if (fail.mode === 'edit-before-rename' && fail.target) {
        real.writeFileSync(fail.target, 'THE USER SAVED THIS JUST NOW\n')
        fail.target = ''
      }
      fail.events.push('fsync')
      return real.fsyncSync(fd)
    },
  }
})

import { writeWithBackup } from '../src/instruction-section.js'

describe('writeWithBackup keeps the original when the write fails partway (#1520 re-audit H1)', () => {
  let dir: string
  const ORIGINAL = '# Mine\n\n' + 'user text\n'.repeat(500)
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-h1-')); fail.mode = 'off'; fail.copies = []; fail.events = [] })
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

describe('writeWithBackup keeps what the file is (#1520 third re-audit N2)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-n2-')); fail.mode = 'off'; fail.copies = []; fail.events = [] })
  afterEach(() => { fail.mode = 'off'; rmSync(dir, { recursive: true, force: true }) })

  it('a hard-linked file keeps its links: both names see the new text', () => {
    const a = join(dir, 'CLAUDE.md')
    const b = join(dir, 'AGENTS.md')
    writeFileSync(a, 'original\n')
    linkSync(a, b)
    const backup = writeWithBackup(a, 'new\n', 'original\n')
    expect(readFileSync(b, 'utf-8')).toBe('new\n')
    expect(statSync(a).nlink).toBe(2)
    expect(readFileSync(backup!, 'utf-8')).toBe('original\n')
  })

  it('a dangling symlink is refused, not replaced by a regular file', () => {
    const link = join(dir, 'CLAUDE.md')
    symlinkSync(join(dir, 'missing.md'), link)
    expect(() => writeWithBackup(link, 'new\n', null)).toThrow(/missing|dangling|symlink/i)
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(existsSync(join(dir, 'missing.md'))).toBe(false)
  })

  it('the backup is created exclusively, so two writers can never share one', () => {
    const p = join(dir, 'CLAUDE.md')
    writeFileSync(p, 'original\n')
    writeWithBackup(p, 'new\n', 'original\n')
    const backupCopy = fail.copies.find(c => c.dest.includes('plur-backup'))
    expect(backupCopy, 'backup made with copyFileSync').toBeDefined()
    expect((backupCopy!.mode ?? 0) & constants.COPYFILE_EXCL).toBe(constants.COPYFILE_EXCL)
  })

  it('the new content is flushed to disk before it replaces the file', () => {
    const p = join(dir, 'CLAUDE.md')
    writeFileSync(p, 'original\n')
    writeWithBackup(p, 'new\n', 'original\n')
    const rename = fail.events.findIndex(e => e.startsWith('rename'))
    expect(rename).toBeGreaterThan(0)
    expect(fail.events.slice(0, rename)).toContain('fsync')
  })

  it('an edit saved while PLUR was writing is kept: the write is abandoned', () => {
    const p = join(dir, 'CLAUDE.md')
    writeFileSync(p, 'original\n')
    fail.mode = 'edit-before-rename'
    fail.target = p
    expect(() => writeWithBackup(p, 'new\n', 'original\n')).toThrow(/changed/i)
    fail.mode = 'off'
    expect(readFileSync(p, 'utf-8')).toBe('THE USER SAVED THIS JUST NOW\n')
    expect(readdirSync(dir).filter(f => f.includes('plur-tmp'))).toEqual([])
  })

  it('a file that changed since the caller read it is not written at all', () => {
    const p = join(dir, 'CLAUDE.md')
    writeFileSync(p, 'edited after the read\n')
    expect(() => writeWithBackup(p, 'new\n', 'what the caller read\n')).toThrow(/changed/i)
    expect(readFileSync(p, 'utf-8')).toBe('edited after the read\n')
    expect(readdirSync(dir)).toEqual(['CLAUDE.md'])
  })
})
