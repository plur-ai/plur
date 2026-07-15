import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Plur, checkForUpdate, clearVersionCache } from '@plur-ai/core'
import { createServer } from '../src/server.js'

describe('MCP server (wire protocol)', () => {
  let client: Client
  let dir: string
  let plurInstance: Plur

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-mcp-server-'))
    const plur = new Plur({ path: dir })
    plurInstance = plur
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
    expect(info?.version).toBe('0.14.0')
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

  // Issue #297 — plur_learn with tags array should work
  it('plur_learn accepts tags array (#297)', async () => {
    const result = await client.callTool({
      name: 'plur_learn',
      arguments: { statement: 'Test with tags', tags: ['test', 'array'] },
    })
    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse((result.content as any)[0].text)
    expect(parsed.id).toBeDefined()
    expect(parsed.statement).toBe('Test with tags')
  })

  // Issue #297 hardening — array params must either work or fail loudly with a
  // useful message. The empty-payload symptom is a CLIENT-side serialization bug
  // (the server provably handles real arrays — test above), but the server can
  // (a) coerce the natural string workarounds back into arrays, and (b) name the
  // known client bug when the payload arrives empty, so the caller can retry
  // with a coercible shape instead of abandoning the write.
  describe('array argument hardening (#297)', () => {
    it('coerces a JSON-stringified array into a real array', async () => {
      const result = await client.callTool({
        name: 'plur_learn',
        arguments: { statement: 'Coerce JSON string tags', tags: '["alpha","beta"]' },
      })
      expect(result.isError).toBeFalsy()
      const parsed = JSON.parse((result.content as any)[0].text)
      expect(parsed.id).toBeDefined()
      const stored = plurInstance.getById(parsed.id)
      expect(stored?.tags).toEqual(['alpha', 'beta'])
    })

    it('coerces a comma-separated string into a string array', async () => {
      const result = await client.callTool({
        name: 'plur_learn',
        arguments: { statement: 'Coerce comma-separated tags', tags: 'alpha, beta' },
      })
      expect(result.isError).toBeFalsy()
      const parsed = JSON.parse((result.content as any)[0].text)
      const stored = plurInstance.getById(parsed.id)
      expect(stored?.tags).toEqual(['alpha', 'beta'])
    })

    it('coerces a single bare string into a one-element array', async () => {
      const result = await client.callTool({
        name: 'plur_learn',
        arguments: { statement: 'Coerce bare string tag', tags: 'solo' },
      })
      expect(result.isError).toBeFalsy()
      const parsed = JSON.parse((result.content as any)[0].text)
      const stored = plurInstance.getById(parsed.id)
      expect(stored?.tags).toEqual(['solo'])
    })

    it('malformed JSON array string fails loudly naming the field', async () => {
      const result = await client.callTool({
        name: 'plur_learn',
        arguments: { statement: 'Malformed tags', tags: '["unterminated' },
      })
      expect(result.isError).toBe(true)
      const parsed = JSON.parse((result.content as any)[0].text)
      expect(parsed.success).toBe(false)
      expect(parsed.error).toContain('tags')
    })

    it('non-string non-array value still fails loudly naming the field', async () => {
      const result = await client.callTool({
        name: 'plur_learn',
        arguments: { statement: 'Numeric tags', tags: 42 },
      })
      expect(result.isError).toBe(true)
      const parsed = JSON.parse((result.content as any)[0].text)
      expect(parsed.success).toBe(false)
      expect(parsed.error).toContain('tags')
    })

    it('empty arguments on a tool with array params names the client bug (#297)', async () => {
      const result = await client.callTool({ name: 'plur_learn', arguments: {} })
      expect(result.isError).toBe(true)
      const parsed = JSON.parse((result.content as any)[0].text)
      expect(parsed.error).toContain('arguments object was empty')
      // The targeted hint: names the known client-side array serialization bug
      // and the coercible retry shapes, so the agent self-corrects.
      expect(parsed.error).toContain('plur-ai/plur#297')
      expect(parsed.error).toMatch(/JSON string|comma-separated/)
    })

    it('empty arguments on a tool WITHOUT array params does not mention #297', async () => {
      // plur_recall has no array-typed params — the hint would be noise.
      const result = await client.callTool({ name: 'plur_recall', arguments: {} })
      expect(result.isError).toBe(true)
      const parsed = JSON.parse((result.content as any)[0].text)
      expect(parsed.error).toContain('arguments object was empty')
      expect(parsed.error).not.toContain('plur-ai/plur#297')
    })
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

  // Issue #281 — a missing required field used to return a bare
  // "Invalid arguments: statement: Required", which agents misread as "my
  // parameters aren't reaching the server" and abandoned persistence (silent
  // memory loss). The error now echoes the received fields and states the call
  // arrived, so the caller self-corrects instead of giving up.
  it('missing required field error echoes received fields and is self-correcting (#281)', async () => {
    const result = await client.callTool({
      name: 'plur_learn',
      // statement (required) omitted; other named fields present.
      arguments: { scope: 'global', domain: 'software', type: 'behavioral' },
    })
    expect(result.isError).toBe(true)
    const parsed = JSON.parse((result.content as any)[0].text)
    expect(parsed.success).toBe(false)
    expect(parsed.error).toContain('statement')
    // Echoes the fields that DID arrive — proof the call was transmitted.
    expect(parsed.error).toContain('Received fields:')
    expect(parsed.error).toContain('scope')
    expect(parsed.error).toContain('domain')
    // Explicitly disambiguates malformed-args from a transport failure.
    expect(parsed.error).toMatch(/not a transport failure/i)
  })

  it('empty arguments error says no fields were received (#281)', async () => {
    const result = await client.callTool({ name: 'plur_learn', arguments: {} })
    expect(result.isError).toBe(true)
    const parsed = JSON.parse((result.content as any)[0].text)
    expect(parsed.error).toContain('arguments object was empty')
  })

  it('returns isError for unknown tools', async () => {
    const result = await client.callTool({ name: 'plur_nonexistent', arguments: {} })
    expect(result.isError).toBe(true)
    expect((result.content as any)[0].text).toContain('Unknown tool')
  })

  it('error responses are valid JSON with success:false (#207)', async () => {
    const result = await client.callTool({ name: 'plur_nonexistent', arguments: {} })
    expect(result.isError).toBe(true)
    const parsed = JSON.parse((result.content as any)[0].text)
    expect(parsed.success).toBe(false)
    expect(parsed.error).toBeDefined()
    expect(typeof parsed.error).toBe('string')
  })

  // Issue #281 — validation errors should echo received fields for debugging
  it('validation errors include received_fields for self-correction (#281)', async () => {
    // Call plur_learn with missing required 'statement' but other fields present
    const result = await client.callTool({
      name: 'plur_learn',
      arguments: { scope: 'global', type: 'behavioral', tags: ['test'] },
    })
    expect(result.isError).toBe(true)
    const parsed = JSON.parse((result.content as any)[0].text)
    expect(parsed.success).toBe(false)
    expect(parsed.received_fields).toBeDefined()
    expect(parsed.received_fields).toContain('scope')
    expect(parsed.received_fields).toContain('type')
    expect(parsed.received_fields).toContain('tags')
    expect(parsed.error).toContain('Received fields:')
  })

  // Issue #231 — plur_session_end used to crash with unhelpful
  // "Cannot read properties of undefined (reading 'match')" when callers passed
  // engram_suggestions as an array of strings. The schema validator now
  // recursively validates array items; the handler coerces bare strings.
  it('session_end tolerates string-array engram_suggestions through wire protocol (#231)', async () => {
    const result = await client.callTool({
      name: 'plur_session_end',
      arguments: {
        summary: 'wire-level string array test',
        engram_suggestions: ['a learning', 'another learning'],
      },
    })
    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse((result.content as any)[0].text)
    expect(parsed.engrams_created).toBe(2)
  })

  it('session_end rejects invalid item types with clear error (#231)', async () => {
    const result = await client.callTool({
      name: 'plur_session_end',
      arguments: {
        summary: 'wire-level invalid types',
        engram_suggestions: [42],
      },
    })
    expect(result.isError).toBe(true)
    const parsed = JSON.parse((result.content as any)[0].text)
    expect(parsed.success).toBe(false)
    expect(parsed.error).toMatch(/engram_suggestions/)
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
    expect(data.version).toBe('0.14.0')
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

  // --- Version staleness warnings (issue #151) ---

  describe('version staleness warnings', () => {
    const originalFetch = globalThis.fetch

    afterEach(() => {
      globalThis.fetch = originalFetch
      clearVersionCache()
    })

    it('session_start includes version_warning when update available', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: '99.0.0' }),
      }) as any
      await checkForUpdate('@plur-ai/mcp', '0.9.8')

      const result = await client.callTool({
        name: 'plur_session_start',
        arguments: { task: 'test' },
      })
      const data = JSON.parse((result.content as any)[0].text)
      expect(data.version_warning).toBeDefined()
      expect(data.version_warning).toContain('99.0.0')
      expect(data.version).toBeDefined()
    })

    it('session_start prepends hard warning to guide when critically stale', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: '1.5.0' }),
      }) as any
      await checkForUpdate('@plur-ai/mcp', '0.9.8')

      const result = await client.callTool({
        name: 'plur_session_start',
        arguments: { task: 'test' },
      })
      const data = JSON.parse((result.content as any)[0].text)
      expect(data.version_warning).toContain('CRITICAL')
      expect(data.guide).toContain('CRITICAL')
    })

    it('session_start omits version_warning when cache empty', async () => {
      clearVersionCache()
      const result = await client.callTool({
        name: 'plur_session_start',
        arguments: { task: 'test' },
      })
      const data = JSON.parse((result.content as any)[0].text)
      expect(data.version_warning).toBeUndefined()
    })

    it('session_start omits version_warning when version is current', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: '0.9.8' }),
      }) as any
      await checkForUpdate('@plur-ai/mcp', '0.9.8')

      const result = await client.callTool({
        name: 'plur_session_start',
        arguments: { task: 'test' },
      })
      const data = JSON.parse((result.content as any)[0].text)
      expect(data.version_warning).toBeUndefined()
    })

    it('plur_status includes update_available when newer version exists', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: '99.0.0' }),
      }) as any
      await checkForUpdate('@plur-ai/mcp', '0.9.8')

      const result = await client.callTool({ name: 'plur_status', arguments: {} })
      const data = JSON.parse((result.content as any)[0].text)
      expect(data.update_available).toBeDefined()
      expect(data.update_available.latest).toBe('99.0.0')
      expect(data.update_available.behind).toBeGreaterThan(0)
    })

    it('plur_status omits update_available when version is current', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: '0.9.8' }),
      }) as any
      await checkForUpdate('@plur-ai/mcp', '0.9.8')

      const result = await client.callTool({ name: 'plur_status', arguments: {} })
      const data = JSON.parse((result.content as any)[0].text)
      expect(data.update_available).toBeUndefined()
    })
  })
})
