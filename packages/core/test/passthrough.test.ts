import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as yaml from 'js-yaml'
import { loadEngrams, saveEngrams } from '../src/engrams.js'
import { EngramSchemaPassthrough } from '../src/schemas/engram.js'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plur-passthrough-'))
}

describe('schema passthrough (F7)', () => {
  let dir: string

  beforeEach(() => {
    dir = tmpDir()
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('preserves unknown fields during Zod parsing', () => {
    const raw = {
      id: 'ENG-2026-0406-001',
      version: 2,
      status: 'active',
      consolidated: false,
      type: 'behavioral',
      scope: 'global',
      visibility: 'private',
      statement: 'Test passthrough',
      activation: { retrieval_strength: 0.7, storage_strength: 1.0, frequency: 0, last_accessed: '2026-04-06' },
      feedback_signals: { positive: 0, negative: 0, neutral: 0 },
      knowledge_anchors: [],
      associations: [],
      derivation_count: 1,
      tags: [],
      pack: null,
      abstract: null,
      derived_from: null,
      polarity: null,
      // Unknown field that should be preserved
      commitment: 'decided',
      content_hash: 'abc123',
    }
    const result = EngramSchemaPassthrough.safeParse(raw)
    expect(result.success).toBe(true)
    if (result.success) {
      expect((result.data as any).commitment).toBe('decided')
      expect((result.data as any).content_hash).toBe('abc123')
    }
  })

  it('preserves unknown fields through load/save cycle', () => {
    const engramsPath = path.join(dir, 'engrams.yaml')
    // Write YAML with an unknown field
    const content = yaml.dump({
      engrams: [{
        id: 'ENG-2026-0406-001',
        version: 2,
        status: 'active',
        consolidated: false,
        type: 'behavioral',
        scope: 'global',
        visibility: 'private',
        statement: 'Test passthrough via YAML',
        activation: { retrieval_strength: 0.7, storage_strength: 1.0, frequency: 0, last_accessed: '2026-04-06' },
        feedback_signals: { positive: 0, negative: 0, neutral: 0 },
        knowledge_anchors: [],
        associations: [],
        derivation_count: 1,
        tags: [],
        pack: null,
        abstract: null,
        derived_from: null,
        polarity: null,
        future_field: 'preserved',
      }],
    })
    fs.writeFileSync(engramsPath, content)

    const engrams = loadEngrams(engramsPath)
    expect(engrams.length).toBe(1)
    expect((engrams[0] as any).future_field).toBe('preserved')

    // Save and reload — field should still be there
    saveEngrams(engramsPath, engrams)
    const reloaded = loadEngrams(engramsPath)
    expect((reloaded[0] as any).future_field).toBe('preserved')
  })
})
