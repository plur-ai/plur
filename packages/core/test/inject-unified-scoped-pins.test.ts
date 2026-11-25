/**
 * Pins load where they belong (owner decision 2026-11-25): a global pin is
 * always loaded; a scoped pin is always loaded in a session within its scope;
 * in a session with no scope, a scoped pin is not loaded unconditionally but
 * competes as an ordinary candidate, so it comes in only when relevant.
 */
import { describe, it, expect } from 'vitest'
import { buildUnifiedPool } from '../src/inject-unified.js'
import { EngramSchema, type Engram } from '../src/schemas/engram.js'

const today = new Date().toISOString().slice(0, 10)
const mk = (id: string, statement: string, scope: string, pinned: boolean): Engram => ({
  ...EngramSchema.parse({
    id, statement, type: 'behavioral', scope, status: 'active', version: 2, tags: [],
    activation: { retrieval_strength: 0.9, storage_strength: 1, frequency: 0, last_accessed: today },
  }),
  pinned,
}) as Engram

const globalPin = mk('ENG-2026-6001-001', 'Never name a customer', 'global', true)
const scopedPin = mk('ENG-2026-6001-002', 'Release notes go through the changelog bot', 'project:alpha', true)
const plain = mk('ENG-2026-6001-003', 'Deploy on weekday mornings', 'project:alpha', false)
const ids = (es: Engram[]) => es.map(e => e.id)

describe('scoped pins load where they belong', () => {
  it('in a session within its scope, a scoped pin is always loaded', () => {
    const pool = buildUnifiedPool({ prompt: 'cooking recipes', scope: 'project:alpha' }, [globalPin, scopedPin, plain], [])
    expect(ids(pool.pins)).toEqual(expect.arrayContaining([globalPin.id, scopedPin.id]))
  })

  it('in a session with no scope, only global pins are always loaded; a scoped pin competes like any memory', () => {
    const pool = buildUnifiedPool({ prompt: 'cooking recipes' }, [globalPin, scopedPin, plain], [])
    expect(ids(pool.pins)).toEqual([globalPin.id])
    expect(ids(pool.candidates)).toContain(scopedPin.id)
  })

  it('in a session of another scope, a scoped pin is not visible at all', () => {
    const pool = buildUnifiedPool({ prompt: 'cooking recipes', scope: 'project:beta' }, [globalPin, scopedPin, plain], [])
    expect(ids(pool.pins)).toEqual([globalPin.id])
    expect(ids(pool.candidates)).not.toContain(scopedPin.id)
  })
})
