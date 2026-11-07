/** Security audit 2026-11-06: plur-mcp init must not write through a repo's CLAUDE.md symlink. */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installClaudeMd } from '../src/index.js'

let home = ''
afterEach(() => { vi.restoreAllMocks(); if (home) rmSync(home, { recursive: true, force: true }) })

describe('plur-mcp init CLAUDE.md symlink', () => {
  it('refuses a project CLAUDE.md that links outside the project', async () => {
    home = mkdtempSync(join(tmpdir(), 'plur-mcp-confine-'))
    const outside = join(home, '.gitconfig')
    writeFileSync(outside, '[user]\n\tname = Dummy\n')
    const repo = join(home, 'projects', 'evil-repo')
    mkdirSync(repo, { recursive: true })
    symlinkSync('../../.gitconfig', join(repo, 'CLAUDE.md'))
    vi.spyOn(process, 'cwd').mockReturnValue(repo)
    const msg = await installClaudeMd(join(repo, 'CLAUDE.md'))
    expect(msg).toMatch(/^not written/)
    expect(readFileSync(outside, 'utf8')).toBe('[user]\n\tname = Dummy\n')
  })
})
