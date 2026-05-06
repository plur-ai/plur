import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Plur } from '@plur-ai/core'
import { createServer } from '../src/server.js'

describe('MCP server (wire protocol)', () => {
  let client: Client
  let dir: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-mcp-server-'))
    const plur = new Plur({ path: dir })
    const server = await createServer(plur)

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)

    client = new Client({ name: 'test-client', version: '1.0.0' })
    await client.connect(clientTransport)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true })
  })

  // --- Server info ---

  it('returns server info with instructions on initialize', () => {
    const info = client.getServerVersion()
    expect(info?.name).toBe('plur-mcp')
    expect(info?.version).toBe('0.9.6')
  })

  // --- Tools ---

  it('lists all tools with annotations', async () => {
    const { tools } = await client.listTools()
    expect(tools.length).toBeGreaterThanOrEqual(14)

    const status = tools.find(t => t.name === 'plur_status')
    expect(status).toBeDefined()
    expect(status!.annotations?.readOnlyHint).toBe(true)
    expect(status!.annotations?.idempotentHint).toBe(true)

    const forget = tools.find(t => t.name === 'plur_forget')
    expect(forget).toBeDefined()
    expect(forget!.annotations?.destructiveHint).toBe(true)

    const learn = tools.find(t => t.name === 'plur_learn')
    expect(learn).toBeDefined()
    expect(learn!.annotations?.destructiveHint).toBe(false)
  })

  it('calls plur_status and returns health info', async () => {
    const result = await client.callTool({ name: 'plur_status', arguments: {} })
    const data = JSON.parse((result.content as any)[0].text)
    expect(data.engram_count).toBe(0)
    expect(data.storage_root).toBe(dir)
  })

  it('learn → recall → feedback roundtrip', async () => {
    // Learn
    const learnResult = await client.callTool({
      name: 'plur_learn',
      arguments: { statement: 'Always use tabs for indentation', type: 'behavioral' },
    })
    const learned = JSON.parse((learnResult.content as any)[0].text)
    expect(learned.id).toBeDefined()
    expect(learned.statement).toBe('Always use tabs for indentation')

    // Recall
    const recallResult = await client.callTool({
      name: 'plur_recall',
      arguments: { query: 'indentation' },
    })
    const recalled = JSON.parse((recallResult.content as any)[0].text)
    expect(recalled.count).toBe(1)
    expect(recalled.results[0].statement).toContain('tabs')

    // Feedback
    const fbResult = await client.callTool({
      name: 'plur_feedback',
      arguments: { id: learned.id, signal: 'positive' },
    })
    const fb = JSON.parse((fbResult.content as any)[0].text)
    expect(fb.success).toBe(true)
  })

  it('returns isError for unknown tools', async () => {
    const result = await client.callTool({ name: 'plur_nonexistent', arguments: {} })
    expect(result.isError).toBe(true)
    expect((result.content as any)[0].text).toContain('Unknown tool')
  })

  // --- Resources ---

  it('lists resources (guide + status)', async () => {
    const { resources } = await client.listResources()
    expect(resources.length).toBe(2)

    const guide = resources.find(r => r.uri === 'plur://guide')
    expect(guide).toBeDefined()
    expect(guide!.mimeType).toBe('text/markdown')

    const status = resources.find(r => r.uri === 'plur://status')
    expect(status).toBeDefined()
    expect(status!.mimeType).toBe('application/json')
  })

  it('reads the guide resource', async () => {
    const result = await client.readResource({ uri: 'plur://guide' })
    const text = (result.contents[0] as any).text
    expect(text).toContain('PLUR')
    expect(text).toContain('plur_learn')
    expect(text).toContain('plur_recall_hybrid')
  })

  it('reads the status resource with live data', async () => {
    // Learn something first
    await client.callTool({
      name: 'plur_learn',
      arguments: { statement: 'Test engram for resource' },
    })

    const result = await client.readResource({ uri: 'plur://status' })
    const data = JSON.parse((result.contents[0] as any).text)
    expect(data.engram_count).toBe(1)
    expect(data.version).toBe('0.9.6')
    expect(data.storage_root).toBe(dir)
  })

  // --- Prompts ---

  it('lists prompts', async () => {
    const { prompts } = await client.listPrompts()
    expect(prompts.length).toBe(2)

    const gettingStarted = prompts.find(p => p.name === 'plur-getting-started')
    expect(gettingStarted).toBeDefined()

    const sessionStart = prompts.find(p => p.name === 'plur-session-start')
    expect(sessionStart).toBeDefined()
    expect(sessionStart!.arguments).toBeDefined()
    expect(sessionStart!.arguments!.length).toBe(2)
  })

  it('gets the getting-started prompt with zero engrams', async () => {
    const result = await client.getPrompt({ name: 'plur-getting-started' })
    const text = (result.messages[0].content as any).text
    expect(text).toContain('Engrams stored: 0')
    expect(text).toContain('no memories yet')
  })

  it('gets the getting-started prompt with engrams', async () => {
    await client.callTool({
      name: 'plur_learn',
      arguments: { statement: 'Test engram' },
    })
    const result = await client.getPrompt({ name: 'plur-getting-started' })
    const text = (result.messages[0].content as any).text
    expect(text).toContain('1 engrams stored')
  })

  it('gets the session-start prompt with task', async () => {
    const result = await client.getPrompt({
      name: 'plur-session-start',
      arguments: { task: 'refactor auth module', scope: 'project:webapp' },
    })
    const text = (result.messages[0].content as any).text
    expect(text).toContain('refactor auth module')
    expect(text).toContain('project:webapp')
  })
})
