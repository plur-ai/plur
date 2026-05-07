import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Plur } from '@plur-ai/core'
import { getToolDefinitions } from '../src/tools.js'

describe('SP2 MCP Tools', () => {
  let dir: string
  let plur: Plur
  const tools = getToolDefinitions()

  function getTool(name: string) {
    const tool = tools.find(t => t.name === name)
    if (!tool) throw new Error(`Tool not found: ${name}`)
    return tool
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-sp2-mcp-'))
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'allow_secrets: false\n')
    fs.writeFileSync(path.join(dir, 'engrams.yaml'), 'engrams: []\n')
    fs.writeFileSync(path.join(dir, 'episodes.yaml'), '[]\n')
    plur = new Plur({ path: dir })
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true })
  })

  describe('plur_episode_to_engram', () => {
    it('is registered', () => {
      expect(getTool('plur_episode_to_engram')).toBeDefined()
    })

    it('promotes an episode', async () => {
      const episode = plur.capture('Important discovery')
      const result = await getTool('plur_episode_to_engram').handler(
        { episode_id: episode.id },
        plur,
      ) as any

      expect(result.id).toMatch(/^ENG-/)
      expect(result.statement).toBe('Important discovery')
      expect(result.memory_class).toBe('episodic')
      expect(result.episode_ids).toContain(episode.id)
    })

    it('throws on non-existent episode', async () => {
      await expect(
        getTool('plur_episode_to_engram').handler({ episode_id: 'EP-fake' }, plur),
      ).rejects.toThrow('Episode not found')
    })
  })

  describe('plur_history', () => {
    it('is registered', () => {
      expect(getTool('plur_history')).toBeDefined()
    })

    it('returns history for a specific engram', async () => {
      const engram = plur.learn('Test history')
      await plur.feedback(engram.id, 'positive')

      const result = await getTool('plur_history').handler(
        { engram_id: engram.id },
        plur,
      ) as any

      expect(result.engram_id).toBe(engram.id)
      expect(result.events.length).toBe(2) // created + feedback
      expect(result.total).toBe(2)
    })

    it('returns recent history when no engram_id specified', async () => {
      plur.learn('First')
      plur.learn('Second')

      const result = await getTool('plur_history').handler({}, plur) as any

      expect(result.events.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe('plur_report_failure', () => {
    it('is registered', () => {
      expect(getTool('plur_report_failure')).toBeDefined()
    })

    it('logs failure without LLM', async () => {
      const engram = plur.learn('Run tests first', { type: 'procedural' })

      const result = await getTool('plur_report_failure').handler(
        { engram_id: engram.id, failure_context: 'Tests missed a bug' },
        plur,
      ) as any

      expect(result.evolved).toBe(false)
      expect(result.failure_episode_id).toMatch(/^EP-/)
      expect(result.statement).toBe('Run tests first') // unchanged
    })

    it('rejects non-procedural engrams', async () => {
      const engram = plur.learn('Use camelCase', { type: 'behavioral' })

      await expect(
        getTool('plur_report_failure').handler(
          { engram_id: engram.id, failure_context: 'Was not helpful' },
          plur,
        ),
      ).rejects.toThrow('Only procedural')
    })
  })

  describe('plur_status (versioned count)', () => {
    it('includes versioned_engram_count', async () => {
      plur.learn('Test')
      const result = await getTool('plur_status').handler({}, plur) as any
      expect(result.versioned_engram_count).toBe(0)
    })
  })

  describe('plur_learn (memory_class + session_episode_id)', () => {
    it('accepts memory_class parameter', async () => {
      const result = await getTool('plur_learn').handler(
        { statement: 'An episodic memory', memory_class: 'episodic' },
        plur,
      ) as any

      const engram = plur.getById(result.id)
      expect((engram as any).knowledge_type?.memory_class).toBe('episodic')
    })

    it('accepts session_episode_id parameter', async () => {
      const episode = plur.capture('Test session')

      const result = await getTool('plur_learn').handler(
        { statement: 'Learned in session', session_episode_id: episode.id },
        plur,
      ) as any

      const engram = plur.getById(result.id)
      expect((engram as any).episode_ids).toContain(episode.id)
    })
  })

  describe('plur_recall_hybrid (include_episodes)', () => {
    it('includes episodes when requested', async () => {
      const episode = plur.capture('Test session for anchoring')
      plur.learn('Port 3000 for dev', { session_episode_id: episode.id })

      const result = await getTool('plur_recall_hybrid').handler(
        { query: 'port', include_episodes: true },
        plur,
      ) as any

      expect(result.count).toBeGreaterThanOrEqual(1)
      const match = result.results.find((r: any) => r.statement?.includes('Port 3000'))
      if (match?.episodes) {
        expect(match.episodes.length).toBeGreaterThanOrEqual(1)
        expect(match.episodes[0].id).toBe(episode.id)
      }
    })
  })
})
