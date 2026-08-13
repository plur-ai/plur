/**
 * Regression tests for the store-corruption guards (audit #794, issues #795/#796).
 *
 * Each test here corresponds to a corruption class that a probe measured as
 * real data loss on 0.17 main. The probes (`packages/core/probe/`) demonstrate
 * the behaviour end-to-end; these pin it at the unit level so it cannot come
 * back.
 *
 * The bug being defended against, in one sentence: `loadEngrams` returned `[]`
 * for a file it could not understand, and every write path replaces the whole
 * file, so the next write persisted that `[]` over the real corpus.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as yaml from 'js-yaml'
import { join } from 'path'
import {
  loadEngrams,
  saveEngrams,
  getQuarantinedEntries,
  EngramStoreUnreadableError,
  EngramStoreShrinkError,
} from '../src/engrams.js'
import { EngramSchemaPassthrough, type Engram } from '../src/schemas/engram.js'

let root: string
let storePath: string

/**
 * Build a real, fully-defaulted Engram.
 *
 * Parsed through the schema rather than cast, so the fixture cannot drift out
 * of shape: a hand-written object literal with an `as Engram` cast compiles
 * only by lying, and a lying fixture is worthless in tests whose entire subject
 * is what does and does not pass validation.
 */
function engram(n: number): Engram {
  return EngramSchemaPassthrough.parse({
    id: `ENG-2026-08-02-${String(n).padStart(3, '0')}`,
    statement: `fact number ${n} about the system`,
    type: 'behavioral',
    status: 'active',
    confidence: 0.5,
    created: '2026-08-02',
    scope: 'local',
  }) as Engram
}

function seed(count: number): Engram[] {
  const engrams = Array.from({ length: count }, (_, i) => engram(i))
  fs.writeFileSync(storePath, yaml.dump({ engrams }))
  return engrams
}

beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), 'plur-corrupt-guard-'))
  storePath = join(root, 'engrams.yaml')
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('loadEngrams — refuses unreadable stores instead of reporting empty (F1)', () => {
  it('treats a MISSING file as genuinely empty', () => {
    // The one case that must stay `[]`: without it, a first run cannot work.
    expect(loadEngrams(join(root, 'nope.yaml'))).toEqual([])
  })

  it('throws on a zero-length file — the canonical power-loss artifact', () => {
    seed(5)
    fs.writeFileSync(storePath, '')
    // Pre-fix this returned [] (yaml.load('') is undefined, not an error), and
    // the next write persisted the empty corpus.
    expect(() => loadEngrams(storePath)).toThrow(EngramStoreUnreadableError)
  })

  it('throws on a file whose bytes parse to nothing (comments-only / whitespace)', () => {
    fs.writeFileSync(storePath, '# everything below was truncated away\n\n')
    expect(() => loadEngrams(storePath)).toThrow(EngramStoreUnreadableError)
  })

  it('throws on a mapping with no engrams key — a truncated or foreign file', () => {
    fs.writeFileSync(storePath, yaml.dump({ schema_version: 5, note: 'not a store' }))
    expect(() => loadEngrams(storePath)).toThrow(EngramStoreUnreadableError)
  })

  it('throws when engrams is present but is not a list', () => {
    fs.writeFileSync(storePath, yaml.dump({ engrams: { id: 'ENG-1' } }))
    expect(() => loadEngrams(storePath)).toThrow(EngramStoreUnreadableError)
  })

  it('throws on a scalar top-level value', () => {
    fs.writeFileSync(storePath, 'just a string\n')
    expect(() => loadEngrams(storePath)).toThrow(EngramStoreUnreadableError)
  })

  it('still throws on git merge-conflict markers (the #766 case must not regress)', () => {
    seed(5)
    const body = fs.readFileSync(storePath, 'utf8')
    fs.writeFileSync(storePath, `<<<<<<< HEAD\n${body}=======\nengrams: []\n>>>>>>> origin/main\n`)
    expect(() => loadEngrams(storePath)).toThrow(EngramStoreUnreadableError)
  })

  it('accepts an explicitly empty store written by initFilesystemStore', () => {
    fs.writeFileSync(storePath, yaml.dump({ engrams: [] }))
    expect(loadEngrams(storePath)).toEqual([])
  })

  it('refuses a null engrams key — only `engrams: []` is an empty store', () => {
    // This test used to assert the opposite, on the reasoning that `engrams:`
    // is what a hand-edited file looks like. That was wrong and it blessed a
    // hole: PLUR only ever writes `engrams: []`, so a null-valued key is a
    // truncation that stopped after the key. Demonstrated with the old
    // behaviour: 5 engrams, truncate to `engrams:\n`, one learn -> 1 engram on
    // disk, corruption normalised into a valid file (#811 audit, finding 4).
    fs.writeFileSync(storePath, 'engrams:\n')
    expect(() => loadEngrams(storePath)).toThrow(EngramStoreUnreadableError)
  })
})

describe('loadEngrams — quarantines invalid entries instead of deleting them (F2)', () => {
  it('withholds invalid entries from callers but preserves them on the next save', () => {
    const engrams = seed(5)
    const raw: any = yaml.load(fs.readFileSync(storePath, 'utf8'))
    raw.engrams[1].type = 12345        // wrong type
    delete raw.engrams[3].statement    // required field removed
    fs.writeFileSync(storePath, yaml.dump(raw))

    const loaded = loadEngrams(storePath)
    expect(loaded).toHaveLength(3)
    expect(getQuarantinedEntries(storePath)).toHaveLength(2)

    // An ordinary unrelated write — this is what used to delete them.
    saveEngrams(storePath, [...loaded, engram(99)])

    const after: any = yaml.load(fs.readFileSync(storePath, 'utf8'))
    const ids = new Set(after.engrams.map((e: any) => e.id))
    expect(after.engrams).toHaveLength(6)
    expect(ids.has(engrams[1].id)).toBe(true)
    expect(ids.has(engrams[3].id)).toBe(true)
  })

  it('does not resurrect a quarantined entry that has since been re-added properly', () => {
    seed(3)
    const raw: any = yaml.load(fs.readFileSync(storePath, 'utf8'))
    const doomedId = raw.engrams[1].id
    delete raw.engrams[1].statement
    fs.writeFileSync(storePath, yaml.dump(raw))

    const loaded = loadEngrams(storePath)
    expect(loaded).toHaveLength(2)

    // The caller repairs the engram under the same id.
    const repaired = { ...engram(1), id: doomedId }
    saveEngrams(storePath, [...loaded, repaired])

    const after: any = yaml.load(fs.readFileSync(storePath, 'utf8'))
    const matching = after.engrams.filter((e: any) => e.id === doomedId)
    expect(matching).toHaveLength(1)
    expect(matching[0].confidence).toBe(0.5)
  })
})

describe('saveEngrams — shrink guard (F1/F2/F3 choke point)', () => {
  it('refuses a write that would drop the corpus past the tolerance', () => {
    seed(10)
    // The shape of the bug: something read the store as near-empty, and the
    // write path is about to make that permanent.
    expect(() => saveEngrams(storePath, [engram(0)])).toThrow(EngramStoreShrinkError)
    // The file is untouched.
    expect(loadEngrams(storePath)).toHaveLength(10)
  })

  it('refuses a write of an empty array over a populated store', () => {
    seed(10)
    expect(() => saveEngrams(storePath, [])).toThrow(EngramStoreShrinkError)
    expect(loadEngrams(storePath)).toHaveLength(10)
  })

  it('allows a deliberate shrink when the caller declares it', () => {
    seed(10)
    saveEngrams(storePath, [engram(0)], { allowShrink: true })
    expect(loadEngrams(storePath)).toHaveLength(1)
  })

  it('allows small removals within tolerance without a declaration', () => {
    const engrams = seed(100)
    // 5% — below the 10% tolerance, so paths that remove one or two engrams
    // without declaring themselves keep working.
    saveEngrams(storePath, engrams.slice(0, 95))
    expect(loadEngrams(storePath)).toHaveLength(95)
  })

  it('allows growth', () => {
    const engrams = seed(5)
    saveEngrams(storePath, [...engrams, engram(98), engram(99)])
    expect(loadEngrams(storePath)).toHaveLength(7)
  })

  it('has no baseline to guard when the file does not exist yet', () => {
    saveEngrams(storePath, [engram(0)])
    expect(loadEngrams(storePath)).toHaveLength(1)
  })

  it('still refuses a 50% shrink on a store large enough to take the fast path', () => {
    // Regression for a hole introduced while making the guard cheap. The exact
    // count was a full YAML parse — and since _reactivateResults turns every
    // recall() into a save, that taxed the READ path of the largest stores. The
    // first fix estimated the record count from a bytes-per-engram constant;
    // measured engrams average 785 bytes against an assumed 2400, so a 20k
    // store estimated as 6.5k and a genuine 50% shrink skipped the guard.
    const engrams = seed(200)
    expect(() => saveEngrams(storePath, engrams.slice(0, 100))).toThrow(EngramStoreShrinkError)
    expect(loadEngrams(storePath)).toHaveLength(200)
  })

  /**
   * The SECOND hole in the same optimisation (audit 2026-08-03, finding 5).
   *
   * Replacing the bytes-per-engram constant with a serialized-bytes comparison
   * removed the bad constant but kept the assumption underneath it — stated in
   * the code as "records are broadly similar in size". Engrams are not: one
   * carrying `rationale` and `dual_coding` outweighs a bare statement several
   * times over.
   *
   * So a write could drop a large FRACTION OF RECORDS while moving few BYTES,
   * the pre-check would report "not shrinking", and the exact count — the only
   * thing that can actually refuse — never ran. Every other test in this file
   * uses uniform generated engrams, where count and bytes move together, so
   * none of them could catch it.
   *
   * The guard is now unconditional; these pin that it stays that way.
   */
  it('refuses a record-count shrink that barely moves the byte count', () => {
    const big = (i: number) => ({ ...engram(i), rationale: 'r'.repeat(4000) })
    const small = (i: number) => engram(i)
    // 89 large + 11 small. Dropping the 11 small ones is an 11% record loss
    // (past the 10% tolerance) but well under a 1% byte change.
    const heavy = Array.from({ length: 89 }, (_, i) => big(i))
    const light = Array.from({ length: 11 }, (_, i) => small(100 + i))
    saveEngrams(storePath, [...heavy, ...light], { allowShrink: true })
    expect(loadEngrams(storePath)).toHaveLength(100)

    expect(() => saveEngrams(storePath, heavy)).toThrow(EngramStoreShrinkError)
    expect(loadEngrams(storePath)).toHaveLength(100)
  })

  it('refuses a record-count shrink even when the outgoing document is LARGER', () => {
    // The byte pre-check could not see this at all: records were removed AND
    // the survivors grew, so the file gets bigger while the corpus shrinks.
    const engrams = seed(100)
    const fewerButFatter = engrams.slice(0, 50).map(e => ({ ...e, rationale: 'r'.repeat(5000) }))
    expect(() => saveEngrams(storePath, fewerButFatter)).toThrow(EngramStoreShrinkError)
    expect(loadEngrams(storePath)).toHaveLength(100)
  })

  it('counts records exactly without parsing, including multi-line scalars', () => {
    // The fast counter scans for record-start lines. A block scalar's body can
    // contain anything — including a line starting with "- " — and must not be
    // counted as a record.
    const withBlock = Array.from({ length: 20 }, (_, i) => ({
      ...engram(i),
      rationale: 'line one\n- line two looks like a list item\n- so does this\n',
    }))
    saveEngrams(storePath, withBlock, { allowShrink: true })
    expect(loadEngrams(storePath)).toHaveLength(20)
    // 20 -> 17 is 15%, past tolerance. If the scalar bodies were miscounted the
    // baseline would be wrong and this would not throw.
    expect(() => saveEngrams(storePath, withBlock.slice(0, 17))).toThrow(EngramStoreShrinkError)
  })

  it('takes the fast path for a same-size rewrite — no exact count needed', () => {
    // The common case: recall() rewrites the corpus it just read. Must not pay
    // for a full re-parse.
    const engrams = seed(200)
    expect(() => saveEngrams(storePath, engrams)).not.toThrow()
    expect(loadEngrams(storePath)).toHaveLength(200)
  })

  it('counts quarantined entries toward the outgoing total', () => {
    // 10 on disk, 2 invalid -> loader returns 8. Writing those 8 back is a 20%
    // shrink by naive counting, but the 2 quarantined entries are re-appended,
    // so the real outgoing count is 10 and the write must be allowed.
    seed(10)
    const raw: any = yaml.load(fs.readFileSync(storePath, 'utf8'))
    raw.engrams[2].type = 999
    raw.engrams[7].type = 999
    fs.writeFileSync(storePath, yaml.dump(raw))

    const loaded = loadEngrams(storePath)
    expect(loaded).toHaveLength(8)
    expect(() => saveEngrams(storePath, loaded)).not.toThrow()
    expect(yaml.load(fs.readFileSync(storePath, 'utf8')) as any).toMatchObject({
      engrams: expect.objectContaining({ length: 10 }),
    })
  })
})

describe('atomicWrite durability (F4)', () => {
  it('leaves no temp files behind after a successful write', () => {
    saveEngrams(storePath, [engram(0)])
    const strays = fs.readdirSync(root).filter(f => f.endsWith('.tmp'))
    expect(strays).toEqual([])
  })

  it('uses a unique temp name so concurrent writers cannot clobber each other', async () => {
    // The fixed `<path>.tmp` let one writer rename another's partial file,
    // measured in probe P02 as an ENOENT crash. Interleave writes and assert
    // both complete and the file stays parseable.
    const a = Array.from({ length: 20 }, (_, i) => engram(i))
    const b = Array.from({ length: 20 }, (_, i) => engram(i + 100))
    saveEngrams(storePath, a)
    await Promise.all([
      Promise.resolve().then(() => saveEngrams(storePath, [...a, ...b])),
      Promise.resolve().then(() => saveEngrams(storePath, [...a, ...b])),
    ])
    expect(loadEngrams(storePath).length).toBeGreaterThanOrEqual(20)
    expect(fs.readdirSync(root).filter(f => f.endsWith('.tmp'))).toEqual([])
  })
})
