import { describe, it, expect } from 'vitest'
import { SessionBreadcrumbs } from '../src/session-state.js'

describe('SessionBreadcrumbs', () => {
  it('records tool calls', () => {
    const bc = new SessionBreadcrumbs()
    bc.recordToolCall('datacore.recall', { topic: 'trading' })
    bc.recordToolCall('datacore.learn', { statement: 'test' })
    expect(bc.getToolCalls()).toHaveLength(2)
    expect(bc.getToolCalls()[0].tool).toBe('datacore.recall')
  })

  it('records engram IDs recalled without duplicates', () => {
    const bc = new SessionBreadcrumbs()
    bc.recordEngramRecalled('ENG-2026-0301-001')
    bc.recordEngramRecalled('ENG-2026-0301-002')
    bc.recordEngramRecalled('ENG-2026-0301-001')
    expect(bc.getEngramsRecalled()).toEqual(['ENG-2026-0301-001', 'ENG-2026-0301-002'])
  })

  it('generates continuation context summary', () => {
    const bc = new SessionBreadcrumbs()
    bc.recordToolCall('datacore.recall', { topic: 'trading' })
    bc.recordToolCall('datacore.learn', { statement: 'new insight' })
    bc.recordEngramRecalled('ENG-2026-0301-001')

    const summary = bc.generateContinuationContext()
    expect(summary).toContain('Tools used: datacore.recall, datacore.learn')
    expect(summary).toContain('Engrams recalled: 1')
  })

  it('returns empty string when no activity', () => {
    const bc = new SessionBreadcrumbs()
    expect(bc.generateContinuationContext()).toBe('')
  })
})

describe('SessionBreadcrumbs meta-engram tracking', () => {
  it('tracks meta-engram injections separately', () => {
    const bc = new SessionBreadcrumbs()
    bc.recordEngramRecalled('ENG-2026-0301-001')
    bc.recordEngramRecalled('META-2026-0302-001')
    bc.recordEngramRecalled('META-2026-0303-002')
    bc.recordEngramRecalled('ENG-2026-0304-003')

    const metaEngrams = bc.getMetaEngramsRecalled()
    expect(metaEngrams).toHaveLength(2)
    expect(metaEngrams).toContain('META-2026-0302-001')
    expect(metaEngrams).toContain('META-2026-0303-002')
  })

  it('returns empty array when no meta-engrams recalled', () => {
    const bc = new SessionBreadcrumbs()
    bc.recordEngramRecalled('ENG-2026-0301-001')
    expect(bc.getMetaEngramsRecalled()).toEqual([])
  })

  it('generates context including meta count when meta-engrams are present', () => {
    const bc = new SessionBreadcrumbs()
    bc.recordToolCall('plur.inject', { task: 'optimize loop' })
    bc.recordEngramRecalled('ENG-2026-0301-001')
    bc.recordEngramRecalled('META-2026-0302-001')
    bc.recordEngramRecalled('META-2026-0303-002')

    const summary = bc.generateContinuationContext()
    expect(summary).toContain('Engrams recalled: 3')
    expect(summary).toContain('Meta-engrams: 2')
  })

  it('omits meta count line when no meta-engrams recalled', () => {
    const bc = new SessionBreadcrumbs()
    bc.recordEngramRecalled('ENG-2026-0301-001')

    const summary = bc.generateContinuationContext()
    expect(summary).toContain('Engrams recalled: 1')
    expect(summary).not.toContain('Meta-engrams')
  })
})
