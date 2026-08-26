/**
 * Every trust-bearing field must be read where the decision is made.
 *
 * This guards the most expensive recurring mistake in this repository, and the
 * reason it recurs is that it does not look like a bug. The field is captured.
 * It is stored correctly. Its own tests pass. Nothing reads it, and nothing
 * complains — so the gap survives review, ships, and is found by somebody
 * outside months later.
 *
 * It has now happened twice on the same feature:
 *
 *   - `origin`, `chain`, `signature` and `license` were defined on the engram
 *     and written by nothing at all. One function read the block, to count how
 *     complete it was (#958).
 *   - `claim_class` was then captured properly and read ONLY by the provenance
 *     record — an artifact produced on request, which nobody asks for
 *     mid-session. So a model's guess and a user's statement still rendered
 *     identically in injected context. An outside contributor reported it
 *     against a working implementation.
 *
 * The second case is the one this file exists for, because it passed every
 * check we had. "Something reads it" was true. The field was read by a reporting
 * surface, not by the surface where the memory is actually used.
 *
 * So the assertion is deliberately narrow: for each field below, at least one
 * DECISION surface must reference it. A reporting surface does not count, and
 * listing one here would defeat the purpose.
 *
 * When this fails, do not add the file to the allowed list to make it pass. The
 * failure means a field is being captured that nothing acts on — either wire it
 * into a decision surface, or delete it.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '..', 'src')

/**
 * Read a source file with its comments removed.
 *
 * Stripping them is not tidiness, it is the difference between this file
 * working and not. The first version searched raw text and passed while the
 * feature was deliberately broken, because the code carried a long comment
 * ABOUT `claim_class` explaining why it must be surfaced. The explanation of
 * the fix was keeping the test for the fix green.
 *
 * A guard that a comment can satisfy is measuring prose, not behaviour.
 */
function readCode(...p: string[]): string {
  const raw = readFileSync(join(SRC, ...p), 'utf8')
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // block comments, including doc comments
    .replace(/(^|[^:])\/\/.*$/gm, '$1')  // line comments, but not the // in a URL
}

/**
 * Surfaces where a memory is USED, as opposed to described.
 *
 * The distinction is the whole point. `provenance.ts` builds a document a
 * person or auditor asks for after the fact; `inject.ts` decides what a model
 * sees while it is working. A field that reaches only the first has not reached
 * anybody who was going to act on it.
 */
const DECISION_SURFACES = [
  ['inject.ts'],
  ['recall-format.ts'],
  ['quality.ts'],
] as const

/** Fields that exist to change how much a reader trusts a memory. */
const TRUST_FIELDS: Array<{ field: string; why: string }> = [
  {
    field: 'claim_class',
    why: 'whether a person stated it or a model worked it out — the single most '
      + 'decision-relevant field there is, and the one that was captured and never shown',
  },
  {
    field: 'commitment',
    why: 'how firmly the belief is held; already surfaced, and listed here so it stays that way',
  },
]

describe('a trust-bearing field is read where the decision is made', () => {
  const sources = DECISION_SURFACES.map(p => {
    try { return readCode(...p) } catch { return '' }
  }).join('\n')

  for (const { field, why } of TRUST_FIELDS) {
    it(`\`${field}\` reaches a decision surface — ${why}`, () => {
      expect(
        sources.includes(field),
        `\`${field}\` is captured but no decision surface reads it.\n\n`
        + `It may well be read by provenance.ts, the summary, or the MCP tool output. `
        + `That is not the same thing: those are produced when somebody asks, and nobody `
        + `asks mid-session. Wire it into where the memory is actually used, or delete the field.\n\n`
        + `Searched: ${DECISION_SURFACES.map(p => p.join('/')).join(', ')}`,
      ).toBe(true)
    })
  }

  it('does not count the provenance record as a decision surface', () => {
    // A guard on the guard. If somebody "fixes" a failure above by adding
    // provenance.ts to DECISION_SURFACES, every assertion here passes again and
    // the file stops testing anything — which is exactly the failure mode it
    // was written to catch.
    const listed = DECISION_SURFACES.map(p => p.join('/'))
    for (const reporting of ['provenance.ts', 'provenance-store.ts', 'receipt.ts']) {
      expect(listed, `${reporting} reports on a memory; it is not where one gets used`)
        .not.toContain(reporting)
    }
  })
})
