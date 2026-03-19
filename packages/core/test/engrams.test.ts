import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { loadEngrams, saveEngrams, generateEngramId } from '../src/engrams.js'
import { EngramSchema } from '../src/schemas/engram.js'

describe('engrams', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-test-')) })
  afterEach(() => { rmSync(dir, { recursive: true }) })

  it('saves and loads engrams', () => {
    const engram = EngramSchema.parse({
      id: 'ENG-2026-0319-001',
      statement: 'test',
      type: 'behavioral',
      scope: 'global',
      status: 'active',
    })
    const path = join(dir, 'engrams.yaml')
    saveEngrams(path, [engram])
    const loaded = loadEngrams(path)
    expect(loaded).toHaveLength(1)
    expect(loaded[0].statement).toBe('test')
  })

  it('returns empty array for missing file', () => {
    const loaded = loadEngrams(join(dir, 'nonexistent.yaml'))
    expect(loaded).toEqual([])
  })

  it('generates sequential IDs', () => {
    const existing = [
      EngramSchema.parse({ id: 'ENG-2026-0319-001', statement: 'a', type: 'behavioral', scope: 'global', status: 'active' }),
      EngramSchema.parse({ id: 'ENG-2026-0319-002', statement: 'b', type: 'behavioral', scope: 'global', status: 'active' }),
    ]
    const newId = generateEngramId(existing)
    expect(newId).toMatch(/^ENG-\d{4}-\d{4}-003$/)
  })
})
