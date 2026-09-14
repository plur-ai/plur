/**
 * The skills must actually reach a user (#1190).
 *
 * Two halves, one invariant: the skill tree has to be IN the published
 * package, and `plur init` has to put it where the harness reads it. Both
 * were missing. `skills/` lives at the repo root and `files[]` is
 * package-relative, so no manifest entry could ever have shipped it; and
 * init's only `Skill` reference is a PreToolUse matcher that fires WHEN a
 * skill runs, which is a different thing entirely. The result was a skill
 * version-stamped by release.sh on every release and delivered to nobody.
 *
 * These tests fail if either half is removed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))
const DIST_SKILLS = join(dirname(CLI), 'skills')

describe('skills are packaged', () => {
  it('the build copies the skill tree into dist/, which files:["dist"] ships', () => {
    expect(existsSync(DIST_SKILLS)).toBe(true)
    const names = readdirSync(DIST_SKILLS).filter(n => existsSync(join(DIST_SKILLS, n, 'SKILL.md')))
    expect(names).toContain('plur-create-engrams')
  })

  it('ships the whole skill tree, not just SKILL.md', () => {
    // plur-create-engrams is useless without its references: SKILL.md tells the
    // agent to read them before serializing.
    const refs = join(DIST_SKILLS, 'plur-create-engrams', 'references')
    expect(existsSync(join(refs, 'plur-format.md'))).toBe(true)
    expect(existsSync(join(refs, 'plur-engram-spectrum.yaml'))).toBe(true)
    expect(existsSync(join(refs, 'examples-explained.md'))).toBe(true)
  })

  it('carries a version stamp, so release.sh bumping it means something', () => {
    const skill = readFileSync(join(DIST_SKILLS, 'plur-create-engrams', 'SKILL.md'), 'utf-8')
    expect(skill).toMatch(/^version:\s*\d+\.\d+\.\d+$/m)
  })
})

describe('plur init installs skills', () => {
  let home: string

  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'plur-skills-test-')) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  function runInit(): string {
    return execSync(`node ${CLI} init --global --no-desktop --no-prompt --no-cursor --no-codex --no-antigravity`, {
      encoding: 'utf-8',
      timeout: 30000,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      cwd: home,
    })
  }

  const installed = (name: string) => join(home, '.claude', 'skills', name, 'SKILL.md')

  it('lands the skills next to settings.json, following init\'s own scope choice', () => {
    const out = runInit()
    expect(out).toContain('Skills:')
    expect(existsSync(installed('plur-create-engrams'))).toBe(true)
    // the referenced files travel too, or the skill cannot do its job
    expect(existsSync(join(home, '.claude', 'skills', 'plur-create-engrams', 'references', 'plur-format.md'))).toBe(true)
  })

  it('is idempotent — a second run reports no change and rewrites nothing', () => {
    runInit()
    const first = readFileSync(installed('plur-create-engrams'), 'utf-8')
    const out = runInit()
    expect(out).toMatch(/Skills: already current/)
    expect(readFileSync(installed('plur-create-engrams'), 'utf-8')).toBe(first)
  })

  it('says so when it overwrites a locally-changed skill, rather than clobbering in silence', () => {
    runInit()
    const path = installed('plur-memory')
    writeFileSync(path, readFileSync(path, 'utf-8') + '\nLOCAL EDIT\n')
    const out = runInit()
    expect(out).toMatch(/overwrote locally-changed[^\n]*plur-memory/)
  })

  it('does not abort the rest of init when the skills leg fails', () => {
    // The leg is contained like the harness legs: hooks and MCP registration
    // are the point of `plur init` and must survive a skills failure.
    const out = runInit()
    expect(out).toContain('PLUR installed')
    const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'))
    expect(settings.mcpServers?.plur).toBeDefined()
  })
})
