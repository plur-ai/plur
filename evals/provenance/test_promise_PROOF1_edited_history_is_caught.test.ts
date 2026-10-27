// PROOF-1: If someone edits my memory history behind PLUR's back, checking it says the
// history is broken and where; a history it could not read is never reported as clean.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyChain } from '../../packages/core/src/index.js'
import { tempStore, type TempStore } from '../helpers/store.js'

function monthFile(dir: string): string {
  const files = readdirSync(join(dir, 'history')).filter(f => f.endsWith('.jsonl'))
  expect(files.length, 'precondition: saving memories wrote a history file').toBeGreaterThan(0)
  return join(dir, 'history', files.sort().at(-1)!)
}

describe('PROOF-1 an edited history is caught, and an unreadable one is never called clean', () => {
  let s: TempStore
  afterEach(() => s?.cleanup())

  it('an untouched history checks out', async () => {
    s = await tempStore({ embedder: 'off' })
    await s.plur.learn('Deploys go out on Tuesdays', { scope: 'global' })
    await s.plur.learn('Backups are restored once a month as a drill', { scope: 'global' })
    const out = verifyChain(s.dir)
    expect(out.status, 'a history nobody touched does not check out').toBe('verified')
  })

  it('changing what a recorded event says, without its hash, is reported at that event', async () => {
    s = await tempStore({ embedder: 'off' })
    const a = await s.plur.learn('Deploys go out on Tuesdays', { scope: 'global' })
    await s.plur.learn('Backups are restored once a month as a drill', { scope: 'global' })
    const file = monthFile(s.dir)
    const lines = readFileSync(file, 'utf8').split('\n')
    const i = lines.findIndex(l => l.includes(a.id) && l.includes('engram_created'))
    expect(i, 'precondition: the creation of the first memory is in the history').toBeGreaterThanOrEqual(0)
    const ev = JSON.parse(lines[i])
    ev.timestamp = '2020-01-01T00:00:00.000Z' // backdate the record, keep its hash
    lines[i] = JSON.stringify(ev)
    writeFileSync(file, lines.join('\n'))

    const out = verifyChain(s.dir)
    expect(out.status, 'an edited history was reported as clean').toBe('broken')
    if (out.status !== 'cannot_verify') {
      const hit = out.result.breaks.find(b => b.event_id === ev.event_id || b.index === i)
      expect(hit, `the report does not name the edited event (breaks: ${JSON.stringify(out.result.breaks)})`).toBeDefined()
    }
  })

  it('a history it cannot read is "cannot verify", never "verified"', async () => {
    s = await tempStore({ embedder: 'off' })
    await s.plur.learn('Deploys go out on Tuesdays', { scope: 'global' })
    await s.plur.learn('Backups are restored once a month as a drill', { scope: 'global' })
    const file = monthFile(s.dir)
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.splice(1, 0, '{this is not json')
    writeFileSync(file, lines.join('\n'))
    const out = verifyChain(s.dir)
    expect(out.status, 'an unreadable history was reported as verified').not.toBe('verified')
    expect(out.status, 'an unreadable line in the middle must make the check refuse, not pass or fail').toBe('cannot_verify')
  })
})
