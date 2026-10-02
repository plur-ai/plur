import { describe, it, expect } from 'vitest'
import { marked } from 'marked'
import { upsertInstructionSection } from '../src/instruction-section.js'

/**
 * #1520 third re-audit N1: when PLUR appends its section to a file whose
 * last code block is still open, the user's own text must render exactly as
 * before, and the section must render as a heading — never inside a code
 * block, and never adding an empty code block to the user's list. Checked
 * with a real Markdown renderer (marked, CommonMark-style lists and fences).
 */

const MARKER = '<!-- plur-instructions-v4 -->'
const NEW = `## PLUR Memory\n\nNEW BODY\n\n${MARKER}\n`
const opts = { section: NEW, heading: '## PLUR Memory', marker: MARKER, shipped: [] as string[] }
const html = (md: string) => marked.parse(md, { async: false }) as string

function check(input: string) {
  const first = upsertInstructionSection(input, opts)
  const second = upsertInstructionSection(first.content, opts)
  expect(second.content, 'second run changes nothing').toBe(first.content)
  return first
}

describe('appending after an open code block keeps the user text rendering unchanged (#1520 re-audit3 N1)', () => {
  const appended = [
    ['a list item ended by a top-level paragraph', '- item\n  ```\n  code\n\noutside\n'],
    ['a list item followed by the next item', '- item\n  ```\n  code\n- next item\n'],
    ['a fence still open in a list item at the end of the file', '- step one\n  ```bash\n  USER-CMD\n'],
    ['a fence still open in a nested list item', '- a\n  - b\n    ```\n    code\n'],
    ['a fence still open in an ordered list item', '1. one\n   ```sh\n   run\n'],
    ['a top-level fence still open', '# Doc\n\n```md\nEXAMPLE\n'],
    ['a top-level fence indented two spaces, still open', '# Doc\n\n  ```\n  code\n'],
    ['a list item that ended, then a top-level fence still open', '- item\n  ```\n  code\nafter\n\n```\nopen\n'],
    ['an HTML comment in a list item that ended (#1557 review L1)', '- item\n  <!--\n  hidden\n\noutside\n'],
    ['backticks inside a closed <pre> block (#1557 review L7)', '<pre>\n```\ntext\n</pre>\n'],
    ['a fence opened on the list-marker line (#1557 review L7)', '- ```\n  code\n  ```\n'],
  ] as const
  for (const [what, input] of appended) {
    it(what, () => {
      const r = check(input)
      expect(r.status).toBe('added')
      const out = html(r.content)
      expect(out.startsWith(html(input).trimEnd()), `user html changed:\n${html(input)}\n---\n${out}`).toBe(true)
      expect(out).toContain('<h2>PLUR Memory</h2>')
      expect(out).not.toMatch(/<pre><code>\s*<\/code><\/pre>/)
    })
  }

  for (const [what, input] of [
    ['an HTML comment still open in a list item (#1557 review L1)', '- item\n  <!--\n  hidden\n'],
  ] as const) {
    it(what, () => {
      const r = check(input)
      if (r.status === 'skipped') { expect(r.content).toBe(input); return }
      const out = html(r.content)
      expect(out).toContain('<h2>PLUR Memory</h2>')
      expect(out).not.toContain('--&gt;')
      expect(out).not.toMatch(/<p>\s*--&gt;|<p>-->/)
    })
  }

  for (const [what, input] of [
    ['an unclosed <pre> block', '<pre>\n```\nopen pre\n'],
    ['an indented code block that looks like a list with a fence', '    - item\n      ```\n      code\n'],
    ['a tab-indented fence in a list item', '- item\n\t```\n\tcode\n'],
    ['a tab after the marker and a tab-indented fence', '-\titem\n\t```\n\tcode\n'],
    ['spaces then a tab before a fence', '- item\n  \t```\n  \tcode\n'],
  ] as const) {
    it(`cannot tell, so skipped (#1557 review L2, L7): ${what}`, () => {
      const r = check(input)
      expect(r.status).toBe('skipped')
      expect(r.content).toBe(input)
      expect(r.skipReason).toBeTruthy()
    })
  }

  it('when it cannot tell whether a block is still open, it leaves the file alone and says why', () => {
    // A lazy continuation line at column 0 after an indented fence: whether
    // the fence is still open depends on a list item PLUR cannot see.
    const input = '  ```\n  code\nlazy\n'
    const r = check(input)
    expect(r.status).toBe('skipped')
    expect(r.content).toBe(input)
    expect(r.skipReason).toMatch(/code block/)
  })
})
