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
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '@plur-ai/core'
import { getToolDefinitions, _resetSessionTelemetry } from '../src/tools.js'

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
    expect(result.not_recorded).toContain('who asserted it')
    expect(result.summary).toContain('Not recorded')
    expect(result.summary).toMatch(/Nothing is guessed/)
  })

  it('reports a complete record as complete', async () => {
    const engram = await plur.learn('Fully attributed statement', {
      type: 'behavioral',
      source: 'https://example.org/runbook',
      claim_class: 'asserted',
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

  it('saves the record when asked, and says where', async () => {
    const engram = await plur.learn('Worth saving', { type: 'behavioral' })
    const result = await call({ id: engram.id, save: true })
    expect(result.saved_to).toBeTruthy()
    expect(String(result.saved_to)).toContain('provenance')
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
