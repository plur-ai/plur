// EPI-2: Previewing memories extracted from my events saves nothing.
//
// Driven through the MCP tools an agent uses: events are recorded with
// plur_capture, read back with plur_timeline, and their text is handed to
// plur_ingest with extract_only (the preview). The preview must return
// candidates (otherwise "saved nothing" proves nothing) and leave the store
// exactly as it was: no memory, no history entry, no file changed. The control
// arm runs the same extraction without the preview flag and shows that it
// does save, so the candidates were real memories-to-be.
import { afterEach, describe, expect, it } from 'vitest'
import { mcpSession, type McpSession } from '../helpers/agent-tools-hooks-mcp.js'
import { offlineFetch, snapshotTree, treeChanges } from '../helpers/privacy-folders-team-mcp.js'
import { useEmbedder } from '../helpers/store.js'

const EVENTS = [
  'Release review: we decided to ship the mobile app on Thursdays.',
  'Incident retro. Important: rotate the payment API keys after every contractor leaves.',
]

describe('EPI-2 previewing memories extracted from my events saves nothing', () => {
  let s: McpSession | undefined
  let net: ReturnType<typeof offlineFetch> | undefined
  afterEach(async () => { await s?.close(); s = undefined; net?.restore() })

  async function eventsText(): Promise<string> {
    for (const summary of EVENTS) {
      const r = await s!.call('plur_capture', { summary, agent: 'claude' })
      expect(r.isError, `recording an event failed: ${r.text}`).toBe(false)
    }
    const t = await s!.call('plur_timeline', { agent: 'claude' })
    const summaries: string[] = (t.json?.episodes ?? []).map((e: { summary: string }) => e.summary)
    expect(summaries.length, `precondition: both recorded events are in the timeline; got ${t.text}`).toBe(EVENTS.length)
    return summaries.join('\n')
  }

  it('the preview returns candidates and the store is unchanged: no memory, no history, no file', async () => {
    net = offlineFetch()
    useEmbedder('off')
    s = await mcpSession({ profile: 'full' })
    await s.plur.learn('An existing memory that was here before the preview', { scope: 'global' })
    const content = await eventsText()

    const countBefore = (await s.plur.list()).length
    const before = snapshotTree(s.dir)

    const r = await s.call('plur_ingest', { content, extract_only: true, source: 'events' })
    expect(r.isError, `the preview failed: ${r.text}`).toBe(false)
    const statements: string[] = (r.json?.candidates ?? []).map((c: { statement: string }) => c.statement)
    expect(statements.length, `precondition: the preview should extract candidate memories from the events; it returned ${r.text}`).toBeGreaterThan(0)
    expect(r.json?.saved, `the preview should say nothing was saved; it said saved=${JSON.stringify(r.json?.saved)}`).toBe(false)

    const after = snapshotTree(s.dir)
    expect(treeChanges(before, after), 'the preview changed files in the store').toEqual([])
    expect((await s.plur.list()).length, 'the preview changed the number of memories').toBe(countBefore)
    for (const st of statements) {
      const found = await s.plur.recall(st, { limit: 5 })
      expect(found.map(e => e.statement), `a previewed candidate was saved as a memory: "${st}"`).not.toContain(st)
    }
  })

  it('control: the same extraction without the preview flag does save the candidates', async () => {
    net = offlineFetch()
    useEmbedder('off')
    s = await mcpSession({ profile: 'full' })
    const content = await eventsText()
    const countBefore = (await s.plur.list()).length

    const r = await s.call('plur_ingest', { content, source: 'events' })
    expect(r.isError, `control: the extraction failed: ${r.text}`).toBe(false)
    const n = (r.json?.candidates ?? []).length
    expect(n, `control: the extraction should return candidates; it returned ${r.text}`).toBeGreaterThan(0)
    expect((await s.plur.list()).length, 'control: without the preview flag the candidates should be saved').toBeGreaterThan(countBefore)
  })
})
