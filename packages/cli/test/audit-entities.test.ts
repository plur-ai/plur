import { describe, it, expect } from 'vitest'
import { extractEntities } from '../src/commands/audit.js'

// #771: engram ids appear in two date shapes — canonical full-date
// (ENG-YYYY-MM-DD-NNN, also server-assigned) and legacy compact
// (ENG-YYYY-MMDD-NNN). Entity extraction must recognize both so audit's
// conflict detection links statements that reference the same engram.
describe('audit extractEntities id-format tolerance', () => {
  it('extracts canonical full-date engram ids', () => {
    const entities = extractEntities('supersedes ENG-2026-07-26-015 per review')
    expect(entities.has('ENG-2026-07-26-015')).toBe(true)
  })

  it('extracts legacy compact engram ids', () => {
    const entities = extractEntities('supersedes ENG-2026-0726-015 per review')
    expect(entities.has('ENG-2026-0726-015')).toBe(true)
  })

  it('extracts store-prefixed ids in either form', () => {
    const entities = extractEntities('see ENG-GPL-2026-07-30-032 and ENG-DFU-2026-0401-001')
    expect(entities.has('ENG-GPL-2026-07-30-032')).toBe(true)
    expect(entities.has('ENG-DFU-2026-0401-001')).toBe(true)
  })
})
