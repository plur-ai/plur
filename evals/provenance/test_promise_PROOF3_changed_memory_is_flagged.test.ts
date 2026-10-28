// PROOF-3: If a memory on a session's list is changed afterwards — even only its
// reason — checking the list says that memory changed; untouched memories still match.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { tempStore, type TempStore } from '../helpers/store.js'

describe('PROOF-3 a memory changed after the session is flagged, the rest still match', () => {
  let s: TempStore
  afterEach(() => s?.cleanup())

  async function setup() {
    s = await tempStore({ embedder: 'off' })
    const SESSION = 'eval-session-proof3'
    const a = await s.plur.learn('Release notes are written in plain language', {
      scope: 'global', session_id: SESSION, rationale: 'customers read them',
    })
    const b = await s.plur.learn('Every release has a rollback plan', { scope: 'global', session_id: SESSION })
    const manifest = await s.plur.sessionManifest(SESSION)
    expect(manifest.engrams.length, 'precondition: both saved memories are on the list').toBe(2)
    return { a, b, manifest }
  }

  function editStore(from: string, to: string) {
    const file = join(s.dir, 'engrams.yaml')
    const text = readFileSync(file, 'utf8')
    expect(text.includes(from), `precondition: "${from}" is in the store`).toBe(true)
    writeFileSync(file, text.replace(from, to))
  }

  it('nothing changed: every memory matches and the check passes', async () => {
    const { manifest } = await setup()
    const v = await s.plur.verifyManifest(manifest)
    expect(v.results.map(r => r.status), 'an untouched memory did not match').toEqual(['MATCH', 'MATCH'])
    expect(v.ok, 'a list with every memory unchanged did not pass').toBe(true)
  })

  it('only the reason was edited: that memory is CHANGED and the check fails', async () => {
    const { a, b, manifest } = await setup()
    editStore('customers read them', 'customers skim them')
    const fresh = new (s.plur.constructor as any)({ path: s.dir, autoDiscover: false })
    const v = await fresh.verifyManifest(manifest)
    const status = (id: string) => v.results.find((r: any) => r.id === id)?.status
    expect(status(a.id), 'editing only the reason of a listed memory went unnoticed').toBe('CHANGED')
    expect(status(b.id), 'an untouched memory was reported as changed').toBe('MATCH')
    expect(v.ok, 'a list with a changed memory still passed').toBe(false)
  })

  it('the statement was edited: CHANGED', async () => {
    const { a, manifest } = await setup()
    editStore('Release notes are written in plain language', 'Release notes are written in legal language')
    const fresh = new (s.plur.constructor as any)({ path: s.dir, autoDiscover: false })
    const v = await fresh.verifyManifest(manifest)
    expect(v.results.find((r: any) => r.id === a.id)?.status, 'editing the statement of a listed memory went unnoticed').toBe('CHANGED')
  })

  it('a memory this store does not hold is "not available", never a match', async () => {
    const { manifest } = await setup()
    const other = await tempStore({ embedder: 'off' })
    try {
      const v = await other.plur.verifyManifest(manifest)
      expect(v.results.every(r => r.status === 'NOT AVAILABLE'), 'a memory missing from the checking store was reported as matching').toBe(true)
    } finally { other.cleanup() }
  })
})
