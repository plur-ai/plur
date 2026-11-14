/**
 * Security audit 2026-11-06: a project CLAUDE.md / AGENTS.md shipped as a
 * symlink out of the repository made the installers append PLUR's section to
 * the link target (e.g. ~/.gitconfig). writeWithBackup now refuses a target
 * outside `confineTo`.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeWithBackup } from '../src/instruction-section.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function layout() {
  const home = mkdtempSync(join(tmpdir(), 'plur-confine-'))
  dirs.push(home)
  const outside = join(home, '.gitconfig')
  writeFileSync(outside, '[user]\n\tname = Dummy\n')
  const repo = join(home, 'projects', 'evil-repo')
  mkdirSync(repo, { recursive: true })
  symlinkSync('../../.gitconfig', join(repo, 'CLAUDE.md'))
  return { home, outside, repo }
}

describe('writeWithBackup confineTo', () => {
  it('refuses a project file that links outside the project and leaves the target untouched', () => {
    const { home, outside, repo } = layout()
    const before = readFileSync(outside, 'utf8')
    expect(() => writeWithBackup(join(repo, 'CLAUDE.md'), before + '\n## PLUR Memory\n', before, { confineTo: repo }))
      .toThrow(/outside .* will not write through it/)
    expect(readFileSync(outside, 'utf8')).toBe(before)
    expect(readdirSync(home).filter(f => f.includes('plur-backup'))).toEqual([])
  })

  it('still writes a regular project file, and a link that stays inside the project', () => {
    const { repo } = layout()
    const real = join(repo, 'docs-CLAUDE.md')
    writeFileSync(real, '# notes\n')
    rmSync(join(repo, 'CLAUDE.md'))
    symlinkSync('docs-CLAUDE.md', join(repo, 'CLAUDE.md'))
    writeWithBackup(join(repo, 'CLAUDE.md'), '# notes\nmore\n', '# notes\n', { confineTo: repo })
    expect(readFileSync(real, 'utf8')).toBe('# notes\nmore\n')
  })

  it('without confineTo keeps following links (dotfiles ~/CLAUDE.md setups)', () => {
    const { outside, repo } = layout()
    const before = readFileSync(outside, 'utf8')
    writeWithBackup(join(repo, 'CLAUDE.md'), before + 'x\n', before)
    expect(readFileSync(outside, 'utf8')).toBe(before + 'x\n')
  })
})
