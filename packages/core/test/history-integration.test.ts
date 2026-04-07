import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Plur } from '../src/index.js'
import { readHistory } from '../src/history.js'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plur-history-int-'))
}

describe('history integration', () => {
  let dir: string
  let plur: Plur

  beforeEach(() => {
    dir = tmpDir()
    plur = new Plur({ path: dir })
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('records engram_created event on learn()', () => {
    const engram = plur.learn('Test history tracking')
    const now = new Date().toISOString().slice(0, 7)
    const events = readHistory(dir, now)
    expect(events.length).toBeGreaterThanOrEqual(1)
    const created = events.find(e => e.event === 'engram_created' && e.engram_id === engram.id)
    expect(created).toBeDefined()
    expect(created!.data.type).toBe('behavioral')
  })

  it('records feedback_received event on feedback()', () => {
    const engram = plur.learn('Test feedback history')
    plur.feedback(engram.id, 'positive')
    const now = new Date().toISOString().slice(0, 7)
    const events = readHistory(dir, now)
    const feedback = events.find(e => e.event === 'feedback_received' && e.engram_id === engram.id)
    expect(feedback).toBeDefined()
    expect(feedback!.data.signal).toBe('positive')
  })

  it('records engram_retired event on forget()', () => {
    const engram = plur.learn('Test retire history')
    plur.forget(engram.id, 'No longer relevant')
    const now = new Date().toISOString().slice(0, 7)
    const events = readHistory(dir, now)
    const retired = events.find(e => e.event === 'engram_retired' && e.engram_id === engram.id)
    expect(retired).toBeDefined()
    expect(retired!.data.reason).toBe('No longer relevant')
  })

  it('history files are JSONL format (one JSON per line)', () => {
    plur.learn('First engram')
    plur.learn('Second engram')
    const now = new Date().toISOString().slice(0, 7)
    const filePath = path.join(dir, 'history', `${now}.jsonl`)
    expect(fs.existsSync(filePath)).toBe(true)
    const content = fs.readFileSync(filePath, 'utf8')
    const lines = content.trim().split('\n')
    expect(lines.length).toBe(2)
    // Each line is valid JSON
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })
})
