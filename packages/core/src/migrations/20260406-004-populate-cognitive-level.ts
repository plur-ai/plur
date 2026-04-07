import type { Migration } from './types.js'
import type { Engram } from '../schemas/engram.js'

/**
 * Migration: Populate knowledge_type.cognitive_level based on engram type.
 * Maps: behavioral -> apply, terminological -> remember, procedural -> apply, architectural -> evaluate
 */

const TYPE_TO_COGNITIVE: Record<string, 'remember' | 'understand' | 'apply' | 'analyze' | 'evaluate' | 'create'> = {
  behavioral: 'apply',
  terminological: 'remember',
  procedural: 'apply',
  architectural: 'evaluate',
}

const TYPE_TO_MEMORY_CLASS: Record<string, 'semantic' | 'episodic' | 'procedural' | 'metacognitive'> = {
  behavioral: 'semantic',
  terminological: 'semantic',
  procedural: 'procedural',
  architectural: 'semantic',
}

export const migration: Migration = {
  id: '20260406-004-populate-cognitive-level',
  description: 'Populate existing knowledge_type.cognitive_level based on type',
  up(engrams: Engram[]): Engram[] {
    return engrams.map(e => {
      const clone = { ...e } as any
      const cogLevel = TYPE_TO_COGNITIVE[e.type] ?? 'remember'
      const memClass = TYPE_TO_MEMORY_CLASS[e.type] ?? 'semantic'
      if (!clone.knowledge_type) {
        clone.knowledge_type = { cognitive_level: cogLevel, memory_class: memClass }
      } else {
        if (!clone.knowledge_type.cognitive_level) {
          clone.knowledge_type = { ...clone.knowledge_type, cognitive_level: cogLevel }
        }
        if (!clone.knowledge_type.memory_class) {
          clone.knowledge_type = { ...clone.knowledge_type, memory_class: memClass }
        }
      }
      return clone as Engram
    })
  },
  down(engrams: Engram[]): Engram[] {
    return engrams.map(e => {
      const clone = { ...e } as any
      delete clone.knowledge_type
      return clone as Engram
    })
  },
}
