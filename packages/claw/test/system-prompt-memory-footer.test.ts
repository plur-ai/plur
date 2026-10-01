import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ensureSystemPrompt, PLUR_SYSTEM_SECTION } from '../src/system-prompt.js'

/**
 * The Claw system prompt carries the memory-footer rule (in Claw's tool
 * names), and an existing SYSTEM.md holding the previous section
 * (plur-instructions-v3) is upgraded in place when the plugin loads.
 */

// The rule has no tool names in it, so Claw carries it verbatim.
const CLAW_RULE_PARTS = [
  'End every reply with one short line: ' +
    '`Memory — recalled N · used: ENG-…, ENG-… · written: ENG-…` ' +
    '(recalled as a count; used and written as ids only, no statements), or `Memory — none`. ' +
    'Only count/list ids you actually saw this turn; never invent an id. ' +
    'Give details only if the user asks.',
]

const count = (h: string, n: string) => h.split(n).length - 1
const legacyV3 = () => readFileSync(join(__dirname, 'fixtures', 'claw-system-section-v3.md'), 'utf-8')

describe('Claw system prompt — memory footer rule', () => {
  it('carries every part of the rule', () => {
    for (const part of CLAW_RULE_PARTS) expect(PLUR_SYSTEM_SECTION).toContain(part)
  })

  it('drops the earlier, longer wording', () => {
    expect(PLUR_SYSTEM_SECTION).not.toContain('Recalled = ids returned to you this turn')
  })

  it('bumps the version marker so existing installs upgrade', () => {
    expect(PLUR_SYSTEM_SECTION).toContain('<!-- plur-instructions-v4 -->')
    expect(PLUR_SYSTEM_SECTION).not.toContain('plur-instructions-v3')
  })
})

describe('ensureSystemPrompt upgrades a v3 SYSTEM.md in place', () => {
  let ws: string
  beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'plur-claw-footer-')) })
  afterEach(() => rmSync(ws, { recursive: true, force: true }))

  it('replaces the v3 section once, keeping the user content before and after it', () => {
    const path = join(ws, 'SYSTEM.md')
    writeFileSync(path, '# Agent\n\nBe concise.\n' + legacyV3() + '\n## House rules\n\nNo emojis.\n')

    const r = ensureSystemPrompt(ws)
    expect(r.updated).toBe(true)

    const md = readFileSync(path, 'utf-8')
    expect(count(md, '## PLUR Memory System')).toBe(1)
    expect(count(md, CLAW_RULE_PARTS[0])).toBe(1)
    expect(md).not.toContain('plur-instructions-v3')
    expect(md.startsWith('# Agent\n\nBe concise.\n')).toBe(true)
    expect(md).toContain('## House rules\n\nNo emojis.')
  })

  it('a second load changes nothing', () => {
    writeFileSync(join(ws, 'SYSTEM.md'), '# Agent\n' + legacyV3())
    ensureSystemPrompt(ws)
    const first = readFileSync(join(ws, 'SYSTEM.md'), 'utf-8')
    const r = ensureSystemPrompt(ws)
    expect(r).toMatchObject({ appended: false, updated: false })
    expect(readFileSync(join(ws, 'SYSTEM.md'), 'utf-8')).toBe(first)
  })
})

describe('ensureSystemPrompt never deletes text it did not write (#1520 audit B2, N3, N5)', () => {
  let ws: string
  beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'plur-claw-b2-')) })
  afterEach(() => rmSync(ws, { recursive: true, force: true }))
  const path = () => join(ws, 'SYSTEM.md')
  const load = (input: string) => {
    writeFileSync(path(), input)
    const r = ensureSystemPrompt(ws)
    const out = readFileSync(path(), 'utf-8')
    // A second load is always a no-op.
    expect(ensureSystemPrompt(ws)).toMatchObject({ appended: false, updated: false })
    expect(readFileSync(path(), 'utf-8')).toBe(out)
    return { r, out }
  }

  it('B2: a user heading that starts with "## PLUR Memory System" before the real section survives', () => {
    const { out } = load('# Agent\n## PLUR Memory System Guardrails\nMY POLICY\n' + legacyV3() + '\n## Tail\nKEEP\n')
    expect(out).toContain('## PLUR Memory System Guardrails\nMY POLICY')
    expect(out).toContain('## Tail\nKEEP')
    expect(out).not.toContain('plur-instructions-v3')
    expect(count(out, CLAW_RULE_PARTS[0])).toBe(1)
  })

  it('B2: a "### PLUR Memory System" user heading is not the section and leaves no stray "#"', () => {
    const input = '### PLUR Memory System\nMY NOTES\n'
    const { out } = load(input)
    expect(out.startsWith(input.trimEnd())).toBe(true)
    expect(out).not.toMatch(/^#\n/m)
  })

  it('N5: a marker-less section that is not a shipped text keeps everything after it', () => {
    const input = '## PLUR Memory System\nOLD\n## User policy\nNEVER DELETE\n'
    const { out } = load(input)
    expect(out.startsWith(input.trimEnd())).toBe(true)
    expect(out).toContain(CLAW_RULE_PARTS[0])
  })

  it('N3: "plur-instructions-v4" mentioned in prose does not stop the upgrade', () => {
    const { out } = load('# Agent\nUpgrade to plur-instructions-v4 later.\n' + legacyV3())
    expect(out).toContain(CLAW_RULE_PARTS[0])
    expect(out).toContain('Upgrade to plur-instructions-v4 later.')
    expect(out).not.toContain('plur-instructions-v3')
  })

  it('S1: a fenced older marker inside an edited section does not cut it short', () => {
    const input = '## PLUR Memory System\nOLD\n```md\n<!-- plur-instructions-v1 -->\n```\nOLD REMAINDER\n<!-- plur-instructions-v3 -->\nUSER\n'
    const { out } = load(input)
    expect(out.startsWith(input.trimEnd())).toBe(true)
  })

  it('writes a backup of SYSTEM.md before changing it', () => {
    writeFileSync(path(), '# Agent\n' + legacyV3())
    ensureSystemPrompt(ws)
    const b = readdirSync(ws).filter(f => f.startsWith('SYSTEM.md.plur-backup-'))
    expect(b).toHaveLength(1)
    expect(readFileSync(join(ws, b[0]), 'utf-8')).toBe('# Agent\n' + legacyV3())
  })
})
