import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Plur } from '../src/index.js'
import type { LlmFunction } from '../src/types.js'

describe('SP2 Idea 18: Failure-Driven Procedure Evolution', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-sp2-fail-'))
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'allow_secrets: false\n')
    fs.writeFileSync(path.join(dir, 'engrams.yaml'), 'engrams: []\n')
    fs.writeFileSync(path.join(dir, 'episodes.yaml'), '[]\n')
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true })
  })

  it('rejects non-procedural engrams', async () => {
    const plur = new Plur({ path: dir })
    const engram = plur.learn('Use camelCase', { type: 'behavioral' })

    await expect(
      plur.reportFailure(engram.id, 'Did not work')
    ).rejects.toThrow('Only procedural engrams can evolve')
  })

  it('rejects non-existent engrams', async () => {
    const plur = new Plur({ path: dir })

    await expect(
      plur.reportFailure('ENG-nonexistent', 'Did not work')
    ).rejects.toThrow('Engram not found')
  })

  it('logs failure without rewriting when no LLM provided', async () => {
    const plur = new Plur({ path: dir })
    const engram = plur.learn('Run npm test before deploying', { type: 'procedural' })

    const result = await plur.reportFailure(engram.id, 'Tests passed but deploy still failed')

    expect(result.evolved).toBe(false)
    expect(result.episode.summary).toContain('Failure report')
    expect(result.engram.statement).toBe('Run npm test before deploying') // unchanged

    // Episode should be linked
    const updated = plur.getById(engram.id)
    expect((updated as any).episode_ids).toContain(result.episode.id)
  })

  it('evolves procedure with LLM', async () => {
    const plur = new Plur({ path: dir })
    const engram = plur.learn('Run npm test before deploying', { type: 'procedural' })

    const mockLlm: LlmFunction = async (_prompt: string) => {
      return 'Run npm test AND npm run build before deploying to catch compilation errors'
    }

    const result = await plur.reportFailure(engram.id, 'Deploy failed due to build error', mockLlm)

    expect(result.evolved).toBe(true)
    expect(result.engram.statement).toContain('npm run build')
    expect((result.engram as any).engram_version).toBe(2)
    expect((result.engram as any).previous_version_ref).toBeDefined()
    expect((result.engram as any).previous_version_ref.event_id).toMatch(/^EVT-/)
  })

  it('logs procedure_evolved in history', async () => {
    const plur = new Plur({ path: dir })
    const engram = plur.learn('Check logs before restarting', { type: 'procedural' })

    const mockLlm: LlmFunction = async () => 'Check logs AND metrics before restarting'

    await plur.reportFailure(engram.id, 'Metrics showed the real issue', mockLlm)

    const history = plur.getEngramHistory(engram.id)
    const evolvedEvent = history.find(e => e.event === 'procedure_evolved')
    expect(evolvedEvent).toBeDefined()
    expect(evolvedEvent!.data.old_statement).toBe('Check logs before restarting')
    expect(evolvedEvent!.data.new_version).toBe(2)
  })

  it('increments version on each evolution', async () => {
    const plur = new Plur({ path: dir })
    const engram = plur.learn('Step 1', { type: 'procedural' })

    const mockLlm: LlmFunction = async () => 'Step 1 improved'
    await plur.reportFailure(engram.id, 'Failed once', mockLlm)

    const mockLlm2: LlmFunction = async () => 'Step 1 improved again'
    const result = await plur.reportFailure(engram.id, 'Failed twice', mockLlm2)

    expect((result.engram as any).engram_version).toBe(3)
  })

  it('enforces rate limit of 3 revisions per 24h', async () => {
    const plur = new Plur({ path: dir })
    const engram = plur.learn('Rate limited procedure', { type: 'procedural' })
    const mockLlm: LlmFunction = async () => 'Improved procedure'

    // First 3 should succeed
    await plur.reportFailure(engram.id, 'Failure 1', mockLlm)
    await plur.reportFailure(engram.id, 'Failure 2', mockLlm)
    await plur.reportFailure(engram.id, 'Failure 3', mockLlm)

    // Fourth should be rate limited
    await expect(
      plur.reportFailure(engram.id, 'Failure 4', mockLlm)
    ).rejects.toThrow('Rate limit')
  })

  it('falls back gracefully when LLM throws', async () => {
    const plur = new Plur({ path: dir })
    const engram = plur.learn('Fragile procedure', { type: 'procedural' })

    const failingLlm: LlmFunction = async () => {
      throw new Error('LLM unavailable')
    }

    const result = await plur.reportFailure(engram.id, 'Something broke', failingLlm)

    expect(result.evolved).toBe(false)
    expect(result.engram.statement).toBe('Fragile procedure') // unchanged
    // But failure should still be logged
    const history = plur.getEngramHistory(engram.id)
    expect(history.some(e => e.event === 'failure_reported')).toBe(true)
  })

  it('status shows versioned_engram_count after evolution', async () => {
    const plur = new Plur({ path: dir })
    plur.learn('Regular engram', { type: 'behavioral' })
    const proc = plur.learn('Evolving procedure', { type: 'procedural' })

    const mockLlm: LlmFunction = async () => 'Improved procedure'
    await plur.reportFailure(proc.id, 'Failed', mockLlm)

    const status = plur.status()
    expect(status.versioned_engram_count).toBe(1)
  })
})
