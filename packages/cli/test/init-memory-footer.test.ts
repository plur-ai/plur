import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'
// The MCP installer writes the same file through the same core function; the
// equivalence block below pins that both treat user text identically.
import { installClaudeMd as mcpInstallClaudeMd } from '../../mcp/src/index.js'

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

// Every test here spawns `plur init` one or more times (the equivalence test
// ten times); under load a single spawn takes seconds, so the 5s default is
// too tight for a correct run.
vi.setConfig({ testTimeout: 180_000 })
const FIXTURES = join(__dirname, 'fixtures', 'instructions-pre-v4')

/** The rule, verbatim. Every generated target must carry this text. */
const MEMORY_FOOTER_RULE =
  'End every reply with one short line: ' +
  '`Memory — recalled N · used: ENG-…, ENG-… · written: ENG-…` ' +
  '(recalled as a count; used and written as ids only, no statements), or `Memory — none`. ' +
  'Only count/list ids you actually saw this turn; never invent an id. ' +
  'Give details only if the user asks.'

const VERSION_MARKER = '<!-- plur-instructions-v4 -->'

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1
const headingCount = (md: string) => (md.match(/^## PLUR Memory[ \t]*$/gm) ?? []).length
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf-8')
const backups = (dir: string, name: string) => readdirSync(dir).filter(f => f.startsWith(`${name}.plur-backup-`))

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

describe('plur init — never deletes text it did not write (#1520 audit B1, S2)', () => {
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
  const run = (args: string, cwd: string) => execSync(`node ${CLI} init --no-desktop --no-codex --no-opencode ${args}`, {
    encoding: 'utf-8', timeout: 30000, env: isolatedHomeEnv(home), cwd,
  })

  it('user text after a shipped section at end of file survives, and a backup is written', () => {
    const input = '# Mine\n\n' + fixture('cli-claude-md-section.md') + '\nNever deploy without approval.\n\n### Team rules\n\nX\n'
    writeFileSync(join(home, 'CLAUDE.md'), input)
    const out = run('--global', home)
    const md = readFileSync(join(home, 'CLAUDE.md'), 'utf-8')
    expect(md).toContain('Never deploy without approval.')
    expect(md).toContain('### Team rules\n\nX\n')
    expect(md).toContain(MEMORY_FOOTER_RULE)
    expect(headingCount(md)).toBe(1)
    const b = backups(home, 'CLAUDE.md')
    expect(b).toHaveLength(1)
    expect(readFileSync(join(home, b[0]), 'utf-8')).toBe(input)
    expect(out).toMatch(/CLAUDE\.md.*backup/)
  })

  it("this repository's own CLAUDE.md loses nothing: its hand-written section stays, the new one is added, and init says so", () => {
    const repo = fixture('repo-claude-md.md')
    writeFileSync(join(home, 'CLAUDE.md'), repo)
    const out = run('--global', home)
    const md = readFileSync(join(home, 'CLAUDE.md'), 'utf-8')
    expect(md.startsWith(repo.trimEnd())).toBe(true)
    expect(md).toContain('### Domain convention')
    expect(md).toContain(MEMORY_FOOTER_RULE)
    expect(out).toMatch(/left 1 older "## PLUR Memory" section untouched/)
    // And a second run does not add a third section.
    run('--global', home)
    expect(headingCount(readFileSync(join(home, 'CLAUDE.md'), 'utf-8'))).toBe(2)
  })

  it('a user-edited AGENTS.md section is kept as it was', () => {
    const edited = fixture('cli-agents-md-section.md').replace('### Session Workflow', 'Our own note.\n\n### Session Workflow')
    writeFileSync(join(project, 'AGENTS.md'), '# AGENTS.md\n\n' + edited)
    run('--antigravity', project)
    const md = readFileSync(join(project, 'AGENTS.md'), 'utf-8')
    expect(md.startsWith('# AGENTS.md\n\n' + edited.trimEnd())).toBe(true)
    expect(md).toContain(MEMORY_FOOTER_RULE)
  })

  it('a user-edited Cursor rule is left alone and backed up, with a notice', () => {
    const rulePath = join(project, '.cursor', 'rules', 'plur-memory.mdc')
    mkdirSync(join(project, '.cursor', 'rules'), { recursive: true })
    const mine = '---\ndescription: My rules\nalwaysApply: false\n---\nNever upload credentials.\n'
    writeFileSync(rulePath, mine)
    const out = run('--cursor', project)
    expect(readFileSync(rulePath, 'utf-8')).toBe(mine)
    const b = backups(join(project, '.cursor', 'rules'), 'plur-memory.mdc')
    expect(b).toHaveLength(1)
    expect(out).toMatch(/rule kept as you edited it/)
  })

  it('an unedited shipped Cursor rule is replaced and backed up', () => {
    const rulePath = join(project, '.cursor', 'rules', 'plur-memory.mdc')
    mkdirSync(join(project, '.cursor', 'rules'), { recursive: true })
    writeFileSync(rulePath, fixture('cli-cursor-rule.mdc'))
    run('--cursor', project)
    expect(readFileSync(rulePath, 'utf-8')).toContain(MEMORY_FOOTER_RULE)
    expect(backups(join(project, '.cursor', 'rules'), 'plur-memory.mdc')).toHaveLength(1)
  })
})

describe('plur init and plur-mcp init treat user text identically', () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'plur-footer-eq-')) })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  const cliRun = (input: string) => {
    writeFileSync(join(home, 'CLAUDE.md'), input)
    execSync(`node ${CLI} init --global --no-desktop --no-codex --no-opencode`, {
      encoding: 'utf-8', timeout: 30000, env: isolatedHomeEnv(home), cwd: home,
    })
    return readFileSync(join(home, 'CLAUDE.md'), 'utf-8')
  }
  const mcpRun = async (input: string) => {
    const p = join(home, 'MCP-CLAUDE.md')
    writeFileSync(p, input)
    await mcpInstallClaudeMd(p)
    return readFileSync(p, 'utf-8')
  }
  // Each package writes its own section text; replace it with a placeholder
  // so what is compared is the treatment of everything else in the file.
  const placeholder = (out: string, section: string) => out.replace(/\r\n/g, '\n').replace(section, '<PLUR SECTION>\n')
  const sectionOf = (fresh: string) => fresh.replace(/^# CLAUDE\.md\n\n/, '')

  it('on the audit inputs', async () => {
    execSync(`node ${CLI} init --global --no-desktop --no-codex --no-opencode`, {
      encoding: 'utf-8', timeout: 30000, env: isolatedHomeEnv(home), cwd: home,
    })
    const CLI_SECTION = sectionOf(readFileSync(join(home, 'CLAUDE.md'), 'utf-8'))
    const freshMcpPath = join(home, 'FRESH.md')
    await mcpInstallClaudeMd(freshMcpPath)
    const MCP_SECTION = sectionOf(readFileSync(freshMcpPath, 'utf-8'))
    const OLD = fixture('cli-claude-md-section.md')
    const inputs = [
      `# Mine\n\n${OLD}\nNever deploy without approval.\n\n### Team rules\n\nX\n`,
      fixture('repo-claude-md.md'),
      `${OLD}\nRun:\n\n\`\`\`bash\n# install\nnpm i\n\`\`\`\n`,
      '# Examples\n\n```md\n## PLUR Memory\nEXAMPLE\n```\n\nAFTER\n',
      `﻿${OLD}\n## After\n\nKeep.\n`,
      `# Mine\n\n${OLD}\n## After\n\nKeep.\n`.replace(/\n/g, '\r\n'),
      `${OLD}\n## User\n\nKEEP\n\n${OLD}`,
      OLD.replace('### Session Workflow', 'Mine.\n\n### Session Workflow'),
      `${OLD}\nUse \`<!-- plur-instructions-v4 -->\` as a delimiter.\n`,
    ]
    for (const input of inputs) {
      expect(placeholder(cliRun(input), CLI_SECTION), JSON.stringify(input.slice(0, 60)))
        .toBe(placeholder(await mcpRun(input), MCP_SECTION))
    }
  })
})

describe('bundled plur-memory skill carries the rule', () => {
  const repo = join(__dirname, '..', '..', '..')
  it.each([
    ['skills/plur-memory/SKILL.md'],
    ['packages/hermes/plur_hermes/skills/plur-memory.SKILL.md'],
  ])('%s', (rel) => {
    const text = readFileSync(join(repo, rel), 'utf-8')
    expect(text).toContain(MEMORY_FOOTER_RULE)
    expect(text).not.toContain('Recalled = ids returned to you this turn')
  })
})
