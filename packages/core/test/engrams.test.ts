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

  // #771: new ids use the canonical full-date form, identical to what the
  // enterprise server assigns: ENG-YYYY-MM-DD-NNN.
  it('mints canonical full-date IDs (ENG-YYYY-MM-DD-NNN)', () => {
    const newId = generateEngramId([])
    expect(newId).toMatch(/^ENG-\d{4}-\d{2}-\d{2}-001$/)
    expect(newId).toBe(`ENG-${new Date().toISOString().slice(0, 10)}-001`)
  })

  it('generates sequential IDs for same date', () => {
    const prefix = `ENG-${new Date().toISOString().slice(0, 10)}`
    const existing = [
      EngramSchema.parse({ id: `${prefix}-001`, statement: 'a', type: 'behavioral', scope: 'global', status: 'active' }),
      EngramSchema.parse({ id: `${prefix}-002`, statement: 'b', type: 'behavioral', scope: 'global', status: 'active' }),
    ]
    const newId = generateEngramId(existing)
    expect(newId).toBe(`${prefix}-003`)
  })

  // #771: a store upgraded mid-day already holds legacy compact ids for
  // today — the sequence continues after them rather than restarting at 001.
  it('continues the daily sequence across legacy compact IDs', () => {
    const day = new Date().toISOString().slice(0, 10)
    const legacyPrefix = `ENG-${day.slice(0, 4)}-${day.slice(5, 7)}${day.slice(8, 10)}`
    const existing = [
      EngramSchema.parse({ id: `${legacyPrefix}-007`, statement: 'a', type: 'behavioral', scope: 'global', status: 'active' }),
      EngramSchema.parse({ id: `ENG-${day}-002`, statement: 'b', type: 'behavioral', scope: 'global', status: 'active' }),
    ]
    const newId = generateEngramId(existing)
    expect(newId).toBe(`ENG-${day}-008`)
  })

  it('starts at 001 when no existing IDs match today', () => {
    const existing = [
      // Legacy compact and canonical full-date ids from OTHER days are ignored
      EngramSchema.parse({ id: 'ENG-2020-0101-001', statement: 'a', type: 'behavioral', scope: 'global', status: 'active' }),
      EngramSchema.parse({ id: 'ENG-2020-01-02-004', statement: 'b', type: 'behavioral', scope: 'global', status: 'active' }),
    ]
    const newId = generateEngramId(existing)
    expect(newId).toMatch(/^ENG-\d{4}-\d{2}-\d{2}-001$/)
  })
})
