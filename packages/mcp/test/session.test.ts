import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '@plur-ai/core'
import { getToolDefinitions } from '../src/tools.js'

describe('Session & store tools', () => {
  let plur: Plur
  let dir: string
  let tools: ReturnType<typeof getToolDefinitions>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-session-'))
    plur = new Plur({ path: dir })
    tools = getToolDefinitions()
  })
  afterEach(() => { rmSync(dir, { recursive: true }) })

  const callTool = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find(t => t.name === name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    return tool.handler(args, plur)
  }

  it('plur_session_start returns session_id and engrams when engrams exist', async () => {
    // Seed an engram so injection finds something
    plur.learn('Always use semicolons in TypeScript', { scope: 'global' })

    const result = await callTool('plur_session_start', { task: 'write TypeScript code' }) as any
    expect(result.session_id).toBeDefined()
    expect(typeof result.session_id).toBe('string')
    expect(result.engrams.count).toBeGreaterThan(0)
    expect(result.engrams.injected_ids.length).toBeGreaterThan(0)
    expect(result.store_stats.engram_count).toBe(1)
    expect(result.guide).toContain('Session started with')
  })

  it('plur_session_start returns empty-store guide and setup hint on fresh install', async () => {
    const result = await callTool('plur_session_start', { task: 'something obscure' }) as any
    expect(result.session_id).toBeDefined()
    expect(result.engrams).toEqual([])
    expect(result.store_stats.engram_count).toBe(0)
    expect(result.guide).toContain('0 engrams')
    expect(result.follow_up).toContain('fresh store')
    expect(result.setup_hint).toContain('npx @plur-ai/cli init')
  })

  it('plur_session_start returns guide when engrams exist but none match', async () => {
    plur.learn('Always use semicolons in TypeScript', { scope: 'global' })
    const result = await callTool('plur_session_start', { task: 'cooking recipes for dinner' }) as any
    expect(result.session_id).toBeDefined()
    expect(result.engrams).toEqual([])
    expect(result.store_stats.engram_count).toBe(1)
    expect(result.guide).toContain('1 engrams but none matched')
    expect(result.follow_up).toBeUndefined()
  })

  it('plur_session_end creates engrams from suggestions and captures episode', async () => {
    const result = await callTool('plur_session_end', {
      summary: 'Implemented session management',
      session_id: 'test-session-123',
      engram_suggestions: [
        { statement: 'Always validate session IDs', type: 'behavioral' },
        { statement: 'Sessions use UUID v4 format' },
      ],
    }) as any
    expect(result.engrams_created).toBe(2)
    expect(result.episode_id).toBeDefined()

    // Verify engrams were created
    const status = plur.status()
    expect(status.engram_count).toBe(2)

    // Verify episode was captured
    const episodes = plur.timeline()
    expect(episodes.length).toBe(1)
    expect(episodes[0].summary).toBe('Implemented session management')
  })

  it('plur_session_end works with no suggestions and returns hint', async () => {
    const result = await callTool('plur_session_end', {
      summary: 'Quick session, nothing learned',
    }) as any
    expect(result.engrams_created).toBe(0)
    expect(result.episode_id).toBeDefined()
    expect(result.hint).toContain('No engrams captured')
    expect(result.total_engrams).toBe(0)
  })

  // Issue #231 — handler used to crash with cryptic
  // "Cannot read properties of undefined (reading 'match')"
  // when callers passed bare strings instead of {statement, type} objects.
  it('plur_session_end coerces string-array engram_suggestions (#231)', async () => {
    const result = await callTool('plur_session_end', {
      summary: 'Session with string-shaped suggestions',
      engram_suggestions: ['First learning as a bare string', 'Second learning as a bare string'],
    }) as any
    expect(result.engrams_created).toBe(2)
    expect(result.episode_id).toBeDefined()
    const status = plur.status()
    expect(status.engram_count).toBe(2)
  })

  it('plur_session_end throws a clear error for non-string non-object items (#231)', async () => {
    await expect(callTool('plur_session_end', {
      summary: 'Session with malformed suggestions',
      engram_suggestions: [42, true],
    })).rejects.toThrow(/engram_suggestions\[0\] must be a string or \{statement/)
  })

  it('plur_session_end throws a clear error for object items missing statement (#231)', async () => {
    await expect(callTool('plur_session_end', {
      summary: 'Session with empty objects',
      engram_suggestions: [{ type: 'behavioral' }],
    })).rejects.toThrow(/must be a string or \{statement/)
  })

  // ── Session injection telemetry ──────────────────────────────────────────────
  //
  // session_start records engram injections per-pack into an in-process Map so
  // session_end can surface them as injection_summary. Validates the 25-80
  // sessions/month activation-rate assumption in hypotheses.yaml (H003).

  describe('session injection telemetry', () => {
    it('session_end returns injection_summary when engrams were injected', async () => {
      // Seed an engram so session_start injects something
      plur.learn('Always use semicolons in TypeScript', { scope: 'global' })

      const startResult = await callTool('plur_session_start', { task: 'write TypeScript code' }) as any
      const session_id = startResult.session_id
      expect(session_id).toBeDefined()

      const endResult = await callTool('plur_session_end', {
        summary: 'Wrote TypeScript',
        session_id,
        engram_suggestions: [],
      }) as any

      expect(endResult.injection_summary).toBeDefined()
      expect(endResult.injection_summary.total_injections).toBeGreaterThan(0)
      expect(endResult.injection_summary.pack_counts).toBeDefined()
      // Personal engrams (no pack) show up as __personal__
      expect(endResult.injection_summary.pack_counts.__personal__).toBeGreaterThan(0)
      // session_duration_ms must be a non-negative number
      expect(typeof endResult.injection_summary.session_duration_ms).toBe('number')
      expect(endResult.injection_summary.session_duration_ms).toBeGreaterThanOrEqual(0)
    })

    it('injection_summary.session_duration_ms reflects elapsed wall-clock time', async () => {
      plur.learn('Timing test engram', { scope: 'global' })

      const before = Date.now()
      const startResult = await callTool('plur_session_start', { task: 'timing test' }) as any
      const session_id = startResult.session_id

      const endResult = await callTool('plur_session_end', {
        summary: 'Timing session done',
        session_id,
        engram_suggestions: [],
      }) as any
      const after = Date.now()

      expect(endResult.injection_summary).toBeDefined()
      const { session_duration_ms } = endResult.injection_summary
      // Duration must be a non-negative number bounded by actual wall time
      expect(session_duration_ms).toBeGreaterThanOrEqual(0)
      expect(session_duration_ms).toBeLessThanOrEqual(after - before)
    })

    it('session_end returns no injection_summary when no engrams exist', async () => {
      // No engrams → session_start injects nothing
      const startResult = await callTool('plur_session_start', { task: 'fresh store task' }) as any
      const session_id = startResult.session_id

      const endResult = await callTool('plur_session_end', {
        summary: 'Nothing injected',
        session_id,
        engram_suggestions: [],
      }) as any

      expect(endResult.injection_summary).toBeUndefined()
    })

    it('standalone plur_inject calls accumulate into the session telemetry', async () => {
      plur.learn('Use pnpm for package management', { scope: 'global' })

      const startResult = await callTool('plur_session_start', { task: 'tooling check' }) as any
      const session_id = startResult.session_id

      // Make an additional standalone inject call
      await callTool('plur_inject', { task: 'pnpm install' })

      const endResult = await callTool('plur_session_end', {
        summary: 'Ran pnpm',
        session_id,
        engram_suggestions: [],
      }) as any

      // At least 2 injection calls: one from session_start, one from plur_inject
      expect(endResult.injection_summary).toBeDefined()
      expect(endResult.injection_summary.total_injections).toBeGreaterThanOrEqual(2)
    })

    it('session telemetry is cleared after session_end — no cross-session bleed', async () => {
      plur.learn('Test engram', { scope: 'global' })

      const startA = await callTool('plur_session_start', { task: 'task A' }) as any
      const session_id_A = startA.session_id

      const endA = await callTool('plur_session_end', {
        summary: 'Session A done',
        session_id: session_id_A,
        engram_suggestions: [],
      }) as any
      const injectionsA = endA.injection_summary?.total_injections ?? 0

      // Session B starts fresh — its total_injections should equal A's (same engram,
      // same one inject call from session_start), NOT 2× A's.
      const startB = await callTool('plur_session_start', { task: 'task B' }) as any
      const session_id_B = startB.session_id
      expect(session_id_B).not.toBe(session_id_A)

      const endB = await callTool('plur_session_end', {
        summary: 'Session B done',
        session_id: session_id_B,
        engram_suggestions: [],
      }) as any
      const injectionsB = endB.injection_summary?.total_injections ?? 0

      expect(injectionsB).toBe(injectionsA)
    })
  })

  it('plur_stores_add registers a store in config', async () => {
    const storePath = join(dir, 'extra-store', 'engrams.yaml')
    const storeDir = join(dir, 'extra-store')
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(storePath, '')

    const result = await callTool('plur_stores_add', {
      path: storePath,
      scope: 'space:test',
      shared: true,
    }) as any
    expect(result.success).toBe(true)
    expect(result.path).toBe(storePath)
    expect(result.scope).toBe('space:test')
  })

  it('plur_stores_list returns primary + added stores', async () => {
    // List before adding
    const before = await callTool('plur_stores_list') as any
    expect(before.count).toBe(1) // Primary only
    expect(before.stores[0].scope).toBe('global')

    // Add a store
    const storePath = join(dir, 'extra-engrams.yaml')
    writeFileSync(storePath, '')
    await callTool('plur_stores_add', { path: storePath, scope: 'project:test' })

    // Re-create plur to reload config
    plur = new Plur({ path: dir })

    const after = await callTool('plur_stores_list') as any
    expect(after.count).toBe(2)
    expect(after.stores[1].scope).toBe('project:test')
  })

  it('plur_promote promotes a candidate engram', async () => {
    // Create an engram and manually set it to candidate status
    const engram = plur.learn('Test candidate engram', { scope: 'global' })
    engram.status = 'candidate' as any
    engram.activation.retrieval_strength = 0.3
    plur.updateEngram(engram)

    const result = await callTool('plur_promote', { id: engram.id }) as any
    expect(result.success).toBe(true)
    expect(result.promoted).toHaveLength(1)
    expect(result.promoted[0].id).toBe(engram.id)

    // Verify it's now active
    const updated = plur.getById(engram.id)
    expect(updated!.status).toBe('active')
    expect(updated!.activation.retrieval_strength).toBe(0.7)
  })

  it('plur_promote returns already_active for active engrams', async () => {
    const engram = plur.learn('Already active engram', { scope: 'global' })
    const result = await callTool('plur_promote', { id: engram.id }) as any
    expect(result.success).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].error).toBe('Already active')
  })

  it('plur_promote returns error for retired engrams', async () => {
    const engram = plur.learn('Soon retired', { scope: 'global' })
    await plur.forget(engram.id)
    const result = await callTool('plur_promote', { id: engram.id }) as any
    expect(result.success).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].error).toBe('Cannot promote retired')
  })

  // ── #177: plur_session_start auto-detects project scope from .plur.yaml ──
  //
  // Root cause of #177: session_start didn't read .plur.yaml. Without explicit
  // scope, every plur_learn fell back to 'global', causing context bleed across
  // projects. These tests pin the new behavior: project scope is auto-applied
  // as the session default + surfaced in the response.

  describe('project scope auto-detection (#177)', () => {
    let projectDir: string
    let originalCwd: string

    beforeEach(() => {
      projectDir = mkdtempSync(join(tmpdir(), 'plur-project-'))
      mkdirSync(join(projectDir, '.git'), { recursive: true })  // marks project boundary
      originalCwd = process.cwd()
    })

    afterEach(() => {
      process.chdir(originalCwd)
      rmSync(projectDir, { recursive: true, force: true })
    })

    it('auto-sets session scope from .plur.yaml when present', async () => {
      writeFileSync(join(projectDir, '.plur.yaml'), 'scope: project:test-app\n')
      process.chdir(projectDir)

      const result = await callTool('plur_session_start', { task: 'work' }) as any

      expect(result.default_scope).toBe('project:test-app')
      expect(result.scope_source).toBe('project-config')
      expect(plur.getSessionScope()).toBe('project:test-app')
    })

    it('explicit default_scope arg overrides .plur.yaml', async () => {
      writeFileSync(join(projectDir, '.plur.yaml'), 'scope: project:test-app\n')
      process.chdir(projectDir)

      const result = await callTool('plur_session_start', {
        task: 'work',
        default_scope: 'group:override',
      }) as any

      expect(result.default_scope).toBe('group:override')
      expect(result.scope_source).toBe('caller')
      expect(plur.getSessionScope()).toBe('group:override')
    })

    it('omits default_scope from response when no project config and no explicit arg', async () => {
      // No .plur.yaml; project boundary still present
      process.chdir(projectDir)

      const result = await callTool('plur_session_start', { task: 'work' }) as any

      expect(result.default_scope).toBeUndefined()
      expect(result.scope_source).toBeUndefined()
      expect(plur.getSessionScope()).toBeNull()
    })

    it('learn() without explicit scope uses auto-detected project scope (full integration)', async () => {
      writeFileSync(join(projectDir, '.plur.yaml'), 'scope: project:integration-test\n')
      process.chdir(projectDir)

      await callTool('plur_session_start', { task: 'integration test' })

      const engram = plur.learn('this should NOT leak to global')
      expect(engram.scope).toBe('project:integration-test')
    })

    it('guide includes warning when no project scope detected', async () => {
      process.chdir(projectDir)

      const result = await callTool('plur_session_start', { task: 'work' }) as any

      expect(result.guide).toContain('No project scope detected')
      // 0.10.0 (#353): the guidance is now IMPERATIVE — "Create a .plur.yaml NOW"
      // — and clarifies the personal-recall vs team-store distinction.
      expect(result.guide).toContain('Create a .plur.yaml NOW')
      expect(result.guide).toContain('.plur.yaml')
      expect(result.guide).toContain('PERSONAL recall context')
    })

    it('guide includes confirmation when project scope is auto-detected', async () => {
      writeFileSync(join(projectDir, '.plur.yaml'), 'scope: project:detected\n')
      process.chdir(projectDir)

      const result = await callTool('plur_session_start', { task: 'work' }) as any

      expect(result.guide).toContain('Auto-detected project scope')
      expect(result.guide).toContain('project:detected')
      expect(result.guide).toContain('.plur.yaml')
      // The project-config branch references the EXISTING .plur.yaml but must NOT
      // imperatively tell the user to CREATE one (that's the no-scope branch).
      expect(result.guide).not.toContain('Create a .plur.yaml NOW')
    })

    it('cross-session: project A scope does not leak into project B', async () => {
      const projectA = projectDir
      writeFileSync(join(projectA, '.plur.yaml'), 'scope: project:a\n')
      process.chdir(projectA)
      await callTool('plur_session_start', { task: 'A' })
      expect(plur.getSessionScope()).toBe('project:a')

      const projectB = mkdtempSync(join(tmpdir(), 'plur-project-b-'))
      mkdirSync(join(projectB, '.git'), { recursive: true })
      try {
        process.chdir(projectB)
        await callTool('plur_session_start', { task: 'B' })
        expect(plur.getSessionScope()).toBeNull()  // not "project:a"!

        const bEngram = plur.learn('B-side engram')
        // 0.10.0 (#353): un-scoped writes default to "global" (reverted from the
        // Stage 3b "local"). The property under test is "no cross-project leak"
        // into project:a — "global" satisfies that (it is the personal namespace,
        // not project A's scope). The key assertion is NOT "project:a".
        expect(bEngram.scope).toBe('global')  // not "project:a"
      } finally {
        rmSync(projectB, { recursive: true, force: true })
      }
    })
  })
})
