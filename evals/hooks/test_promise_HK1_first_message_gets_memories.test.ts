// HK-1: My agent sees my relevant memories on the first message of every
// session without asking for them.
//
// The installed UserPromptSubmit hook (hook-inject) is run from source as a
// separate process, as Claude Code runs it: payload on stdin, context on
// stdout. Keyword search only (embeddings off), deterministic.
import { afterEach, describe, expect, it } from 'vitest'
import { hookHome, prompt, seed, type HookHome } from '../helpers/agent-tools-hooks-cli.js'

const MEMORY = 'Billing service deploys always use blue-green rollouts'
const UNRELATED = 'The office plants are watered on Thursdays'

describe('HK-1 the first message of a session carries my relevant memories', () => {
  let h: HookHome
  afterEach(() => h?.cleanup())

  it('first message: memories arrive unasked; later messages do not repeat them', () => {
    h = hookHome()
    seed(h, MEMORY)
    seed(h, UNRELATED)

    const first = prompt(h, 'hk1-session-a', 'How do I deploy the billing service?')
    expect(first.status, `the hook failed on the first message: ${first.stderr}`).toBe(0)
    expect(first.context, `the first message got no session-start header; it got: "${first.context}"`)
      .toContain('session started')
    expect(first.context, `the first message did not carry the relevant memory; it got: "${first.context}"`)
      .toContain(MEMORY)

    const second = prompt(h, 'hk1-session-a', 'How do I deploy the billing service to staging?')
    expect(second.status, `the hook failed on the second message: ${second.stderr}`).toBe(0)
    expect(second.context, 'the second message of the same session started the session again')
      .not.toContain('session started')
    expect(second.context, 'the second message of the same session injected the memories again')
      .not.toContain(MEMORY)
  }, 60_000)

  it('every session: a new session gets its own first-message injection', () => {
    h = hookHome()
    seed(h, MEMORY)
    const a = prompt(h, 'hk1-session-b1', 'deploy the billing service')
    expect(a.context, `precondition: the first session got the memory; it got: "${a.context}"`).toContain(MEMORY)

    const b = prompt(h, 'hk1-session-b2', 'deploy the billing service')
    expect(b.status, `the hook failed: ${b.stderr}`).toBe(0)
    expect(b.context, `a second session's first message got no memories; it got: "${b.context}"`).toContain(MEMORY)
  }, 60_000)
})
