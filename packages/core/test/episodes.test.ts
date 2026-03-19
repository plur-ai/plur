import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { captureEpisode, queryTimeline } from '../src/episodes.js'

describe('episodic memory', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-ep-')) })
  afterEach(() => { rmSync(dir, { recursive: true }) })

  it('captures and retrieves episodes', () => {
    const path = join(dir, 'episodes.yaml')
    captureEpisode(path, 'Fixed auth bug in project X', { agent: 'claude-code' })
    captureEpisode(path, 'Deployed to staging', { agent: 'openclaw', channel: 'telegram' })
    const all = queryTimeline(path)
    expect(all).toHaveLength(2)
  })

  it('filters by agent', () => {
    const path = join(dir, 'episodes.yaml')
    captureEpisode(path, 'Episode 1', { agent: 'claude-code' })
    captureEpisode(path, 'Episode 2', { agent: 'openclaw' })
    const filtered = queryTimeline(path, { agent: 'openclaw' })
    expect(filtered).toHaveLength(1)
    expect(filtered[0].summary).toBe('Episode 2')
  })

  it('filters by date range', () => {
    const path = join(dir, 'episodes.yaml')
    captureEpisode(path, 'Today', { agent: 'test' })
    const since = new Date()
    since.setDate(since.getDate() - 1)
    const results = queryTimeline(path, { since })
    expect(results).toHaveLength(1)
  })

  it('episodes are permanent — no auto-deletion', () => {
    const path = join(dir, 'episodes.yaml')
    for (let i = 0; i < 100; i++) {
      captureEpisode(path, `Episode ${i}`, { agent: 'test' })
    }
    expect(queryTimeline(path)).toHaveLength(100)
  })

  it('searches by text', () => {
    const path = join(dir, 'episodes.yaml')
    captureEpisode(path, 'Fixed authentication bug', { agent: 'test' })
    captureEpisode(path, 'Deployed database migration', { agent: 'test' })
    const results = queryTimeline(path, { search: 'authentication' })
    expect(results).toHaveLength(1)
  })
})
