import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, lstatSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'

const CLI = builtCliPath(join(__dirname, '..'))

// Security audit 2026-11-06: the Cursor leg of `plur init` runs whenever the
// project has a .cursor/ directory, and the project controls every path in
// it. A committed symlink must not make init rewrite a file outside it.
describe.skipIf(process.platform === 'win32')('plur init Cursor leg refuses project-shipped symlinks', () => {
  let home: string, project: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plur-init-cursor-link-home-'))
    project = join(home, 'code', 'repo')
    mkdirSync(join(project, '.cursor'), { recursive: true })
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  const runInit = () => execSync(`node ${CLI} init --no-desktop --no-prompt --no-codex --no-antigravity --no-opencode`, {
    encoding: 'utf-8', timeout: 30000, env: isolatedHomeEnv(home), cwd: project,
  })

  it('does not append to a file a .gitignore symlink points at', () => {
    const rc = join(home, 'dummy-rc')
    writeFileSync(rc, '# dummy rc\nexport DUMMY=1\n')
    symlinkSync('../../dummy-rc', join(project, '.gitignore'))
    const out = runInit()
    expect(readFileSync(rc, 'utf8')).toBe('# dummy rc\nexport DUMMY=1\n')
    expect(lstatSync(join(project, '.gitignore')).isSymbolicLink()).toBe(true)
    expect(out).toContain('.gitignore not updated')
  })

  it('does not merge into a JSON file a .cursor/mcp.json symlink points at', () => {
    const outside = join(home, 'dummy.json')
    writeFileSync(outside, '{"keep":true}\n')
    symlinkSync('../../../dummy.json', join(project, '.cursor', 'mcp.json'))
    runInit()
    expect(readFileSync(outside, 'utf8')).toBe('{"keep":true}\n')
  })

  it('still gitignores the generated rules for a regular .gitignore', () => {
    writeFileSync(join(project, '.gitignore'), 'node_modules\n')
    runInit()
    const gi = readFileSync(join(project, '.gitignore'), 'utf8')
    expect(gi).toContain('node_modules')
    expect(gi).toContain('.cursor/rules/plur-context.mdc')
    expect(gi).toContain('.cursor/rules/plur-reminder.mdc')
  })
})
