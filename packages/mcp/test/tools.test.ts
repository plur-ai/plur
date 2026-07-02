import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur, _setCachedReranker, _resetRerankerCache, resetRerankerStatus, rerankerStatus } from '@plur-ai/core'
import type { RerankerAdapter } from '@plur-ai/core'
import { getToolDefinitions } from '../src/tools.js'

describe('MCP tools', () => {
  let plur: Plur
  let dir: string
  let tools: ReturnType<typeof getToolDefinitions>

  // #469: the first hybrid recall in a fresh process pays the cold ONNX
  // embedder load synchronously (learn() embeds in the background, so it
  // doesn't count as a warm-up) — on CI runners that alone can blow vitest's
  // 5s default and fail whichever recall-shaped test runs first. Warm the
  // query-embedding path once, with a hook timeout sized for a cold cache,
  // so individual tests measure logic, not model load.
  beforeAll(async () => {
    const warmDir = mkdtempSync(join(tmpdir(), 'plur-mcp-warm-'))
    try {
      const warm = new Plur({ path: warmDir })
      warm.learn('embedder warm-up', { scope: 'global' })
      await warm.recallHybrid('embedder warm-up')
    } finally {
      rmSync(warmDir, { recursive: true, force: true })
    }
  }, 120_000)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-mcp-'))
    plur = new Plur({ path: dir })
    tools = getToolDefinitions()
  })
  afterEach(() => { rmSync(dir, { recursive: true }) })

  const callTool = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find(t => t.name === name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    return tool.handler(args, plur)
  }

  it('defines all PLUR tools', () => {
    const names = tools.map(t => t.name)
    expect(names).toContain('plur_learn')
    expect(names).toContain('plur_recall')
    expect(names).toContain('plur_inject')
    expect(names).toContain('plur_feedback')
    expect(names).toContain('plur_forget')
    expect(names).toContain('plur_capture')
    expect(names).toContain('plur_timeline')
    expect(names).toContain('plur_ingest')
    expect(names).toContain('plur_packs_install')
    expect(names).toContain('plur_packs_list')
    expect(names).toContain('plur_status')
  })

  it('plur_learn creates an engram', async () => {
    const result = await callTool('plur_learn', { statement: 'Test learning', scope: 'global' }) as any
    expect(result.id).toMatch(/^ENG-/)
    expect(result.statement).toBe('Test learning')
  })

  // #347 — temporal validity params on the write path.
  describe('plur_learn temporal validity (#347)', () => {
    it('accepts explicit valid_until and echoes it back', async () => {
      const result = await callTool('plur_learn', {
        statement: 'Conference discount code is CONF20',
        scope: 'global',
        valid_until: '2099-12-31',
      }) as any
      expect(result.valid_until).toBe('2099-12-31')
      const stored = plur.getById(result.id)
      expect(stored?.temporal?.valid_until).toBe('2099-12-31')
    })

    it('accepts explicit valid_from and echoes it back', async () => {
      const result = await callTool('plur_learn', {
        statement: 'New pricing takes effect next fiscal year',
        scope: 'global',
        valid_from: '2099-01-01',
      }) as any
      expect(result.valid_from).toBe('2099-01-01')
    })

    it('echoes an auto-extracted expiry date with a confirmation note', async () => {
      const result = await callTool('plur_learn', {
        statement: 'Enterprise offer REV.002, valid until 31 May 2026',
        scope: 'global',
      }) as any
      expect(result.valid_until).toBe('2026-05-31')
      expect(result.expiry_note).toContain('2026-05-31')
      expect(result.expiry_note).toContain('valid_until')
    })

    it('does not add an expiry note for explicit params', async () => {
      const result = await callTool('plur_learn', {
        statement: 'Plain fact with no dates',
        scope: 'global',
        valid_until: '2099-12-31',
      }) as any
      expect(result.expiry_note).toBeUndefined()
    })
  })

  // #296 — team knowledge silently defaulting to 'global'. When a team store is
  // configured and no scope is passed, surface a hint at the moment of the write.
  describe('scope hint when a team store is configured (#296)', () => {
    beforeEach(() => {
      plur.addStore('', 'group:acme/engineering', { url: 'https://plur.example.com', token: 'tok' })
    })

    it('hints to use the team scope when scope is omitted and engram lands at a personal scope', async () => {
      const result = await callTool('plur_learn', { statement: 'We use trunk-based development' }) as any
      // 0.10.0 (#353): un-scoped writes default to "global" (reverted). The hint
      // must still fire on a personal landing scope (global is personal-family)
      // when a team store exists — the scope_hint now keys off isSharedScope.
      expect(result.scope).toBe('global')
      expect(result.scope_hint).toBeDefined()
      expect(result.scope_hint).toContain('group:acme/engineering')
    })

    it('hints on a user:* personal landing scope (proves isSharedScope swap, #353)', async () => {
      // A user:alice scope is personal-family (not shared). Drive the engram to
      // land there WITHOUT an explicit args.scope by setting a session default,
      // so explicitScope is false and the hint must fire (the old hardcoded
      // {local,global} set would have stayed silent on user:alice).
      plur.setSessionScope('user:alice')
      try {
        const result = await callTool('plur_learn', { statement: 'team prefers tabs over spaces' }) as any
        expect(result.scope).toBe('user:alice')
        expect(result.scope_hint).toBeDefined()
        expect(result.scope_hint).toContain('group:acme/engineering')
      } finally {
        plur.setSessionScope(null)
      }
    })

    it('no hint when an explicit scope is passed', async () => {
      const result = await callTool('plur_learn', {
        statement: 'We use trunk-based development', scope: 'group:acme/engineering',
      }) as any
      expect(result.scope_hint).toBeUndefined()
    })

    it('no hint when the explicit scope is global on purpose', async () => {
      const result = await callTool('plur_learn', { statement: 'TS enums are slow', scope: 'global' }) as any
      expect(result.scope_hint).toBeUndefined()
    })
  })

  // LOW-22 (#353): the ONLY combo where wasRouted suppresses the hint — an
  // un-scoped write that AUTO-ROUTES (Stage 3b) to a PERSONAL landing scope while
  // a writable team store IS configured. Without the wasRouted-silence branch the
  // hint would fire (personal landing + team store); with it, the routing decision
  // already explained the scope, so the hint must stay silent.
  describe('scope hint is suppressed after a Stage-3b auto-route to a personal scope (LOW-22)', () => {
    let routedDir: string
    let routedPlur: Plur
    const routedCall = async (name: string, args: Record<string, unknown> = {}) => {
      const tool = tools.find(t => t.name === name)!
      return tool.handler(args, routedPlur)
    }

    beforeEach(() => {
      routedDir = mkdtempSync(join(tmpdir(), 'plur-mcp-routed-'))
      // Two stores:
      //  (1) a writable LOCAL store at scope:"global" (PERSONAL family) whose
      //      covers confidently match the statement → auto-route lands at global
      //      and stamps _routed, so wasRouted=true.
      //  (2) a writable REMOTE team store so getWritableRemoteScopes() is non-empty
      //      — i.e. the hint WOULD fire if wasRouted were not honored.
      const globalPath = join(routedDir, 'global.yaml')
      writeFileSync(join(routedDir, 'config.yaml'),
        `index: false\n` +
        `stores:\n` +
        `  - path: ${globalPath}\n` +
        `    scope: global\n` +
        `    description: Personal global\n` +
        `    covers: ['plur.*', 'embeddings', 'core']\n` +
        `  - url: https://plur.example.com\n` +
        `    token: tok\n` +
        `    scope: group:acme/engineering\n` +
        `    shared: true\n` +
        `    readonly: false\n`,
      )
      routedPlur = new Plur({ path: routedDir })
    })
    afterEach(() => { rmSync(routedDir, { recursive: true, force: true }) })

    it('auto-routes to global, stamps routed, and SUPPRESSES the scope_hint', async () => {
      // No scope passed; domain-prefix + tag + keyword hits clear the threshold.
      const result = await routedCall('plur_learn', {
        statement: 'the embeddings index for the core engine',
        domain: 'plur.core.embeddings',
        tags: ['embeddings'],
      }) as any
      // Landed at the personal (global) scope via auto-route...
      expect(result.scope).toBe('global')
      expect(result.routed).toBeDefined()
      expect(result.routed.scope).toBe('global')
      // ...and the hint is SILENT even though a team store is configured
      // (wasRouted-silence — the only combo that suppresses).
      expect(result.scope_hint).toBeUndefined()
    })

    it('control: the SAME personal landing WITHOUT a route DOES fire the hint', async () => {
      // No covers match → no auto-route → wasRouted=false → hint fires (proves the
      // suppression above is the wasRouted branch, not the team store being absent).
      const result = await routedCall('plur_learn', {
        statement: 'an unrelated note that matches no covers at all',
      }) as any
      expect(result.scope).toBe('global')
      expect(result.routed).toBeUndefined()
      expect(result.scope_hint).toBeDefined()
      expect(result.scope_hint).toContain('group:acme/engineering')
    })
  })

  it('plur_learn does NOT hint on a personal install (no team store configured)', async () => {
    const result = await callTool('plur_learn', { statement: 'Personal note' }) as any
    // 0.10.0 (#353): un-scoped writes default to "global"; with no team store
    // there is nowhere to route to, so the hint stays silent.
    expect(result.scope).toBe('global')
    expect(result.scope_hint).toBeUndefined()
  })

  it('plur_learn strips XML envelope artifacts from statement (#145)', async () => {
    // Reproduce the corruption: LLM generates old XML tool-call format where the
    // statement value contains the closing tag + duplicated parameter body.
    const corrupted = 'Use snake_case for all identifiers.</statement>\n\n<parameter name="statement">Use snake_case for all identifiers.</parameter>\n<parameter name="type">behavioral</parameter>'
    const result = await callTool('plur_learn', { statement: corrupted }) as any
    expect(result.statement).toBe('Use snake_case for all identifiers.')
    expect(result.statement).not.toContain('</statement>')
    expect(result.statement).not.toContain('<parameter name=')
  })

  it('plur_learn does not truncate clean statements', async () => {
    const clean = 'Always verify timestamps with python before committing.'
    const result = await callTool('plur_learn', { statement: clean }) as any
    expect(result.statement).toBe(clean)
  })

  it('plur_recall finds learned engrams', async () => {
    await callTool('plur_learn', { statement: 'API uses snake_case', scope: 'global' })
    const result = await callTool('plur_recall', { query: 'API snake' }) as any
    expect(result.results.length).toBeGreaterThan(0)
  })

  it('plur_inject returns formatted injection', async () => {
    await callTool('plur_learn', { statement: 'Always deploy carefully', scope: 'global' })
    const result = await callTool('plur_inject', { task: 'deploy the application' }) as any
    expect(result.count).toBeGreaterThan(0)
  })

  it('plur_feedback updates engram', async () => {
    const learned = await callTool('plur_learn', { statement: 'Test feedback engram', scope: 'global' }) as any
    const result = await callTool('plur_feedback', { id: learned.id, signal: 'positive' }) as any
    expect(result.success).toBe(true)
  })

  it('plur_capture and plur.timeline work', async () => {
    await callTool('plur_capture', { summary: 'Test episode', agent: 'test' })
    const result = await callTool('plur_timeline', {}) as any
    expect(result.episodes.length).toBe(1)
  })

  it('plur_status returns counts', async () => {
    const result = await callTool('plur_status', {}) as any
    expect(result.engram_count).toBe(0)
    await callTool('plur_learn', { statement: 'Status test', scope: 'global' })
    const result2 = await callTool('plur_status', {}) as any
    expect(result2.engram_count).toBe(1)
  })

  it('plur_status includes running version', async () => {
    const result = await callTool('plur_status', {}) as any
    expect(result.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  // #452 — injection-provenance event/label counts feed #202's volume gate.
  it('plur_status surfaces injection event and label counts', async () => {
    const empty = await callTool('plur_status', {}) as any
    expect(empty.history_events).toEqual({
      co_injection: 0,
      injection_outcome: 0,
      outcome_positive: 0,
      outcome_negative: 0,
    })

    const learned = await callTool('plur_learn', { statement: 'Always use pnpm for package installation', scope: 'global' }) as any
    await callTool('plur_inject', { task: 'how do I run pnpm installation for a package' })
    await callTool('plur_feedback', { id: learned.id, signal: 'positive' })

    const result = await callTool('plur_status', {}) as any
    expect(result.history_events).toEqual({
      co_injection: 1,
      injection_outcome: 1,
      outcome_positive: 1,
      outcome_negative: 0,
    })
  })

  // plur_stores_add must report an honest status, never an unconditional
  // success:true that masks a dropped scope (#291).
  describe('plur_stores_add status reporting (#291)', () => {
    const url = 'https://plur.datafund.io/sse'

    it('reports status:added for a second scope on the same remote URL', async () => {
      const first = await callTool('plur_stores_add', { url, token: 'tok', scope: 'group:plur/plur-ai/engineering' }) as any
      expect(first).toMatchObject({ success: true, status: 'added', kind: 'remote' })

      // The bug: this used to return success:true while persisting nothing.
      const second = await callTool('plur_stores_add', { url, token: 'tok', scope: 'group:plur/plur-ai/comms' }) as any
      expect(second).toMatchObject({ success: true, status: 'added', scope: 'group:plur/plur-ai/comms' })

      // Both scopes are now visible in the listing (alongside the default local
      // store, so we assert on scopes present rather than total count).
      const list = await callTool('plur_stores_list', {}) as any
      const scopes = list.stores.map((s: any) => s.scope)
      expect(scopes).toContain('group:plur/plur-ai/engineering')
      expect(scopes).toContain('group:plur/plur-ai/comms')
    })

    it('reports status:already_registered on an exact url+scope repeat', async () => {
      await callTool('plur_stores_add', { url, token: 'tok', scope: 'group:plur/plur-ai/engineering' })
      const repeat = await callTool('plur_stores_add', { url, token: 'tok', scope: 'group:plur/plur-ai/engineering' }) as any
      expect(repeat).toMatchObject({ success: true, status: 'already_registered' })

      // The repeat must not have created a duplicate entry for that scope.
      const list = await callTool('plur_stores_list', {}) as any
      const engineering = list.stores.filter((s: any) => s.scope === 'group:plur/plur-ai/engineering')
      expect(engineering).toHaveLength(1)
    })
  })

  // #341 — reranker non-engagement is silent at runtime. When PLUR_RERANKER
  // requests reranking but the cross-encoder can't engage (corrupt download,
  // model unavailable), recall silently degrades to RRF order. These tests
  // pin the surfacing: a warning on the recall response and a plur_doctor
  // check with corrupt-vs-unavailable remediation. Fakes are seeded into the
  // adapter cache so no test touches the real ~300 MB model.
  describe('reranker non-engagement surfacing (#341)', () => {
    const BGE = 'bge-reranker-v2-m3' as const
    const BGE_MODEL_ID = 'onnx-community/bge-reranker-v2-m3-ONNX'

    const failing = (message: string): RerankerAdapter => ({
      name: BGE,
      modelId: BGE_MODEL_ID,
      async score(): Promise<number> { throw new Error(message) },
      async scoreBatch(): Promise<number[]> { throw new Error(message) },
    })

    const working = (): RerankerAdapter => ({
      name: BGE,
      modelId: BGE_MODEL_ID,
      async score(): Promise<number> { return 0.5 },
      async scoreBatch(_q: string, docs: string[]): Promise<number[]> { return docs.map(() => 0.5) },
    })

    beforeEach(() => {
      process.env.PLUR_RERANKER = BGE
      _resetRerankerCache()
      resetRerankerStatus()
      plur.learn('The deploy target for staging is cluster-2', { scope: 'global' })
    })
    afterEach(() => {
      delete process.env.PLUR_RERANKER
      _resetRerankerCache()
      resetRerankerStatus()
    })

    it('plur_recall_hybrid warns when reranking is requested but never engages', async () => {
      _setCachedReranker(BGE, failing('fetch failed: getaddrinfo ENOTFOUND huggingface.co'))
      const result = await callTool('plur_recall_hybrid', { query: 'deploy target staging' }) as any
      expect(result.count).toBeGreaterThan(0)   // recall still returns results
      expect(result.reranked).toBe(0)
      expect(result.reranker_warning).toContain('RRF-only')
      expect(result.reranker_warning).toContain('plur_doctor')
    })

    it('the recall warning flags a corrupt model cache distinctly', async () => {
      _setCachedReranker(BGE, failing('Protobuf parsing failed.'))
      const result = await callTool('plur_recall_hybrid', { query: 'deploy target staging' }) as any
      expect(result.reranker_warning).toContain('corrupt')
      expect(result.reranker_warning).toContain('Protobuf parsing failed.')
    })

    it('does not warn when the reranker engages', async () => {
      _setCachedReranker(BGE, working())
      const result = await callTool('plur_recall_hybrid', { query: 'deploy target staging' }) as any
      expect(result.reranked).toBeGreaterThan(0)
      expect(result.reranker_warning).toBeUndefined()
    })

    it('omits the reranked field and never warns when PLUR_RERANKER is off', async () => {
      delete process.env.PLUR_RERANKER
      const result = await callTool('plur_recall_hybrid', { query: 'deploy target staging' }) as any
      expect(result.count).toBeGreaterThan(0)
      expect(result.reranked).toBeUndefined()
      expect(result.reranker_warning).toBeUndefined()
    })

    it('plur_doctor reports a corrupt reranker cache with purge remediation', async () => {
      _setCachedReranker(BGE, failing('Protobuf parsing failed.'))
      const result = await callTool('plur_doctor') as any
      const check = result.checks.find((c: any) => c.check === 'reranker available')
      expect(check).toBeDefined()
      expect(check.ok).toBe(false)
      expect(check.detail).toContain('corrupt')
      expect(check.detail).toContain('RRF-only')
      const remediation = result.remediation.join('\n')
      expect(remediation).toContain('models--onnx-community--bge-reranker-v2-m3-ONNX')
      expect(result.ok).toBe(false)
    })

    it('plur_doctor reports an unavailable reranker with connectivity remediation', async () => {
      _setCachedReranker(BGE, failing('fetch failed: getaddrinfo ENOTFOUND huggingface.co'))
      const result = await callTool('plur_doctor') as any
      const check = result.checks.find((c: any) => c.check === 'reranker available')
      expect(check.ok).toBe(false)
      expect(check.detail).toContain('Failed to load')
      expect(result.remediation.join('\n')).toContain('huggingface.co')
    })

    it('plur_doctor reports a healthy reranker when the probe scores', async () => {
      _setCachedReranker(BGE, working())
      const result = await callTool('plur_doctor') as any
      const check = result.checks.find((c: any) => c.check === 'reranker available')
      expect(check.ok).toBe(true)
      // #220: seconds-scale per recall on CPU is expected, not a fault — the
      // healthy detail says so instead of letting users misread the latency.
      expect(check.detail).toContain('seconds')
    })

    it('plur_doctor healthy detail is tier-aware for the tiny reranker (#451)', async () => {
      // The tiny tier's whole point is ms-scale on the hot path — the healthy
      // detail must not repeat the bge "seconds-scale is expected" framing.
      const TINY = 'ms-marco-minilm-l6' as const
      process.env.PLUR_RERANKER = TINY
      _setCachedReranker(TINY, {
        name: TINY,
        modelId: 'Xenova/ms-marco-MiniLM-L-6-v2',
        async score(): Promise<number> { return 0.5 },
        async scoreBatch(_q: string, docs: string[]): Promise<number[]> { return docs.map(() => 0.5) },
      })
      const result = await callTool('plur_doctor') as any
      const check = result.checks.find((c: any) => c.check === 'reranker available')
      expect(check.ok).toBe(true)
      expect(check.detail).not.toContain('seconds-scale')
      expect(check.detail).toContain('ms-scale')
    })

    it('plur_doctor skips the reranker check when PLUR_RERANKER is off', async () => {
      delete process.env.PLUR_RERANKER
      const result = await callTool('plur_doctor') as any
      expect(result.checks.find((c: any) => c.check === 'reranker available')).toBeUndefined()
    })

    it('plur_doctor retry:true clears recorded reranker failures', async () => {
      _setCachedReranker(BGE, failing('Protobuf parsing failed.'))
      await callTool('plur_recall_hybrid', { query: 'deploy target staging' })
      expect(rerankerStatus().failure_count).toBeGreaterThan(0)
      // Turn the env off so the doctor probe does not attempt a real model
      // load after the cache reset — we only assert the state reset here.
      delete process.env.PLUR_RERANKER
      await callTool('plur_doctor', { retry: true })
      expect(rerankerStatus().failure_count).toBe(0)
      expect(rerankerStatus().lastError).toBeNull()
    })
  })

  describe('plur_stores_add honest reporting for a re-registered local path (#406)', () => {
    it('reports success:false and the dropped requested scope when a local path already exists', async () => {
      const storePath = join(dir, 'extra', 'engrams.yaml')
      const first = await callTool('plur_stores_add', { path: storePath, scope: 'space:original' }) as any
      expect(first.success).toBe(true)
      expect(first.status).toBe('added')

      // Same path, NEW scope: a local store is path-keyed, so the scope is dropped.
      const second = await callTool('plur_stores_add', { path: storePath, scope: 'space:other' }) as any
      expect(second.success).toBe(false)               // not a silent success
      expect(second.status).toBe('already_registered')
      expect(second.scope).toBe('space:original')      // the existing scope wins
      expect(second.requested_scope).toBe('space:other')
      expect(second.note).toMatch(/was NOT added/)
    })

    it('still reports success when the same path + same scope is a true no-op', async () => {
      const storePath = join(dir, 'extra2', 'engrams.yaml')
      await callTool('plur_stores_add', { path: storePath, scope: 'space:same' })
      const again = await callTool('plur_stores_add', { path: storePath, scope: 'space:same' }) as any
      expect(again.success).toBe(true)                 // idempotent no-op, not a drop
      expect(again.status).toBe('already_registered')
      expect(again.requested_scope).toBeUndefined()
    })
  })
})
