import type { Migration } from './types.js'
import type { Engram } from '../schemas/engram.js'

const TYPE_TO_MEMORY_CLASS: Record<string, 'semantic' | 'episodic' | 'procedural' | 'metacognitive'> = {
  behavioral: 'semantic',
  terminological: 'semantic',
  procedural: 'procedural',
  architectural: 'semantic',
}

/**
 * Migration: Populate knowledge_type.memory_class based on engram type.
 * Maps: behavioral → semantic, terminological → semantic, procedural → procedural, architectural → semantic.
 */
export const migration: Migration = {
  id: '20260406-003-populate-memory-class',
  description: 'Populate existing knowledge_type.memory_class based on type',
  up(engrams: Engram[]): Engram[] {
    return engrams.map(e => {
      const raw = e as any
      if (raw.knowledge_type?.memory_class) return e // already set
      const memoryClass = TYPE_TO_MEMORY_CLASS[e.type] ?? 'semantic'
      const cogLevel = raw.knowledge_type?.cognitive_level ?? 'remember'
      return {
        ...e,
        knowledge_type: { memory_class: memoryClass, cognitive_level: cogLevel },
      } as Engram
    })
  },
  down(engrams: Engram[]): Engram[] {
    return engrams.map(e => {
      const raw = e as any
      if (raw.knowledge_type) {
        const { ...rest } = raw
        delete rest.knowledge_type
        return rest as Engram
      }
      return e
    })
  },
}
