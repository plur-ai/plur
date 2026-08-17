/**
 * 03 — Scope filtering (multi-project)
 *
 * One store, many projects. Scope isolates project knowledge while `global` facts
 * are always included. This is how PLUR keeps one machine's memory from leaking
 * project A's conventions into project B.
 *
 * Prerequisites: from the repo root, run `pnpm install && pnpm build` once.
 * Run: pnpm --filter @plur-ai/examples ex:scope
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Plur } from '@plur-ai/core'

const path = mkdtempSync(join(tmpdir(), 'plur-example-'))
const plur = new Plur({ path })

try {
  // A global fact — applies in every project
  plur.learn('Prefer explicit over implicit; avoid clever one-liners', {
    type: 'behavioral',
    scope: 'global',
    domain: 'dev/style',
  })
  // Project A convention
  plur.learn('api-service uses REST, not GraphQL', {
    type: 'architectural',
    scope: 'project:api-service',
    domain: 'dev/arch',
  })
  // Project B convention
  plur.learn('web-app uses GraphQL via Apollo', {
    type: 'architectural',
    scope: 'project:web-app',
    domain: 'dev/arch',
  })

  // Recall scoped to project A: sees project A + global, never project B
  console.log('Recall in scope project:api-service:')
  for (const e of plur.recall('which API style do we use', { scope: 'project:api-service', limit: 10 })) {
    console.log(`  • [${e.scope}] ${e.statement}`)
  }

  console.log('\nRecall in scope project:web-app:')
  for (const e of plur.recall('which API style do we use', { scope: 'project:web-app', limit: 10 })) {
    console.log(`  • [${e.scope}] ${e.statement}`)
  }
} finally {
  rmSync(path, { recursive: true, force: true })
}

/* Expected: the project:api-service recall shows the REST engram plus the global
 * style engram, but never the web-app GraphQL engram — and vice-versa. Global
 * knowledge rides along with every scoped recall; sibling project scopes stay
 * isolated. */
