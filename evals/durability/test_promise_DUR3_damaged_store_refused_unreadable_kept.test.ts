// DUR-3: A damaged store is refused rather than read as empty, and entries PLUR cannot read are kept, not deleted on the next save.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Plur } from '../../packages/core/src/index.js'
import { tempStore, type TempStore } from '../helpers/store.js'
import { yaml } from '../helpers/sync-packs-durability-history-git.js'

const FIVE = [
  'Backups run nightly at two', 'The staging database is reset on Sundays', 'Release branches are cut on Thursdays',
  'Every service exposes a health endpoint', 'Logs are kept for thirty days',
]

async function storeWithFive(): Promise<TempStore> {
  const s = await tempStore({ embedder: 'off' })
  for (const st of FIVE) await s.plur.learn(st, { scope: 'global' })
  return s
}

describe('DUR-3 a damaged store is refused, and unreadable entries survive the next save', () => {
  let s: TempStore
  afterEach(() => s?.cleanup())

  // Shapes a power loss, a truncated copy or a bad merge leave behind.
  const damages: Array<[string, (text: string) => string]> = [
    ['emptied to zero bytes', () => ''],
    ['truncated right after the "engrams:" line', () => 'engrams:\n'],
    ['cut off part-way through, leaving only whitespace', () => '\n\n   \n'],
    ['left with merge-conflict markers', t => `${'<'.repeat(7)} HEAD\n${t}${'='.repeat(7)}\nengrams: []\n${'>'.repeat(7)} theirs\n`],
  ]

  for (const [what, damage] of damages) {
    it(`a store ${what} is refused, and saving does not overwrite it`, async () => {
      s = await storeWithFive()
      const storePath = join(s.dir, 'engrams.yaml')
      const healthy = readFileSync(storePath, 'utf8')
      const damaged = damage(healthy)
      writeFileSync(storePath, damaged)

      const fresh = new Plur({ path: s.dir, autoDiscover: false })
      let listed: string[] | null = null
      let listErr: unknown = null
      try { listed = (await fresh.list()).map(e => e.statement) } catch (e) { listErr = e }
      expect(listErr, `a store ${what} was read as a store with ${listed?.length} memories instead of being refused`).toBeTruthy()

      let saved = false
      try { await fresh.learn('A brand new memory after the damage', { scope: 'global' }); saved = true } catch { /* refused: expected */ }
      const after = readFileSync(storePath, 'utf8')
      expect(after, `saving into a store ${what} replaced the damaged file (save ${saved ? 'reported success' : 'failed'}) — the original memories could no longer be recovered from it`).toBe(damaged)
    })
  }

  it('entries PLUR cannot read are kept on disk through the next save', async () => {
    s = await storeWithFive()
    const storePath = join(s.dir, 'engrams.yaml')
    const doc = yaml.load(readFileSync(storePath, 'utf8')) as { engrams: Array<Record<string, unknown>> }
    expect(doc.engrams.length, 'precondition: five memories on disk').toBe(5)
    const badTypeId = String(doc.engrams[1].id)
    const noStatementId = String(doc.engrams[3].id)
    doc.engrams[1].type = 12345           // a field PLUR cannot read
    delete doc.engrams[3].statement       // a required field missing
    writeFileSync(storePath, yaml.dump(doc))

    const fresh = new Plur({ path: s.dir, autoDiscover: false })
    const visible = (await fresh.list()).map(e => e.id)
    expect(visible.length, 'precondition: the three readable memories are still served').toBe(3)
    expect(visible, 'precondition: the unreadable entries are withheld, not served').not.toContain(badTypeId)

    let saveErr: unknown = null
    try { await fresh.learn('An ordinary unrelated save after the damage', { scope: 'global' }) } catch (e) { saveErr = e }
    expect(saveErr, `an ordinary save next to unreadable entries should succeed and keep them; it failed: ${String(saveErr).slice(0, 300)}`).toBeNull()

    const ids = (yaml.load(readFileSync(storePath, 'utf8')) as { engrams: Array<{ id: string }> }).engrams.map(e => e.id)
    expect(ids, 'precondition: the new save landed').toHaveLength(6)
    expect(ids, 'an entry PLUR could not read (a wrong field type) was deleted by the next save').toContain(badTypeId)
    expect(ids, 'an entry PLUR could not read (a missing statement) was deleted by the next save').toContain(noStatementId)
  })
})
