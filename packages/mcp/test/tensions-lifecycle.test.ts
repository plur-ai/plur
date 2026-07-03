import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Plur } from '@plur-ai/core'
import { getToolDefinitions } from '../src/tools.js'

/**
 * plur_tensions lifecycle wiring (#181): scan persistence + suppress-list,
 * confirm/dismiss/resolve actions, injection warnings through the MCP
 * surface.
 */
describe('plur_tensions lifecycle (#181)', () => {
  let dir: string
  let plur: Plur
  let originalFetch: typeof globalThis.fetch
  const tools = getToolDefinitions()
  const tensionsTool = tools.find(t => t.name === 'plur_tensions')!
  const injectTool = tools.find(t => t.name === 'plur_inject')!

  const LLM_ARGS = { llm_base_url: 'https://api.openai.com/v1', llm_api_key: 'test-key' }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-tensions-lc-'))
    plur = new Plur({ path: dir })
    originalFetch = globalThis.fetch
    delete (process.env as any).OPENAI_API_KEY
    delete (process.env as any).OPENROUTER_API_KEY
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function mockYesLlm() {
    const fetchMock = vi.fn().mockImplementation(async (_url: any, init: any) => {
      const prompt: string = JSON.parse(init.body).messages[0].content
      const n = (prompt.match(/PAIR \d+/g) ?? []).length
      const content = n > 0
        ? Array.from({ length: n }, (_, i) => `PAIR_${i + 1}: CONTRADICTS: yes | CONFIDENCE: 0.9 | REASON: Opposite claims.`).join('\n')
        : 'CONTRADICTS: yes\nCONFIDENCE: 0.9\nREASON: Opposite claims.'
      return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) }
    })
    globalThis.fetch = fetchMock as any
    return fetchMock
  }

  it('scan persists new detections as tension records', async () => {
    plur.learn('plur cli version is 0.3.0')
    plur.learn('plur cli version is 0.8.2')
    mockYesLlm()

    const result = await tensionsTool.handler({ scan: true, ...LLM_ARGS }, plur) as any
    expect(result.count).toBe(1)
    expect(result.persisted_new).toBe(1)
    expect(result.tensions[0].tension_id).toMatch(/^T-/)
    expect(result.tensions[0].category).toBeDefined()
    expect(result.next_steps).toContain('confirm')

    // Records visible in list mode
    const list = await tensionsTool.handler({}, plur) as any
    expect(list.count).toBe(1)
    expect(list.tensions[0].id).toBe(result.tensions[0].tension_id)
    expect(list.tensions[0].status).toBe('detected')
  })

  it('a second scan skips the recorded pair (no LLM calls)', async () => {
    plur.learn('plur cli version is 0.3.0')
    plur.learn('plur cli version is 0.8.2')
    mockYesLlm()
    await tensionsTool.handler({ scan: true, ...LLM_ARGS }, plur)

    const fetchMock = mockYesLlm()
    const second = await tensionsTool.handler({ scan: true, ...LLM_ARGS }, plur) as any
    expect(second.pairs_checked).toBe(0)
    expect(second.count).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('persist:false is a dry run — nothing recorded, suppress-list ignored', async () => {
    plur.learn('plur cli version is 0.3.0')
    plur.learn('plur cli version is 0.8.2')
    mockYesLlm()

    const result = await tensionsTool.handler({ scan: true, persist: false, ...LLM_ARGS }, plur) as any
    expect(result.count).toBe(1)
    expect(result.persisted_new).toBeUndefined()
    expect(plur.listTensions()).toHaveLength(0)
  })

  it('confirm action marks the record confirmed', async () => {
    plur.learn('plur cli version is 0.3.0')
    plur.learn('plur cli version is 0.8.2')
    mockYesLlm()
    const scan = await tensionsTool.handler({ scan: true, ...LLM_ARGS }, plur) as any
    const id = scan.tensions[0].tension_id

    const result = await tensionsTool.handler({ action: 'confirm', id }, plur) as any
    expect(result.record.status).toBe('confirmed')
    expect(result.message).toContain(id)
  })

  it('dismiss action suppresses the pair', async () => {
    plur.learn('plur cli version is 0.3.0')
    plur.learn('plur cli version is 0.8.2')
    mockYesLlm()
    const scan = await tensionsTool.handler({ scan: true, ...LLM_ARGS }, plur) as any

    const result = await tensionsTool.handler({ action: 'dismiss', id: scan.tensions[0].tension_id }, plur) as any
    expect(result.record.status).toBe('dismissed')

    // Dismissed records leave the default list view but stay under status:all
    const list = await tensionsTool.handler({}, plur) as any
    expect(list.count).toBe(0)
    const all = await tensionsTool.handler({ status: 'all' }, plur) as any
    expect(all.count).toBe(1)
  })

  it('resolve action retires the losing engram', async () => {
    const a = plur.learn('plur cli version is 0.3.0')
    const b = plur.learn('plur cli version is 0.8.2')
    mockYesLlm()
    const scan = await tensionsTool.handler({ scan: true, ...LLM_ARGS }, plur) as any
    const id = scan.tensions[0].tension_id

    const result = await tensionsTool.handler({ action: 'resolve', id, winner: b.id }, plur) as any
    expect(result.record.status).toBe('resolved')
    expect(result.record.resolved_by).toBe(b.id)
    expect(result.retired).toBe(a.id)
    expect(plur.getById(a.id)?.status).toBe('retired')
    expect(plur.getById(b.id)?.status).toBe('active')
  })

  it('resolve without winner and unknown actions fail loudly', async () => {
    await expect(tensionsTool.handler({ action: 'resolve', id: 'T-0000-0000-001' }, plur)).rejects.toThrow(/winner/)
    await expect(tensionsTool.handler({ action: 'confirm' }, plur)).rejects.toThrow(/requires id/)
  })

  it('plur_inject surfaces tension warnings for confirmed tensions', async () => {
    const a = plur.learn('use tabs for indentation everywhere', { pinned: true })
    const b = plur.learn('completely unrelated database fact')
    const { records } = plur.recordTensions([{
      id_a: a.id, id_b: b.id,
      statement_a: a.statement, statement_b: b.statement,
      confidence: 0.9, reason: 'Opposite.',
    }])
    plur.confirmTension(records[0].id)

    const result = await injectTool.handler({ task: 'anything' }, plur) as any
    expect(result.warnings).toBeDefined()
    expect(result.warnings[0]).toContain(records[0].id)
  })
})
