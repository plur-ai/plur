/**
 * The recorded conversation must keep working.
 *
 * `docs/demo/agent-conversation.sh` is how most people meet this feature: they
 * talk to an assistant, and the assistant calls the tools. Every result in it
 * is a real call over stdio to the built server, so the demo breaks the moment
 * the tools change — which is the point, as long as something notices.
 *
 * Nothing notices a demo. So this does.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const SCRIPT = join(__dirname, '..', '..', '..', 'docs', 'demo', 'agent-conversation.sh')
const SERVER = join(__dirname, '..', 'dist', 'index.js')

/** Strip the colours the script writes for readability. */
const ESCAPES = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g')

describe('the recorded agent conversation', () => {
  const output = execFileSync('bash', [SCRIPT], {
    encoding: 'utf8',
    timeout: 240_000,
    env: { ...process.env, PLUR_MCP_SERVER: SERVER },
  }).replace(ESCAPES, '')

  it('runs every exchange to the end', () => {
    expect(output).toContain('deleted on exit')
  })

  it('writes a memory through plur_learn', () => {
    expect(output).toContain('plur_learn')
    expect(output).toMatch(/id: ENG-/)
    expect(output).toContain('decision: ADD')
  })

  it('shows the honest answer for a memory nobody documented', () => {
    expect(output).toContain('Not recorded:')
    expect(output).toContain('who asserted it')
    expect(output).toContain('These are not guesses left blank')
  })

  it('shows a properly recorded memory reaching complete', () => {
    expect(output).toContain('nothing missing: True | complete: True')
    expect(output).toContain('local:priya')
    expect(output).toContain('https://example.org/runbook')
  })

  it('answers the sharing question from machine-readable values', () => {
    // The whole point of the fourth exchange: an assistant should not have to
    // parse prose to answer whether something may be shared.
    expect(output).toContain('may_leave_this_machine     True')
    expect(output).toContain('may_reuse_commercially     True')
    expect(output).toContain('licence_chosen             True')
  })

  it('keeps reuse and sharing apart on a private memory', () => {
    // A private memory under a permissive licence: reuse allowed, sharing not.
    // Conflating these is the mistake the feature exists to prevent.
    expect(output).toContain('may_leave_this_machine     False')
    expect(output).toContain('Nobody chose this licence')
  })

  it('shows a correction, and what the old memory now says', () => {
    expect(output).toContain('SUPERSEDED')
    expect(output).toMatch(/superseded_by: \['ENG-/)
    expect(output).toContain('complete: False')
  })

  it('shows the record is real W3C PROV with an ODRL licence', () => {
    expect(output).toContain('prov, engram, pa, odrl, xsd')
    expect(output).toContain('engram:claimClass')
  })

  it('never touches the real store', () => {
    expect(output).not.toMatch(/\/Users\/[^/]+\/\.plur/)
  })
}, 260_000)
