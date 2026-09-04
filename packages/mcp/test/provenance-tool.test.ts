/**
 * plur_provenance — reaching provenance from a session (#979).
 *
 * The feature existed for a while with no way to reach it: 44 tools and none
 * touched provenance, so a user running the installed server could not get a
 * record at all. A user found that by asking the obvious question.
 *
 * Two design rules these tests hold in place.
 *
 * **Answer in prose, not JSON-LD.** A wall of JSON-LD is expensive for an agent
 * to read and unreadable for a person. The record is for machines.
 *
 * **Say what is missing as loudly as what is known.** On an older engram the
 * honest answer is "nothing recorded who asserted this". Hiding that would make
 * the record look more authoritative than it is.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '@plur-ai/core'
import { getToolDefinitions, _resetSessionTelemetry } from '../src/tools.js'
import { StubServer } from '../../core/test/helpers/stub-server.js'

describe('plur_provenance (#979)', () => {
  let plur: Plur
  let dir: string
  let tools: ReturnType<typeof getToolDefinitions>

  const call = async (args: Record<string, unknown> = {}) => {
    const tool = tools.find(t => t.name === 'plur_provenance')
    if (!tool) throw new Error('plur_provenance is not registered')
    return tool.handler(args, plur) as Promise<any>
  }

  /** The path a real session takes: dispatch through plur_admin. */
  const callViaAdmin = async (args: Record<string, unknown> = {}) => {
    const lean = getToolDefinitions()
    const admin = lean.find(t => t.name === 'plur_admin')
    if (!admin) throw new Error('plur_admin is not registered')
    return admin.handler({ action: 'plur_provenance', args }, plur) as Promise<any>
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-prov-tool-'))
    plur = new Plur({ path: dir })
    // Provenance is not a core session tool, so it lives behind plur_admin
    // like most of the surface. Ask for the full set to reach it directly.
    tools = getToolDefinitions('full')
    _resetSessionTelemetry()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('is registered as a tool at all', () => {
    expect(tools.find(t => t.name === 'plur_provenance')).toBeDefined()
  })

  it('is reachable from a real session, through plur_admin', async () => {
    // The lean profile exposes 11 core tools to save schema tokens on every
    // turn. Provenance is not something you do every session, so it belongs
    // behind the dispatch — but it must genuinely work from there.
    const engram = await plur.learn('Reachable through the dispatch', { type: 'behavioral' })
    const result = await callViaAdmin({ id: engram.id })
    expect(result.found).toBe(true)
    expect(result.summary).toContain('Where')
  })

  it('is listed by the admin dispatch, so it can be discovered', async () => {
    const lean = getToolDefinitions()
    const admin = lean.find(t => t.name === 'plur_admin')!
    const help = await admin.handler({ action: 'help' }, plur) as any
    expect(JSON.stringify(help)).toContain('plur_provenance')
  })

  it('is marked read-only, because it is', () => {
    const tool = tools.find(t => t.name === 'plur_provenance')!
    expect((tool as any).annotations?.readOnlyHint).toBe(true)
  })

  it('finds an engram by what it says, not only by id', async () => {
    // Nobody remembers ENG-2026-08-21-086.
    const engram = await plur.learn('Deploys run after migrations, never before', { type: 'behavioral' })
    const result = await call({ search: 'deploys migrations' })
    expect(result.found).toBe(true)
    expect(result.engram_id).toBe(engram.id)
  })

  it('answers in prose by default', async () => {
    const engram = await plur.learn('Something to explain', { type: 'behavioral' })
    const result = await call({ id: engram.id })
    expect(typeof result.summary).toBe('string')
    expect(result.summary).toContain('Where')
    expect(result.record).toBeUndefined()
  })

  it('returns the document only when asked', async () => {
    const engram = await plur.learn('Something to serialise', { type: 'behavioral' })
    const result = await call({ id: engram.id, format: 'record' })
    expect(result.record['@graph']).toBeDefined()
  })

  it('names what was not recorded', async () => {
    // An engram written with no attribution genuinely cannot say who asserted
    // it. The tool must say so rather than leaving a blank.
    const engram = await plur.learn('Nobody said who wrote this', { type: 'behavioral' })
    const result = await call({ id: engram.id })

    expect(result.complete).toBe(false)
    // Matched by prefix, not exact string: the entry now also says HOW it is
    // unrecorded — the writer marked that nobody was identified, which is a
    // recorded fact and still not an answer to who is answerable.
    expect(result.not_recorded.some((m: string) => m.startsWith('who asserted it'))).toBe(true)
    expect(result.summary).toContain('Not recorded')
    // The absence is stated as an absence, not left as a blank a reader
    // would fill in with a guess of their own.
    expect(result.summary).toMatch(/not guesses left blank/)
  })

  it('reports a complete record as complete', async () => {
    // A licence has to be CHOSEN for the record to be complete. The schema
    // default is not a decision anyone made, so an engram that never picked
    // one is incomplete however well attributed it is (#970, tester finding).
    const engram = await plur.learn('Fully attributed statement', {
      type: 'behavioral',
      source: 'https://example.org/runbook',
      claim_class: 'asserted',
      license: 'cc-by-4.0',
      attribution: { asserted_by: 'local:maintainer', runtime: { name: 'plur-mcp', version: '0.18.0' } },
    })
    const result = await call({ id: engram.id })
    expect(result.not_recorded).toEqual([])
    expect(result.complete).toBe(true)
    expect(result.summary).toContain('local:maintainer')
    expect(result.summary).toContain('asserted')
  })

  it('translates the licence into plain words', async () => {
    const engram = await plur.learn('Licensed statement', { type: 'behavioral' })
    const result = await call({ id: engram.id })
    expect(result.summary).toMatch(/credit required/)
  })

  it('marks a licence nobody chose, and does not call the record complete', async () => {
    // The licence was the one legally-consequential field, and it was the one
    // invented field — a schema default printed among recorded facts.
    const engram = await plur.learn('Never picked a licence', { type: 'behavioral' })
    const result = await call({ id: engram.id })
    expect(result.summary).toContain('Nobody chose this licence')
    expect(result.complete).toBe(false)
  })

  it('says the licence is not permission to share a private memory', async () => {
    const engram = await plur.learn('A private local secret', { type: 'behavioral' })
    const result = await call({ id: engram.id })
    expect(result.summary).toContain('Not permission to share')
  })

  it('says plainly when nobody was identified', async () => {
    const engram = await plur.learn('Written with no identity set', {
      type: 'behavioral',
      attribution: { asserted_by: 'unidentified', runtime: { name: 'plur-mcp' } },
    })
    const result = await call({ id: engram.id })
    expect(result.summary).toContain('nobody identified')
  })

  it('shows what else matched, so a wrong pick is visible', async () => {
    await plur.learn('Migrations run before deploys in staging', { type: 'behavioral' })
    await plur.learn('Migrations run before deploys in production', { type: 'behavioral' })
    const result = await call({ search: 'migrations deploys' })
    expect(result.found).toBe(true)
    if (result.other_matches) {
      expect(result.note).toMatch(/closest/)
      expect(result.other_matches.length).toBeGreaterThan(0)
    }
  })

  it('offers no way to write, because it is annotated read-only (#1002 review)', async () => {
    // A host may run a `readOnlyHint` tool without asking. A `save` flag that
    // wrote files made the annotation a lie; writing is `plur provenance
    // --write` or `plur.writeProvenance()`.
    const tool = tools.find(t => t.name === 'plur_provenance')!
    expect((tool as any).annotations.readOnlyHint).toBe(true)
    expect((tool as any).inputSchema.properties.save).toBeUndefined()
    const engram = await plur.learn('Worth saving', { type: 'behavioral' })
    const result = await call({ id: engram.id, save: true })
    expect(result.found).toBe(true)
    expect(result.saved_to).toBeUndefined()
    expect(existsSync(join(dir, 'provenance'))).toBe(false)
  })

  it('explains itself when nothing matches, rather than failing', async () => {
    const result = await call({ search: 'nothing whatsoever matches this phrase' })
    expect(result.found).toBe(false)
    expect(result.message).toMatch(/Nothing matched/)
  })

  it('explains itself when the id is unknown', async () => {
    const result = await call({ id: 'ENG-does-not-exist' })
    expect(result.found).toBe(false)
    expect(result.message).toContain('ENG-does-not-exist')
  })

  it('asks for input when given none', async () => {
    const result = await call({})
    expect(result.found).toBe(false)
    expect(result.message).toMatch(/id or a search term/)
  })
})

/**
 * Two more things the testers hit (#970).
 */
describe('plur_provenance — corrections from testing', () => {
  let plur: Plur
  let dir: string
  let tools: ReturnType<typeof getToolDefinitions>

  const call = async (args: Record<string, unknown> = {}) =>
    tools.find(t => t.name === 'plur_provenance')!.handler(args, plur) as Promise<any>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-prov-fixes-'))
    plur = new Plur({ path: dir })
    tools = getToolDefinitions('full')
    _resetSessionTelemetry()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('refuses a format it does not know, instead of quietly returning prose', async () => {
    // A tester asked for "jsonld" and got a summary, with nothing to indicate
    // the request had not been honoured.
    const engram = await plur.learn('Something', { type: 'behavioral' })
    const result = await call({ id: engram.id, format: 'jsonld' })
    expect(result.found).toBe(false)
    expect(result.message).toContain('Unknown format')
    expect(result.summary).toBeUndefined()
  })

  it('still accepts the format it does know', async () => {
    const engram = await plur.learn('Something', { type: 'behavioral' })
    expect((await call({ id: engram.id, format: 'summary' })).found).toBe(true)
    expect((await call({ id: engram.id, format: 'record' })).record).toBeDefined()
  })

  it('tells an agent apart from plur_receipt, which sounds like the same thing', async () => {
    // Both are read-only and both sound like "proof of where things came
    // from". A tester picked the wrong one. Each description now names the other.
    const prov = tools.find(t => t.name === 'plur_provenance')!
    const receipt = tools.find(t => t.name === 'plur_receipt')!
    expect(prov.description).toContain('plur_receipt')
    expect(receipt.description).toContain('plur_provenance')
  })

  it('a search does not dial remote stores (#776, #1002 review)', async () => {
    // The engram whose provenance we can show lives in OUR store; sending
    // the phrase to every configured host leaks it, and a remote top hit
    // would only fail `provenanceFor`.
    const stub = new StubServer('tok')
    const info = await stub.start()
    try {
      writeFileSync(join(dir, 'config.yaml'),
        `stores:\n  - url: "${info.url}"\n    token: "tok"\n    scope: "team:remote"\n`)
      const remote = new Plur({ path: dir })
      await remote.learn('A memory about aurora borealis', { type: 'behavioral' })
      const tool = tools.find(t => t.name === 'plur_provenance')!
      const result = await tool.handler({ search: 'aurora borealis' }, remote) as any
      expect(result.found).toBe(true)
      expect(stub.recallCalls).toBe(0)
    } finally {
      await stub.stop()
    }
  })

  it('lets a caller choose a licence, so a complete record is reachable', async () => {
    // Before this, no public path set a licence — so "complete" could never be
    // true, however carefully a caller filled in everything else.
    const engram = await plur.learn('Deliberately licensed', {
      type: 'behavioral',
      source: 'https://example.org/doc',
      claim_class: 'documented',
      license: 'cc-by-4.0',
      attribution: { asserted_by: 'local:maintainer' },
    })
    const result = await call({ id: engram.id })
    expect(result.complete).toBe(true)
    expect(result.summary).toContain('cc-by-4.0')
    expect(result.summary).not.toContain('Nobody chose this licence')
  })
})

/**
 * A fuzzy match must not hide how fuzzy it was (#970, round four).
 *
 * An agent tester searched a term matching six memories, got one back with no
 * count, and called it "a confident wrong answer on the exact question the tool
 * exists for". Listing three of six and saying nothing about the rest lets an
 * agent answer about a memory nobody asked about.
 */
describe('plur_provenance — how many actually matched', () => {
  let plur: Plur
  let dir: string
  let tools: ReturnType<typeof getToolDefinitions>

  const call = async (args: Record<string, unknown>) =>
    tools.find(t => t.name === 'plur_provenance')!.handler(args, plur) as Promise<any>

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-prov-count-'))
    plur = new Plur({ path: dir })
    tools = getToolDefinitions('full')
    _resetSessionTelemetry()
    for (let i = 1; i <= 6; i++) {
      await plur.learn(`Aurora database note number ${i} about connections`, { type: 'behavioral' })
    }
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reports the true number of matches, not the number it lists', async () => {
    const r = await call({ search: 'Aurora' })
    expect(r.match_count).toBe(6)
    expect(r.note).toContain('6 engrams matched')
  })

  it('says how many it is not showing', async () => {
    const r = await call({ search: 'Aurora' })
    expect(r.other_matches.length).toBeLessThan(r.match_count - 1)
    expect(r.note).toMatch(/Showing \d+ of the other \d+/)
  })

  it('quotes the memory it actually chose, not only the ones it rejected', async () => {
    const r = await call({ search: 'Aurora' })
    expect(r.matched).toContain('Aurora')
  })

  it('says nothing about alternatives when exactly one matched', async () => {
    const r = await call({ search: 'number 3' })
    if (r.match_count === 1) expect(r.note).toBeUndefined()
  })
})

/**
 * An agent must be able to mark a memory shareable (#970).
 *
 * `plur_learn` had no `visibility`, so every memory written over MCP was
 * private — the schema default — and stayed that way forever. Private engrams
 * are excluded from export, so a pack built from an agent's memories was always
 * empty, and `may_leave_this_machine` was a constant false carrying no
 * information. The whole sharing half of the feature was unreachable from the
 * surface most people use.
 */
describe('plur_learn can mark a memory shareable', () => {
  let plur: Plur
  let dir: string
  let tools: ReturnType<typeof getToolDefinitions>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-vis-'))
    plur = new Plur({ path: dir })
    tools = getToolDefinitions('full')
    _resetSessionTelemetry()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const learn = async (args: Record<string, unknown>) =>
    tools.find(t => t.name === 'plur_learn')!.handler(args, plur) as Promise<any>
  const provenance = async (args: Record<string, unknown>) =>
    tools.find(t => t.name === 'plur_provenance')!.handler(args, plur) as Promise<any>

  it('offers visibility in its schema, so an agent knows it exists', () => {
    const schema = (tools.find(t => t.name === 'plur_learn') as any).inputSchema
    expect(schema.properties.visibility).toBeDefined()
    expect(schema.properties.visibility.enum).toContain('public')
  })

  it('honours a public visibility rather than dropping it', async () => {
    const e = await learn({ statement: 'Shareable memory', type: 'behavioral', visibility: 'public' })
    const p = await provenance({ id: e.id })
    expect(p.visibility).toBe('public')
    expect(p.may_leave_this_machine).toBe(true)
  })

  it('still defaults to private when nobody says otherwise', async () => {
    const e = await learn({ statement: 'Ordinary memory', type: 'behavioral' })
    expect((await provenance({ id: e.id })).may_leave_this_machine).toBe(false)
  })

  it('tells an agent that private means excluded from packs', () => {
    // The description has to say what the default costs, or an agent will
    // never think to ask the user about it.
    const schema = (tools.find(t => t.name === 'plur_learn') as any).inputSchema
    expect(schema.properties.visibility.description).toContain('EXCLUDED')
  })
})

/**
 * Export without a licence is a refusal an agent can act on (#970, #1002
 * review). Core throws a long explanation; for an agent the answer has to be
 * a next step — and the next step is to ask the user, never to pick one.
 */
describe('plur_packs_export without a licence', () => {
  let plur: Plur
  let dir: string
  let out: string
  let tools: ReturnType<typeof getToolDefinitions>

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-export-lic-'))
    out = join(mkdtempSync(join(tmpdir(), 'plur-export-lic-out-')), 'p')
    plur = new Plur({ path: dir })
    await plur.learn('Shareable convention', { type: 'behavioral', visibility: 'public' })
    tools = getToolDefinitions('full')
    _resetSessionTelemetry()
  })
  afterEach(() => { for (const d of [dir, join(out, '..')]) rmSync(d, { recursive: true, force: true }) })

  const exportPack = async (args: Record<string, unknown>) =>
    tools.find(t => t.name === 'plur_packs_export')!.handler({ name: 'p', output_dir: out, ...args }, plur) as Promise<any>

  it('returns a structured refusal with the question to put to the user', async () => {
    const r = await exportPack({})
    expect(r.exported).toBe(false)
    expect(r.error).toMatch(/licence/)
    expect(r.next_step).toMatch(/[Aa]sk the user/)
    expect(r.next_step).toContain('license')
    expect(existsSync(join(out, 'engrams.yaml'))).toBe(false)
  })

  it('exports once a licence is given', async () => {
    const r = await exportPack({ license: 'cc-by-4.0' })
    expect(r.engram_count).toBe(1)
    expect(existsSync(join(out, 'engrams.yaml'))).toBe(true)
  })
})
