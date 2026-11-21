/**
 * `originLines` (inject.ts): every delivered memory with a scope names it on
 * its own line, in every section; a memory whose scope is the empty string
 * has none to name and gets no line.
 */
import { describe, it, expect } from 'vitest'
import { selectAndSpread, formatWithLayer, assignLayer } from '../src/inject.js'
import { EngramSchema } from '../src/schemas/engram.js'

const base = {
  type: 'behavioral', status: 'active', version: 2, tags: ['deploy'],
  activation: { retrieval_strength: 0.9, storage_strength: 1, frequency: 0, last_accessed: '2026-09-20T10:11:12.000Z' },
}

function render(r: ReturnType<typeof selectAndSpread>) {
  return [
    formatWithLayer(r.directives, assignLayer('directives')),
    formatWithLayer(r.constraints, assignLayer('constraints')),
    formatWithLayer(r.consider, assignLayer('consider')),
  ].join('\n')
}

describe('originLines: delivered memories say their scope', () => {
  it('every delivered memory with a scope shows it, in directives, constraints and consider', () => {
    const all = [
      EngramSchema.parse({ ...base, id: 'ENG-2026-1101-501', scope: 'project:alpha', statement: 'deploy with the checklist' }),
      EngramSchema.parse({ ...base, id: 'ENG-2026-1101-502', scope: 'group:acme/eng', polarity: 'dont', statement: 'never deploy on friday' }),
      EngramSchema.parse({ ...base, id: 'ENG-2026-1101-503', scope: 'global', statement: 'deploy notes are kept',
        knowledge_type: { memory_class: 'semantic', cognitive_level: 'remember' } }),
    ]
    const r = selectAndSpread({ prompt: 'deploy', maxTokens: 4000 }, all, [])
    const ids = [...r.directives, ...r.constraints, ...r.consider].map(e => e.id)
    expect(ids.sort()).toEqual(all.map(e => e.id).sort())
    expect(r.constraints.map(e => e.id)).toContain('ENG-2026-1101-502')
    expect(r.consider.map(e => e.id)).toContain('ENG-2026-1101-503')
    const text = render(r)
    for (const e of all) {
      const entry = text.split(/\n(?=\[)/).find(x => x.startsWith(`[${e.id}]`))!
      expect(entry, e.id).toContain(`Scope: ${e.scope}`)
    }
  })

  it('an empty scope is delivered without a scope line', () => {
    const e = EngramSchema.parse({ ...base, id: 'ENG-2026-1101-504', scope: '', statement: 'deploy from main' })
    const r = selectAndSpread({ prompt: 'deploy', maxTokens: 4000 }, [e], [])
    const text = render(r)
    expect(text).toContain('[ENG-2026-1101-504]')
    expect(text).not.toContain('Scope:')
  })
})
