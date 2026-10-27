// PROOF-2: For any session, I can get the list of memories my agent had in context —
// given to it, looked up, or saved — and the list carries none of their text, scope
// names, tags or domains.
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalManifestBytes } from '../../packages/core/src/index.js'
import { tempStore, type TempStore } from '../helpers/store.js'

describe('PROOF-2 a session list names given, looked-up and saved memories, and leaks nothing readable', () => {
  let s: TempStore
  afterEach(() => s?.cleanup())

  it('lists all three roles, with hashes', async () => {
    s = await tempStore({ embedder: 'off' })
    const SESSION = 'eval-session-proof2'
    const given = await s.plur.learn('Customer Acme renews in March', {
      scope: 'project:acme-renewals', domain: 'sales.acme', tags: ['acme-secret-tag'], type: 'behavioral',
    })
    const looked = await s.plur.learn('Invoices are sent on the first working day', { scope: 'global' })
    await s.plur.inject('When does Customer Acme renew', { session_id: SESSION, scope: 'project:acme-renewals' } as never)
    s.plur.recordRecall({ session_id: SESSION, ids: [looked.id], query: 'invoices' })
    const saved = await s.plur.learn('The renewal call is booked for Monday', { scope: 'global', session_id: SESSION })

    const m = await s.plur.sessionManifest(SESSION)
    const role = (id: string) => m.engrams.find(e => e.id === id)?.role
    expect(role(given.id), 'a memory given to the agent at injection is not listed as given').toBe('injected')
    expect(role(looked.id), 'a memory the agent looked up is not listed as looked up').toBe('recalled')
    expect(role(saved.id), 'a memory the agent saved is not listed as saved').toBe('written')
    for (const e of m.engrams) {
      expect(e.record_hash, `listed memory ${e.id} has no hash to check it by`).toMatch(/^[0-9a-f]{64}$/)
    }

    const bytes = canonicalManifestBytes(m).toString('utf8')
    for (const secret of ['Customer Acme renews in March', 'Acme', 'acme-renewals', 'sales.acme', 'acme-secret-tag', 'Invoices are sent', 'renewal call']) {
      expect(bytes.includes(secret), `the session list carries "${secret}", which it must never contain`).toBe(false)
    }
  })

  it('a session with nothing recorded gives an empty list, not another session\'s memories', async () => {
    s = await tempStore({ embedder: 'off' })
    await s.plur.learn('The renewal call is booked for Monday', { scope: 'global', session_id: 'some-other-session' })
    const m = await s.plur.sessionManifest('a-session-that-did-nothing')
    expect(m.engrams, 'another session\'s memories appear in this session\'s list').toEqual([])
  })
})
