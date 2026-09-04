/**
 * A pack's shipped integrity value must actually be checked (#987).
 *
 * Export wrote the hash into an `INTEGRITY` file. Install recomputed its own
 * hash, recorded that, and never looked at the shipped one — so a pack edited
 * after it was built installed silently, and `plur packs list` then reported
 * `integrity_ok: true`. That field meant "we computed a hash", not "the hash
 * matched", which is the opposite of how anybody reads it.
 *
 * What this does and does not prove is load-bearing, so it is tested too.
 * Matching means the pack ARRIVED INTACT. It does not mean the contents are
 * trustworthy or that the sender is who they claim: nothing is signed, so
 * somebody who edited the contents could edit the value beside it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EngramSchema } from '../src/schemas/engram.js'
import { exportPack, installPack, previewPack, verifyPackIntegrity } from '../src/packs.js'

const engram = (id = 'ENG-2026-08-23-001') => EngramSchema.parse({
  id,
  statement: 'Migrations run before deploys',
  type: 'behavioral',
  scope: 'global',
  status: 'active',
  visibility: 'public',
  content_hash: 'a'.repeat(64),
})

describe('checking the integrity value a pack shipped', () => {
  let out: string
  let packs: string

  beforeEach(() => {
    out = mkdtempSync(join(tmpdir(), 'plur-integ-out-'))
    packs = mkdtempSync(join(tmpdir(), 'plur-integ-packs-'))
    exportPack([engram()], out, { name: 'honest', version: '1.0.0', license: 'cc-by-4.0' })
  })
  afterEach(() => {
    for (const d of [out, packs]) rmSync(d, { recursive: true, force: true })
  })

  const tamper = () => {
    const p = join(out, 'engrams.yaml')
    writeFileSync(p, readFileSync(p, 'utf8').replace('Migrations', 'Deployments'))
  }

  it('an untouched pack matches', () => {
    expect(verifyPackIntegrity(out).status).toBe('ok')
  })

  it('an edited pack does not', () => {
    tamper()
    const check = verifyPackIntegrity(out)
    expect(check.status).toBe('modified')
    expect(check.shipped).not.toBe(check.computed)
  })

  it('a pack with no integrity value is "absent", never "ok"', () => {
    // Nothing was checked. Reporting that as a pass is the original defect.
    rmSync(join(out, 'INTEGRITY'))
    const check = verifyPackIntegrity(out)
    expect(check.status).toBe('absent')
    expect(check.note).toContain('nothing to check it against')
  })

  it('never claims the contents are trustworthy, only that they arrived intact', () => {
    // Matching says nothing about the sender. Packs are not signed.
    const note = verifyPackIntegrity(out).note
    expect(note).toContain('not that its contents are trustworthy')
    expect(note).toContain('not signed')
  })

  it('surfaces the verdict in a preview, before anything installs', async () => {
    tamper()
    const preview = await previewPack(out)
    expect(preview.integrity.status).toBe('modified')
  })

  it('refuses to install a pack that does not match', async () => {
    tamper()
    await expect(installPack(packs, out)).rejects.toThrow(/does not match the integrity value/)
    // And nothing was installed.
    expect(existsSync(join(packs, 'honest'))).toBe(false)
  })

  it('installs one that does, and says what was checked', async () => {
    const result = await installPack(packs, out)
    expect(result.installed).toBe(1)
    expect(result.integrity_check.status).toBe('ok')
  })

  it('can be overridden deliberately, for somebody who knows why it differs', async () => {
    tamper()
    const result = await installPack(packs, out, undefined, { allowModified: true })
    expect(result.installed).toBe(1)
    // The verdict still travels: overriding must not rewrite what was found.
    expect(result.integrity_check.status).toBe('modified')
  })

  it('reports "absent" through an install rather than inventing a pass', async () => {
    rmSync(join(out, 'INTEGRITY'))
    const result = await installPack(packs, out)
    expect(result.integrity_check.status).toBe('absent')
  })
})
