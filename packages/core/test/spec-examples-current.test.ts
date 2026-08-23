/**
 * The worked examples in the standard must match what the code produces.
 *
 * They are what a reader of the profile actually looks at. An example that no
 * longer matches the code teaches the wrong format to everybody who copies it,
 * and nothing notices — which is exactly what happened: two of them were
 * hand-committed from a one-off run, and the first time a field was renamed the
 * checked-in files kept the old name.
 *
 * Regenerate with:  pnpm --filter @plur-ai/core build:spec-examples
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const EXAMPLES = join(__dirname, '..', '..', '..', 'spec', 'examples')
const SCRIPT = join(__dirname, '..', 'scripts', 'build-spec-examples.ts')

describe('the worked examples are current', () => {
  const built = (() => {
    const before = ['example-from-typescript.jsonld', 'example-pack.jsonld']
      .map(f => readFileSync(join(EXAMPLES, f), 'utf8'))
    execFileSync('npx', ['tsx', SCRIPT], { cwd: join(__dirname, '..'), stdio: 'pipe', timeout: 120_000 })
    const after = ['example-from-typescript.jsonld', 'example-pack.jsonld']
      .map(f => readFileSync(join(EXAMPLES, f), 'utf8'))
    return { before, after }
  })()

  it('matches what the current code generates, byte for byte', () => {
    // The generator uses fixed inputs and a fixed timestamp, so a difference
    // here means the code changed and the examples were not regenerated.
    expect(built.after[0], 'example-from-typescript.jsonld is stale — run build:spec-examples').toBe(built.before[0])
    expect(built.after[1], 'example-pack.jsonld is stale — run build:spec-examples').toBe(built.before[1])
  }, 130_000)

  it('the pack example still shows both licence counts differing', () => {
    // The example exists to show that a chosen licence and a defaulted one are
    // counted separately. If they ever match, the example stops demonstrating
    // the thing it was written to demonstrate.
    const doc = JSON.parse(readFileSync(join(EXAMPLES, 'example-pack.jsonld'), 'utf8'))
    const pack = doc['@graph'].find((n: any) => n['engram:packName'])
    expect(pack['engram:licenseChosenCount']).toBe(1)
    expect(pack['engram:licenseDefaultedCount']).toBe(1)
  })

  it('carries no stale field names', () => {
    // The specific drift that prompted this test.
    for (const f of ['example-from-typescript.jsonld', 'example-pack.jsonld']) {
      expect(readFileSync(join(EXAMPLES, f), 'utf8'), `${f} uses a renamed field`)
        .not.toContain('engram:licensedCount')
    }
  })
})
