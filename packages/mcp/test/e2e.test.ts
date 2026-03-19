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

  it('full lifecycle', () => {
    // Learn
    const e1 = plur.learn('Always run tests before deploying', { scope: 'global', type: 'procedural' })
    const e2 = plur.learn('Project X uses PostgreSQL', { scope: 'project:x', type: 'architectural' })
    const e3 = plur.learn('User prefers verbose output', { scope: 'global', type: 'behavioral' })

    // Inject — scoped to project:x
    const injected = plur.inject('deploy project X', { scope: 'project:x', budget: 1000 })
    expect(injected.count).toBeGreaterThanOrEqual(1)

    // Feedback
    plur.feedback(e1.id, 'positive')

    // Capture episode
    plur.capture('Deployed project X to staging', { agent: 'claude-code' })

    // Recall
    const results = plur.recall('tests deploying')
    expect(results.some(r => r.statement.includes('tests before deploying'))).toBe(true)

    // Timeline
    const episodes = plur.timeline({ agent: 'claude-code' })
    expect(episodes).toHaveLength(1)

    // Forget
    plur.forget(e3.id, 'no longer relevant')
    const afterForget = plur.recall('verbose output')
    expect(afterForget).toHaveLength(0)
  })

  it('cross-scope isolation', () => {
    plur.learn('Use React for frontend', { scope: 'project:a', type: 'architectural' })
    plur.learn('Use Vue for frontend', { scope: 'project:b', type: 'architectural' })

    // Inject for project:a should prefer React
    const resultA = plur.inject('build frontend', { scope: 'project:a', budget: 500 })
    expect(resultA.directives).toContain('React')

    // Inject for project:b should prefer Vue
    const resultB = plur.inject('build frontend', { scope: 'project:b', budget: 500 })
    expect(resultB.directives).toContain('Vue')
  })

  it('feedback loop improves injection', () => {
    const e1 = plur.learn('Use docker for deployment', { scope: 'global', type: 'procedural' })
    const e2 = plur.learn('Use kubernetes for deployment', { scope: 'global', type: 'procedural' })

    // Positive feedback on e1
    plur.feedback(e1.id, 'positive')
    plur.feedback(e1.id, 'positive')
    plur.feedback(e1.id, 'positive')
    // Negative feedback on e2
    plur.feedback(e2.id, 'negative')
    plur.feedback(e2.id, 'negative')

    // e1 should score higher and appear before e2 in formatted directives string
    const result = plur.inject('deploy the application', { budget: 500 })
    const dockerIdx = result.directives.indexOf('docker')
    const k8sIdx = result.directives.indexOf('kubernetes')
    if (dockerIdx >= 0 && k8sIdx >= 0) {
      expect(dockerIdx).toBeLessThan(k8sIdx)
    }
  })

  it('ingest extracts and saves', () => {
    // Ingest with extract_only = false (saves to store)
    const saved = plur.ingest(
      'We decided to use GraphQL for the API. Always validate inputs at the boundary.',
      { source: 'meeting-notes' }
    )
    expect(saved.length).toBeGreaterThan(0)

    // Status should reflect the saved engrams
    const status = plur.status()
    expect(status.engram_count).toBeGreaterThanOrEqual(saved.length)
  })

  it('status reports accurate counts', () => {
    expect(plur.status().engram_count).toBe(0)
    expect(plur.status().episode_count).toBe(0)

    plur.learn('Test 1', { scope: 'global' })
    plur.learn('Test 2', { scope: 'global' })
    plur.capture('Episode 1', { agent: 'test' })

    const status = plur.status()
    expect(status.engram_count).toBe(2)
    expect(status.episode_count).toBe(1)
  })
})
