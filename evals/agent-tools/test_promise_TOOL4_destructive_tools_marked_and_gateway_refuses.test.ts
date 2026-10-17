// TOOL-4: Every tool that deletes a memory or overwrites its text is marked as
// destructive, so my client can ask me first, and the general gateway tool can
// never delete or overwrite. Moving a memory to another scope is not counted as
// overwriting.
//
// (Replaces TOOL-2, whose wording promised that "my client still asks me first".
// PLUR can only mark a tool; whether a given client asks is the client's policy.)
//
// What PLUR controls is the destructiveHint annotation a client reads, and the
// gateway (plur_admin), which carries ONE static annotation for every action it
// dispatches. A deleting action run through the gateway would slip past the
// client's prompt, so the gateway must refuse it.
//
// Which tools delete or overwrite is NOT a hand list and NOT read from the
// annotation under test: it is enumerated from the tool handlers in
// packages/mcp/src/tools.ts — every handler that reaches a core entry point that
// removes or retires a memory, or that assigns a new statement to an existing
// memory before writing it back. The entry points are literals written from the
// promise. A literal minimum count makes an empty or broken enumeration fail.
//
// Driven over the MCP wire against a server built from source, lean (default)
// profile — the profile most users get.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mcpSession, type McpSession } from '../helpers/agent-tools-hooks-mcp.js'

const TOOLS_SRC = join(__dirname, '..', '..', 'packages', 'mcp', 'src', 'tools.ts')

/** Core calls that remove or retire a memory. */
const DELETES = [
  /\bplur\.forget\(/, // forget: retires the memory
  /\bplur\.uninstallPack\(/, // uninstall: removes every memory the pack brought
  /\bplur\.resolveTension\(/, // resolve: retires the losing memory, no copy kept
  /\bvalidateMetaEngram\(/, // a third failed domain retires the meta-memory
]
/** A new statement assigned to an existing memory and written back. */
const OVERWRITES_TEXT = /\.statement\s*=(?!=)[\s\S]*?\bplur\.updateEngram\(/
/** Moving to another scope: not counted as overwriting (the promise says so). */
const MOVES = /\bplur\.rescope\(/
/**
 * Saving through the AI duplicate check can fold the new statement into an
 * existing memory (UPDATE replaces its text, MERGE appends to it). Whether that
 * automatic merge counts as "overwriting" is an open owner question (see the
 * TOOL-4 `decide:`), so these tools are listed and reported, not yet graded.
 */
const AUTOMATIC_MERGE = /\bplur\.(learnBatch|learnAsync)\(/

interface Classified { deleting: string[]; moving: string[]; automaticMerge: string[]; all: string[] }

function classifyFromSource(): Classified {
  const src = readFileSync(TOOLS_SRC, 'utf8')
  const starts = [...src.matchAll(/\n\s+name: '(plur_[a-z_]+)',\n/g)].map(m => ({ at: m.index!, name: m[1] }))
  const out: Classified = { deleting: [], moving: [], automaticMerge: [], all: [] }
  starts.forEach((s, i) => {
    const block = src.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : src.length)
    out.all.push(s.name)
    if (DELETES.some(re => re.test(block)) || OVERWRITES_TEXT.test(block)) out.deleting.push(s.name)
    else if (MOVES.test(block)) out.moving.push(s.name)
    if (AUTOMATIC_MERGE.test(block)) out.automaticMerge.push(s.name)
  })
  return out
}

type ListedTool = { name: string; annotations?: { destructiveHint?: boolean } }

describe('TOOL-4 deleting and overwriting tools are marked destructive, and the gateway refuses them', () => {
  let s: McpSession
  afterEach(async () => { await s?.close() })

  it('forgetting a memory through plur_admin is refused and the memory survives', async () => {
    s = await mcpSession({ profile: 'lean' })
    const keep = await s.plur.learn('Release notes are written by the on-call engineer', { scope: 'global' })
    expect((await s.plur.recall('release notes on-call engineer', { limit: 5 })).map(e => e.id),
      'precondition: the memory exists and is found before the attempt').toContain(keep.id)

    const res = await s.call('plur_admin', { action: 'plur_forget', args: { id: keep.id, reason: 'eval' } })
    expect(res.json?.success === false || res.isError,
      `the gateway ran a forget instead of refusing it: ${res.text}`).toBe(true)
    expect(res.text, `the refusal does not tell the agent to call plur_forget directly: ${res.text}`)
      .toContain('plur_forget')

    const after = await s.plur.recall('release notes on-call engineer', { limit: 5 })
    expect(after.map(e => e.id), 'the memory was deleted through the gateway').toContain(keep.id)
  })

  it('every tool whose handler deletes or overwrites a memory is marked destructive, callable directly, and refused by the gateway', async () => {
    const found = classifyFromSource()
    expect(found.all.length, `precondition: the tool definitions were read from tools.ts (found ${found.all.length})`).toBeGreaterThanOrEqual(40)
    // Literal floor: forget, pack uninstall, tension resolve and meta validation
    // each remove a memory today. Fewer means the enumeration broke.
    expect(found.deleting.length,
      `precondition: at least 4 deleting/overwriting tools found in tools.ts; found ${JSON.stringify(found.deleting)}`).toBeGreaterThanOrEqual(4)
    // The literal list TOOL-2 held stays covered (stricter, never weaker).
    const required = [...new Set([...found.deleting, 'plur_forget', 'plur_packs_uninstall', 'plur_tensions_purge'])]

    s = await mcpSession({ profile: 'lean' })
    const direct = (await s.client.listTools()).tools as ListedTool[]
    const help = await s.call('plur_admin', { action: 'help' })
    const gatewayActions: string[] = (help.json?.actions ?? []).map((a: { action: string }) => a.action)
    expect(gatewayActions.length, `precondition: the gateway lists its actions: ${help.text.slice(0, 200)}`).toBeGreaterThan(0)

    const seed = await s.plur.learn('The ledger service is deployed by the platform team', { scope: 'global' })
    const before = (await s.plur.list()).map(e => `${e.id}|${e.status}|${e.statement}`).sort()
    expect(before.length, 'precondition: the store holds a memory the gateway could harm').toBeGreaterThan(0)

    const problems: string[] = []
    for (const name of required) {
      const tool = direct.find(t => t.name === name)
      if (!tool) { problems.push(`${name} deletes or overwrites but is not callable directly, so the gateway is the only way to it`); continue }
      if (tool.annotations?.destructiveHint !== true) problems.push(`${name} deletes or overwrites but is listed without destructiveHint, so a client cannot know to ask first`)
      if (gatewayActions.includes(name)) problems.push(`the gateway offers ${name} as one of its actions`)
      const viaGateway = await s.call('plur_admin', {
        action: name,
        args: { id: seed.id, ids: [seed.id], winner: seed.id, action: 'resolve', name: 'eval-pack', meta_engram_id: seed.id, test_domain: 'eval', reason: 'eval' },
      })
      if (!(viaGateway.json?.success === false || viaGateway.isError)) problems.push(`the gateway accepted ${name}: ${viaGateway.text.slice(0, 200)}`)
      else if (!viaGateway.text.includes(name)) problems.push(`the gateway refused ${name} without naming the direct tool to call: ${viaGateway.text.slice(0, 200)}`)
    }
    const after = (await s.plur.list()).map(e => `${e.id}|${e.status}|${e.statement}`).sort()
    if (JSON.stringify(after) !== JSON.stringify(before)) problems.push(`the store changed while every gateway call should have been refused: before ${JSON.stringify(before)} after ${JSON.stringify(after)}`)

    // And no tool marked destructive is offered by the gateway at all.
    const destructive = direct.filter(t => t.annotations?.destructiveHint === true).map(t => t.name)
    expect(destructive.length, 'precondition: some direct tools are marked destructive').toBeGreaterThan(0)
    for (const name of destructive) if (gatewayActions.includes(name)) problems.push(`the gateway offers the destructive tool ${name}`)

    expect(problems, `deleting/overwriting tools checked: ${JSON.stringify(required)}; ` +
      `moves (not counted): ${JSON.stringify(found.moving)}; automatic-merge tools pending the owner's decision: ${JSON.stringify(found.automaticMerge)}\n` +
      problems.join('\n')).toEqual([])
  })
})
