import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { appendHistory, readHistory, HistoryEvent } from '../src/history.js'

let tempDir: string

function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'plur-history-test-'))
  return tempDir
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

const YEAR_MONTH = '2026-04'
const TIMESTAMP = '2026-04-22T10:00:00.000Z'

function makeEvent(eventType: HistoryEvent['event'], data: Record<string, unknown> = {}): HistoryEvent {
  return {
    event: eventType,
    engram_id: `test-engram-${eventType}`,
    timestamp: TIMESTAMP,
    data,
  }
}

describe('history extended event types', () => {
  it('writes and reads back recurrence_detected', () => {
    const root = makeTempDir()
    const event = makeEvent('recurrence_detected', { pattern: 'weekly', count: 5 })
    appendHistory(root, event)
    const events = readHistory(root, YEAR_MONTH)
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('recurrence_detected')
    expect(events[0].data).toEqual({ pattern: 'weekly', count: 5 })
    expect(events[0].engram_id).toBe('test-engram-recurrence_detected')
  })

  it('writes and reads back contradiction_detected', () => {
    const root = makeTempDir()
    const event = makeEvent('contradiction_detected', { conflicting_ids: ['eng-1', 'eng-2'], resolution: 'merge' })
    appendHistory(root, event)
    const events = readHistory(root, YEAR_MONTH)
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('contradiction_detected')
    expect(events[0].data).toEqual({ conflicting_ids: ['eng-1', 'eng-2'], resolution: 'merge' })
  })

  it('writes and reads back scope_promoted', () => {
    const root = makeTempDir()
    const event = makeEvent('scope_promoted', { from_scope: 'local', to_scope: 'global' })
    appendHistory(root, event)
    const events = readHistory(root, YEAR_MONTH)
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('scope_promoted')
    expect(events[0].data).toEqual({ from_scope: 'local', to_scope: 'global' })
  })

  it('writes and reads back buffer_pruned', () => {
    const root = makeTempDir()
    const event = makeEvent('buffer_pruned', { pruned_count: 12, reason: 'capacity' })
    appendHistory(root, event)
    const events = readHistory(root, YEAR_MONTH)
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('buffer_pruned')
    expect(events[0].data).toEqual({ pruned_count: 12, reason: 'capacity' })
  })

  it('writes and reads back weekly_review with stats', () => {
    const root = makeTempDir()
    const stats = {
      engrams_created: 14,
      engrams_retired: 3,
      feedback_events: 22,
      avg_activation: 0.74,
      top_domains: ['infrastructure', 'preferences'],
    }
    const event = makeEvent('weekly_review', stats)
    appendHistory(root, event)
    const events = readHistory(root, YEAR_MONTH)
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('weekly_review')
    expect(events[0].data).toEqual(stats)
    expect(events[0].data['engrams_created']).toBe(14)
    expect(events[0].data['avg_activation']).toBe(0.74)
    expect(events[0].data['top_domains']).toEqual(['infrastructure', 'preferences'])
  })

  it('preserves all new event types written in sequence', () => {
    const root = makeTempDir()
    const newTypes: HistoryEvent['event'][] = [
      'recurrence_detected',
      'contradiction_detected',
      'scope_promoted',
      'buffer_pruned',
      'weekly_review',
    ]
    for (const type of newTypes) {
      appendHistory(root, makeEvent(type, { type }))
    }
    const events = readHistory(root, YEAR_MONTH)
    expect(events).toHaveLength(5)
    expect(events.map(e => e.event)).toEqual(newTypes)
  })
})
