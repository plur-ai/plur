// PCK-1: Exporting a pack never includes my private memories, secrets or personal details.
//
// The whole store is handed to export, as "export everything" would do. The
// written pack must carry the shareable memory and none of: a private memory, a
// memory holding a credential, a memory holding an email address, or one
// holding a personal home-folder path.
import { readFileSync, readdirSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { tempStore, type TempStore } from '../helpers/store.js'

function readTree(dir: string): string {
  let out = ''
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name)
    out += ent.isDirectory() ? readTree(p) : `\n${readFileSync(p, 'utf8')}`
  }
  return out
}

// A fake token in the shape of a GitHub token, assembled at runtime so this
// file never holds a credential-shaped string.
const FAKE_TOKEN = ['gh', 'p_', 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5'].join('')

describe('PCK-1 an exported pack never carries private memories, secrets or personal details', () => {
  let s: TempStore
  let out: string
  afterEach(() => { s?.cleanup(); if (out) rmSync(out, { recursive: true, force: true }) })

  it('exports the shareable memory and holds back the rest', async () => {
    // allow_secrets: the store holds a credential the way a user who opted out
    // of the save-time secret check (or an older client) would have saved it.
    s = await tempStore({ embedder: 'off', config: 'backend: yaml\nallow_secrets: true\n' })
    const shareable = await s.plur.learn('Prefer small pull requests that do one thing', { scope: 'global', visibility: 'public' })
    const priv = await s.plur.learn('My therapist appointment moved to Tuesdays', { scope: 'global', visibility: 'private' })
    const secret = await s.plur.learn(`The CI deploy token is ${FAKE_TOKEN}`, { scope: 'global', visibility: 'public' })
    const email = await s.plur.learn('Send invoices to jane.doe@example.com each month', { scope: 'global', visibility: 'public' })
    const path = await s.plur.learn('My notes live in /Users/janedoe/Documents/notes', { scope: 'global', visibility: 'public' })

    const all = await s.plur.list()
    const ids = all.map(e => e.id)
    for (const m of [shareable, priv, secret, email, path]) {
      expect(ids, `precondition: memory "${m.statement}" is in the store handed to export`).toContain(m.id)
    }
    const stored = JSON.stringify(all)
    for (const raw of ['therapist appointment', FAKE_TOKEN, 'jane.doe@example.com', '/Users/janedoe']) {
      expect(stored, `precondition: "${raw}" is stored verbatim, so there is something for export to hold back`).toContain(raw)
    }

    out = mkdtempSync(join(tmpdir(), 'plur-eval-export-'))
    const res = s.plur.exportPack(all, join(out, 'my-pack'), { name: 'my-pack', version: '1.0.0', description: 'eval pack', license: 'cc0-1.0' })
    const written = readTree(join(out, 'my-pack'))

    expect(written, 'the shareable memory should be in the exported pack').toContain('Prefer small pull requests')
    expect(res.engram_count, 'the pack should report exactly the one shareable memory').toBe(1)
    expect(written, 'a private memory was written into the exported pack').not.toContain('therapist appointment')
    expect(written, 'a credential was written into the exported pack').not.toContain(FAKE_TOKEN)
    expect(written, 'an email address was written into the exported pack').not.toContain('jane.doe@example.com')
    expect(written, 'a personal home-folder path was written into the exported pack').not.toContain('/Users/janedoe')
    for (const m of [priv, secret, email, path]) {
      expect(written, `memory ${m.id} ("${m.statement}") was written into the exported pack`).not.toContain(m.id)
    }
  })
})
