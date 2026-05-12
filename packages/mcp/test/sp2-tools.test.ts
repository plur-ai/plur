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

  // memory_class and session_episode_id were removed from the MCP tool
  // inputSchema in plur-ai/plur#139 (LLMs don't fill them meaningfully and
  // the schema bloat costs tokens every session). The features still work
  // at the Plur class level — these tests now assert that contract.
  describe('plur.learn() — memory_class + session_episode_id at Plur class level', () => {
    it('Plur.learn accepts memory_class and stores it on the engram', () => {
      const engram = plur.learn('An episodic memory', { memory_class: 'episodic' })
      expect((engram as any).knowledge_type?.memory_class).toBe('episodic')
    })

    it('Plur.learn accepts session_episode_id and pushes to episode_ids', () => {
      const episode = plur.capture('Test session')
      const engram = plur.learn('Learned in session', { session_episode_id: episode.id })
      expect((engram as any).episode_ids).toContain(episode.id)
    })

    it('MCP plur_learn tool no longer surfaces memory_class or session_episode_id', () => {
      const tool = getTool('plur_learn') as any
      const props = tool.inputSchema.properties
      expect(props.memory_class).toBeUndefined()
      expect(props.session_episode_id).toBeUndefined()
      // But the kept-and-trimmed set is intact:
      expect(props.statement).toBeDefined()
      expect(props.tags).toBeDefined()
      expect(props.rationale).toBeDefined()
      expect(props.pinned).toBeDefined()
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
