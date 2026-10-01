import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'

/**
 * The agent instructions `plur init` writes carry the memory-footer rule: end
 * every reply with one line naming the engrams recalled, used and written
 * that turn. And because `plur init` is how an existing install picks up new
 * instructions, re-running it over a file that carries the PREVIOUS section
 * must replace that section in place — one PLUR section, the user's own
 * content before and after it untouched — not append a second copy and not
 * report "already in" while leaving the old text there.
 */

const CLI = builtCliPath(join(__dirname, '..'))
const FIXTURES = join(__dirname, 'fixtures', 'instructions-pre-v4')

/** The rule, verbatim. Every generated target must carry this text. */
const MEMORY_FOOTER_RULE =
  'End every reply with one line listing the PLUR engrams from this turn by id: ' +
  '`Memory — recalled: ENG-…, ENG-… · used: ENG-… · written: ENG-…`, or `Memory — none` when there were none. ' +
  "Recalled = ids returned to you this turn (plur_session_start's injected_ids, " +
  'plur_recall/plur_recall_hybrid/plur_inject results, hook-injected memory blocks). ' +
  'Used = the recalled ids that actually shaped the answer. ' +
  'Written = ids returned by plur_learn this turn. ' +
  'Only list ids you actually saw this turn; never invent an id.'

const VERSION_MARKER = '<!-- plur-instructions-v4 -->'

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1
const headingCount = (md: string) => (md.match(/^## PLUR Memory[ \t]*$/gm) ?? []).length
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf-8')

describe('plur init — memory footer rule in every generated instruction target', () => {
  let home: string
  let project: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plur-footer-home-'))
    project = mkdtempSync(join(tmpdir(), 'plur-footer-project-'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  })

  function run(args: string, cwd: string): string {
    return execSync(`node ${CLI} init --no-desktop --no-codex --no-opencode ${args}`, {
      encoding: 'utf-8',
      timeout: 30000,
      env: isolatedHomeEnv(home),
      cwd,
    })
  }

  describe('CLAUDE.md', () => {
    const claudeMd = () => readFileSync(join(home, 'CLAUDE.md'), 'utf-8')

    it('a fresh install writes the rule and the current version marker', () => {
      run('--global', home)
      const md = claudeMd()
      expect(md).toContain(MEMORY_FOOTER_RULE)
      expect(md).toContain(VERSION_MARKER)
      expect(headingCount(md)).toBe(1)
    })

    it('re-running init over the previous section upgrades it in place, once', () => {
      const before = '# My project\n\nMy own rules come first.\n\n'
      const after = '\n## Deploying\n\nRun make deploy. This is mine and must survive.\n'
      // The section exactly as origin/main wrote it (no version marker), plus
      // a guardrails section whose heading merely STARTS with "## PLUR Memory".
      const guardrails = '\n## PLUR Memory Guardrails\n\nKeep this too.\n'
      writeFileSync(join(home, 'CLAUDE.md'), before + fixture('cli-claude-md-section.md') + after + guardrails)

      const out = run('--global', home)
      expect(out).toMatch(/CLAUDE\.md.*upgraded/)

      const md = claudeMd()
      expect(md).toContain(MEMORY_FOOTER_RULE)
      expect(count(md, MEMORY_FOOTER_RULE)).toBe(1)
      expect(headingCount(md)).toBe(1)
      expect(count(md, 'Do not ask permission to use these tools')).toBe(1)
      expect(md.startsWith(before)).toBe(true)
      expect(md).toContain('Run make deploy. This is mine and must survive.')
      expect(md).toContain('## PLUR Memory Guardrails\n\nKeep this too.')
      // The user's section still follows the PLUR one, in its original order.
      expect(md.indexOf('## PLUR Memory\n')).toBeLessThan(md.indexOf('## Deploying'))
    })

    it('a second run on a current file changes nothing', () => {
      run('--global', home)
      const first = claudeMd()
      const out = run('--global', home)
      expect(out).toMatch(/CLAUDE\.md.*already/)
      expect(claudeMd()).toBe(first)
    })
  })

  describe('AGENTS.md (Codex / Antigravity)', () => {
    const agentsMd = () => readFileSync(join(project, 'AGENTS.md'), 'utf-8')

    it('a fresh install writes the rule and the current version marker', () => {
      run('--antigravity', project)
      const md = agentsMd()
      expect(md).toContain(MEMORY_FOOTER_RULE)
      expect(md).toContain(VERSION_MARKER)
      expect(headingCount(md)).toBe(1)
    })

    it('re-running init over the previous section upgrades it in place, once', () => {
      const before = '# AGENTS.md\n\nProject notes first.\n\n'
      const after = '\n## Testing\n\nRun pnpm test. Mine.\n'
      writeFileSync(join(project, 'AGENTS.md'), before + fixture('cli-agents-md-section.md') + after)

      const out = run('--antigravity', project)
      expect(out).toMatch(/AGENTS\.md.*upgraded/)

      const md = agentsMd()
      expect(count(md, MEMORY_FOOTER_RULE)).toBe(1)
      expect(headingCount(md)).toBe(1)
      expect(md.startsWith(before)).toBe(true)
      expect(md).toContain('## Testing\n\nRun pnpm test. Mine.')
    })

    it('a second run on a current file changes nothing', () => {
      run('--antigravity', project)
      const first = agentsMd()
      run('--antigravity', project)
      expect(agentsMd()).toBe(first)
    })
  })

  describe('Cursor rule (.cursor/rules/plur-memory.mdc)', () => {
    const rulePath = () => join(project, '.cursor', 'rules', 'plur-memory.mdc')

    it('a fresh install writes the rule', () => {
      run('--cursor', project)
      const rule = readFileSync(rulePath(), 'utf-8')
      expect(rule).toContain(MEMORY_FOOTER_RULE)
      expect(rule).toContain(VERSION_MARKER)
      expect(rule).toContain('alwaysApply: true')
    })

    it('re-running init over the previous rule file upgrades it', () => {
      mkdirSync(join(project, '.cursor', 'rules'), { recursive: true })
      writeFileSync(rulePath(), fixture('cli-cursor-rule.mdc'))

      const out = run('--cursor', project)
      expect(out).toMatch(/rule upgraded/)
      const rule = readFileSync(rulePath(), 'utf-8')
      expect(count(rule, MEMORY_FOOTER_RULE)).toBe(1)
      expect(count(rule, 'alwaysApply: true')).toBe(1)
    })

    it('a second run on a current rule file changes nothing', () => {
      run('--cursor', project)
      const first = readFileSync(rulePath(), 'utf-8')
      const out = run('--cursor', project)
      expect(out).toMatch(/rule already present/)
      expect(readFileSync(rulePath(), 'utf-8')).toBe(first)
    })
  })
})

describe('bundled plur-memory skill carries the rule', () => {
  const repo = join(__dirname, '..', '..', '..')
  it.each([
    ['skills/plur-memory/SKILL.md'],
    ['packages/hermes/plur_hermes/skills/plur-memory.SKILL.md'],
  ])('%s', (rel) => {
    expect(readFileSync(join(repo, rel), 'utf-8')).toContain(MEMORY_FOOTER_RULE)
  })
})
