import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, linkSync, statSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'

/**
 * #1557 review M1: a CLAUDE.md that shares its file with another name (a hard
 * link, e.g. to AGENTS.md) is not rewritten — an in-place write on a full disk
 * would empty every name. `plur init` says why and how to proceed, and
 * finishes the rest of the install.
 */
const CLI = builtCliPath(join(__dirname, '..'))
vi.setConfig({ testTimeout: 120_000 })

describe('plur init and a hard-linked CLAUDE.md', () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'plur-hardlink-')) })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('leaves both names unchanged and says why', () => {
    const claude = join(home, 'CLAUDE.md')
    const other = join(home, 'AGENTS-shared.md')
    writeFileSync(claude, '# Mine\n\nMy rules.\n')
    linkSync(claude, other)
    const out = execSync('node ' + CLI + ' init --global --no-desktop --no-codex --no-opencode', {
      encoding: 'utf-8', timeout: 60000, env: isolatedHomeEnv(home), cwd: home,
    })
    expect(readFileSync(claude, 'utf-8')).toBe('# Mine\n\nMy rules.\n')
    expect(readFileSync(other, 'utf-8')).toBe('# Mine\n\nMy rules.\n')
    expect(statSync(claude).nlink).toBe(2)
    expect(readdirSync(home).filter(f => f.includes('plur-backup'))).toEqual([])
    expect(out).toMatch(/CLAUDE\.md.*not written.*hard link/i)
    expect(out).toContain('PLUR installed')
  })
})
