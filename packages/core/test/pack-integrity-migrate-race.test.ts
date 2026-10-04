/**
 * Audit of #1229, finding 3: an install that finishes while
 * `migratePackIntegrity` is walking the packs directory renames its staging
 * directory away between the `readdir` that named it and the `stat` of it. That
 * aborted the whole run with ENOENT. The walk now skips transient entries by
 * name, and skips any entry that is gone by the time it is looked at.
 *
 * `readdirSync` is wrapped so the test can act at exactly that moment.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

let afterReaddir: ((dir: string, names: string[]) => void) | undefined

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const readdirSync = ((...args: Parameters<typeof actual.readdirSync>) => {
    const out = (actual.readdirSync as (...a: unknown[]) => unknown)(...args)
    if (afterReaddir && Array.isArray(out) && typeof args[0] === 'string' && out.every(x => typeof x === 'string')) {
      const hook = afterReaddir
      afterReaddir = undefined
      hook(args[0], out as string[])
    }
    return out
  }) as typeof actual.readdirSync
  return { ...actual, default: { ...actual, readdirSync }, readdirSync }
})

const { mkdtempSync, rmSync, readFileSync, writeFileSync, cpSync, renameSync } = await import('fs')
const { tmpdir } = await import('os')
const { join } = await import('path')
const yaml = (await import('js-yaml')).default
const { EngramSchema } = await import('../src/schemas/engram.js')
const { exportPack, installPack, computePackHash, migratePackIntegrity, listPacks } = await import('../src/packs.js')
const { loadAllPacks } = await import('../src/engrams.js')

let tmp: string
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'plur-integ-race-')) })
afterEach(() => { afterReaddir = undefined; rmSync(tmp, { recursive: true, force: true }) })

async function legacyInstall(packs: string, name: string): Promise<string> {
  const out = join(tmp, `src-${name}`)
  exportPack([EngramSchema.parse({
    id: 'ENG-2026-09-27-001', statement: 'Migrations run before deploys', type: 'behavioral',
    scope: 'global', status: 'active', visibility: 'public', content_hash: 'a'.repeat(64),
  })], out, { name, version: '1.0.0', license: 'cc-by-4.0' })
  await installPack(packs, out)
  const regPath = join(packs, 'registry.yaml')
  const reg = yaml.load(readFileSync(regPath, 'utf8')) as { packs: Array<{ name: string; integrity: string }> }
  reg.packs.find(r => r.name === name)!.integrity = `sha256:${computePackHash(join(packs, `src-${name}`))}`
  writeFileSync(regPath, yaml.dump(reg))
  return join(packs, `src-${name}`)
}

describe('a staging directory renamed mid-run does not abort the run', () => {
  for (const dryRun of [true, false]) {
    it(dryRun ? 'dry run' : 'real run', async () => {
      const packs = join(tmp, 'packs')
      const installed = await legacyInstall(packs, 'clean')
      const staging = join(packs, 'other.installing-999-1')
      const ghost = join(packs, 'ghost')
      cpSync(installed, staging, { recursive: true })
      cpSync(installed, ghost, { recursive: true })
      // The walk has its names; now the install completes (staging renamed
      // into place elsewhere) and another pack is removed.
      afterReaddir = (dir) => {
        if (dir !== packs) return
        renameSync(staging, join(tmp, 'moved-away'))
        rmSync(ghost, { recursive: true, force: true })
      }
      const report = migratePackIntegrity(packs, { dryRun })
      expect(afterReaddir).toBeUndefined() // the hook fired
      expect(report.packs.map(p => [p.dir, p.action])).toEqual([['src-clean', 'migrated']])
    })
  }

  it('listPacks and loadAllPacks survive the same race', async () => {
    const packs = join(tmp, 'packs')
    await legacyInstall(packs, 'clean')
    const ghost = join(packs, 'ghost')
    cpSync(join(packs, 'src-clean'), ghost, { recursive: true })
    afterReaddir = (dir) => { if (dir === packs) rmSync(ghost, { recursive: true, force: true }) }
    expect(listPacks(packs).map(p => p.name)).toEqual(['clean'])
    cpSync(join(packs, 'src-clean'), ghost, { recursive: true })
    afterReaddir = (dir) => { if (dir === packs) rmSync(ghost, { recursive: true, force: true }) }
    expect(loadAllPacks(packs).map(p => p.manifest.name)).toEqual(['clean'])
  })
})
