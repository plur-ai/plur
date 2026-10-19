// FGT-3: When what I asked to forget matches more than one memory, PLUR refuses and asks, instead of forgetting the wrong one.
//
// Two ways "what I asked to forget" can match more than one memory:
//  1. An id that names a memory in my local store AND a different memory in a
//     team store (ids are minted per store). Driven through Plur.forget against
//     the in-process stub team server.
//  2. Search words that match several memories. Driven through the MCP
//     plur_forget tool, which is where forget-by-words lives.
import { afterEach, describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { StubServer } from '../../packages/core/test/helpers/stub-server.js'
import { getToolDefinitions } from '../../packages/mcp/src/tools.js'
import { tempStore, type TempStore } from '../helpers/store.js'

describe('FGT-3 an ambiguous forget is refused, nothing is forgotten', () => {
  let s: TempStore
  let server: StubServer | undefined
  afterEach(async () => {
    s?.cleanup()
    await server?.stop()
    server = undefined
  })

  it('an id that names one memory locally and another in a team store', async () => {
    server = new StubServer('eval-token')
    const { url, token } = await server.start()
    s = await tempStore({ embedder: 'off' })
    const local = await s.plur.learn('Local note: the build cache lives on the second disk', { scope: 'global' })
    // A different memory on the team server that happens to carry the same id.
    server.seedEngram({ id: local.id, scope: 'group:test', status: 'active', data: { statement: 'Team note: never purge the shared build cache' } })
    writeFileSync(join(s.dir, 'config.yaml'), `backend: yaml\nstores:\n  - url: ${url}\n    token: ${token}\n    scope: "group:test"\n    shared: true\n    readonly: false\n`)
    const { Plur } = await import('../../packages/core/src/index.js')
    const plur = new Plur({ path: s.dir, autoDiscover: false })
    await plur.ready()

    const outcome = await plur.forget(local.id, 'eval: which one?', { force: true })
      .then(() => 'forgot something', (e: Error) => e.message)

    expect(outcome, `expected PLUR to refuse and ask which memory; it answered: ${outcome}`).toMatch(/ambiguous/i)
    expect(outcome, 'the refusal should say how to pick one (by scope)').toMatch(/scope/i)
    const stillLocal = await plur.getById(local.id)
    expect(stillLocal?.status, `the local memory was forgotten although the request was ambiguous (status ${stillLocal?.status})`).toBe('active')
    expect(server.getEngram(local.id)?.status, 'the team memory was forgotten although the request was ambiguous').toBe('active')
    expect(server.deleteCalls, 'no delete should have reached the team server').toBe(0)
  })

  it('search words that match several memories (MCP plur_forget)', async () => {
    s = await tempStore({ embedder: 'off' })
    const one = await s.plur.learn('Archive the quarterly sales report in the finance drive', { scope: 'global' })
    const two = await s.plur.learn('Email the quarterly sales report to the board', { scope: 'global' })
    const tool = getToolDefinitions('full').find(t => t.name === 'plur_forget')
    expect(tool, 'the MCP plur_forget tool must exist').toBeTruthy()

    const reply = await tool!.handler({ search: 'quarterly sales report' }, s.plur as never) as any

    expect(reply?.success, `expected the forget to be refused; got ${JSON.stringify(reply)}`).toBe(false)
    const offered = (reply?.matches ?? []).map((m: { id: string }) => m.id)
    expect(offered, `expected PLUR to ask by listing both matches; it listed ${JSON.stringify(offered)}`)
      .toEqual(expect.arrayContaining([one.id, two.id]))
    for (const e of [one, two]) {
      const now = await s.plur.getById(e.id)
      expect(now?.status, `${e.id} was forgotten although the request matched two memories`).toBe('active')
    }
  })
})
