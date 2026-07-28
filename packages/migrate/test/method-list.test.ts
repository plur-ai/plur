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
import { join } from 'path'
import { NEWLY_ASYNC } from '../src/scan.js'

const CORE_INDEX = join(__dirname, '..', '..', 'core', 'src', 'index.ts')

/**
 * Async on `Plur` BEFORE 0.16, so an un-awaited call to one was always a bug
 * rather than migration fallout. Out of this tool's stated scope.
 *
 * Membership here is a claim about history, so it is deliberately explicit:
 * adding a new async method to `Plur` fails the test until someone says which
 * side it belongs on.
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
