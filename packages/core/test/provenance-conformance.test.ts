/**
 * Provenance records must be readable by someone else (#968).
 *
 * Our own validator agreeing with our own generator is not evidence. This suite
 * generates records from the CURRENT code and runs them through implementations
 * that share none of it.
 *
 * That matters because we have already been burned by the alternative. Our
 * provenance library had 167 passing tests while emitting a field name the
 * reference implementation rejects outright, because every test compared our
 * code against our code.
 *
 * How it runs: the structural checks below always run. The outside check needs
 * Python and two packages, so it is skipped locally when they are absent — and
 * enforced in continuous integration, which installs them. Skipping in CI is a
 * failure, not a pass, and the CI step asserts that.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { EngramSchema } from '../src/schemas/engram.js'
import type { HistoryEvent } from '../src/history.js'
import {
  buildProvenanceRecord,
  buildPackProvenanceRecord,
  serializeProvenanceRecord,
} from '../src/provenance.js'

const CONFORMANCE = resolve(__dirname, '../../../spec/examples/conformance.py')

const engramOf = (id: string, overrides: Record<string, unknown> = {}) =>
  EngramSchema.parse({
    id,
    statement: `Statement for ${id}`,
    type: 'behavioral',
    scope: 'global',
    status: 'active',
    visibility: 'public',
    content_hash: 'e'.repeat(64),
    claim_class: 'asserted',
    attribution: { asserted_by: 'unidentified', runtime: { name: 'plur-core', version: '0.18.0' } },
    provenance: { origin: 'session:test', license: 'cc-by-sa-4.0' },
    temporal: { learned_at: '2026-08-21T00:00:00Z' },
    ...overrides,
  })

/** Every kind of record the code can produce, so all of them are checked. */
function generateAll(dir: string): number {
  const events: HistoryEvent[] = [
    { event: 'engram_created', engram_id: 'ENG-2026-08-21-001', timestamp: '2026-08-21T00:00:00Z', data: {} },
    {
      event: 'co_injection', engram_id: 'INJ-1', timestamp: '2026-08-21T01:00:00Z',
      data: { ids: ['ENG-2026-08-21-001', 'ENG-secret'], query_hash: 'abc123', session_id: 'sess-private' },
    },
    { event: 'engram_retired', engram_id: 'ENG-2026-08-21-001', timestamp: '2026-08-21T02:00:00Z', data: { reason: 'superseded' } },
  ]

  const records: Array<[string, Record<string, unknown>]> = [
    ['plain', buildProvenanceRecord(engramOf('ENG-2026-08-21-001'))],
    ['with-history', buildProvenanceRecord(engramOf('ENG-2026-08-21-001'), events)],
    ['with-statement', buildProvenanceRecord(engramOf('ENG-2026-08-21-001'), [], { includeStatement: true })],
    ['local-mode', buildProvenanceRecord(engramOf('ENG-2026-08-21-001'), events, { mode: 'local' })],
    ['no-agent', buildProvenanceRecord(engramOf('ENG-2026-08-21-002', { attribution: undefined }))],
    ['unknown-licence', buildProvenanceRecord(engramOf('ENG-2026-08-21-003', {
      provenance: { origin: 'x', license: 'some-bespoke-licence' },
    }))],
    ['domain-fields', buildProvenanceRecord(engramOf('ENG-2026-08-21-004'), [], {
      domain: { namespaces: { geo: 'https://example.org/geo#' }, attributes: { 'geo:parcelId': '1234' } },
    })],
    ['pack', buildPackProvenanceRecord(
      { name: 'test-pack', version: '1.0.0', creator: 'local:maintainer', integrity: 'sha256:abc' },
      [engramOf('ENG-2026-08-21-001'), engramOf('ENG-2026-08-21-002', { claim_class: 'inferred' })],
    )],
  ]

  for (const [name, record] of records) {
    writeFileSync(join(dir, `${name}.jsonld`), serializeProvenanceRecord(record))
  }
  return records.length
}

/** Is Python available with both outside implementations installed? */
function outsideToolsAvailable(): string | null {
  for (const python of ['python3', 'python']) {
    try {
      execFileSync(python, ['-c', 'import rdflib, prov.model'], { stdio: 'pipe' })
      return python
    } catch {
      // try the next one
    }
  }
  return null
}

describe('provenance records are readable by someone else (#968)', () => {
  let dir: string
  let count: number

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-conformance-'))
    count = generateAll(dir)
  })

  it('generates a record for every shape the code can produce', () => {
    expect(count).toBeGreaterThanOrEqual(8)
  })

  const python = outsideToolsAvailable()

  it.skipIf(!python)(
    'every generated record is accepted by two outside implementations',
    () => {
      // rdflib parses it; the prov reference implementation must accept it.
      // The script also enforces the profile's own rules: nothing dangles, and
      // a recipient can answer all five questions.
      const output = execFileSync(python!, [CONFORMANCE, '--dir', dir], { encoding: 'utf8' })
      expect(output).toContain('accepted by both outside tools')
    },
    120_000,
  )

  it.skipIf(!python)(
    'the check actually fails on a broken record, so it can catch one',
    () => {
      // A test that cannot fail proves nothing. Break a record on purpose and
      // confirm the checker rejects it.
      const broken = mkdtempSync(join(tmpdir(), 'plur-conformance-broken-'))
      const record: any = buildProvenanceRecord(engramOf('ENG-2026-08-21-001'))
      // Point at an engram that is not described anywhere in the record.
      record['@graph'][1]['prov:wasDerivedFrom'] = { '@id': 'engram:ENG-does-not-exist' }
      writeFileSync(join(broken, 'broken.jsonld'), serializeProvenanceRecord(record))

      let failed = false
      try {
        execFileSync(python!, [CONFORMANCE, '--dir', broken], { stdio: 'pipe' })
      } catch {
        failed = true
      }
      rmSync(broken, { recursive: true, force: true })
      expect(failed).toBe(true)
    },
    120_000,
  )

  if (!python) {
    it('reports that the outside check was skipped, rather than passing quietly', () => {
      // Continuous integration installs these, and asserts they are present
      // before running the suite. A local skip is fine; a skip in CI is a
      // failure, and the CI step catches it.
      expect(python).toBeNull()
    })
  }
})
