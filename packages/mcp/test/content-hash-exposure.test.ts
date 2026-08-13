/**
 * `content_hash` must reach the agent — "same fact", not "same record".
 *
 * Every engram has carried a `content_hash` (SHA-256 of the normalized
 * statement) since dedup was added, and `findActiveByContentHash` is part of the
 * store contract. But it appeared in ZERO MCP tool outputs, so an agent could
 * not use it: no cross-store matching, no "do I already hold this fact?" check
 * without re-reading statements.
 *
 * Exposed as a LOOKUP KEY, deliberately not as an identifier. Statements mutate
 * — `learn-async` UPDATE and MERGE, and procedure evolution — so a
 * content-derived handle changes when the content does. #852 is the live proof:
 * 38 engrams in one real store carried a hash that no longer matched their
 * statement. `id` is what stays fixed; the hash answers a different question.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur, computeContentHash } from '@plur-ai/core'
import { getToolDefinitions } from '../src/tools.js'

function tool(name: string) {
  const t = getToolDefinitions('full').find(d => d.name === name)
  if (!t) throw new Error(`tool ${name} not found`)
  return t
}

describe('content_hash reaches the agent', () => {
  let dir: string
  let plur: Plur
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-hash-expose-')); plur = new Plur({ path: dir }) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('plur_learn returns it, and it matches the statement', async () => {
    const res = await tool('plur_learn').handler(
      { statement: 'deploy staging with docker compose', scope: 'global', type: 'procedural' },
      plur,
    ) as { content_hash?: string; statement: string }

    expect(res.content_hash, 'agents cannot dedup across stores without it').toBeDefined()
    expect(res.content_hash).toBe(computeContentHash(res.statement))
  })

  it('plur_recall returns it on every result', async () => {
    await plur.learn('rebase before pushing on this repo', { scope: 'global', type: 'behavioral' })
    const res = await tool('plur_recall').handler({ query: 'rebase' }, plur) as
      { results: Array<{ id: string; content_hash?: string }> }

    expect(res.results.length).toBeGreaterThan(0)
    for (const r of res.results) {
      expect(r.content_hash, `result ${r.id} carried no content_hash`).toBeDefined()
    }
  })

  it('the hash is derived from the fact, so equal statements hash equal', () => {
    // The property that makes cross-store matching work: the hash depends on
    // the normalized statement and nothing else — not the id, not the scope,
    // not when it was written. Asserted directly rather than through two stored
    // engrams, because same-scope writes correctly dedup into one record.
    const a = computeContentHash('systemd units have no $HOME by default')
    const b = computeContentHash('  Systemd units have no $HOME by default!  ')
    expect(b, 'normalization should make these the same fact').toBe(a)
    expect(computeContentHash('systemd units DO have $HOME')).not.toBe(a)
  })

  it('the hash tracks CONTENT, so it is not a stable identifier', async () => {
    // Stated as a test because it is the reason this is a lookup key and not an
    // id: rewrite the statement and the hash moves, while the id does not.
    const e = await plur.learn('the original text', { scope: 'global', type: 'procedural' })
    const before = (e as { content_hash?: string }).content_hash

    const raw = (await plur.getById(e.id))!
    raw.statement = 'entirely different text'
    ;(raw as { content_hash?: string }).content_hash = computeContentHash(raw.statement)
    await plur.updateEngram(raw)

    const after = (await plur.getById(e.id))!
    expect(after.id, 'the id is the identity and must not move').toBe(e.id)
    expect((after as { content_hash?: string }).content_hash).not.toBe(before)
  })
})
