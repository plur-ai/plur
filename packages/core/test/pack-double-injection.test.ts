/**
 * #901 — an installed-pack engram must be considered ONCE, not twice.
 *
 * `selectAndSpread` scores two collections: the engram array it is given, and
 * the `packs` array. `_loadAllEngrams` already merges installed-pack engrams
 * into the corpus (stamping `_pack`), deliberately and for RECALL — its own
 * comment says "include pack engrams so they're searchable via recall".
 * `_inject` then read packs a SECOND time and passed both, so every pack
 * engram was scored twice.
 *
 * Not merely a double count. The two loops apply different rules — the pack
 * loop uses `packMatchTerms` and is capped by MAX_PER_PACK, the personal loop
 * is neither — so the stray copy was scored under rules never meant for it,
 * competed for the same token budget, and could displace a distinct engram.
 * It also inflated `total_injections`, the input to the H003 activation-rate
 * assumption.
 *
 * Found while writing #553's test, which needed a store with exactly one pack
 * engram and no personal ones — and got two injections back.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'

/** An installable pack with `n` engrams, all matching the same query. */
function writePack(dir: string, name: string, n: number): void {
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\nversion: "1.0"\n---\n`)
  const rows = Array.from({ length: n }, (_, i) => [
    `  - id: ENG-2026-0101-${String(i + 1).padStart(3, '0')}`,
    `    statement: prefer semicolons when writing TypeScript code ${i}`,
    '    type: behavioral',
    '    scope: global',
    '    status: active',
    '    version: 2',
    '    activation:',
    '      retrieval_strength: 0.9',
    '      storage_strength: 1.0',
    '      frequency: 0',
    '      last_accessed: "2026-01-01"',
  ].join('\n')).join('\n')
  writeFileSync(join(dir, 'engrams.yaml'), `engrams:\n${rows}\n`)
}

describe('installed-pack engrams are injected once (#901)', () => {
  let dir: string
  let packSource: string
  let plur: Plur

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-901-'))
    packSource = mkdtempSync(join(tmpdir(), 'plur-901-pack-'))
    plur = new Plur({ path: dir })
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(packSource, { recursive: true, force: true })
  })

  it('one pack engram, no personal engrams → exactly one injection', async () => {
    // The measured reproduction. Before the fix this returned 2 for a store
    // holding a single engram.
    writePack(packSource, 'solo-pack', 1)
    await plur.installPack(packSource)

    const res = await plur.inject('write TypeScript code')
    expect(res.count, 'the pack engram was considered twice').toBe(1)
    expect(res.injected_ids).toHaveLength(1)
  })

  it('no injected id appears more than once', async () => {
    // The property that matters regardless of count: the same engram must not
    // occupy two slots in the same context window.
    writePack(packSource, 'multi-pack', 4)
    await plur.installPack(packSource)

    const res = await plur.inject('write TypeScript code')
    expect(new Set(res.injected_ids).size, `duplicates in ${JSON.stringify(res.injected_ids)}`)
      .toBe(res.injected_ids.length)
  })

  it('pack engrams still reach the context — deduping must not silence them', async () => {
    // The opposite failure. Removing them from the personal pool would be a
    // regression if `packs` did not carry them, so assert they are still there.
    writePack(packSource, 'still-visible', 2)
    await plur.installPack(packSource)

    const res = await plur.inject('write TypeScript code')
    expect(res.count, 'the pack path no longer surfaces pack engrams at all').toBeGreaterThan(0)
  })

  it('personal engrams are unaffected', async () => {
    // The filter keys on `_pack`, which only pack clones carry. A personal
    // engram must be untouched by it.
    await plur.learn('always use semicolons in TypeScript', { scope: 'global', type: 'behavioral' })
    const res = await plur.inject('write TypeScript code')
    expect(res.count).toBe(1)
  })

  it('a mixed store counts each engram once', async () => {
    writePack(packSource, 'mixed-pack', 2)
    await plur.installPack(packSource)
    await plur.learn('always use semicolons in TypeScript', { scope: 'global', type: 'behavioral' })

    const res = await plur.inject('write TypeScript code')
    expect(new Set(res.injected_ids).size).toBe(res.injected_ids.length)
    expect(res.count, 'three distinct engrams, three slots').toBe(3)
  })
})
