/**
 * Formal-verification apply phase, decision E2 ("reword"), 2026-09-26.
 *
 * Behaviour is unchanged: a team-scope write with no `visibility` still goes to
 * the team store, and only an EXPLICIT `visibility: "private"` keeps it local
 * (core learn()/learnRouted, spec/formal/findings/writepath.md candidate 4).
 * What changes is the description the agent reads: it said the default
 * `private` decides "whether this memory may leave this machine", which the
 * store write path does not honour for the default. These tests pin the words.
 */
import { describe, it, expect } from 'vitest'
import { getToolDefinitions } from '../src/tools.js'

const tool = (name: string) => {
  const t = getToolDefinitions('full').find(d => d.name === name)
  if (!t) throw new Error(`missing tool ${name}`)
  return t
}

describe('plur_learn visibility description says what the write path does (E2)', () => {
  const desc = String((tool('plur_learn').inputSchema as any).properties.visibility.description)

  it('no longer claims the default keeps a memory on this machine', () => {
    expect(desc).not.toMatch(/may leave this machine/i)
  })

  it('says an omitted visibility still reaches the team store, and only an explicit private stays local', () => {
    expect(desc).toMatch(/team store/i)
    expect(desc).toMatch(/explicit/i)
    expect(desc).toMatch(/pack/i)
  })
})

describe('plur_learn_batch says how its items are shared (E2)', () => {
  it('states that items take the default visibility and a team-scope item still goes to the team store', () => {
    const d = tool('plur_learn_batch').description
    expect(d).toMatch(/visibility/i)
    expect(d).toMatch(/team store/i)
  })
})
