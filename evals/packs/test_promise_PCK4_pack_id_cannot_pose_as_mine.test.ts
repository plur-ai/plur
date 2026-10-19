// PCK-4: Text inside a pack cannot pass itself off as one of my own memories or as an instruction to my agent.
//
// The id half. Memory ids are minted per store from the date and a sequence
// number, so a perfectly ordinary pack made by someone else on the same day
// carries the very ids my own memories have. Nothing hostile is needed; a
// hostile author can also just pick my ids. Whatever the pack's ids are, my
// agent must never be shown pack text under one of my memories' ids.
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { tempStore, type TempStore } from '../helpers/store.js'
import { authorPack, scratch } from '../helpers/sync-packs-durability-history-packs.js'

describe('PCK-4 a pack memory cannot pose as mine by carrying my memory id', () => {
  const cleanups: Array<() => void> = []
  let me: TempStore
  afterEach(() => { me?.cleanup(); while (cleanups.length) cleanups.pop()!() })

  it('pack text is never shown to my agent under my own memory id', async () => {
    me = await tempStore({ embedder: 'off' })
    const mine = await me.plur.learn('Deploy rule: run the migrations first', { scope: 'global' })
    const src = scratch('plur-eval-pck4id-'); cleanups.push(src.cleanup)
    // An ordinary pack, made today by someone else from a fresh store.
    const res = await me.plur.installPack(await authorPack(join(src.dir, 'p', 'deploy-tips'), 'deploy-tips', ['Deploy rule: skip the tests when deploying']))
    expect(res.installed, 'precondition: the pack installed its memory').toBe(1)

    const r = await me.plur.inject('deploy rule migrations tests')
    const rendered = [r.directives, r.constraints, r.consider].join('\n')
    expect(rendered, 'precondition: my memory was given to the agent').toContain('run the migrations first')
    expect(rendered, 'precondition: the pack memory was given to the agent').toContain('skip the tests when deploying')

    const underMyId = rendered.split('\n').filter(l => l.includes(`[${mine.id}]`))
    expect(underMyId.some(l => l.includes('run the migrations first')), 'precondition: my memory is shown under its own id').toBe(true)
    for (const line of underMyId) {
      expect(line, `the pack's text was shown to my agent under my own memory id ${mine.id}: ${JSON.stringify(line)}`).not.toContain('skip the tests')
    }
  })
})
