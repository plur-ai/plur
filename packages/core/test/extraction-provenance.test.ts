import { describe, it, expect } from 'vitest'
import {
  ExtractionProvenanceSchema,
  getExtractionProvenance,
  EngramSchemaPassthrough,
} from '../src/schemas/engram.js'

// Issue #463 — ETL extraction provenance convention.
//
// The enterprise ETL CLI (enterprise#409) emits engrams whose classifier-time
// provenance rides in `structured_data.extraction`:
//
//   structured_data:
//     extraction:
//       confidence: 0.85        # 0-1 classifier score, frozen at extraction
//       source_commit: "abc123"
//       extractor_version: "0.1.0"
//
// This is a CONVENTION, not a schema change: `structured_data` is already
// z.record(z.string(), z.unknown()). The exported schema + helper validate the
// convention for producers/consumers without wiring it into EngramSchema.

describe('ExtractionProvenanceSchema (#463)', () => {
  it('accepts the full canonical shape from the issue', () => {
    const parsed = ExtractionProvenanceSchema.safeParse({
      confidence: 0.85,
      source_commit: 'abc123',
      extractor_version: '0.1.0',
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.confidence).toBe(0.85)
      expect(parsed.data.source_commit).toBe('abc123')
      expect(parsed.data.extractor_version).toBe('0.1.0')
    }
  })

  it('accepts partial provenance (fields are individually optional)', () => {
    expect(ExtractionProvenanceSchema.safeParse({ confidence: 0.5 }).success).toBe(true)
    expect(ExtractionProvenanceSchema.safeParse({ source_commit: 'deadbeef' }).success).toBe(true)
    expect(ExtractionProvenanceSchema.safeParse({ extractor_version: '2.0.0' }).success).toBe(true)
    expect(ExtractionProvenanceSchema.safeParse({}).success).toBe(true)
  })

  it('rejects confidence outside [0,1]', () => {
    expect(ExtractionProvenanceSchema.safeParse({ confidence: 1.5 }).success).toBe(false)
    expect(ExtractionProvenanceSchema.safeParse({ confidence: -0.1 }).success).toBe(false)
    // Boundary values are valid
    expect(ExtractionProvenanceSchema.safeParse({ confidence: 0 }).success).toBe(true)
    expect(ExtractionProvenanceSchema.safeParse({ confidence: 1 }).success).toBe(true)
  })

  it('rejects wrong types', () => {
    expect(ExtractionProvenanceSchema.safeParse({ confidence: 'high' }).success).toBe(false)
    expect(ExtractionProvenanceSchema.safeParse({ source_commit: 123 }).success).toBe(false)
    expect(ExtractionProvenanceSchema.safeParse({ extractor_version: ['0.1.0'] }).success).toBe(false)
  })

  it('preserves unknown keys (forward-compatible for newer extractors)', () => {
    const parsed = ExtractionProvenanceSchema.safeParse({
      confidence: 0.9,
      future_field: 'something new',
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect((parsed.data as any).future_field).toBe('something new')
  })
})

describe('getExtractionProvenance (#463)', () => {
  const baseEngram = { structured_data: undefined as Record<string, unknown> | undefined }

  it('returns validated provenance when present and valid', () => {
    const engram = {
      structured_data: {
        extraction: { confidence: 0.85, source_commit: 'abc123', extractor_version: '0.1.0' },
        other_key: 'untouched',
      },
    }
    const prov = getExtractionProvenance(engram)
    expect(prov).not.toBeNull()
    expect(prov!.confidence).toBe(0.85)
    expect(prov!.source_commit).toBe('abc123')
    expect(prov!.extractor_version).toBe('0.1.0')
  })

  it('returns null when structured_data is absent', () => {
    expect(getExtractionProvenance(baseEngram)).toBeNull()
    expect(getExtractionProvenance({})).toBeNull()
  })

  it('returns null when extraction key is absent', () => {
    expect(getExtractionProvenance({ structured_data: { unrelated: true } })).toBeNull()
  })

  it('returns null (gracefully, no throw) when extraction is malformed', () => {
    // Wrong container types
    expect(getExtractionProvenance({ structured_data: { extraction: 'not an object' } })).toBeNull()
    expect(getExtractionProvenance({ structured_data: { extraction: 42 } })).toBeNull()
    expect(getExtractionProvenance({ structured_data: { extraction: [0.85] } })).toBeNull()
    expect(getExtractionProvenance({ structured_data: { extraction: null } })).toBeNull()
    // Wrong field types inside the object
    expect(getExtractionProvenance({ structured_data: { extraction: { confidence: 'high' } } })).toBeNull()
    expect(getExtractionProvenance({ structured_data: { extraction: { confidence: 2 } } })).toBeNull()
    expect(getExtractionProvenance({ structured_data: { extraction: { source_commit: 99 } } })).toBeNull()
  })

  it('round-trips through the engram schema unchanged (convention is additive)', () => {
    // The engram schema itself stays untouched — extraction rides inside the
    // existing structured_data extension bag and survives a parse round-trip.
    const engram = EngramSchemaPassthrough.parse({
      id: 'ENG-2026-0702-001',
      status: 'active',
      type: 'procedural',
      scope: 'global',
      statement: 'ETL-extracted knowledge',
      structured_data: {
        extraction: { confidence: 0.7, source_commit: '357f1ec', extractor_version: '0.1.0' },
      },
    })
    const prov = getExtractionProvenance(engram)
    expect(prov).toEqual({ confidence: 0.7, source_commit: '357f1ec', extractor_version: '0.1.0' })
  })

  it('distinct semantics: does NOT read feedback-derived or episodic confidence', () => {
    // Three different "confidence" fields exist; the helper must only ever
    // read the extraction-time classifier score, never the other two.
    const engram = {
      episodic: { emotional_weight: 5, confidence: 9 }, // 1-10 subjective certainty
      feedback_signals: { positive: 10, negative: 0, neutral: 0 }, // drives computeConfidence()
      structured_data: {},
    }
    expect(getExtractionProvenance(engram)).toBeNull()
  })
})
