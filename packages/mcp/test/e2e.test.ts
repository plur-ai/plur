import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Plur } from '@plur-ai/core'

describe('E2E: full learn-inject-feedback-recall lifecycle', () => {
  let plur: Plur
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-e2e-'))
    plur = new Plur({ path: dir })
  })
  afterEach(() => { rmSync(dir, { recursive: true }) })

  it('full lifecycle', async () => {
    // Learn
    const e1 = await plur.learn('Always run tests before deploying', { scope: 'global', type: 'procedural' })
    const e2 = await plur.learn('Project X uses PostgreSQL', { scope: 'project:x', type: 'architectural' })
    const e3 = await plur.learn('User prefers verbose output', { scope: 'global', type: 'behavioral' })

    // Inject — scoped to project:x
    const injected = await plur.inject('deploy project X', { scope: 'project:x', budget: 1000 })
    expect(injected.count).toBeGreaterThanOrEqual(1)

    // Feedback
    await plur.feedback(e1.id, 'positive')

    // Capture episode
    plur.capture('Deployed project X to staging', { agent: 'claude-code' })

    // Recall
    const results = await plur.recall('tests deploying')
    expect(results.some(r => r.statement.includes('tests before deploying'))).toBe(true)

    // Timeline
    const episodes = plur.timeline({ agent: 'claude-code' })
    expect(episodes).toHaveLength(1)

    // Forget
    await plur.forget(e3.id, 'no longer relevant')
    const afterForget = await plur.recall('verbose output')
    expect(afterForget).toHaveLength(0)
  })

  it('cross-scope isolation', async () => {
    await plur.learn('Use React for frontend', { scope: 'project:a', type: 'architectural' })
    await plur.learn('Use Vue for frontend', { scope: 'project:b', type: 'architectural' })

    // Inject for project:a should prefer React
    const resultA = await plur.inject('build frontend', { scope: 'project:a', budget: 500 })
    expect(resultA.directives).toContain('React')

    // Inject for project:b should prefer Vue
    const resultB = await plur.inject('build frontend', { scope: 'project:b', budget: 500 })
    expect(resultB.directives).toContain('Vue')
  })

  it('feedback loop improves injection ranking', async () => {
    // Learn kubernetes FIRST so insertion order favours it. Positive feedback on
    // docker + negative on kubernetes must then OVERCOME insertion order to rank
    // docker ahead — proving feedback (not insertion order) drives ranking.
    //
    // The old test guarded on result.directives.indexOf('docker'/'kubernetes'),
    // but these engrams land in the consider pool, so the directives STRING is
    // empty and both indexOf calls returned -1 — the guard was always false and
    // the ordering assertion never ran. Assert against injected_ids (the ordered
    // id list inject() actually returns), unguarded.
    const k8s = await plur.learn('Use kubernetes for deployment', { scope: 'global', type: 'procedural' })
    const docker = await plur.learn('Use docker for deployment', { scope: 'global', type: 'procedural' })

    await plur.feedback(docker.id, 'positive')
    await plur.feedback(docker.id, 'positive')
    await plur.feedback(docker.id, 'positive')
    await plur.feedback(k8s.id, 'negative')
    await plur.feedback(k8s.id, 'negative')

    const result = await plur.inject('deployment', { budget: 500 })
    // Both engrams are injected for this task…
    expect(result.injected_ids).toContain(docker.id)
    expect(result.injected_ids).toContain(k8s.id)
    // …and docker (positive feedback, learned SECOND) ranks ahead of kubernetes.
    expect(result.injected_ids.indexOf(docker.id))
      .toBeLessThan(result.injected_ids.indexOf(k8s.id))
  })

  it('ingest extracts and saves', async () => {
    // Ingest with extract_only = false (saves to store)
    const saved = await plur.ingest(
      'We decided to use GraphQL for the API. Always validate inputs at the boundary.',
      { source: 'meeting-notes' }
    )
    expect(saved.length).toBeGreaterThan(0)

    // Status should reflect the saved engrams
    const status = await plur.status()
    expect(status.engram_count).toBeGreaterThanOrEqual(saved.length)
  })

  it('status reports accurate counts', async () => {
    expect((await plur.status()).engram_count).toBe(0)
    expect((await plur.status()).episode_count).toBe(0)

    await plur.learn('Test 1', { scope: 'global' })
    await plur.learn('Test 2', { scope: 'global' })
    plur.capture('Episode 1', { agent: 'test' })

    const status = await plur.status()
    expect(status.engram_count).toBe(2)
    expect(status.episode_count).toBe(1)
  })
})
