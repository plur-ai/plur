import { describe, it, expect } from 'vitest'
import { embed, cosineSimilarity, embedderStatus } from '../src/embeddings.js'
import { searchTextFrom } from '../src/fts.js'
import { NEAR_DUPLICATE_OBSERVATION_FLOOR } from '../src/learn-async.js'

/**
 * Calibration for the #854 cosine dedup bar. Runs the REAL embedder.
 *
 * WHAT THIS IS FOR, precisely — because it is easy to mistake for a regression
 * gate and it is not one:
 *
 *   - The bar (`threshold`, default 0.95) is only defensible if enriched
 *     duplicates land above it and enriched DISTINCT statements land below.
 *     That is a property of the embedding model and of which fields
 *     `searchTextFrom` includes — neither of which lives in our control flow, so
 *     no stubbed test can check it.
 *   - Run this after changing the embedder, the enrichment fields, or the
 *     default threshold. If the separation has closed, the bar is no longer
 *     supported by anything and needs re-deriving from a fresh run.
 *
 * The regression gate for the code path is elsewhere and runs every time:
 * `dedup-cosine.test.ts` → "compares enriched text, not the bare statement"
 * asserts the query carries domain/tags/rationale, which is the mistake that
 * actually shipped. This file checks whether the resulting numbers still mean
 * what the threshold assumes.
 *
 * GATED, matching `embeddings-cache-dim.test.ts`: loading BGE-small needs model
 * access, so the default suite stays offline-safe.
 *
 *   PLUR_EMBEDDER_NETWORK_TESTS=1 npx vitest run --project @plur-ai/core \
 *     packages/core/test/dedup-threshold-calibration.test.ts
 *
 * In CI it runs from the `dedup-calibration` job, path-filtered to the files
 * that can invalidate the claim (embeddings.ts, fts.ts, learn-async.ts, these
 * fixtures) and non-blocking, since it depends on a model fetch.
 *
 * Baseline from THESE fixtures, 2026-08-10, BGE-small-en-v1.5, enriched both
 * sides:
 *
 *   0.7962  DISTINCT   one token apart: staging port 8080 vs 8081
 *   0.8437  DISTINCT   negation — a correction of an existing engram
 *   0.8570  DISTINCT   same rule, different host
 *   0.9797  DUPLICATE  reordered clauses, same claim
 *   0.9830  DUPLICATE  the #854 pair
 *
 * Separation 0.123, with the 0.95 bar inside the band rather than at an edge.
 *
 * Bare — the bug this replaced — the worst DISTINCT pair sat at 0.9749, ABOVE
 * both duplicates. No threshold could separate them. That inversion is the
 * thing worth never reintroducing, and the second test below pins it.
 */

const NETWORK = process.env.PLUR_EMBEDDER_NETWORK_TESTS === '1'

/**
 * Imported, NOT re-declared. The previous revision hardcoded its own copy of
 * the bar and claimed "kept here so a drift shows up as a failure" — which was
 * false: changing the production value would not have failed this test.
 */
const FLOOR = NEAR_DUPLICATE_OBSERVATION_FLOOR

interface Fixture {
  label: string
  a: Parameters<typeof searchTextFrom>[0]
  b: Parameters<typeof searchTextFrom>[0]
}

/** Pairs a competent reader would call clearly DIFFERENT facts. */
const DISTINCT: Fixture[] = [
  {
    label: 'one token apart: staging port',
    a: {
      statement: 'Use port 8080 for staging',
      domain: 'infrastructure.deploy',
      tags: ['staging', 'ports'],
      rationale: 'Chosen because 8080 is the default the reverse proxy forwards to.',
    },
    b: {
      statement: 'Use port 8081 for staging',
      domain: 'infrastructure.deploy',
      tags: ['staging', 'ports'],
      rationale: 'Moved off 8080 after the metrics sidecar claimed it in the 2026-07 rollout.',
    },
  },
  {
    // The case that decides the bar. A correction is usually the prior
    // statement with one thing negated, and corrections are the highest-value
    // engrams this system stores — suppressing one is the worst outcome the
    // dedup path can produce.
    label: 'negation: a correction of an existing engram',
    a: {
      statement: 'Always rebase before pushing',
      domain: 'git.workflow',
      tags: ['git', 'conventions'],
      rationale: 'Keeps history linear and makes bisect usable on this repo.',
    },
    b: {
      statement: 'Never rebase before pushing',
      domain: 'git.workflow',
      tags: ['git', 'conventions'],
      rationale: 'Shared branches here are checked out by three agents; rewriting published history breaks their working copies.',
    },
  },
  {
    label: 'same rule, different host',
    a: {
      statement: 'Set RESTIC_CACHE_DIR explicitly on the nightshift host',
      domain: 'infrastructure.backup',
      tags: ['restic', 'nightshift'],
      rationale: 'systemd units there run with no $HOME, so the default cache path resolves under /.',
    },
    b: {
      statement: 'Set RESTIC_CACHE_DIR explicitly on the winston host',
      domain: 'infrastructure.backup',
      tags: ['restic', 'winston'],
      rationale: 'Same systemd no-$HOME problem, but winston also has a smaller root volume.',
    },
  },
]

/** Pairs that are genuinely the same fact, reworded. */
const DUPLICATE: Fixture[] = [
  {
    label: '#854 019/029 — the pair that prompted the issue',
    a: {
      statement: 'Time Machine does not exclude node_modules or other reinstallable build artifacts',
      domain: 'infrastructure.backup',
      tags: ['timemachine', 'backup'],
      rationale: 'Backups balloon because reinstallable trees are treated as user data.',
    },
    b: {
      statement: 'Time Machine does not exclude node_modules or reinstallable build artifacts; clean them first',
      domain: 'infrastructure.backup',
      tags: ['timemachine', 'backup'],
      rationale: 'Backups balloon because reinstallable trees are treated as user data.',
    },
  },
  {
    label: 'reordered clauses, same claim',
    a: {
      statement: 'systemd services run with no $HOME, so pin RESTIC_CACHE_DIR explicitly',
      domain: 'infrastructure.backup',
      tags: ['systemd', 'restic'],
      rationale: 'The default cache path is derived from $HOME and resolves wrong without it.',
    },
    b: {
      statement: 'Pin RESTIC_CACHE_DIR explicitly, because systemd services have no $HOME',
      domain: 'infrastructure.backup',
      tags: ['systemd', 'restic'],
      rationale: 'The default cache path is derived from $HOME and resolves wrong without it.',
    },
  },
]

async function score(f: Fixture): Promise<number> {
  const ea = await embed(searchTextFrom(f.a))
  const eb = await embed(searchTextFrom(f.b))
  if (!ea || !eb) throw new Error(`embedder returned null for "${f.label}" — cannot calibrate`)
  return cosineSimilarity(ea, eb)
}

describe.skipIf(!NETWORK)('dedup threshold calibration (#854, real embedder)', () => {
  it('reports the measured separation', async () => {
    // `available` only means "not disabled, and the library imported" — it is
    // true before any model has loaded. Asserting it alone would let this whole
    // file pass without ever embedding anything, which is the exact shape of
    // check this test exists to replace. `loaded` is asserted after scoring,
    // below, once a real pipeline must exist.
    expect(embedderStatus().available).toBe(true)

    const distinct = await Promise.all(DISTINCT.map(async f => [f.label, await score(f)] as const))
    const duplicate = await Promise.all(DUPLICATE.map(async f => [f.label, await score(f)] as const))

    // Proof the numbers above came from a real model rather than from a
    // short-circuit. `score()` throws on a null embedding, so this is belt and
    // braces — but a calibration that cannot tell you whether it calibrated is
    // worth nothing, and that has to be visible in the file, not inferred from
    // a CI log.
    expect(embedderStatus().loaded, 'embedder never loaded — these scores are not real').toBe(true)

    const rows = [
      ...distinct.map(([l, s]) => `  ${s.toFixed(4)}  DISTINCT   ${l}`),
      ...duplicate.map(([l, s]) => `  ${s.toFixed(4)}  DUPLICATE  ${l}`),
    ]
    // Printed unconditionally: the point of running this is to READ the numbers,
    // not merely to see it pass.
    console.log(`\nobservation floor = ${FLOOR}\n${rows.join('\n')}\n`)

    const worstDistinct = Math.max(...distinct.map(([, s]) => s))
    const bestDistinctLabel = distinct.find(([, s]) => s === worstDistinct)![0]
    const weakestDuplicate = Math.min(...duplicate.map(([, s]) => s))

    // WHAT THIS ASSERTS NOW, and why it changed (#856 audit).
    //
    // The previous revision asserted a SEPARATING bar: no distinct pair above
    // 0.95, every duplicate at or above it. Those assertions passed, and were
    // still not evidence that a gate would work — because every fixture gave
    // both sides an identical domain, tags and rationale, and the duplicates
    // that actually occur do not. See the ASYMMETRIC test below: the very pair
    // from #854, scored as it was really written, lands at ~0.83 — beneath the
    // distinct pairs. No single bar separates the real classes, so the gate was
    // removed and this file now calibrates REPORTING instead.
    //
    // 1. Every duplicate must clear the observation floor, or it is never even
    //    reported and the pass is decorative.
    expect(
      weakestDuplicate,
      `weakest duplicate scores ${weakestDuplicate.toFixed(4)} < floor ${FLOOR} — it would not be reported at all`,
    ).toBeGreaterThanOrEqual(FLOOR)

    // 2. The floor must stay below the distinct pairs' scores too — reporting
    //    is meant to capture the whole interesting band, including the pairs a
    //    future gate would have to NOT suppress. A floor above them would hide
    //    exactly the evidence needed to decide whether a gate is possible.
    expect(
      FLOOR,
      `floor ${FLOOR} is above the distinct pair "${bestDistinctLabel}" at ${worstDistinct.toFixed(4)} — the recorded distribution would be truncated`,
    ).toBeLessThan(worstDistinct)
  }, 180_000)

  // The measurement that removed the gate. Pinned as a test so the reasoning
  // cannot quietly stop being true — if a future embedder closes this gap, a
  // write gate becomes arguable again, and this is where that shows up.
  it('asymmetric context defeats any fixed bar — this is why nothing is suppressed', async () => {
    // The #854 pair AS ACTUALLY WRITTEN. The twin was generated from the
    // statements alone, so it carries no domain and no rationale — that is
    // defect 2 of the same issue. Production enriches the incoming side from
    // the write's own context only, so an under-contexted write is compared
    // against a fully-contexted stored engram.
    const stored = searchTextFrom({
      statement: 'Time Machine does not exclude node_modules or other reinstallable build artifacts',
      domain: 'infrastructure.backup',
      tags: ['timemachine', 'backup'],
      rationale: 'Backups balloon because reinstallable trees are treated as user data.',
    })
    const incomingBare = searchTextFrom({
      statement: 'Time Machine does not exclude node_modules or reinstallable build artifacts; clean them first',
    })
    const ea = await embed(stored)
    const eb = await embed(incomingBare)
    if (!ea || !eb) throw new Error('embedder returned null — cannot calibrate')
    const asymmetric = cosineSimilarity(ea, eb)

    const symmetric = await score(DUPLICATE[0])
    const worstDistinct = Math.max(...(await Promise.all(DISTINCT.map(score))))

    console.log(
      `\n#854 pair, both sides contexted : ${symmetric.toFixed(4)}  (a bar would catch this)` +
      `\n#854 pair, as actually written  : ${asymmetric.toFixed(4)}  (a bar would MISS this)` +
      `\nworst DISTINCT pair             : ${worstDistinct.toFixed(4)}\n`,
    )

    // A real duplicate scoring BELOW a genuinely-distinct pair is the whole
    // argument: the two classes overlap, so no threshold separates them and
    // any gate would both miss duplicates and risk suppressing corrections.
    expect(
      asymmetric,
      `asymmetric duplicate ${asymmetric.toFixed(4)} no longer sits below the worst distinct pair ` +
      `${worstDistinct.toFixed(4)} — the classes may have become separable, so a write gate is worth re-deriving`,
    ).toBeLessThan(worstDistinct)

    // …and it must still clear the reporting floor, or the pairs that actually
    // occur would be invisible in the recorded distribution.
    expect(
      asymmetric,
      `asymmetric duplicate ${asymmetric.toFixed(4)} is below the reporting floor ${FLOOR} — ` +
      `the real duplicates would not even be observed`,
    ).toBeGreaterThanOrEqual(FLOOR)
  }, 180_000)

  it('enrichment is what creates the separation — bare statements invert it', async () => {
    // The bug this guards against conceptually: comparing bare statements put
    // the DISTINCT pairs ABOVE the duplicate, so no threshold could work.
    const bare = async (f: Fixture) => {
      const ea = await embed(f.a.statement)
      const eb = await embed(f.b.statement)
      if (!ea || !eb) throw new Error('embedder returned null')
      return cosineSimilarity(ea, eb)
    }
    const distinctBare = Math.max(...(await Promise.all(DISTINCT.map(bare))))
    const distinctRich = Math.max(...(await Promise.all(DISTINCT.map(score))))

    console.log(`\nDISTINCT worst-case: bare ${distinctBare.toFixed(4)} -> enriched ${distinctRich.toFixed(4)}\n`)

    // Enrichment must pull distinct facts APART. If this ever fails, the
    // enrichment fields have stopped carrying the distinguishing information
    // and the threshold rests on nothing.
    expect(
      distinctRich,
      `enrichment no longer separates distinct facts (bare ${distinctBare.toFixed(4)}, enriched ${distinctRich.toFixed(4)})`,
    ).toBeLessThan(distinctBare)
  }, 180_000)
})
