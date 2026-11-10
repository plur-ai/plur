/**
 * A generated large store for the retrieval and injection overhaul (W1).
 *
 * Synthetic and deterministic (seeded): filler engrams from a neutral word
 * list, a block of keyword-dense lookalikes that share the query's common
 * words (many of them locked "apply"-level rules, the shape that fills the
 * legacy constraints floor), 40 long situational pins, and one target engram
 * that carries the query's rare words. Keyword search ranks the target first;
 * the legacy selection crowds it out.
 */
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { EngramSchema, type Engram } from '../../src/schemas/engram.js'
import { saveEngrams } from '../../src/engrams.js'

export const LARGE_QUERY = 'how do I rotate the zorblat signing keys for the quarterly vendor export'
export const TARGET_ID = 'ENG-2026-0101-9999'

const FILLER_WORDS = [
  'garden', 'harbor', 'violet', 'copper', 'meadow', 'lantern', 'pebble', 'orchid', 'thimble', 'saddle',
  'quiver', 'marble', 'timber', 'falcon', 'velvet', 'canyon', 'cobalt', 'ember', 'glacier', 'hazel',
  'island', 'juniper', 'kettle', 'ladder', 'mosaic', 'nectar', 'oyster', 'parcel', 'quartz', 'ribbon',
  'spindle', 'tundra', 'umber', 'vortex', 'willow', 'yonder', 'zephyr', 'anchor', 'beacon', 'cradle',
  'dune', 'easel', 'fable', 'gondola', 'hammock', 'igloo', 'jigsaw', 'kiosk', 'lagoon', 'mitten',
]

/** Tiny deterministic PRNG (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const today = new Date().toISOString().slice(0, 10)

function id(n: number): string {
  // ENG-2025-MMDD-NNN style, unique and stable.
  const mmdd = String(101 + Math.floor(n / 900)).padStart(4, '0')
  return `ENG-2025-${mmdd}-${String((n % 900) + 1).padStart(3, '0')}`
}

function base(n: number, statement: string, extra: Record<string, unknown> = {}): Engram {
  return {
    ...EngramSchema.parse({
      id: id(n), statement, type: 'behavioral', scope: 'global', status: 'active', version: 2, tags: [],
      activation: { retrieval_strength: 0.8, storage_strength: 1, frequency: 0, last_accessed: today },
    }),
    ...extra,
  } as Engram
}

export interface LargeFixture {
  engrams: Engram[]
  pins: Engram[]
  target: Engram
}

/**
 * Build the store. `size` is the total engram count (default 3,000); the
 * lookalike and pin blocks are fixed, fillers make up the rest.
 */
export function buildLargeFixture(size = 3000, seed = 7): LargeFixture {
  const rnd = prng(seed)
  const pick = () => FILLER_WORDS[Math.floor(rnd() * FILLER_WORDS.length)]
  const out: Engram[] = []
  let n = 0
  // 40 long situational pins (about 50 tokens each): far more than half of a
  // 2,000-token budget, as on the measured store.
  const pins: Engram[] = []
  for (let i = 0; i < 40; i++) {
    const words = Array.from({ length: 28 }, pick).join(' ')
    const e = base(n++, `Pinned situational rule ${i}: when handling ${words} follow the ${pick()} checklist.`, { pinned: true })
    pins.push(e)
    out.push(e)
  }
  // 400 lookalikes: the query's common words, keyword-dense, matching tags.
  // Half are locked apply-level rules (the legacy constraints pool).
  for (let i = 0; i < 400; i++) {
    const locked = i % 2 === 0
    const e = base(n++,
      `Vendor export rule ${i}: quarterly signing keys and export keys for the vendor export follow the ${pick()} ${pick()} policy for keys.`,
      {
        tags: ['keys', 'vendor', 'export', 'quarterly', 'signing'],
        domain: 'ops.vendor',
        ...(locked ? { commitment: 'locked', knowledge_type: { memory_class: 'semantic', cognitive_level: 'apply' } } : {}),
        activation: { retrieval_strength: 0.95, storage_strength: 1, frequency: 0, last_accessed: today },
      })
    out.push(e)
  }
  // Fillers.
  while (out.length < size - 1) {
    const words = Array.from({ length: 12 }, pick).join(' ')
    out.push(base(n++, `Note ${n}: ${words}.`, { domain: `misc.${pick()}` }))
  }
  // The target: the query's rare word, no tags, an ordinary strength.
  const target = {
    ...base(0, 'Zorblat signing keys are rotated with the kesh-rotate script before each quarterly vendor export.'),
    id: TARGET_ID,
    domain: 'ops.keys',
  } as Engram
  out.push(target)
  return { engrams: out, pins, target }
}

/** Write a fixture store (engrams.yaml + optional config.yaml) into `dir`. */
export function writeFixtureStore(dir: string, engrams: Engram[], configYaml = ''): void {
  mkdirSync(dir, { recursive: true })
  saveEngrams(join(dir, 'engrams.yaml'), engrams)
  if (configYaml) writeFileSync(join(dir, 'config.yaml'), configYaml)
}
