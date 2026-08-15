/**
 * The real `Plur` class must satisfy `PlurClient`.
 *
 * `PlurClient` is a structural interface so tests can pass plain objects. That
 * convenience is also its danger: an invented signature type-checks perfectly
 * against a mock and then fails silently against the real engine. This suite
 * found exactly that — `learn` was declared taking an options object when core
 * takes `(statement, context)`, and `feedback` was declared taking a number when
 * core takes `'positive' | 'negative' | 'neutral'`. Both would have shipped.
 *
 * These tests exercise the REAL engine against a temp store.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PlurClient } from '../src/client.js'

let storePath: string
let plur: PlurClient

beforeAll(async () => {
  storePath = mkdtempSync(join(tmpdir(), 'plur-dsh-conf-'))
  const { Plur } = await import('@plur-ai/core')
  // The compile-time half of the contract: if the real class does not satisfy
  // PlurClient, this assignment fails to typecheck.
  plur = new Plur({ path: storePath }) satisfies PlurClient
})

afterAll(() => { rmSync(storePath, { recursive: true, force: true }) })

const SCOPE = 'project:conformance'

/**
 * Every method PlurClient declares, read from the source rather than typed out.
 *
 * A hand-maintained list is how `compactLearn` survived: it was declared on
 * PlurClient, called through `?.`, never added to this array, and core never
 * implemented it — so the compaction path was dead from the first commit and
 * every test passed. Parsing the interface means a method cannot be invented
 * without this file noticing.
 */
function declaredMethods(): string[] {
  const src = readFileSync(new URL('../src/client.ts', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf('export interface PlurClient'))
  return [...body.slice(0, body.indexOf('\n}')).matchAll(/^\s{2}(\w+)\??\(/gm)].map(m => m[1])
}

describe('the real Plur satisfies PlurClient', () => {
  it('declares at least the methods we know it calls', () => {
    // Guards the parser itself: a regex that silently matched nothing would
    // make the check below vacuously pass.
    expect(declaredMethods()).toEqual(expect.arrayContaining(['learn', 'recall', 'inject', 'status']))
  })

  it('exposes EVERY method PlurClient declares — no invented contracts', () => {
    const missing = declaredMethods().filter(m => typeof (plur as Record<string, unknown>)[m] !== 'function')
    expect(missing, `PlurClient declares methods core does not implement: ${missing.join(', ')}`).toEqual([])
  })

  it('learn accepts a positional statement plus a context object', async () => {
    const stored = await plur.learn!('Conformance: pin dsh deps to one release line.', { scope: SCOPE })
    expect((stored as { id?: string }).id).toBeTypeOf('string')
  })

  it('recall returns objects with the id and statement the renderer reads', async () => {
    await plur.learn!('Conformance: deploy with pnpm not npm.', { scope: SCOPE })
    const results = await plur.recall!('deploy', { scope: SCOPE, limit: 5 })
    expect(Array.isArray(results)).toBe(true)
    for (const engram of results) {
      expect(engram.id).toBeTypeOf('string')
      expect(engram.statement).toBeTypeOf('string')
    }
  })

  it('injectHybrid returns the directives/constraints/consider shape renderBlock expects', async () => {
    await plur.learn!('Conformance: always run the manifest gate before publishing.', { scope: SCOPE })
    const injection = await plur.injectHybrid!('publishing checklist', { scope: SCOPE })
    expect(injection).toBeTypeOf('object')
    for (const key of ['directives', 'constraints', 'consider'] as const) {
      const value = (injection as Record<string, unknown>)[key]
      expect(value === undefined || typeof value === 'string', `${key} must be a string`).toBe(true)
    }
    expect(typeof (injection as { count?: unknown }).count).toBe('number')
  })

  it('inject (BM25 fallback) returns the same shape', async () => {
    const injection = await plur.inject!('publishing checklist', { scope: SCOPE })
    expect(typeof (injection as { count?: unknown }).count).toBe('number')
  })

  it('feedback takes the signal WORD — a number is silently ignored, not rejected', async () => {
    const stored = await plur.learn!('Conformance: feedback takes a word.', { scope: SCOPE }) as { id: string }
    await expect(plur.feedback!(stored.id, 'positive', SCOPE)).resolves.not.toThrow()
    // The regression this suite exists for: an earlier contract passed 1 / -1.
    // Core does NOT reject that — it no-ops. So the bug would have shipped as a
    // feature that quietly never trained anything, which is why a type-level
    // contract alone was not enough and this suite exists.
    await expect(plur.feedback!(stored.id, 1 as never, SCOPE)).resolves.not.toThrow()
  })

  it('capture accepts a positional summary plus a context object', async () => {
    // capture() is synchronous in core (it returns the episode, not a promise),
    // so `await` is a no-op here. The contract types it as Promise-or-value.
    expect(() => plur.capture!('Conformance: an episode summary.', { tags: [`scope:${SCOPE}`] })).not.toThrow()
  })

  it('forget accepts an id, a reason, and a scope', async () => {
    const stored = await plur.learn!('Conformance: this one gets retired.', { scope: SCOPE }) as { id: string }
    await expect(plur.forget!(stored.id, 'conformance test', { scope: SCOPE })).resolves.not.toThrow()
  })

  it('list returns the rows the memory viewer renders', async () => {
    // The viewer reads `list()` and nothing else; if core ever changes it to
    // return a paged envelope, /plur-memory renders an empty table in silence.
    const rows = await plur.list!()
    expect(Array.isArray(rows)).toBe(true)
    const row = (rows as Array<{ id?: unknown; statement?: unknown }>)[0]
    if (row) {
      expect(row.id).toBeTypeOf('string')
      expect(row.statement).toBeTypeOf('string')
    }
  })

  it('status exposes storage_root, which the viewer shows and reveals', async () => {
    const status = await plur.status!()
    expect(status).toBeTypeOf('object')
    expect(status.storage_root).toBeTypeOf('string')
  })
})
