import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { INSTRUCTIONS } from '../src/server.js'
import { installClaudeMd } from '../src/index.js'

/**
 * The MCP server instructions and the CLAUDE.md section `plur-mcp init`
 * writes carry the memory-footer rule: end every reply with one line naming
 * the engrams recalled, used and written that turn.
 */

const MEMORY_FOOTER_RULE =
  'End every reply with one short line: ' +
  '`Memory — recalled N · used: ENG-…, ENG-… · written: ENG-…` ' +
  '(recalled as a count; used and written as ids only, no statements), or `Memory — none`. ' +
  'Only count/list ids you actually saw this turn; never invent an id. ' +
  'Give details only if the user asks.'

const VERSION_MARKER = '<!-- plur-instructions-v4 -->'
const count = (h: string, n: string) => h.split(n).length - 1
const headingCount = (md: string) => (md.match(/^## PLUR Memory[ \t]*$/gm) ?? []).length
const legacy = () => readFileSync(join(__dirname, 'fixtures', 'mcp-claude-md-section-pre-v4.md'), 'utf-8')

describe('server INSTRUCTIONS — memory footer rule', () => {
  it('carries the rule verbatim', () => {
    expect(INSTRUCTIONS).toContain(MEMORY_FOOTER_RULE)
    expect(INSTRUCTIONS).not.toContain('Recalled = ids returned to you this turn')
  })

  it('places the rule inside the first 2048 characters', () => {
    // Claude Code truncates MCP server instructions at 2048 characters (seen
    // in a live session: the tail arrives as "… [truncated]"). A rule past
    // that point is never read by the agent it is written for.
    const start = INSTRUCTIONS.indexOf(MEMORY_FOOTER_RULE)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(start + MEMORY_FOOTER_RULE.length).toBeLessThanOrEqual(2048)
  })
})

describe('plur-mcp init CLAUDE.md section — memory footer rule', () => {
  let dir: string
  let path: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-mcp-footer-'))
    path = join(dir, 'CLAUDE.md')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('a fresh file gets the rule and the version marker', async () => {
    expect(await installClaudeMd(path)).toMatch(/^created/)
    const md = readFileSync(path, 'utf-8')
    expect(md).toContain(MEMORY_FOOTER_RULE)
    expect(md).toContain(VERSION_MARKER)
  })

  it('the previous section is upgraded in place, once, keeping the user content around it', async () => {
    writeFileSync(path, '# Mine\n\nFirst.\n\n' + legacy() + '\n## After\n\nAlso mine.\n')
    expect(await installClaudeMd(path)).toMatch(/^upgraded/)
    const md = readFileSync(path, 'utf-8')
    expect(count(md, MEMORY_FOOTER_RULE)).toBe(1)
    expect(headingCount(md)).toBe(1)
    expect(md.startsWith('# Mine\n\nFirst.\n\n')).toBe(true)
    expect(md).toContain('## After\n\nAlso mine.')
  })

  it('a current file is left alone', async () => {
    await installClaudeMd(path)
    const first = readFileSync(path, 'utf-8')
    expect(await installClaudeMd(path)).toMatch(/^already/)
    expect(readFileSync(path, 'utf-8')).toBe(first)
  })

  it('user text after the old section at end of file survives, with a backup (#1520 audit B1)', async () => {
    const input = '# Mine\n\n' + legacy() + '\nNever deploy without approval.\n\n### Team rules\n\nX\n'
    writeFileSync(path, input)
    expect(await installClaudeMd(path)).toMatch(/^upgraded in .*backup: .*CLAUDE\.md\.plur-backup-/)
    const md = readFileSync(path, 'utf-8')
    expect(md).toContain('Never deploy without approval.')
    expect(md).toContain('### Team rules\n\nX\n')
    const b = readdirSync(dir).filter(f => f.startsWith('CLAUDE.md.plur-backup-'))
    expect(b).toHaveLength(1)
    expect(readFileSync(join(dir, b[0]), 'utf-8')).toBe(input)
  })

  it('a hand-edited section is left untouched and the status says so', async () => {
    const edited = legacy().replace('### When corrected', 'Our own rule.\n\n### When corrected')
    writeFileSync(path, edited)
    expect(await installClaudeMd(path)).toMatch(/left 1 older "## PLUR Memory" section untouched/)
    expect(readFileSync(path, 'utf-8').startsWith(edited.trimEnd())).toBe(true)
  })

  it('the section it writes is in the shipped list (#1520 re-audit R3)', async () => {
    await installClaudeMd(path)
    const section = readFileSync(path, 'utf-8').replace(/^# CLAUDE\.md\n\n/, '')
    const { isShippedText, SHIPPED_PLUR_SECTIONS } = await import('@plur-ai/core')
    expect(isShippedText(section, SHIPPED_PLUR_SECTIONS)).toBe(true)
  })

  it('has no local copy of the section logic: it uses the one in @plur-ai/core', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf-8')
    expect(src).not.toMatch(/function upsertPlurSection/)
    expect(src).toMatch(/upsertInstructionSection/)
  })
})
