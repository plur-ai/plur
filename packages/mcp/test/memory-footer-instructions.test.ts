import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { INSTRUCTIONS } from '../src/server.js'
import { installClaudeMd, upsertPlurSection as mcpUpsert } from '../src/index.js'
// @plur-ai/mcp cannot depend on @plur-ai/cli, so the section upsert is
// mirrored. This import is test-only: it pins the mirror to the source.
import { upsertPlurSection as cliUpsert } from '../../cli/src/commands/init.js'

/**
 * The MCP server instructions and the CLAUDE.md section `plur-mcp init`
 * writes carry the memory-footer rule: end every reply with one line naming
 * the engrams recalled, used and written that turn.
 */

const MEMORY_FOOTER_RULE =
  'End every reply with one line listing the PLUR engrams from this turn by id: ' +
  '`Memory — recalled: ENG-…, ENG-… · used: ENG-… · written: ENG-…`, or `Memory — none` when there were none. ' +
  "Recalled = ids returned to you this turn (plur_session_start's injected_ids, " +
  'plur_recall/plur_recall_hybrid/plur_inject results, hook-injected memory blocks). ' +
  'Used = the recalled ids that actually shaped the answer. ' +
  'Written = ids returned by plur_learn this turn. ' +
  'Only list ids you actually saw this turn; never invent an id.'

const VERSION_MARKER = '<!-- plur-instructions-v4 -->'
const count = (h: string, n: string) => h.split(n).length - 1
const headingCount = (md: string) => (md.match(/^## PLUR Memory[ \t]*$/gm) ?? []).length
const legacy = () => readFileSync(join(__dirname, 'fixtures', 'mcp-claude-md-section-pre-v4.md'), 'utf-8')

describe('server INSTRUCTIONS — memory footer rule', () => {
  it('carries the rule verbatim', () => {
    expect(INSTRUCTIONS).toContain(MEMORY_FOOTER_RULE)
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

  it('a fresh file gets the rule and the version marker', () => {
    expect(installClaudeMd(path)).toMatch(/^created/)
    const md = readFileSync(path, 'utf-8')
    expect(md).toContain(MEMORY_FOOTER_RULE)
    expect(md).toContain(VERSION_MARKER)
  })

  it('the previous section is upgraded in place, once, keeping the user content around it', () => {
    writeFileSync(path, '# Mine\n\nFirst.\n\n' + legacy() + '\n## After\n\nAlso mine.\n')
    expect(installClaudeMd(path)).toMatch(/^upgraded/)
    const md = readFileSync(path, 'utf-8')
    expect(count(md, MEMORY_FOOTER_RULE)).toBe(1)
    expect(headingCount(md)).toBe(1)
    expect(md.startsWith('# Mine\n\nFirst.\n\n')).toBe(true)
    expect(md).toContain('## After\n\nAlso mine.')
  })

  it('a current file is left alone', () => {
    installClaudeMd(path)
    const first = readFileSync(path, 'utf-8')
    expect(installClaudeMd(path)).toMatch(/^already/)
    expect(readFileSync(path, 'utf-8')).toBe(first)
  })

  it('the mirrored upsert behaves exactly like the cli source', () => {
    const section = '## PLUR Memory\n\nnew body\n\n' + VERSION_MARKER + '\n'
    const inputs: Array<string | null> = [
      null,
      '',
      '# T\n\nmine\n',
      '# T\n\n' + legacy() + '\n## After\n\nmine\n',
      '# T\n\n## PLUR Memory\n\nold\n\n<!-- plur-instructions-v3 -->\n\ntrailing prose\n',
      '# T\n\n## PLUR Memory Guardrails\n\nnot ours\n',
      '# T\n\n' + section,
    ]
    for (const input of inputs) {
      expect(mcpUpsert(input, section, '# CLAUDE.md')).toEqual(cliUpsert(input, section, '# CLAUDE.md'))
    }
  })
})
