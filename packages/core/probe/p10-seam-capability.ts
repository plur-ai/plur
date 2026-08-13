/**
 * P10 — is the wipe the SEAM's fault or the YAML fallback's?
 *
 * A capability store (append + updateMany, e.g. Postgres/Memory) never gets a
 * whole-corpus save from _appendEngram/_updateEngrams, so a bad read cannot
 * delete rows. A YAML store has neither capability, so BOTH seam methods fall
 * back to _writeEngrams = full replace. This isolates which half destroys data.
 */
import { Plur } from '../src/index.js'
import { MemoryPrimaryStore } from '../src/store/memory-primary-store.js'
import type { PrimaryStore } from '../src/store/primary-store.js'
import type { Engram } from '../src/schemas/engram.js'
import * as fs from 'fs'
import * as os from 'os'
import { join } from 'path'

/** A capability store whose load() lies (returns []) — the corrupt-read case. */
class LyingMemoryStore extends MemoryPrimaryStore {
  lying = false
  override async load(): Promise<Engram[]> { return this.lying ? [] : super.load() }
  override async loadCached(): Promise<Engram[]> { return this.load() }
  realCount(): number { return super.estimateCount() }
}

/** Same lie, but with the capabilities removed — i.e. what YAML looks like. */
class LyingPlainStore implements PrimaryStore {
  readonly kind = 'memory' as const
  readonly location = null
  lying = false
  private engrams: Engram[] = []
  async load(): Promise<Engram[]> { return this.lying ? [] : this.engrams.map(e => structuredClone(e)) }
  async loadCached(): Promise<Engram[]> { return this.load() }
  async save(engrams: Engram[]): Promise<void> { this.engrams = engrams.map(e => structuredClone(e)) }
  invalidate(): void {}
  realCount(): number { return this.engrams.length }
}

// The plain store is now REFUSED at construction (audit #794 / #802): a store
// that can under-report on load() and cannot write single rows defeats every
// write-path guard at once, so it is rejected at wiring time rather than
// allowed to lose data later. It is still exercised here — with the explicit
// `allowUnprotectedStore` opt-out — to show what that opt-out costs.
for (const [label, store, unsafe] of [
  ['capability store (append+updateMany)', new LyingMemoryStore(), false],
  ['plain store (save only), attached WITHOUT the opt-out', new LyingPlainStore(), false],
  ['plain store (save only), attached WITH allowUnprotectedStore', new LyingPlainStore(), true],
] as const) {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'plur-p10-'))
  process.env.PLUR_PATH = root
  let plur: Plur
  try {
    plur = new Plur({ path: root, autoDiscover: false, store: store as unknown as PrimaryStore, allowUnprotectedStore: unsafe })
  } catch (e) {
    console.log(`${label}: REFUSED AT ATTACHMENT — ${(e as Error).message.split('\n')[0]}`)
    console.log('   SAFE — the unprotectable store never got to hold data')
    fs.rmSync(root, { recursive: true, force: true })
    continue
  }
  for (let i = 0; i < 5; i++) await plur.learn(`fact number ${i}`, { scope: 'local' })
  const before = (store as any).realCount()
  ;(store as any).lying = true                       // read now returns [] (corrupt/empty)
  let note = ''
  try {
    const fresh = await plur.learn('a write after the bad read', { scope: 'local' })
    note = `wrote ${fresh.id}`
  } catch (e) {
    note = `REFUSED: ${(e as Error).message.slice(0, 70)}`
  }
  const after = (store as any).realCount()
  console.log(`${label}: rows ${before} -> ${after} — ${note}`)
  console.log(`   ${after < before ? `LOSS — ${before - after} rows destroyed by the fallback save` : 'SAFE — no rows deleted'}`)
  fs.rmSync(root, { recursive: true, force: true })
}
