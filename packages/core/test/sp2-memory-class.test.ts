import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Plur } from '../src/index.js'

describe('SP2 Idea 3: Three-Memory Unification', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-sp2-mc-'))
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'allow_secrets: false\n')
    fs.writeFileSync(path.join(dir, 'engrams.yaml'), 'engrams: []\n')
    fs.writeFileSync(path.join(dir, 'episodes.yaml'), '[]\n')
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true })
  })

  it('auto-sets memory_class=semantic for behavioral engrams', () => {
    const plur = new Plur({ path: dir })
    const engram = plur.learn('Always use camelCase', { type: 'behavioral' })
    expect((engram as any).knowledge_type?.memory_class).toBe('semantic')
  })

  it('auto-sets memory_class=procedural for procedural engrams', () => {
    const plur = new Plur({ path: dir })
    const engram = plur.learn('Run npm test before committing', { type: 'procedural' })
    expect((engram as any).knowledge_type?.memory_class).toBe('procedural')
  })

  it('auto-sets memory_class=semantic for terminological engrams', () => {
    const plur = new Plur({ path: dir })
    const engram = plur.learn('A widget is a reusable component', { type: 'terminological' })
    expect((engram as any).knowledge_type?.memory_class).toBe('semantic')
  })

  it('auto-sets memory_class=semantic for architectural engrams', () => {
    const plur = new Plur({ path: dir })
    const engram = plur.learn('Use event sourcing for audit', { type: 'architectural' })
    expect((engram as any).knowledge_type?.memory_class).toBe('semantic')
  })

  it('respects explicit memory_class override', () => {
    const plur = new Plur({ path: dir })
    const engram = plur.learn('That time the server crashed', { type: 'behavioral', memory_class: 'episodic' })
    expect((engram as any).knowledge_type?.memory_class).toBe('episodic')
  })

  it('defaults to semantic when type is omitted', () => {
    const plur = new Plur({ path: dir })
    const engram = plur.learn('Use port 3000 for development')
    expect((engram as any).knowledge_type?.memory_class).toBe('semantic')
  })
})

describe('SP2 Idea 3: Episode to Engram promotion', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-sp2-ep-'))
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'allow_secrets: false\n')
    fs.writeFileSync(path.join(dir, 'engrams.yaml'), 'engrams: []\n')
    fs.writeFileSync(path.join(dir, 'episodes.yaml'), '[]\n')
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true })
  })

  it('promotes an episode to an episodic engram', () => {
    const plur = new Plur({ path: dir })
    const episode = plur.capture('Discovered a critical bug in the deploy pipeline')
    const engram = plur.episodeToEngram(episode.id)

    expect(engram.statement).toBe('Discovered a critical bug in the deploy pipeline')
    expect((engram as any).knowledge_type?.memory_class).toBe('episodic')
    expect(engram.source).toBe(`episode:${episode.id}`)
    expect((engram as any).episode_ids).toContain(episode.id)
  })

  it('throws on non-existent episode', () => {
    const plur = new Plur({ path: dir })
    expect(() => plur.episodeToEngram('EP-nonexistent')).toThrow('Episode not found')
  })

  it('passes context to the created engram', () => {
    const plur = new Plur({ path: dir })
    const episode = plur.capture('Important meeting outcome')
    const engram = plur.episodeToEngram(episode.id, { domain: 'meetings', tags: ['important'] })

    expect(engram.domain).toBe('meetings')
    expect(engram.tags).toContain('important')
  })

  it('logs promotion in history', () => {
    const plur = new Plur({ path: dir })
    const episode = plur.capture('Something important happened')
    const engram = plur.episodeToEngram(episode.id)

    const history = plur.getEngramHistory(engram.id)
    const promotionEvents = history.filter(e => e.event === 'engram_promoted')
    expect(promotionEvents.length).toBe(1)
    expect(promotionEvents[0].data.from_episode).toBe(episode.id)
  })
})
