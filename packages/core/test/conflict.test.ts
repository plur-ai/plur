import { describe, it, expect } from 'vitest'
import { detectConflicts } from '../src/conflict.js'
import { EngramSchema } from '../src/schemas/engram.js'

describe('conflict detection', () => {
  const makeEngram = (statement: string, scope = 'project:myapp') =>
    EngramSchema.parse({
      id: 'ENG-2026-0319-001',
      statement,
      type: 'behavioral',
      scope,
      status: 'active',
    })

  it('detects contradictory engrams in same scope', () => {
    const existing = [makeEngram('API uses camelCase')]
    const conflicts = detectConflicts(
      { statement: 'API uses snake_case', scope: 'project:myapp' },
      existing
    )
    expect(conflicts).toHaveLength(1)
  })

  it('does not flag different scopes', () => {
    const existing = [makeEngram('Database uses PostgreSQL', 'project:other')]
    const conflicts = detectConflicts(
      { statement: 'API uses snake_case', scope: 'project:myapp' },
      existing
    )
    expect(conflicts).toHaveLength(0)
  })

  it('ignores retired engrams', () => {
    const existing = [EngramSchema.parse({
      id: 'ENG-2026-0319-001',
      statement: 'API uses camelCase',
      type: 'behavioral',
      scope: 'project:myapp',
      status: 'retired',
    })]
    const conflicts = detectConflicts(
      { statement: 'API uses snake_case', scope: 'project:myapp' },
      existing
    )
    expect(conflicts).toHaveLength(0)
  })
})
