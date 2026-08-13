/**
 * The corruption matrix: every artifact PLUR reads, damaged every way it can be
 * damaged, against every entry point — asserting BOTH directions of the
 * contract.
 *
 * ## Why this file exists
 *
 * The refuse-on-corrupt work (audits #794, #811, #805) turned a set of silent
 * degradations into exceptions. That was right — returning `[]` for a file that
 * would not parse is what destroyed corpora, because every write replaces the
 * whole file. But it created a NEW class of defect that then recurred five
 * times, each found separately, each after the previous one was declared fixed:
 *
 *   - `status()` died on a corrupt pack registry              (found in #820)
 *   - `status()` still died on corrupt episodes/tensions       (#821 finding 6)
 *   - `session_start` therefore could not start at all         (#821 finding 6)
 *   - `listPacks` aborted entirely on one corrupt pack         (#821 finding 13)
 *   - a refused install left a half-installed pack behind      (#805, on re-probe)
 *
 * Five instances of one mistake: a caller that cannot tolerate a throw now gets
 * one. Each was found by someone tracing callers by hand, and hand-tracing kept
 * missing one. This table replaces the tracing.
 *
 * ## The contract, in both directions
 *
 * A test that only asserts "does not throw" would be satisfied by deleting the
 * protections, so both halves are pinned here:
 *
 *   MUST THROW    a WRITE path reading a damaged corpus. This is the F1/F2
 *                 protection; losing it silently is the original data-loss bug.
 *   MUST NOT THROW  a DIAGNOSTIC, whatever is damaged. `status()` is what an
 *                 operator runs to find out what is wrong; dying on the fault
 *                 it exists to report is worse than the silence it replaced.
 *   MUST NOT THROW  a read path when an UNRELATED artifact is damaged. A broken
 *                 episodes file must not take down recall.
 *   MUST ISOLATE  one damaged pack must not hide the others.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as yaml from 'js-yaml'
import { join } from 'path'
import { Plur } from '../src/index.js'
import { listPacks, installPack, PackRegistryUnreadableError } from '../src/packs.js'
import { loadEngrams, EngramStoreUnreadableError } from '../src/engrams.js'

/**
 * Every way a YAML artifact gets damaged in the wild.
 *
 * Not invented: each maps to something an audit or probe actually produced —
 * a power cut (0 bytes), a truncation landing on a document boundary
 * (`engrams:` with no value), a git merge conflict after `plur sync`, a
 * half-written file, a hand edit.
 */
const CORRUPTIONS: Array<{ name: string; make: (good: string) => string }> = [
  { name: 'zero bytes', make: () => '' },
  { name: 'whitespace only', make: () => '   \n\n  ' },
  { name: 'truncated mid-document', make: g => g.slice(0, Math.max(1, Math.floor(g.length * 0.6))) },
  { name: 'truncated on a key boundary', make: () => 'engrams:\n' },
  { name: 'top level is a list', make: () => '- one\n- two\n' },
  { name: 'top level is a scalar', make: () => 'just a string\n' },
  { name: 'unparseable yaml', make: g => g.slice(0, 40) + '\n  bad: "unterminated\n' },
  { name: 'git conflict markers', make: g => `<<<<<<< HEAD\n${g.slice(0, 60)}\n=======\n${g.slice(0, 60)}\n>>>>>>> other\n` },
]

let root: string

async function seeded(): Promise<Plur> {
  const plur = new Plur({ path: root })
  await plur.ready()
  await plur.learn('the sky is usually blue during the day', { scope: 'global' })
  await plur.learn('espresso extraction takes about thirty seconds', { scope: 'global' })
  return plur
}

function damage(relPath: string, corruption: (good: string) => string): void {
  const p = join(root, relPath)
  const good = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : 'placeholder: true\n'
  fs.mkdirSync(join(root, relPath, '..'), { recursive: true })
  fs.writeFileSync(p, corruption(good))
}

beforeEach(() => { root = fs.mkdtempSync(join(os.tmpdir(), 'plur-matrix-')) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

/**
 * Not every corruption makes an artifact UNREADABLE, and the matrix had to be
 * taught that rather than the other way round:
 *
 *   - `episodes.yaml` and `tensions.yaml` are bare YAML LISTS, so a top-level
 *     list is a structurally valid file whose entries merely fail validation —
 *     and those are quarantined, not errors.
 *   - a corpus truncated mid-document frequently still parses, as a valid but
 *     SMALLER `engrams:` list. The loader is right not to throw; the protection
 *     against that one is the shrink guard on the next write.
 *
 * So the invariant is not "status reports something" — it is that `status()`
 * never throws, and that what it reports AGREES with what the loader does. A
 * hard-coded expectation per cell would encode today's parser behaviour; this
 * encodes the relationship, which is the thing that must hold.
 */
function loaderRefuses(path: string): boolean {
  try {
    loadEngrams(path)
    return false
  } catch {
    return true
  }
}

describe('corruption matrix — status() is a diagnostic and must never throw', () => {
  for (const artifact of ['engrams.yaml', 'episodes.yaml', 'tensions.yaml', 'packs/registry.yaml']) {
    for (const c of CORRUPTIONS) {
      it(`survives ${artifact} — ${c.name}`, async () => {
        const plur = await seeded()
        damage(artifact, c.make)

        // THE invariant: whatever is damaged, the diagnostic answers.
        const status = await plur.status()
        expect(typeof status.engram_count).toBe('number')
        expect(typeof status.storage_root).toBe('string')

        // And it agrees with the loader: reports exactly when reading refuses.
        if (artifact === 'engrams.yaml') {
          const refuses = loaderRefuses(join(root, 'engrams.yaml'))
          expect(Boolean(status.store_errors?.engrams),
            `${c.name}: status and loader disagree about readability`).toBe(refuses)
        }
      })
    }
  }

  it('reports EVERY damaged artifact at once, not just the first', async () => {
    const plur = await seeded()
    damage('episodes.yaml', () => 'oops: "')
    damage('tensions.yaml', () => '- not: {a list of records')

    const status = await plur.status()
    // An operator fixing them one at a time pays a round trip per file
    // otherwise, and each fix reveals the next failure as if it were new.
    expect(Object.keys(status.store_errors ?? {}).sort()).toEqual(['episodes', 'tensions'])
  })

  it('reports nothing when everything is healthy', async () => {
    const plur = await seeded()
    const status = await plur.status()
    expect(status.store_errors).toBeUndefined()
  })
})

describe('corruption matrix — write paths MUST refuse a damaged corpus', () => {
  // Corruptions that leave nothing intelligible. The loader must refuse each:
  // if it ever returns `[]` instead, the original data-loss bug is back, since
  // the write path replaces the whole file.
  const UNREADABLE = CORRUPTIONS.filter(c => c.name !== 'truncated mid-document')

  for (const c of UNREADABLE) {
    it(`refuses to read a corpus that is ${c.name}`, async () => {
      await seeded()
      damage('engrams.yaml', c.make)
      expect(() => loadEngrams(join(root, 'engrams.yaml'))).toThrow(EngramStoreUnreadableError)
    })
  }

  /**
   * The cell that is NOT covered by either guard — pinned deliberately, because
   * the obvious "fix" for it is wrong.
   *
   * A truncation can land where the remainder still parses, so the corpus reads
   * as valid and simply SMALLER. The loader cannot object: nothing is
   * malformed. And the shrink guard cannot either, because its baseline is the
   * file on disk — which IS the truncated one. It compares 21 against 21 and
   * correctly allows the write.
   *
   * That is not a hole in the guards. The records were lost when the file was
   * truncated, not by the write that followed; no write-side check can recover
   * bytes that are already gone. The defence for this class is the validity-
   * gated daily backup and `plur restore`, which is why those exist (#799).
   *
   * This test exists so nobody "fixes" it by making the guard compare against
   * something other than the file it is about to replace — which would break
   * every legitimate write instead.
   */
  it('does NOT refuse a smaller-but-valid corpus — this class is covered by backups', async () => {
    const plur = await seeded()
    for (let i = 0; i < 40; i++) await plur.learn(`filler engram number ${i}`, { scope: 'global' })

    const p = join(root, 'engrams.yaml')
    const before = loadEngrams(p).length
    const good = fs.readFileSync(p, 'utf8')

    // Cut at a record boundary so the remainder is well-formed YAML.
    const lines = good.split('\n')
    const starts = lines.map((l, i) => (/^  - /.test(l) ? i : -1)).filter(i => i >= 0)
    fs.writeFileSync(p, lines.slice(0, starts[Math.floor(starts.length * 0.5)]).join('\n') + '\n')

    const after = loadEngrams(p)
    expect(after.length, 'truncation should leave a readable, smaller corpus').toBeLessThan(before)

    // Neither guard fires, and both are right not to.
    const { saveEngrams } = await import('../src/engrams.js')
    expect(() => saveEngrams(p, after)).not.toThrow()

    // The recovery path for this class is the backup, not the guard.
    const { listBackups } = await import('../src/backup.js')
    expect(typeof listBackups, 'the documented recovery path must exist').toBe('function')
  })
})

describe('corruption matrix — a damaged SIBLING must not break unrelated reads', () => {
  for (const artifact of ['episodes.yaml', 'tensions.yaml', 'packs/registry.yaml']) {
    it(`recall still works with a corrupt ${artifact}`, async () => {
      const plur = await seeded()
      damage(artifact, () => 'nonsense: "')

      // The corpus is intact; nothing about a broken episodes file should stop
      // an engram being retrieved.
      const hits = await plur.recall('espresso')
      expect(hits.length, `${artifact} corruption blocked recall`).toBeGreaterThan(0)
    })
  }
})

describe('corruption matrix — one damaged pack must not hide the others', () => {
  function makePack(name: string): string {
    const dir = join(root, `src-${name}`)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(join(dir, 'SKILL.md'),
      `---\nname: ${name}\nversion: 1.0.0\ndescription: matrix pack\n---\n\n# ${name}\n`)
    fs.writeFileSync(join(dir, 'engrams.yaml'), yaml.dump({
      engrams: [{
        id: `ENG-2026-08-03-${name.slice(-1)}01`, version: 2, status: 'active', consolidated: false,
        type: 'behavioral', scope: 'global', visibility: 'public', statement: `${name} knowledge`,
        activation: { retrieval_strength: 0.7, storage_strength: 1, frequency: 0, last_accessed: '2026-08-03' },
        feedback_signals: { positive: 0, negative: 0, neutral: 0 },
        knowledge_type: { memory_class: 'semantic', cognitive_level: 'remember' },
        knowledge_anchors: [], associations: [], derivation_count: 1, tags: [], pack: null,
        abstract: null, derived_from: null, polarity: null, content_hash: `h${name}`,
        commitment: 'leaning', reference_count: 1, sources: [], recurrence_count: 0,
        summary: name, engram_version: 1, episode_ids: [],
      }],
    }))
    return dir
  }

  for (const c of CORRUPTIONS) {
    it(`lists the healthy pack when a sibling pack's engrams are ${c.name}`, async () => {
      const packsDir = join(root, 'packs')
      fs.mkdirSync(packsDir, { recursive: true })
      await installPack(packsDir, makePack('packA'))
      await installPack(packsDir, makePack('packB'))

      const bDir = listPacks(packsDir).find(p => p.name === 'packB')!.path
      const good = fs.readFileSync(join(bDir, 'engrams.yaml'), 'utf8')
      fs.writeFileSync(join(bDir, 'engrams.yaml'), c.make(good))

      // Aborting here is what finding 13 was: the per-pack fallback called the
      // now-throwing loadEngrams outside any try, so ONE damaged pack removed
      // every other pack from the listing.
      const packs = listPacks(packsDir)
      expect(packs.map(p => p.name), `${c.name}: healthy pack missing`).toContain('packA')
      expect(packs.length, `${c.name}: listing collapsed`).toBe(2)

      const broken = packs.find(p => p.name !== 'packA')!
      // A damaged pack is reported as damaged — not silently listed as a
      // healthy pack that happens to hold zero engrams.
      expect(broken.integrity_status).toBe('unverified')
      expect(broken.load_error, `${c.name}: damage not reported`).toBeTruthy()
    })
  }

  it('refuses an INSTALL against a corrupt registry, and leaves nothing behind', async () => {
    const packsDir = join(root, 'packs')
    fs.mkdirSync(packsDir, { recursive: true })
    await installPack(packsDir, makePack('packA'))
    fs.writeFileSync(join(packsDir, 'registry.yaml'), 'packs:\n  - name: a\n bad: "')

    // Refusing IS correct here — proceeding from a phantom-empty registry
    // destroys every other pack's integrity baseline.
    await expect(installPack(packsDir, makePack('packB'))).rejects.toThrow(PackRegistryUnreadableError)
    // But it must refuse BEFORE doing filesystem work, or the refusal leaves a
    // half-installed pack that then reports as 'unverified' — the same
    // ambiguous state the refusal exists to prevent.
    expect(fs.existsSync(join(packsDir, 'src-packB'))).toBe(false)
  })
})

/**
 * The shrink guard must protect EVERY whole-corpus writer, not just the one
 * everybody exercises (#824, from Črt's independent review of #822).
 *
 * `saveEngrams` had the guard; `YamlStore.save()` — the `EngramStore` backend
 * from `createStore`/`factory.ts` — replaced the whole file by `yaml.dump` and
 * never reached it. It went unnoticed because the DEFAULT primary is
 * `YamlPrimaryStore`, which routes through `saveEngrams`: the guarded path was
 * the one under test.
 *
 * Same failure shape as the quarantine bug — a cross-cutting rule enforced by
 * convention, missed at a parallel call site. These pin both writers against
 * the same invariant so a third one cannot quietly diverge.
 */
describe('every whole-corpus writer honours the shrink guard', () => {
  async function seedStore(path: string, n: number) {
    const { YamlStore } = await import('../src/store/yaml-store.js')
    const store = new YamlStore(path)
    const engrams = Array.from({ length: n }, (_, i) => ({
      id: `ENG-2026-08-03-${String(i).padStart(3, '0')}`,
      statement: `store fact ${i}`, type: 'behavioral', status: 'active',
      scope: 'global', tags: [],
      activation: { retrieval_strength: 1, storage_strength: 1, frequency: 0, last_accessed: '2026-08-03' },
      feedback_signals: { positive: 0, negative: 0, neutral: 0 },
    })) as any[]
    await store.save(engrams)
    return { store, engrams }
  }

  it('YamlStore.save refuses to drop most of the corpus', async () => {
    const path = join(root, 'engrams.yaml')
    const { store, engrams } = await seedStore(path, 40)
    const { EngramStoreShrinkError } = await import('../src/engrams.js')

    await expect(store.save(engrams.slice(0, 4)), 'a 90% drop went through unguarded')
      .rejects.toThrow(EngramStoreShrinkError)
    // And refusing means not writing.
    expect(loadEngrams(path)).toHaveLength(40)
  })

  it('YamlStore.save still allows ordinary edits and growth', async () => {
    const path = join(root, 'engrams.yaml')
    const { store, engrams } = await seedStore(path, 40)

    await expect(store.save(engrams.slice(0, 38))).resolves.toBeUndefined() // 5% — within tolerance
    expect(loadEngrams(path)).toHaveLength(38)
  })

  it('agrees with saveEngrams about where the boundary is', async () => {
    // Two writers, one rule: the same corpus and the same outgoing count must
    // produce the same verdict, whichever path is taken.
    const a = join(root, 'a.yaml')
    const b = join(root, 'b.yaml')
    const { store, engrams } = await seedStore(a, 30)
    const { saveEngrams, EngramStoreShrinkError } = await import('../src/engrams.js')
    saveEngrams(b, engrams as any, { allowShrink: true })

    const tooFew = engrams.slice(0, 20) // 33% drop — past tolerance for both
    await expect(store.save(tooFew)).rejects.toThrow(EngramStoreShrinkError)
    expect(() => saveEngrams(b, tooFew as any)).toThrow(EngramStoreShrinkError)
  })
})
