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

  it('generates sequential IDs for same date', () => {
    const now = new Date()
    const date = now.toISOString().slice(0, 10).replace(/-/g, '')
    const prefix = `ENG-${date.slice(0, 4)}-${date.slice(4)}`
    const existing = [
      EngramSchema.parse({ id: `${prefix}-001`, statement: 'a', type: 'behavioral', scope: 'global', status: 'active' }),
      EngramSchema.parse({ id: `${prefix}-002`, statement: 'b', type: 'behavioral', scope: 'global', status: 'active' }),
    ]
    const newId = generateEngramId(existing)
    expect(newId).toBe(`${prefix}-003`)
  })

  it('starts at 001 when no existing IDs match today', () => {
    const existing = [
      EngramSchema.parse({ id: 'ENG-2020-0101-001', statement: 'a', type: 'behavioral', scope: 'global', status: 'active' }),
    ]
    const newId = generateEngramId(existing)
    expect(newId).toMatch(/^ENG-\d{4}-\d{4}-001$/)
  })
})
