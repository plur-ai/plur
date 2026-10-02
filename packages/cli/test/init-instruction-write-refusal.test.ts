import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, symlinkSync, lstatSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'

/**
 * #1520 third re-audit N2: `plur init` must not replace a CLAUDE.md that is a
 * symlink to a missing file with a regular file. It leaves the link alone,
 * finishes the rest of the install, and says why the section was not written.
 */
const CLI = builtCliPath(join(__dirname, '..'))
vi.setConfig({ testTimeout: 120_000 })

describe('plur init and a CLAUDE.md it must not write', () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'plur-refuse-')) })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('a dangling symlink is left as it is, and init says so', () => {
    const link = join(home, 'CLAUDE.md')
    symlinkSync(join(home, 'notes', 'missing.md'), link)
    const out = execSync('node ' + CLI + ' init --global --no-desktop --no-codex --no-opencode', {
      encoding: 'utf-8', timeout: 60000, env: isolatedHomeEnv(home), cwd: home,
    })
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(existsSync(join(home, 'notes', 'missing.md'))).toBe(false)
    expect(out).toMatch(/CLAUDE\.md.*not written.*missing/i)
    expect(out).toContain('PLUR installed')
  })
})
