/**
 * Provenance has to work for a team that does not write in English (#970).
 *
 * A tester working in Slovenian, Japanese and Arabic found four defects. Each
 * is kept here because each is the kind that only shows up in the script it
 * breaks, and never in the language the tests happen to be written in.
 */
import { describe, it, expect } from 'vitest'
import { EngramSchema } from '../src/schemas/engram.js'
import { buildProvenanceRecord, summariseProvenance } from '../src/provenance.js'

const engramOf = (overrides: Record<string, unknown> = {}) =>
  EngramSchema.parse({
    id: 'ENG-2026-08-23-001',
    statement: 'Statement',
    type: 'behavioral', scope: 'global', status: 'active',
    content_hash: 'a'.repeat(64),
    ...overrides,
  })

const summaryFor = (overrides: Record<string, unknown> = {}) =>
  summariseProvenance(buildProvenanceRecord(engramOf(overrides)) as any)

const subjectOf = (record: any) =>
  record['@graph'].find((n: any) => String(n['@id']).startsWith('engram:ENG'))

describe('names outside English', () => {
  it('shows an accented name as itself, not as an escape sequence', () => {
    // "Anže%20Novak" was printed where a colleague's name belonged.
    expect(summaryFor({ attribution: { asserted_by: 'Anže Novak' } }).fields.asserted_by)
      .toBe('Anže Novak')
  })

  it('shows a non-Latin name as itself', () => {
    expect(summaryFor({ attribution: { asserted_by: '田中太郎' } }).fields.asserted_by)
      .toBe('田中太郎')
  })

  it('treats the two encodings of one name as one person', () => {
    // The same name typed on two machines can arrive composed or decomposed.
    // Without normalising, one colleague becomes two agents in the graph —
    // indistinguishable in every readable view, and impossible to reconcile.
    const composed = 'José Ángel'.normalize('NFC')
    const decomposed = 'José Ángel'.normalize('NFD')
    expect(composed).not.toBe(decomposed)

    const idOf = (n: string) =>
      subjectOf(buildProvenanceRecord(engramOf({ attribution: { asserted_by: n } })))['prov:wasAttributedTo']['@id']
    expect(idOf(composed)).toBe(idOf(decomposed))
  })

  it('does not leave invisible characters raw inside an identifier', () => {
    // A zero-width joiner cannot be seen, and makes two identifiers that look
    // identical compare unequal.
    const id = subjectOf(buildProvenanceRecord(engramOf({
      attribution: { asserted_by: '👩‍💻 Ana' },
    })))['prov:wasAttributedTo']['@id']
    expect(id).not.toContain('‍')
    expect(id).toContain('%200D')
  })
})

describe('right-to-left text does not reorder the sentence around it', () => {
  it('isolates a right-to-left licence name', () => {
    // Without this the value's direction wins: the full stop moved to the front
    // of the English sentence and the indentation jumped to the other edge.
    const record = buildProvenanceRecord(engramOf({
      visibility: 'public',
      provenance: { origin: 'x', license: 'رخصة المشاع الإبداعي 4.0' },
    }))
    const note = String(subjectOf(record)['odrl:hasPolicy']['engram:note'])
    expect(note).toContain('⁨')
    expect(note).toContain('⁩')
  })

  it('isolates a right-to-left name in the readable summary', () => {
    expect(summaryFor({ attribution: { asserted_by: 'محمد بن راشد' } }).fields.asserted_by)
      .toMatch(/^⁨.*⁩$/)
  })

  it('leaves ordinary text untouched, byte for byte', () => {
    // The isolate characters are invisible, but they should not appear where
    // there is no direction to protect.
    expect(summaryFor({ attribution: { asserted_by: 'local:maintainer' } }).fields.asserted_by)
      .toBe('local:maintainer')
  })
})
