/**
 * 01 — Basic store & recall
 *
 * Store a few engrams (corrections / conventions), then recall the most relevant
 * one. Fully local and zero-cost: this uses BM25 keyword search — no model
 * download, no API calls. (For semantic search, swap `recall` for the async
 * `recallHybrid` — see the README.)
 *
 * Prerequisites: from the repo root, run `pnpm install && pnpm build` once
 *   (examples import the built @plur-ai/core).
 * Run: pnpm --filter @plur-ai/examples ex:basic
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Plur } from '@plur-ai/core'

// Use a throwaway store so this example never touches your real ~/.plur
const path = mkdtempSync(join(tmpdir(), 'plur-example-'))
const plur = new Plur({ path })

try {
  // Teach the agent a few corrections / conventions
  plur.learn('Use toMatchObject() for partial matching in Vitest — toEqual() is strict', {
    type: 'behavioral',
    domain: 'dev/testing',
  })
  plur.learn('Never force-push to main; open a PR instead', {
    type: 'behavioral',
    domain: 'dev/git',
  })
  plur.learn('House style: tabs for indentation, single quotes in TypeScript', {
    type: 'terminological',
    domain: 'dev/style',
  })

  // Recall the most relevant engrams for a query (BM25, sync, ~15ms)
  const hits = plur.recall('vitest assertion matching', { limit: 3 })

  console.log('Stored 3 engrams. Top matches for "vitest assertion matching":\n')
  for (const e of hits) {
    console.log(`  • ${e.statement}`)
    console.log(`    (${e.id}, scope: ${e.scope})`)
  }
} finally {
  rmSync(path, { recursive: true, force: true })
}

/* Expected output (engram IDs vary):
 *
 * Stored 3 engrams. Top matches for "vitest assertion matching":
 *
 *   • Use toMatchObject() for partial matching in Vitest — toEqual() is strict
 *     (ENG-..., scope: global)
 */
