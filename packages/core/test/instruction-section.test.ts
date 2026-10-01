import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { upsertInstructionSection, writeWithBackup } from '../src/instruction-section.js'

/**
 * The installers (`plur init`, `plur-mcp init`, the Claw loader) put PLUR's
 * instruction section into a file the user also writes in. The one rule:
 * text PLUR did not write is never removed. An old section is replaced only
 * when it is, whitespace aside, a text PLUR shipped; anything else is left
 * alone and the new section is added beside it.
 *
 * Inputs come from the #1520 audit (B1, S1, N1–N4) and its Codex review.
 */

const HEADING = '## PLUR Memory'
const MARKER = '<!-- plur-instructions-v4 -->'
const OLD = '## PLUR Memory\n\nOld body line one.\n\n### Sub\n\nOld body line two.\n'
const OLD_B = '## PLUR Memory\n\nAn older body.\n'
const NEW = `## PLUR Memory\n\nNEW BODY\n\n${MARKER}\n`
const opts = { section: NEW, heading: HEADING, marker: MARKER, shipped: [OLD, OLD_B], title: '# CLAUDE.md' }
const up = (content: string | null) => upsertInstructionSection(content, opts)
const headings = (s: string) => (s.match(/^## PLUR Memory[ \t]*\r?$/gm) ?? []).length
const count = (s: string, n: string) => s.split(n).length - 1

/** Run twice: the second run must be a no-op whatever the first did. */
function upTwice(input: string) {
  const first = up(input)
  const second = up(first.content)
  expect(second.status).toBe('already')
  expect(second.content).toBe(first.content)
  return first
}

describe('upsertInstructionSection — basic', () => {
  it('creates a file', () => {
    expect(up(null)).toMatchObject({ status: 'created', content: `# CLAUDE.md\n\n${NEW}` })
  })

  it('appends when there is no section', () => {
    const r = upTwice('# Mine\n\nText.\n')
    expect(r.status).toBe('added')
    expect(r.content).toBe(`# Mine\n\nText.\n\n${NEW}`)
  })

  it('replaces a shipped section whose text matches exactly', () => {
    const r = upTwice(`# Mine\n\nBefore.\n\n${OLD}\n## After\n\nKeep.\n`)
    expect(r.status).toBe('upgraded')
    expect(r.content).toBe(`# Mine\n\nBefore.\n\n${NEW}\n## After\n\nKeep.\n`)
    expect(r.keptSections).toBe(0)
  })

  it('a shipped section differing only in whitespace still matches', () => {
    const loose = OLD.replace('Old body line one.', '  Old body line one.   ').replace('\n\n### Sub', '\n\n\n### Sub')
    const r = upTwice(`${loose}`)
    expect(r.status).toBe('upgraded')
    expect(r.content).toBe(NEW)
  })
})

describe('upsertInstructionSection — never deletes user text (B1)', () => {
  it('user prose and a ### subsection after a shipped section at end of file survive', () => {
    const input = `# Mine\n\n${OLD}\nNever deploy without approval.\n\n### Team rules\n\nX\n`
    const r = upTwice(input)
    expect(r.status).toBe('upgraded')
    expect(r.content).toContain('Never deploy without approval.')
    expect(r.content).toContain('### Team rules\n\nX\n')
    expect(count(r.content, 'Old body line')).toBe(0)
    expect(headings(r.content)).toBe(1)
  })

  it('a section the user edited is left exactly as it was; the new one is added beside it', () => {
    const edited = OLD.replace('### Sub', 'My own line inside.\n\n### Sub')
    const input = `# Mine\n\n${edited}\n## After\n\nKeep.\n`
    const r = upTwice(input)
    expect(r.status).toBe('added')
    expect(r.keptSections).toBe(1)
    expect(r.content.startsWith(input.trimEnd())).toBe(true)
    expect(r.content.endsWith(NEW)).toBe(true)
  })

  it('a user-written "## PLUR Memory" section is never replaced', () => {
    const input = '# Mine\n\n## PLUR Memory\n\nWe run plur on staging only.\n\n### Our conventions\n\nKEEP\n'
    const r = upTwice(input)
    expect(r.status).toBe('added')
    expect(r.content).toContain('We run plur on staging only.\n\n### Our conventions\n\nKEEP\n')
  })

  it('indented and tab-separated user headings after a shipped section survive', () => {
    for (const h of ['  ## User policy', '##\tUser policy', '##Notes', 'User Notes\n==========']) {
      const r = upTwice(`${OLD}\n${h}\nNEVER DELETE\n`)
      expect(r.content, h).toContain(`${h}\nNEVER DELETE`)
    }
  })

  it("this repository's own CLAUDE.md keeps every line, including ### Domain convention", () => {
    const repo = readFileSync(join(__dirname, '..', '..', 'cli', 'test', 'fixtures', 'instructions-pre-v4', 'repo-claude-md.md'), 'utf-8')
    const r = upTwice(repo)
    expect(r.status).toBe('added')
    expect(r.keptSections).toBe(1)
    expect(r.content.startsWith(repo.trimEnd())).toBe(true)
    expect(r.content).toContain('### Domain convention')
  })
})

describe('upsertInstructionSection — code fences (S1)', () => {
  it('a "# comment" in a fence after the section is not a boundary, and nothing is lost', () => {
    const input = `${OLD}\nRun:\n\n\`\`\`bash\n# install\nnpm i\n\`\`\`\n`
    const r = upTwice(input)
    expect(r.content).toBe(`${NEW}\nRun:\n\n\`\`\`bash\n# install\nnpm i\n\`\`\`\n`)
  })

  it('a fenced "## PLUR Memory" example is not a section; the real one is still upgraded', () => {
    const input = `# Examples\n\n\`\`\`md\n## PLUR Memory\nEXAMPLE\n\`\`\`\n\nAFTER EXAMPLE\n\n${OLD}`
    const r = upTwice(input)
    expect(r.status).toBe('upgraded')
    expect(r.content).toBe(`# Examples\n\n\`\`\`md\n## PLUR Memory\nEXAMPLE\n\`\`\`\n\nAFTER EXAMPLE\n\n${NEW}`)
  })

  it('a fenced example only: the new section lands outside the fence', () => {
    const input = '# Examples\n\n~~~\n## PLUR Memory\nEXAMPLE\n~~~\n'
    const r = upTwice(input)
    expect(r.status).toBe('added')
    expect(r.content).toBe(`${input}\n${NEW}`)
  })

  it('a marker inside a fence does not count as an installed section', () => {
    const input = `# Doc\n\n\`\`\`\n## PLUR Memory\n${MARKER}\n\`\`\`\n`
    expect(up(input).status).toBe('added')
  })
})

describe('upsertInstructionSection — audit notes N1–N4', () => {
  it('N1: every shipped section is handled, not only the first', () => {
    const input = `${OLD}\n## User\n\nKEEP\n\n${OLD_B}`
    const r = upTwice(input)
    expect(r.status).toBe('upgraded')
    expect(headings(r.content)).toBe(1)
    expect(r.content).toContain('## User\n\nKEEP')
    expect(r.content).not.toContain('An older body.')
  })

  it('N1: a stale shipped copy next to a current section is removed', () => {
    const r = upTwice(`${NEW}\n## User\n\nKEEP\n\n${OLD_B}`)
    expect(r.status).toBe('upgraded')
    expect(r.content).toBe(`${NEW}\n## User\n\nKEEP\n`)
  })

  it('N2: a byte-order mark before the heading is kept and does not cause a second section', () => {
    const r = upTwice(`﻿${OLD}\n## After\n\nKeep.\n`)
    expect(r.status).toBe('upgraded')
    expect(r.content).toBe(`﻿${NEW}\n## After\n\nKeep.\n`)
  })

  it('N3: the current marker quoted inline does not stop the upgrade', () => {
    const input = `${OLD}\nUse \`${MARKER}\` as a delimiter.\n`
    const r = upTwice(input)
    expect(r.status).toBe('upgraded')
    expect(r.content).toContain('NEW BODY')
    expect(r.content).toContain(`Use \`${MARKER}\` as a delimiter.`)
  })

  it('N4: a CRLF file keeps CRLF line endings throughout', () => {
    const input = `# Mine\n\n${OLD}\n## After\n\nKeep.\n`.replace(/\n/g, '\r\n')
    const r = upTwice(input)
    expect(r.status).toBe('upgraded')
    expect(r.content).toBe(`# Mine\n\n${NEW}\n## After\n\nKeep.\n`.replace(/\n/g, '\r\n'))
  })

  it('N4: appending to a CRLF file uses CRLF', () => {
    const r = upTwice('# Mine\r\n\r\nText.\r\n')
    expect(r.content).toBe(`# Mine\n\nText.\n\n${NEW}`.replace(/\n/g, '\r\n'))
  })
})

describe('writeWithBackup', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-backup-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('copies the previous content next to the file before overwriting it', () => {
    const p = join(dir, 'CLAUDE.md')
    writeFileSync(p, 'before')
    const backup = writeWithBackup(p, 'after')
    expect(readFileSync(p, 'utf-8')).toBe('after')
    expect(backup).toMatch(/CLAUDE\.md\.plur-backup-\d{8}T\d{6}Z$/)
    expect(readFileSync(backup!, 'utf-8')).toBe('before')
  })

  it('writes no backup for a new file', () => {
    expect(writeWithBackup(join(dir, 'NEW.md'), 'x')).toBeNull()
    expect(readdirSync(dir)).toEqual(['NEW.md'])
  })
})
