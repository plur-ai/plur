import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Plur, readHistoryForEngram, generateEventId } from '../src/index.js'

describe('SP2 Idea 7: Enhanced Event-Sourced History', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-sp2-hist-'))
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'allow_secrets: false\n')
    fs.writeFileSync(path.join(dir, 'engrams.yaml'), 'engrams: []\n')
    fs.writeFileSync(path.join(dir, 'episodes.yaml'), '[]\n')
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true })
  })

  it('readHistoryForEngram returns events for specific engram', async () => {
    const plur = new Plur({ path: dir })
    const e1 = plur.learn('First statement')
    const e2 = plur.learn('Second statement')
    await plur.feedback(e1.id, 'positive')

    const history = readHistoryForEngram(dir, e1.id)
    expect(history.length).toBe(2) // created + feedback
    expect(history[0].event).toBe('engram_created')
    expect(history[1].event).toBe('feedback_received')

    const history2 = readHistoryForEngram(dir, e2.id)
    expect(history2.length).toBe(1) // created only
  })

  it('getEngramHistory works via Plur instance', async () => {
    const plur = new Plur({ path: dir })
    const engram = plur.learn('Test engram')
    await plur.feedback(engram.id, 'negative')

    const history = plur.getEngramHistory(engram.id)
    expect(history.length).toBe(2)
    expect(history.every(e => e.engram_id === engram.id)).toBe(true)
  })

  it('readHistoryForEngram returns empty for non-existent engram', () => {
    const history = readHistoryForEngram(dir, 'ENG-2026-0406-999')
    expect(history).toEqual([])
  })

  it('generateEventId returns unique IDs', () => {
    const id1 = generateEventId()
    const id2 = generateEventId()
    expect(id1).toMatch(/^EVT-/)
    expect(id1).not.toBe(id2)
  })

  it('forget logs engram_retired in history', async () => {
    const plur = new Plur({ path: dir })
    const engram = plur.learn('Will be forgotten')
    await plur.forget(engram.id, 'No longer relevant')

    const history = plur.getEngramHistory(engram.id)
    const retiredEvent = history.find(e => e.event === 'engram_retired')
    expect(retiredEvent).toBeDefined()
    expect(retiredEvent!.data.reason).toBe('No longer relevant')
  })
})

describe('SP2 Idea 8: Version Lineage Tracking', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-sp2-ver-'))
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'allow_secrets: false\n')
    fs.writeFileSync(path.join(dir, 'engrams.yaml'), 'engrams: []\n')
    fs.writeFileSync(path.join(dir, 'episodes.yaml'), '[]\n')
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true })
  })

  it('new engrams start at engram_version 1', () => {
    const plur = new Plur({ path: dir })
    const engram = plur.learn('Version test')
    expect((engram as any).engram_version).toBe(1)
  })

  it('new engrams have empty episode_ids', () => {
    const plur = new Plur({ path: dir })
    const engram = plur.learn('Episode test')
    expect((engram as any).episode_ids).toEqual([])
  })

  it('status includes versioned_engram_count', () => {
    const plur = new Plur({ path: dir })
    plur.learn('Test statement')
    const status = plur.status()
    expect(status.versioned_engram_count).toBe(0) // version 1, not > 1
  })
})

describe('SP2 Idea 24: Episodic Anchoring', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-sp2-anc-'))
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'allow_secrets: false\n')
    fs.writeFileSync(path.join(dir, 'engrams.yaml'), 'engrams: []\n')
    fs.writeFileSync(path.join(dir, 'episodes.yaml'), '[]\n')
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true })
  })

  it('auto-links session episode when session_episode_id provided', () => {
    const plur = new Plur({ path: dir })
    const episode = plur.capture('Test session')

    const engram = plur.learn('Learned during session', {
      session_episode_id: episode.id,
    })

    expect((engram as any).episode_ids).toContain(episode.id)
  })

  it('does not link episodes when session_episode_id is not provided', () => {
    const plur = new Plur({ path: dir })
    const engram = plur.learn('No session context')
    expect((engram as any).episode_ids).toEqual([])
  })
})
