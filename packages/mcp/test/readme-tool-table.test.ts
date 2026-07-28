/**
 * The README's lean-profile table must match the lean profile.
 *
 * The table is the only description most users read before wiring PLUR into an
 * agent, and it had drifted: it announced 11 tools when the profile serves 12,
 * omitted `plur_receipt` entirely, and listed `plur_recall` under "reachable via
 * plur_admin" while `plur_recall` is in the lean set — telling readers to route
 * the single most-used tool through a dispatcher.
 *
 * Nothing could notice, because the table is prose and the profile is code.
 * This test reads both.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { getToolDefinitions } from '../src/tools.js'

const README = join(__dirname, '..', 'README.md')

/** Tool names in the lean table — the rows between the header and the blank line. */
function documentedLeanTools(): string[] {
  const md = readFileSync(README, 'utf8')
  const start = md.indexOf('By default (lean profile)')
  expect(start, 'the lean-profile section is gone — this test needs updating').toBeGreaterThan(-1)
  const section = md.slice(start, md.indexOf('\n\n', md.indexOf('| Tool |', start)))
  return [...section.matchAll(/^\|\s*`(plur_[a-z_]+)`\s*\|/gm)].map(m => m[1])
}

describe('the MCP README documents the real lean profile', () => {
  const lean = getToolDefinitions('lean').map(t => t.name).sort()

  it('lists exactly the tools the lean profile serves', () => {
    expect(documentedLeanTools().sort()).toEqual(lean)
  })

  it('states the right count in the sentence above the table', () => {
    const md = readFileSync(README, 'utf8')
    const m = md.match(/lean profile\), your agent gets (\d+) tools/)
    expect(m, 'the count sentence is gone').not.toBeNull()
    expect(Number(m![1])).toBe(lean.length)
  })

  it('does not describe a lean tool as admin-only', () => {
    // The specific error that shipped: `plur_recall` appeared in both the lean
    // table and the "reachable via plur_admin" list.
    const md = readFileSync(README, 'utf8')
    const line = md.split('\n').find(l => l.includes('reachable via `plur_admin`'))
    expect(line, 'the admin-dispatch sentence is gone').toBeDefined()
    const named = [...line!.matchAll(/`(plur_[a-z_]+)`/g)].map(m => m[1])
    const contradictions = named.filter(n => lean.includes(n) && n !== 'plur_admin')
    expect(contradictions, 'these are IN the lean profile, not admin-only').toEqual([])
  })

  it('states the right total for the full profile', () => {
    const md = readFileSync(README, 'utf8')
    const m = md.match(/expose all (\d+) tools directly/)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBe(getToolDefinitions('full').length)
  })
})
