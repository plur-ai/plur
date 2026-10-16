// DUR-4: A save that would wipe out most of my store is refused.
//
// Driven through the package's exported store primitives (loadEngrams /
// saveEngrams), which every write path and any integrator ends in. Two shapes:
// one save that drops most of the store at once, and a run of small saves that
// would erode it one memory at a time.
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Plur, loadEngrams, saveEngrams } from '../../packages/core/src/index.js'
import { tempStore, type TempStore } from '../helpers/store.js'

async function storeWithTwenty(): Promise<TempStore> {
  const s = await tempStore({ embedder: 'off' })
  const words = ['amber', 'basil', 'cedar', 'delta', 'ember', 'fjord', 'grove', 'heron', 'iris', 'juniper',
    'kelp', 'lotus', 'maple', 'nectar', 'olive', 'pebble', 'quartz', 'raven', 'sage', 'thistle']
  for (const w of words) await s.plur.learn(`The ${w} project ships on its own schedule`, { scope: 'global' })
  return s
}

async function countAfterReopen(dir: string): Promise<number> {
  return (await new Plur({ path: dir, autoDiscover: false }).list()).length
}

describe('DUR-4 a save that would wipe out most of my store is refused', () => {
  let s: TempStore
  afterEach(() => s?.cleanup())

  it('one save that would keep 2 of 20 memories is refused and the store is untouched', async () => {
    s = await storeWithTwenty()
    const path = join(s.dir, 'engrams.yaml')
    const all = loadEngrams(path)
    expect(all.length, 'precondition: 20 memories on disk').toBe(20)

    let refused: unknown = null
    try { saveEngrams(path, all.slice(0, 2)) } catch (e) { refused = e }
    expect(refused, 'a save that would drop 18 of 20 memories was accepted').toBeTruthy()
    expect(await countAfterReopen(s.dir), 'after the refused save the store should still hold all 20 memories').toBe(20)
  })

  it('small saves that each drop one memory cannot erode the store below half', async () => {
    s = await storeWithTwenty()
    const path = join(s.dir, 'engrams.yaml')
    let current = loadEngrams(path)
    expect(current.length, 'precondition: 20 memories on disk').toBe(20)

    // Precondition: an ordinary small removal is allowed.
    saveEngrams(path, current.slice(0, 19))
    current = loadEngrams(path)
    expect(current.length, 'precondition: removing one memory of 20 is an ordinary save and goes through').toBe(19)

    let refusedAt: number | null = null
    for (let keep = 18; keep >= 2; keep--) {
      try { saveEngrams(path, current.slice(0, keep)); current = loadEngrams(path) } catch { refusedAt = keep; break }
    }
    expect(refusedAt, `one-at-a-time saves went all the way down to ${current.length} of 20 memories without a refusal`).not.toBeNull()
    expect(await countAfterReopen(s.dir), 'one-at-a-time saves eroded the store below half of its 20 memories').toBeGreaterThanOrEqual(10)
  })
})
