// HK-2: When I correct my agent ("no, …", "from now on …"), it is reminded to
// save the correction, every time.
//
// The installed UserPromptSubmit hook (hook-inject) is run from source as a
// separate process, as Claude Code runs it. The reminder is the hook's
// "CORRECTION SIGNAL DETECTED" block telling the agent to call plur_learn.
//
// The normal path and the two paths reported broken in issue 1385 (the
// session's inject lock is busy; the session reached its injection attempt
// cap) are separate tests, so a red one says which path drops the reminder.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hookHome, prompt, type HookHome } from '../helpers/agent-tools-hooks-cli.js'

function reminded(context: string): boolean {
  return context.includes('CORRECTION SIGNAL DETECTED') && context.includes('plur_learn')
}

describe('HK-2 a correction gets the save reminder every time', () => {
  let h: HookHome
  afterEach(() => h?.cleanup())

  it('normal session: the first message and every later correction are reminded', () => {
    h = hookHome()
    const first = prompt(h, 'hk2-normal', 'No, from now on always run the tests before committing.')
    expect(first.status, `the hook failed: ${first.stderr}`).toBe(0)
    expect(first.context, 'precondition: the first message started the session').toContain('session started')
    expect(reminded(first.context), `a correction in the first message got no save reminder; it got: "${first.context}"`).toBe(true)

    const corrections = [
      'No, use pnpm, not npm.',
      'From now on put the changelog entry in the same commit.',
      'No, that is wrong: the staging database is read-only.',
    ]
    for (const text of corrections) {
      const later = prompt(h, 'hk2-normal', text)
      expect(later.status, `the hook failed: ${later.stderr}`).toBe(0)
      expect(reminded(later.context), `the correction "${text}" got no save reminder; it got: "${later.context}"`).toBe(true)
    }

    const plain = prompt(h, 'hk2-normal', 'show me the diff')
    expect(reminded(plain.context), 'precondition: a message that is not a correction is not flagged as one').toBe(false)
  }, 90_000)

  it('a correction while another prompt of the session holds the inject lock is still reminded', () => {
    h = hookHome()
    // Calibrate where the session's state lives: a normal first message
    // writes its marker there.
    prompt(h, 'hk2-probe', 'hello')
    expect(existsSync(join(h.sessions, 'hk2-probe.marker')),
      `precondition: session state is kept in ${h.sessions}`).toBe(true)

    // A first-message injection of this session is still running (two prompts
    // sent in quick succession): its lock is fresh.
    mkdirSync(h.sessions, { recursive: true })
    writeFileSync(join(h.sessions, 'hk2-busy.injecting'), `${process.pid}-eval`)
    const r = prompt(h, 'hk2-busy', 'No, from now on always run the tests before committing.')
    expect(r.status, `the hook failed: ${r.stderr}`).toBe(0)
    expect(reminded(r.context),
      `the correction was dropped because the session's inject lock was busy; the agent got: "${r.context}"`).toBe(true)
  }, 60_000)

  it('a correction after the session hit its injection attempt cap is still reminded', () => {
    h = hookHome()
    prompt(h, 'hk2-probe', 'hello')
    expect(existsSync(join(h.sessions, 'hk2-probe.marker')),
      `precondition: session state is kept in ${h.sessions}`).toBe(true)

    // Two earlier first-message injections of this session did not finish
    // (the store was too slow for the hook timeout).
    writeFileSync(join(h.sessions, 'hk2-capped.attempts'), '2')
    const r = prompt(h, 'hk2-capped', 'No, from now on always run the tests before committing.')
    expect(r.status, `the hook failed: ${r.stderr}`).toBe(0)
    expect(r.context, 'precondition: the hook took the attempt-cap path').toContain('automatic injection skipped')
    expect(reminded(r.context),
      `the correction was dropped because the session hit its attempt cap; the agent got: "${r.context}"`).toBe(true)
  }, 60_000)
})
