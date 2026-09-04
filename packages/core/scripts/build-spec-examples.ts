/**
 * Regenerate the worked examples that ship with the provenance profile.
 *
 *   pnpm --filter @plur-ai/core build:spec-examples
 *
 * The examples in `spec/examples/` are what a reader of the standard actually
 * looks at, so an example that no longer matches the code teaches the wrong
 * format. Two of them were hand-committed from a one-off run and drifted the
 * first time the record changed: a licence count was renamed and the checked-in
 * file kept the old name.
 *
 * A companion test asserts the checked-in files match what this produces, so
 * the next change fails the suite instead of quietly teaching the wrong thing.
 *
 * Fixed inputs and a fixed timestamp, so running it twice with no code change
 * produces identical bytes.
 */
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EngramSchema } from '../src/schemas/engram.js'
import type { HistoryEvent } from '../src/history.js'
import {
  buildProvenanceRecord,
  buildPackProvenanceRecord,
  serializeProvenanceRecord,
} from '../src/provenance.js'

/** Never `new Date()` — the output has to be byte-identical between runs. */
const NOW = '2026-08-12T09:00:00Z'
const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', '..', '..', 'spec', 'examples')

const engram = (id: string, overrides: Record<string, unknown> = {}) =>
  EngramSchema.parse({
    id,
    statement: 'Grant applications are reviewed on the first Monday of the month',
    type: 'behavioral',
    scope: 'group:swarm',
    status: 'active',
    visibility: 'public',
    content_hash: 'c'.repeat(64),
    claim_class: 'documented',
    source: 'https://example.org/grants/handbook',
    attribution: {
      asserted_by: 'local:maintainer',
      runtime: { name: 'plur-mcp', version: '0.18.0' },
      on_behalf_of: 'local:maintainer',
    },
    provenance: { origin: 'session:example', license: 'cc-by-4.0' },
    temporal: { learned_at: '2026-08-12T08:00:00Z' },
    ...overrides,
  })

const history: HistoryEvent[] = [
  { event: 'engram_created', engram_id: 'ENG-2026-08-12-002', timestamp: '2026-08-12T08:00:00Z', data: {} },
  { event: 'engram_updated', engram_id: 'ENG-2026-08-12-002', timestamp: '2026-08-12T08:30:00Z', data: { reason: 'corrected the weekday' } },
]

/** One engram, fully attributed, with its history. */
writeFileSync(
  join(OUT, 'example-from-typescript.jsonld'),
  serializeProvenanceRecord(buildProvenanceRecord(engram('ENG-2026-08-12-002'), history, { now: NOW })),
)

/**
 * A pack. Deliberately mixed: one engram whose author chose a licence and one
 * that took the default, so the example shows the two counts differing — which
 * is the whole reason they are two counts.
 */
writeFileSync(
  join(OUT, 'example-pack.jsonld'),
  serializeProvenanceRecord(buildPackProvenanceRecord(
    // An MIT pack of CC-BY engrams: the licence on the collection differs from
    // the licences on its members, which is the ordinary case and the one the
    // example needs to show. `engram:memberLicensesDiffer` marks it.
    {
      name: 'swarm-grants', version: '1.0.0', creator: 'local:maintainer',
      license: 'mit', integrity: `sha256:${'d'.repeat(64)}`,
    },
    [
      engram('ENG-2026-08-12-002'),
      engram('ENG-2026-08-12-003', { claim_class: 'inferred', provenance: undefined }),
    ],
    { now: NOW },
  )),
)

console.log('wrote example-from-typescript.jsonld and example-pack.jsonld')
