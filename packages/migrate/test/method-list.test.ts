/**
 * The migrate tool's method list must match reality.
 *
 * `NEWLY_ASYNC` is the entire behaviour of this tool: a name missing from it is
 * an un-awaited call the user is never told about, and a name wrongly in it is
 * an `await` the tool tells them to add to a synchronous method.
 *
 * It was hand-written and was wrong in both directions — `addStore` was listed
 * and is synchronous, while eight methods that genuinely flipped
 * (`compact`, `episodeToEngram`, `installPack`, `outboxCount`, `receipt`,
 * `rerankerEvalStatus`, `resolveTension`, `saveMetaEngrams`) were absent.
 * `scan.test.ts` could not detect either: it tests the SCANNER against
 * hand-written fixtures, so a wrong list produces a green suite and wrong advice.
 *
 * This test reads the real `Plur` class instead. It cannot be satisfied by
 * agreeing with itself.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { join } from 'path'
import { NEWLY_ASYNC } from '../src/scan.js'

const CORE_INDEX = join(__dirname, '..', '..', 'core', 'src', 'index.ts')

/**
 * Async on `Plur` BEFORE 0.16 and NOT reported by the tool.
 *
 * `NEWLY_ASYNC` also contains some already-async methods on purpose (see its
 * comment) — reporting an un-awaited `feedback()` costs nothing and helps, even
 * though it was a bug before 0.16 rather than fallout from it. So "already
 * async" and "in NEWLY_ASYNC" are not opposites, and the two lists below are
 * NOT a before/after partition. `alreadyAsyncAt0_15` is what pins the history.
 *
 * Membership here is still a claim about history, so it is deliberately
 * explicit: adding a new async method to `Plur` fails the test until someone
 * says which side it belongs on.
 */
const ALWAYS_ASYNC = new Set([
  // The *Async family — the async twin of a sync method, named for it.
  'learnAsync', 'recallAsync', 'setPinnedAsync', 'updateEngramAsync',
  'reindexAsync', 'listStoresAsync',
  // Embedding/LLM-backed retrieval — always async, always awaited by callers.
  'recallHybrid', 'recallHybridWithMeta', 'recallSemantic', 'recallAutoSearch',
  'recallExpanded', 'injectHybrid', 'similaritySearch', 'checkRerankerFit',
  'rerankerSelfEval',
  // Network / index plumbing.
  'checkRemoteHealth', 'discoverRemoteScopes', 'registerDiscoveredScopes',
  'registerScope', 'offerableScopes', 'warmRemoteCaches', 'waitForIndex',
  'reportFailure', 'ready',
  // Born async (#676) — never had a sync form, so there is no pre-0.16
  // call site for the migrate tool to rewrite.
  'rescope',
  // Born async (#667) — the outbox inspector behind `plur_outbox` / `plur
  // outbox`. Reads through the async store seam, and new in this release, so
  // there is no pre-0.16 call site for the migrate tool to rewrite.
  'listOutbox',
  // Born async (#856) — near-duplicate REPORTING for the plur_learn path.
  // Embedding-backed, so it could never have been sync, and it is new in this
  // release, so no pre-0.16 call site exists for the migrate tool to rewrite.
  'nearDuplicates',
  // Born async (#852) — the content_hash repair behind `plur reindex-hashes`.
  // Takes the store lock and goes through the async PrimaryStore seam, so it
  // could never have been sync; new in this release, so there is no pre-0.16
  // call site to rewrite.
  'repairContentHashes',
])

/** Public methods of `Plur`, mapped to whether they are declared `async`. */
function plurMethods(): Map<string, boolean> {
  const src = readFileSync(CORE_INDEX, 'utf8')
  const out = new Map<string, boolean>()
  for (const m of src.matchAll(/^ {2}(async )?([a-zA-Z_][\w]*)\(/gm)) {
    const name = m[2]
    if (name.startsWith('_') || name === 'constructor') continue
    if (!out.has(name)) out.set(name, Boolean(m[1]))
  }
  return out
}

describe('NEWLY_ASYNC matches the real Plur class', () => {
  it('lists no method that is actually synchronous', () => {
    // The damaging direction: the tool rewrites a caller's source, so a
    // synchronous name here means it inserts an `await` that does not belong.
    const methods = plurMethods()
    const wrong = NEWLY_ASYNC.filter(n => methods.has(n) && methods.get(n) === false)
    expect(wrong, 'these are synchronous — the tool would advise a wrong await').toEqual([])
  })

  it('lists no name that is not a Plur method at all', () => {
    const methods = plurMethods()
    const unknown = NEWLY_ASYNC.filter(n => !methods.has(n))
    expect(unknown, 'not methods on Plur — a rename or typo').toEqual([])
  })

  it('leaves no async method unaccounted for', () => {
    // The quiet direction: a missing name is an un-awaited call the user is
    // never warned about. A hand-written "expected" list cannot catch this —
    // the first version of this test used one, and dropping `receipt` from
    // NEWLY_ASYNC still passed.
    //
    // So every async public method must be EITHER listed as newly-async OR
    // explicitly declared always-async below. A new async method on `Plur`
    // cannot fall through silently; someone has to decide which it is.
    const methods = plurMethods()
    const asyncMethods = [...methods.entries()].filter(([, isAsync]) => isAsync).map(([n]) => n)
    const unaccounted = asyncMethods.filter(
      n => !NEWLY_ASYNC.includes(n as never) && !ALWAYS_ASYNC.has(n),
    )
    expect(
      unaccounted,
      'async on Plur but neither listed nor declared always-async — add to NEWLY_ASYNC, or to ALWAYS_ASYNC with a reason',
    ).toEqual([])
  })

  it('the method list is non-trivial — a guard against it being emptied', () => {
    // An empty list makes every test above pass and the tool report nothing.
    expect(NEWLY_ASYNC.length).toBeGreaterThan(20)
  })
})

/**
 * Which methods ACTUALLY changed in 0.16 — checked against the released source,
 * not against the current class.
 *
 * Every test above reads `Plur` as it is today, so none of them can see a claim
 * about the past being wrong. That gap was real: the CHANGELOG's BREAKING
 * section listed `learnRouted`, `recallHybrid`, `injectHybrid`, `feedback` and
 * `forget` as newly promise-returning when all five were already async in
 * 0.15.0 — which sends a reader auditing call sites that never moved, and
 * makes the rest of the list less believable.
 */
describe('the sync -> async claim, against the 0.15.0 source', () => {
  /** Methods in NEWLY_ASYNC that were already async before this release. */
  const alreadyAsyncAt0_15 = new Set(['feedback', 'flushOutbox', 'forget', 'learnBatch', 'learnRouted'])

  function methodsAsyncAt0_15(): Set<string> | null {
    try {
      const src = execFileSync('git', ['show', 'v0.15.0:packages/core/src/index.ts'], {
        cwd: join(__dirname, '..', '..', '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      })
      const out = new Set<string>()
      for (const m of src.matchAll(/^ {2}async ([a-zA-Z_][\w]*)\(/gm)) out.add(m[1])
      return out.size > 0 ? out : null
    } catch {
      return null // shallow clone or no tags — see the assertion below
    }
  }

  /**
   * When v0.15.0 is unreachable, these tests must not PASS — that is the
   * vacuous-early-return class this file already fell to twice. The first
   * version took a bare `return` (no assertion, reported green in every
   * shallow clone); the second "fix" asserted the size of a hardcoded Set
   * literal defined nine lines above — a tautology that can never fail, found
   * by the 0.16.0 pre-release audit (#752). So:
   *
   *   - In CI, unreachable history is a hard FAILURE: both workflow checkouts
   *     use `fetch-depth: 0` precisely so this check can run, and a regression
   *     that drops it must break the build, not quietly disable the guard.
   *   - Locally (a `--depth 1` clone, no tags), the tests SKIP — visible in
   *     the report as not-run, unlike a pass. `git fetch --tags` runs them.
   */
  const requireHistory = (before: Set<string> | null, ctx: { skip: () => void }): before is Set<string> => {
    if (before) return true
    if (process.env.CI) {
      expect.fail('v0.15.0 unreachable in CI — the checkout must fetch tags (fetch-depth: 0); this guard cannot run without them')
    }
    ctx.skip()
    return false
  }

  it('every NEWLY_ASYNC method was sync in 0.15.0, except the documented few', ctx => {
    const before = methodsAsyncAt0_15()
    if (!requireHistory(before, ctx)) return
    const unexpected = NEWLY_ASYNC.filter(n => before.has(n) && !alreadyAsyncAt0_15.has(n))
    expect(
      unexpected,
      'already async in 0.15.0 but not listed as such — the release notes will claim it changed',
    ).toEqual([])
  })

  it('and the documented few really were async in 0.15.0', ctx => {
    // The other direction: if one of these was in fact sync, it belongs in the
    // BREAKING list and users are not being told to await it.
    const before = methodsAsyncAt0_15()
    if (!requireHistory(before, ctx)) return
    for (const m of alreadyAsyncAt0_15) {
      expect(before.has(m), `${m} was NOT async in 0.15.0 — it changed, and the notes omit it`).toBe(true)
    }
  })
})
