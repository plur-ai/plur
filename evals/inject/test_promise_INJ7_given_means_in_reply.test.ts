// INJ-7: A memory reported as given to my agent is in the actual tool or hook
// reply, with its text and where it came from.
//
// What the agent receives is what crosses the wire: the MCP tool reply
// (plur_inject, plur_inject_hybrid) over the in-memory client transport, and
// the context the installed UserPromptSubmit hook prints. A count or an id
// list is not delivery. For every id a reply reports as given, the reply
// itself must carry that memory's statement and its origin (the scope it was
// saved in), on that memory's own entry.
//
// The set always includes a pinned rule that says what NOT to do: such a rule
// goes to the "constraints" section, the section audit B-01 found the MCP
// replies drop (packages/mcp/src/tools.ts, both inject handlers).
//
// Entry boundaries follow the renderer's documented contract: one entry per
// line starting "[ID]", continuation lines indented.
//
// Extended after the independent re-audit (2026-10-18, B-01 partly closed):
//  * a memory longer than 60 characters that lands in the "also consider"
//    section (a terminological memory is routed there) must arrive with its
//    FULL text, on every surface — the short form may not stand in for it;
//  * the session-start tool reply (plur_session_start) is a delivery surface
//    too: every memory it reports as given must be in its reply text, with its
//    full text and origin.
// The original cases keep their short statements and are unchanged.
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Plur } from '../../packages/core/src/index.js'
import { useEmbedder } from '../helpers/store.js'
import { mcpSession, type McpSession } from '../helpers/agent-tools-hooks-mcp.js'
import { hookHome, prompt, runSource, type HookHome } from '../helpers/agent-tools-hooks-cli.js'

const TASK = 'deploy the billing service'
const RULE = 'Never deploy billing on Fridays without a rollback plan'
const MATCHING = [
  'Deploy billing with blue-green rollouts and a smoke test',
  'Deploy billing only after the staging migration ran',
]
/** Over 60 characters, and terminological, so it is routed to "also consider". */
const LONG_CONSIDER = 'Billing deploy glossary: a cutover is the moment billing service traffic moves from the old deployment to the new one'

/** Every string the reply carries, except the bare id lists (they prove nothing). */
function deliveredText(reply: unknown): string {
  const out: string[] = []
  const walk = (v: unknown, key?: string): void => {
    if (key === 'injected_ids' || key === 'omitted_pinned') return
    if (typeof v === 'string') out.push(v)
    else if (Array.isArray(v)) v.forEach(x => walk(x))
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k)
  }
  walk(reply)
  return out.join('\n')
}

/** The entry for `id` in delivered text: its "[id]" line plus indented continuation lines. '' when absent. */
function entryFor(text: string, id: string): string {
  const lines = text.split('\n')
  const start = lines.findIndex(l => l.includes(`[${id}]`))
  if (start < 0) return ''
  const block = [lines[start]]
  for (let i = start + 1; i < lines.length && /^\s+\S/.test(lines[i]) && !/^\s*\[/.test(lines[i]); i++) block.push(lines[i])
  return block.join('\n')
}

/** Check one reply: every reported id has its statement and its scope on its own entry. */
function checkDelivered(where: string, text: string, reported: string[], memories: Map<string, { statement: string; scope: string }>): void {
  const problems: string[] = []
  for (const id of reported) {
    const m = memories.get(id)
    if (!m) { problems.push(`${id}: reported as given, but it is not one of the memories this eval saved`); continue }
    const entry = entryFor(text, id)
    if (!entry) { problems.push(`${id} ("${m.statement}"): reported as given, but the reply has no entry for it at all`); continue }
    if (!entry.includes(m.statement)) problems.push(`${id}: its entry does not carry its text "${m.statement}"; the entry is "${entry}"`)
    // The statement is removed first so a scope word inside the text cannot count as the origin.
    if (!entry.replace(m.statement, '').includes(m.scope)) {
      problems.push(`${id}: its entry does not say where it came from (scope "${m.scope}"); the entry is "${entry}"`)
    }
  }
  expect(problems, `${where}: memories reported as given are not really in the reply the agent receives:\n  ${problems.join('\n  ')}\nFull reply text:\n${text}`)
    .toEqual([])
}

describe('INJ-7 what PLUR reports as given is in the reply, with its text and origin', () => {
  let s: McpSession | undefined
  let h: HookHome | undefined
  afterEach(async () => { await s?.close(); s = undefined; h?.cleanup(); h = undefined })

  for (const tool of ['plur_inject', 'plur_inject_hybrid'] as const) {
    it(`MCP tool ${tool}, with a pinned "never" rule`, async () => {
      useEmbedder('bag-of-words')
      s = await mcpSession({ profile: 'full' })
      const scope = 'project:inj7'
      const memories = new Map<string, { statement: string; scope: string }>()
      const rule = await s.plur.learn(RULE, { scope, pinned: true })
      memories.set(rule.id, { statement: RULE, scope })
      for (const m of MATCHING) {
        const e = await s.plur.learn(m, { scope })
        memories.set(e.id, { statement: m, scope })
      }

      const res = await s.call(tool, { task: TASK, scope, budget: 2000 })
      expect(res.isError, `${tool} failed: ${res.text}`).toBe(false)
      const reported: string[] = res.json?.injected_ids ?? []
      expect(res.json?.count, `precondition: ${tool} reports memories as given; it reported ${res.json?.count}`).toBeGreaterThan(0)
      expect(reported, `precondition: ${tool} reports the pinned rule ${rule.id} as given (reported ${JSON.stringify(reported)})`)
        .toContain(rule.id)
      expect(reported.length, `${tool}: the reported count ${res.json?.count} does not match the ${reported.length} ids it lists`)
        .toBe(res.json?.count)

      checkDelivered(tool, deliveredText(res.json), reported, memories)
    })
  }

  it('installed session-start hook (hook-inject), with a pinned "never" rule', async () => {
    h = hookHome()
    const memories = new Map<string, { statement: string; scope: string }>()
    for (const m of [RULE, ...MATCHING]) {
      const r = runSource('cli', ['learn', m, '--scope', 'global', '--json'], { env: h.env, cwd: h.home })
      expect(r.status, `could not save a memory through the CLI: ${r.stderr}`).toBe(0)
      const id = JSON.parse(r.stdout).id as string
      expect(id, `precondition: the CLI returned an id for "${m}" (it printed ${r.stdout})`).toMatch(/^ENG-/)
      memories.set(id, { statement: m, scope: 'global' })
    }
    const ruleId = [...memories].find(([, m]) => m.statement === RULE)![0]
    // Pin the rule in the same store the hook reads (there is no CLI pin command).
    const store = new Plur({ path: join(h.home, '.plur'), autoDiscover: false })
    await store.ready()
    const pinned = await store.setPinned(ruleId, true)
    expect(pinned?.pinned, 'precondition: the rule is pinned in the store the hook reads').toBe(true)

    const first = prompt(h, 'inj7-hook-session', 'How do I deploy the billing service?')
    expect(first.status, `the hook failed: ${first.stderr}`).toBe(0)
    const header = first.context.match(/session started, (\d+) engrams injected/)
    expect(header, `precondition: the hook started a session and said how many memories it gave; it printed "${first.context}"`)
      .not.toBeNull()
    const reportedCount = Number(header![1])
    const reported = [...first.context.matchAll(/\[(ENG-[^\]]+)\]/g)].map(m => m[1])
    expect(reportedCount, `precondition: the hook reports memories as given; it said ${reportedCount}`).toBeGreaterThan(0)
    expect(reported.length, `the hook says it gave ${reportedCount} memories, but its reply carries ${reported.length} entries: "${first.context}"`)
      .toBe(reportedCount)
    expect(reported, `precondition: the hook gave the pinned rule ${ruleId}; it gave ${JSON.stringify(reported)}`).toContain(ruleId)

    checkDelivered('hook-inject', first.context, reported, memories)
  }, 120_000)
  for (const tool of ['plur_inject', 'plur_inject_hybrid'] as const) {
    it(`MCP tool ${tool}, with a memory over 60 characters in "also consider"`, async () => {
      useEmbedder('bag-of-words')
      s = await mcpSession({ profile: 'full' })
      const scope = 'project:inj7'
      const memories = new Map<string, { statement: string; scope: string }>()
      for (const m of MATCHING) memories.set((await s.plur.learn(m, { scope })).id, { statement: m, scope })
      const long = await s.plur.learn(LONG_CONSIDER, { scope, type: 'terminological' })
      memories.set(long.id, { statement: LONG_CONSIDER, scope })
      expect(LONG_CONSIDER.length, 'precondition: the statement is longer than the 60-character short form').toBeGreaterThan(60)

      const res = await s.call(tool, { task: TASK, scope, budget: 2000 })
      expect(res.isError, `${tool} failed: ${res.text}`).toBe(false)
      const reported: string[] = res.json?.injected_ids ?? []
      expect(reported, `precondition: ${tool} reports the long memory ${long.id} as given (reported ${JSON.stringify(reported)})`).toContain(long.id)
      expect(String(res.json?.consider ?? ''), `precondition: the long memory landed in the "also consider" section; consider is ${JSON.stringify(res.json?.consider)}`)
        .toContain(`[${long.id}]`)

      checkDelivered(tool, deliveredText(res.json), reported, memories)
    })
  }

  it('MCP tool plur_session_start: every memory its reply reports as given is in the reply, incl. a pinned "never" rule and a long "also consider" memory', async () => {
    useEmbedder('bag-of-words')
    s = await mcpSession({ profile: 'lean' })
    const scope = 'global'
    const memories = new Map<string, { statement: string; scope: string }>()
    const rule = await s.plur.learn(RULE, { scope, pinned: true })
    memories.set(rule.id, { statement: RULE, scope })
    for (const m of MATCHING) memories.set((await s.plur.learn(m, { scope })).id, { statement: m, scope })
    const long = await s.plur.learn(LONG_CONSIDER, { scope, type: 'terminological' })
    memories.set(long.id, { statement: LONG_CONSIDER, scope })

    const res = await s.call('plur_session_start', { task: TASK })
    expect(res.isError, `plur_session_start failed: ${res.text}`).toBe(false)
    const given = res.json?.engrams
    const reported: string[] = given?.injected_ids ?? []
    expect(given?.count, `precondition: plur_session_start reports memories as given; its engrams field is ${JSON.stringify(given)?.slice(0, 300)}`).toBeGreaterThan(0)
    expect(reported.length, `plur_session_start: the reported count ${given?.count} does not match the ${reported.length} ids it lists`).toBe(given?.count)
    expect(reported, `precondition: plur_session_start reports the pinned rule ${rule.id} as given (reported ${JSON.stringify(reported)})`).toContain(rule.id)
    expect(reported, `precondition: plur_session_start reports the long memory ${long.id} as given (reported ${JSON.stringify(reported)})`).toContain(long.id)

    checkDelivered('plur_session_start', deliveredText(res.json), reported, memories)
  })

  it('installed session-start hook (hook-inject), with a memory over 60 characters in "also consider"', async () => {
    h = hookHome()
    const memories = new Map<string, { statement: string; scope: string }>()
    for (const [m, type] of [...MATCHING.map(x => [x, 'behavioral'] as const), [LONG_CONSIDER, 'terminological'] as const]) {
      const r = runSource('cli', ['learn', m, '--scope', 'global', '--type', type, '--json'], { env: h.env, cwd: h.home })
      expect(r.status, `could not save a memory through the CLI: ${r.stderr}`).toBe(0)
      const id = JSON.parse(r.stdout).id as string
      expect(id, `precondition: the CLI returned an id for "${m}" (it printed ${r.stdout})`).toMatch(/^ENG-/)
      memories.set(id, { statement: m, scope: 'global' })
    }
    const longId = [...memories].find(([, m]) => m.statement === LONG_CONSIDER)![0]

    const first = prompt(h, 'inj7-hook-long', 'How do I deploy the billing service?')
    expect(first.status, `the hook failed: ${first.stderr}`).toBe(0)
    const reported = [...first.context.matchAll(/\[(ENG-[^\]]+)\]/g)].map(m => m[1])
    expect(reported, `precondition: the hook gave the long memory ${longId}; it gave ${JSON.stringify(reported)}: "${first.context}"`).toContain(longId)

    checkDelivered('hook-inject (long)', first.context, reported, memories)
  }, 120_000)
})
