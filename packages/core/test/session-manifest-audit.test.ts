/**
 * 0.23 release audit, findings 3 and 12.
 *  3: a manifest is made to be published, so it carries no hash of the bare
 *     statement (an unsalted statement hash lets anyone confirm a guessed text).
 * 12: a check where none of the listed engrams is held is not a pass.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import { canonicalManifestBytes } from '../src/session-manifest.js'
import { computeContentHash } from '../src/content-hash.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
function store(): Plur {
  const d = mkdtempSync(join(tmpdir(), 'plur-manifest-audit-'))
  dirs.push(d)
  return new Plur({ path: d, autoDiscover: false })
}

describe('session manifest (audit findings 3, 12)', () => {
  it('carries no statement hash a reader could test a guessed text against', async () => {
    const p = store()
    const statement = 'Use pnpm for the monorepo builds'
    await p.learn(statement, { type: 'behavioral', session_id: 's-audit' })
    const m = await p.sessionManifest('s-audit')
    expect(m.engrams).toHaveLength(1)
    const text = canonicalManifestBytes(m).toString('utf8')
    expect(text).not.toContain(computeContentHash(statement))
    expect(text).not.toContain(computeContentHash(statement.toLowerCase()))
    expect(m.engrams[0]).not.toHaveProperty('content_hash')
  })

  it('is not ok when none of the listed engrams is in the checking store', async () => {
    const a = store()
    await a.learn('Release notes are written in plain language', { type: 'behavioral', session_id: 's-na' })
    const m = await a.sessionManifest('s-na')
    const v = await store().verifyManifest(m)
    expect(v.counts['NOT AVAILABLE']).toBe(1)
    expect(v.ok).toBe(false)
  })

  it('still ok when what it holds matches and the rest is not available', async () => {
    const a = store()
    await a.learn('Release notes are written in plain language', { type: 'behavioral', session_id: 's-mix' })
    const m = await a.sessionManifest('s-mix')
    m.engrams.push({ id: 'ENG-2099-01-01-001', role: 'recalled', record_hash: null, reason: 'not in local store' } as never)
    const v = await a.verifyManifest(m)
    expect(v.counts.MATCH).toBe(1)
    expect(v.ok).toBe(true)
  })
})
