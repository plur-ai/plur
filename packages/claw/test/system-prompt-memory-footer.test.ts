import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ensureSystemPrompt, PLUR_SYSTEM_SECTION } from '../src/system-prompt.js'

/**
 * The Claw system prompt carries the memory-footer rule (in Claw's tool
 * names), and an existing SYSTEM.md holding the previous section
 * (plur-instructions-v3) is upgraded in place when the plugin loads.
 */

// Claw's adaptation of the rule: same line format and the same three
// definitions, with Claw's tool names and its injected memory block.
const CLAW_RULE_PARTS = [
  'End every reply with one line listing the PLUR engrams from this turn by id: ' +
    '`Memory — recalled: ENG-…, ENG-… · used: ENG-… · written: ENG-…`, or `Memory — none` when there were none.',
  'Recalled = ids returned to you this turn (`plur.recall` results and the injected "Your Memories" block).',
  'Used = the recalled ids that actually shaped the answer.',
  'Written = ids returned by `plur.learn` this turn.',
  'Only list ids you actually saw this turn; never invent an id.',
]

const count = (h: string, n: string) => h.split(n).length - 1
const legacyV3 = () => readFileSync(join(__dirname, 'fixtures', 'claw-system-section-v3.md'), 'utf-8')

describe('Claw system prompt — memory footer rule', () => {
  it('carries every part of the rule', () => {
    for (const part of CLAW_RULE_PARTS) expect(PLUR_SYSTEM_SECTION).toContain(part)
  })

  it('puts the footer after the "I learned" section, so it is the last line', () => {
    expect(PLUR_SYSTEM_SECTION).toMatch(/after any "I learned" section/)
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
