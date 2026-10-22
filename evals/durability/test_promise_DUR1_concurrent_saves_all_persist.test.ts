// DUR-1: Many saves at the same moment all persist; none is lost.
import { afterEach, describe, expect, it } from 'vitest'
import { Plur } from '../../packages/core/src/index.js'
import { tempStore, type TempStore } from '../helpers/store.js'

// Thirty clearly different memories, so nothing about them is a near-copy.
const TOPICS = [
  'apples', 'bridges', 'candles', 'dolphins', 'engines', 'forests', 'glaciers', 'harbours', 'islands', 'jungles',
  'kettles', 'lanterns', 'meadows', 'nebulas', 'orchards', 'pianos', 'quarries', 'rivers', 'saddles', 'tunnels',
  'umbrellas', 'volcanoes', 'windmills', 'xylophones', 'yachts', 'zeppelins', 'anchors', 'beacons', 'canyons', 'deserts',
]
const statements = TOPICS.map((t, i) => `Note ${i + 1}: the inventory of ${t} is checked on ${['Mondays', 'Tuesdays', 'Wednesdays'][i % 3]} by team ${t.toUpperCase()}`)

describe('DUR-1 many saves at the same moment all persist', () => {
  let s: TempStore
  afterEach(() => s?.cleanup())

  it('30 saves started together through one instance are all there after reopening', async () => {
    s = await tempStore({ embedder: 'off' })
    const results = await Promise.all(statements.map(st => s.plur.learn(st, { scope: 'global' })))
    expect(new Set(results.map(r => r.id)).size, 'precondition: 30 saves were acknowledged with 30 distinct ids').toBe(30)

    const reopened = new Plur({ path: s.dir, autoDiscover: false })
    const onDisk = (await reopened.list()).map(e => e.statement)
    const missing = statements.filter(st => !onDisk.includes(st))
    expect(missing, `${missing.length} of 30 acknowledged saves are missing after reopening the store`).toEqual([])
  })

  it('two writers on the same store, 15 saves each at once, lose nothing', async () => {
    s = await tempStore({ embedder: 'off' })
    const other = new Plur({ path: s.dir, autoDiscover: false })
    await other.ready()
    const results = await Promise.all(statements.map((st, i) => (i % 2 === 0 ? s.plur : other).learn(st, { scope: 'global' })))
    expect(results.length, 'precondition: all 30 saves were acknowledged').toBe(30)

    const reopened = new Plur({ path: s.dir, autoDiscover: false })
    const onDisk = (await reopened.list()).map(e => e.statement)
    const missing = statements.filter(st => !onDisk.includes(st))
    expect(missing, `${missing.length} of 30 acknowledged saves from two writers are missing after reopening the store`).toEqual([])
  })
})
