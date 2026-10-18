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
// Three independent checks, because a fixed list of source patterns cannot
// prove "every tool" (independent re-audit 2026-10-18, R-03):
//
//  1. Handler enumeration. Every handler in packages/mcp/src/tools.ts that
//     reaches a core entry point that removes or retires a memory, assigns a
//     new statement to an existing memory, or saves through the AI duplicate
//     check (learnBatch / learnAsync: UPDATE replaces the existing text, MERGE
//     rewrites it) must be listed directly with destructiveHint and refused by
//     the gateway. There is no "pending owner decision" exception: the promise
//     says "overwrites its text" and names only scope moves as exempt.
//  2. The automatic overwrite, by effect. A scripted duplicate checker (a real
//     HTTP server on 127.0.0.1 answering as the OpenAI chat endpoint; no model,
//     no network, no credential) answers UPDATE, then MERGE, for an existing
//     memory. Through plur_admin { action: "plur_learn_batch" } the existing
//     memory's text must be unchanged on disk (fresh reopen), or the gateway
//     must have refused. Called directly, a batch that did overwrite must be
//     listed with destructiveHint.
//  3. Effects sweep. Every gateway action is called with harmless arguments on
//     a seeded store, the checker scripted as above, and after each call the
//     store is reopened fresh: no seeded memory may have changed its text or
//     been deleted. A move (plur_rescope) is run as a dry run, so it is never
//     counted. Actions that are not called are listed in the failure message.
//
// Driven over the MCP wire against a server built from source.
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Plur } from '../../packages/core/src/index.js'
import { mcpSession, type McpSession } from '../helpers/agent-tools-hooks-mcp.js'
import { useEmbedder } from '../helpers/store.js'
import { authorPack } from '../helpers/sync-packs-durability-history-packs.js'

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
/**
 * Saving through the AI duplicate check: UPDATE replaces an existing memory's
 * text, MERGE rewrites it. That is overwriting text, so these handlers count.
 */
const AUTOMATIC_MERGE = /\bplur\.(learnBatch|learnAsync)\(/
/** Moving to another scope: not counted as overwriting (the promise says so). */
const MOVES = /\bplur\.rescope\(/

interface Classified { deleting: string[]; moving: string[]; all: string[] }

function classifyFromSource(): Classified {
  const src = readFileSync(TOOLS_SRC, 'utf8')
  const starts = [...src.matchAll(/\n\s+name: '(plur_[a-z_]+)',\n/g)].map(m => ({ at: m.index!, name: m[1] }))
  const out: Classified = { deleting: [], moving: [], all: [] }
  starts.forEach((s, i) => {
    const block = src.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : src.length)
    out.all.push(s.name)
    if (DELETES.some(re => re.test(block)) || OVERWRITES_TEXT.test(block) || AUTOMATIC_MERGE.test(block)) out.deleting.push(s.name)
    else if (MOVES.test(block)) out.moving.push(s.name)
  })
  return out
}

type ListedTool = { name: string; annotations?: { destructiveHint?: boolean } }

// ---------------------------------------------------------------------------
// The scripted duplicate checker: a real HTTP server on 127.0.0.1.
// ---------------------------------------------------------------------------

interface Checker {
  url: string
  /** What a duplicate-check prompt is answered with. */
  decision: 'UPDATE' | 'MERGE'
  /** The memory a duplicate-check answer points at. */
  target: string
  calls: number
  /** Swap in for the OpenAI endpoint PLUR's environment-configured checker calls. */
  restore(): Promise<void>
}

const REWRITE = 'SCRIPTED CHECKER REWRITE: this text replaced the memory'

async function startChecker(): Promise<Checker> {
  const c: Checker = { url: '', decision: 'UPDATE', target: '', calls: 0, restore: async () => undefined }
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => {
      c.calls++
      let prompt = ''
      try { prompt = JSON.parse(body).messages?.map((m: { content: string }) => m.content).join('\n') ?? '' } catch { /* not JSON */ }
      // A duplicate-check prompt asks for DECISION/TARGET; anything else (procedure
      // evolution, meta extraction, profile) gets a plain rewrite.
      const content = /DECISION:/.test(prompt)
        ? `STATEMENT_0:\nDECISION: ${c.decision}\nTARGET: ${c.target}\nREASON: scripted local fixture\n` +
          `STATEMENT_1:\nDECISION: ${c.decision}\nTARGET: ${c.target}\nREASON: scripted local fixture`
        : REWRITE
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content } }] }))
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  c.url = `http://127.0.0.1:${port}/v1`
  // PLUR's batch checker is configured by OPENAI_API_KEY and always calls the
  // OpenAI host; send exactly that endpoint to the local server instead.
  const guarded = globalThis.fetch
  const prevKey = process.env.OPENAI_API_KEY
  const prevRouter = process.env.OPENROUTER_API_KEY
  process.env.OPENAI_API_KEY = 'eval-only-synthetic-token'
  delete process.env.OPENROUTER_API_KEY
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (href.startsWith('https://api.openai.com/v1/')) return guarded(href.replace('https://api.openai.com/v1', c.url), init)
    return guarded(input, init)
  }) as typeof fetch
  c.restore = async () => {
    globalThis.fetch = guarded
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevKey
    if (prevRouter === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prevRouter
    await new Promise<void>(r => server.close(() => r()))
  }
  return c
}

/** id -> "status|statement" for every memory, read by a fresh instance from disk. */
async function snapshot(dir: string): Promise<Map<string, string>> {
  const fresh = new Plur({ path: dir, autoDiscover: false })
  await fresh.ready()
  return new Map((await fresh.list()).map(e => [e.id, `${e.status}|${e.statement}`]))
}

/** What happened to the memories in `before`: rewritten or deleted (new memories are fine). */
function harmed(before: Map<string, string>, after: Map<string, string>): string[] {
  const out: string[] = []
  for (const [id, was] of before) {
    const now = after.get(id)
    if (!was.startsWith('active|')) continue
    if (now === undefined) out.push(`${id} was deleted (was "${was.slice(7)}")`)
    else if (!now.startsWith('active|')) out.push(`${id} was retired (was "${was.slice(7)}")`)
    else if (now !== was) out.push(`${id} text changed from "${was.slice(7)}" to "${now.slice(7)}"`)
  }
  return out
}

const OLD = 'Write release summaries as three bullets followed by one explicit next action.'
const INCOMING = 'Write release summaries as five bullets followed by one explicit next action.'

describe('TOOL-4 deleting and overwriting tools are marked destructive, and the gateway refuses them', () => {
  let s: McpSession | undefined
  let checker: Checker | undefined
  const cleanups: Array<() => void> = []
  afterEach(async () => {
    await checker?.restore(); checker = undefined
    await s?.close(); s = undefined
    while (cleanups.length) cleanups.pop()!()
  })

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
    // each remove a memory today, and the batch save can overwrite. Fewer means
    // the enumeration broke.
    expect(found.deleting.length,
      `precondition: at least 5 deleting/overwriting tools found in tools.ts; found ${JSON.stringify(found.deleting)}`).toBeGreaterThanOrEqual(5)
    // The literal list TOOL-2 held stays covered (stricter, never weaker), and
    // the batch save is named so a broken enumeration cannot drop it.
    const required = [...new Set([...found.deleting, 'plur_forget', 'plur_packs_uninstall', 'plur_tensions_purge', 'plur_learn_batch'])]

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
    }
    for (const name of required) {
      if (gatewayActions.includes(name)) problems.push(`the gateway offers ${name} as one of its actions`)
      const viaGateway = await s.call('plur_admin', {
        action: name,
        // Harmless arguments: a statement unlike the seed (no checker configured
        // here, so a batch cannot fold it into the seed).
        args: { id: seed.id, ids: [seed.id], winner: seed.id, action: 'resolve', name: 'eval-pack', meta_engram_id: seed.id, test_domain: 'eval', reason: 'eval', engrams: [{ statement: 'Gateway probe note about unrelated widgets', scope: 'global' }] },
      })
      if (!(viaGateway.json?.success === false || viaGateway.isError)) problems.push(`the gateway accepted ${name}: ${viaGateway.text.slice(0, 200)}`)
      else if (!viaGateway.text.includes(name)) problems.push(`the gateway refused ${name} without naming the direct tool to call: ${viaGateway.text.slice(0, 200)}`)
    }
    const after = (await s.plur.list()).map(e => `${e.id}|${e.status}|${e.statement}`).sort()
    const lost = before.filter(b => !after.includes(b))
    if (lost.length) problems.push(`a memory that existed before was changed or removed while every gateway call should have been refused: ${JSON.stringify(lost)}`)

    // And no tool marked destructive is offered by the gateway at all.
    const destructive = direct.filter(t => t.annotations?.destructiveHint === true).map(t => t.name)
    expect(destructive.length, 'precondition: some direct tools are marked destructive').toBeGreaterThan(0)
    for (const name of destructive) if (gatewayActions.includes(name)) problems.push(`the gateway offers the destructive tool ${name}`)

    expect(problems, `deleting/overwriting tools checked: ${JSON.stringify(required)}; ` +
      `moves (not counted): ${JSON.stringify(found.moving)}\n` + problems.join('\n')).toEqual([])
  })

  for (const decision of ['UPDATE', 'MERGE'] as const) {
    it(`plur_admin plur_learn_batch with the duplicate checker answering ${decision}: the existing memory's text is unchanged on disk, or the gateway refused`, async () => {
      useEmbedder('bag-of-words')
      s = await mcpSession({ profile: 'lean' })
      const old = await s.plur.learn(OLD, { scope: 'global' })
      checker = await startChecker()
      checker.decision = decision
      checker.target = old.id

      const res = await s.call('plur_admin', { action: 'plur_learn_batch', args: { engrams: [{ statement: INCOMING, scope: 'global' }] } })
      const refused = res.isError || res.json?.success === false
      const disk = await snapshot(s.dir)
      const oldNow = disk.get(old.id)
      if (!refused) {
        // Non-vacuous: the checker was asked, so the overwrite path was reachable.
        expect(checker.calls, `precondition: the gateway ran the batch and its duplicate checker was asked (reply: ${res.text.slice(0, 300)})`).toBeGreaterThan(0)
      }
      expect(refused || oldNow === `active|${OLD}`,
        `the gateway ran plur_learn_batch and the checker's ${decision} overwrote an existing memory: ` +
        `${old.id} was "${OLD}", on disk it is now "${oldNow?.slice(7) ?? '(gone)'}". Gateway reply: ${res.text.slice(0, 400)}`).toBe(true)
    })
  }

  // The batch save is the known overwrite; plur_learn receives the same
  // environment-configured checker, so it is held to the same rule by effect;
  // procedure evolution (plur_report_failure) rewrites a memory with whatever
  // its checker returns, a rewrite found by the effects sweep below.
  const PROC = 'To roll back the ledger service, revert the release tag and redeploy the previous image'
  const directCases: Array<{ tool: string; old: string; type?: 'procedural'; args: (id: string, c: Checker) => Record<string, unknown> }> = [
    { tool: 'plur_learn_batch', old: OLD, args: () => ({ engrams: [{ statement: INCOMING, scope: 'global' }] }) },
    { tool: 'plur_learn', old: OLD, args: () => ({ statement: INCOMING, scope: 'global' }) },
    { tool: 'plur_report_failure', old: PROC, type: 'procedural', args: (id, c) => ({ engram_id: id, failure_context: 'the previous image tag had been garbage-collected', llm_base_url: c.url, llm_api_key: 'eval-only-synthetic-token' }) },
  ]
  for (const dc of directCases) {
    const tool = dc.tool
    const OLD = dc.old
    it(`${tool} called directly: if the checker can overwrite through it, it is listed with destructiveHint`, async () => {
      useEmbedder('bag-of-words')
      s = await mcpSession({ profile: 'full' })
      const listed = ((await s.client.listTools()).tools as ListedTool[]).find(t => t.name === tool)
      expect(listed, `precondition: ${tool} is listed directly in the full profile`).toBeDefined()
      const old = await s.plur.learn(OLD, { scope: 'global', ...(dc.type ? { type: dc.type } : {}) })
      checker = await startChecker()
      checker.decision = 'UPDATE'
      checker.target = old.id
      const res = await s.call(tool, dc.args(old.id, checker))
      expect(res.isError, `precondition: the direct ${tool} call ran: ${res.text.slice(0, 300)}`).toBe(false)
      // The batch documents the checker on its path: it must have been reached.
      if (tool === 'plur_learn_batch') expect(checker.calls, 'precondition: the duplicate checker was asked').toBeGreaterThan(0)
      const now = (await snapshot(s.dir)).get(old.id)
      const overwrote = now !== `active|${OLD}`
      expect(!overwrote || listed!.annotations?.destructiveHint === true,
        `${tool} overwrote ${old.id} ("${OLD}" -> "${now?.slice(7) ?? '(gone)'}") ` +
        `but is listed with ${JSON.stringify(listed!.annotations)}, so a client cannot know to ask first`).toBe(true)
    })
  }

  it('effects sweep: no gateway action, called with harmless arguments, deletes or rewrites an existing memory', async () => {
    useEmbedder('bag-of-words')
    s = await mcpSession({ profile: 'lean' })
    const plain = await s.plur.learn('The ledger service is deployed by the platform team', { scope: 'global' })
    const dup = await s.plur.learn(OLD, { scope: 'global' })
    const proc = await s.plur.learn('To roll back the ledger service, revert the release tag and redeploy the previous image', { scope: 'global', type: 'procedural' })
    await s.plur.learn('Kubernetes deployments need a readiness probe', { scope: 'global' })
    checker = await startChecker()
    checker.decision = 'UPDATE'
    checker.target = dup.id

    const help = await s.call('plur_admin', { action: 'help' })
    const actions: string[] = (help.json?.actions ?? []).map((a: { action: string }) => a.action)
    expect(actions.length, `precondition: the gateway lists its actions: ${help.text.slice(0, 200)}`).toBeGreaterThanOrEqual(20)

    const tmp = mkdtempSync(join(tmpdir(), 'plur-eval-tool4-'))
    cleanups.push(() => rmSync(tmp, { recursive: true, force: true }))
    const pack = await authorPack(join(tmp, 'pack', 'sweep-pack'), 'sweep-pack', ['Grafana dashboards are exported as JSON'], 20)
    const episode = await s.call('plur_admin', { action: 'plur_capture', args: { summary: 'eval sweep episode' } })
    const episodeId = episode.json?.id ?? episode.json?.episode?.id ?? ''
    const llm = { llm_base_url: checker.url, llm_api_key: 'eval-only-synthetic-token' }

    /** Harmless arguments per action. Missing here: called with {} (a validation error at worst). */
    const harmless: Record<string, Record<string, unknown>> = {
      plur_capture: { summary: 'eval sweep note' },
      plur_episode_to_engram: { episode_id: episodeId, scope: 'global' },
      plur_extract_meta: { ...llm, run_validation: true },
      plur_history: { engram_id: plain.id },
      plur_ingest: { content: 'Release summaries are reviewed before they are sent.', scope: 'global' },
      plur_inject: { task: 'deploy the ledger service' },
      plur_inject_hybrid: { task: 'deploy the ledger service' },
      plur_learn_batch: { engrams: [{ statement: INCOMING, scope: 'global' }] },
      plur_meta_engrams: {},
      plur_outbox: { flush: true },
      plur_packs_discover: { query: 'eval' },
      plur_packs_export: { name: 'eval-export', output_dir: join(tmp, 'export') },
      plur_packs_install: { source: pack },
      plur_packs_list: {},
      plur_packs_preview: { source: pack },
      plur_pin: { id: plain.id, pinned: true },
      plur_profile: { ...llm, force_regenerate: true },
      plur_promote: { id: plain.id },
      plur_provenance: { id: plain.id },
      plur_recall_hybrid: { query: 'ledger service' },
      plur_report_failure: { engram_id: proc.id, failure_context: 'the previous image tag had been garbage-collected', ...llm },
      plur_rescope: { id: plain.id, target_scope: 'project:elsewhere', dry_run: true },
      plur_scopes_discover: {},
      plur_session_scope: { op: 'show' },
      plur_similarity_search: { query: 'ledger service' },
      plur_stores_add: { path: join(tmp, 'extra-store'), scope: 'project:extra' },
      plur_stores_list: {},
      plur_suggest_scope: { statement: 'Ledger deploys need a rollback plan' },
      plur_sync: {},
      plur_sync_status: {},
      plur_timeline: {},
    }
    /** Actions deliberately not called, with the reason. */
    const skipped: Record<string, string> = {}

    const problems: string[] = []
    const called: string[] = []
    let baseline = await snapshot(s.dir)
    expect([...baseline.values()].filter(v => v.startsWith('active|')).length, 'precondition: the seeded memories are on disk').toBeGreaterThanOrEqual(4)
    for (const action of actions) {
      if (action in skipped) continue
      const res = await s.call('plur_admin', { action, args: harmless[action] ?? {} })
      called.push(`${action}${res.isError || res.json?.success === false ? ' (refused/error)' : ''}`)
      const now = await snapshot(s.dir)
      for (const h of harmed(baseline, now)) problems.push(`plur_admin ${action}: ${h}`)
      baseline = now
    }

    expect(problems,
      `the general gateway deleted or overwrote memories by effect.\n  ${problems.join('\n  ')}\n` +
      `Called (${called.length}): ${called.join(', ')}\nNot called: ${JSON.stringify(skipped)}\nChecker calls: ${checker.calls}`).toEqual([])
  })
})
