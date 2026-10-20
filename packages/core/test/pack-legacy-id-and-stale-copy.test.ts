/**
 * Upgrade compatibility for two earlier pack fixes.
 *
 * 1. Pack ids. A pack name not in slug form (`Release Rules`) now carries a
 *    digest in its pack-id part, so `ENG-TEST-pack-release-rules` became
 *    `ENG-TEST-pack-release-rules--<digest>`. Ids handed out under the earlier
 *    form (lookups, my memories' relations, receipts) must still name the same
 *    pack row when exactly one row answers to them, and name nothing when
 *    several do.
 *
 * 2. Stale copies. An earlier install bug could leave one pack installed twice:
 *    a copy displaced into a fallback directory by a collision, plus a second
 *    copy in the directory it was displaced from. Upgrading that pack must leave
 *    one installation, while two installations the user made on purpose (each
 *    in the directory its own source is named after) stay apart.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { installPack, uninstallPack, listPacks } from '../src/packs.js'
import { packEngramId } from '../src/engrams.js'

function source(root: string, owner: string, name: string, version: string, statement = `Follow release procedure version ${version}`): string {
  const d = join(root, owner, 'pack')
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'SKILL.md'), `---\nname: ${JSON.stringify(name)}\nversion: "${version}"\n---\n`)
  writeFileSync(join(d, 'engrams.yaml'), yaml.dump({ engrams: [{
    id: 'ENG-TEST', statement, type: 'behavioral', scope: 'global', status: 'active', visibility: 'public',
    activation: { retrieval_strength: 0.9, storage_strength: 1.0, frequency: 0, last_accessed: '2026-01-01' },
  }] }))
  return d
}

function registryRows(packsDir: string): Array<{ name: string; dir?: string; version?: string }> {
  const p = join(packsDir, 'registry.yaml')
  if (!existsSync(p)) return []
  return ((yaml.load(readFileSync(p, 'utf8')) as { packs?: any[] })?.packs ?? [])
}

describe('a public pack id from the earlier id scheme still names its pack row', () => {
  let dir: string
  let src: string
  let plur: Plur
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-legacy-packid-'))
    src = mkdtempSync(join(tmpdir(), 'plur-legacy-packid-src-'))
    writeFileSync(join(dir, 'config.yaml'), 'backend: yaml\nembeddings:\n  enabled: false\n')
    plur = new Plur({ path: dir, autoDiscover: false } as never)
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(src, { recursive: true, force: true })
  })

  it('getById and getByIds resolve the earlier id when one pack row answers to it', async () => {
    await plur.installPack(source(src, 'a', 'Release Rules', '1.0'))
    const nowId = packEngramId('ENG-TEST', 'Release Rules')
    const oldId = 'ENG-TEST-pack-release-rules'
    expect(nowId).not.toBe(oldId)
    const current = await plur.getById(nowId)
    expect(current?.statement).toContain('version 1.0')
    const old = await plur.getById(oldId)
    expect(old?.id).toBe(nowId)
    expect(old?.statement).toBe(current?.statement)
    const many = await plur.getByIds([oldId])
    expect(many.map(e => e.statement)).toEqual([current?.statement])
  })

  it('an earlier id two packs answer to names neither', async () => {
    await plur.installPack(source(src, 'a', 'Release Rules', '1.0', 'Rule from the first pack'))
    await plur.installPack(source(src, 'b', 'release_rules', '1.0', 'Rule from the second pack'))
    expect(await plur.getById('ENG-TEST-pack-release-rules')).toBeNull()
    expect(await plur.getByIds(['ENG-TEST-pack-release-rules'])).toEqual([])
    // Each pack still answers to its own current id.
    expect((await plur.getById(packEngramId('ENG-TEST', 'Release Rules')))?.statement).toBe('Rule from the first pack')
    expect((await plur.getById(packEngramId('ENG-TEST', 'release_rules')))?.statement).toBe('Rule from the second pack')
  })

  it('a slug-form pack keeps its id, which the earlier scheme already gave it', async () => {
    await plur.installPack(source(src, 'a', 'Release Rules', '1.0', 'Rule from the spaced name'))
    await plur.installPack(source(src, 'b', 'release-rules', '1.0', 'Rule from the slug name'))
    expect((await plur.getById('ENG-TEST-pack-release-rules'))?.statement).toBe('Rule from the slug name')
  })

  it('my memory relating to the earlier id still reaches the pack row after the upgrade', async () => {
    await plur.installPack(source(src, 'a', 'Release Rules', '1.0', 'Tag the release commit before publishing'))
    const oldId = 'ENG-TEST-pack-release-rules'
    const mine = await plur.learn('Zebra deployment checklist lives in the wiki', { scope: 'global' })
    // A relation stored before the upgrade, naming the pack row by its earlier id.
    const file = join(dir, 'engrams.yaml')
    const doc = yaml.load(readFileSync(file, 'utf8')) as { engrams: Array<Record<string, any>> }
    const row = doc.engrams.find(e => e.id === mine.id)!
    row.relations = { broader: [], narrower: [], related: [oldId], conflicts: [], supersedes: [], superseded_by: [] }
    writeFileSync(file, yaml.dump(doc))

    const reloaded = await plur.getById(mine.id)
    const target = await plur.getByIds(reloaded!.relations!.related)
    expect(target.map(e => e.statement)).toEqual(['Tag the release commit before publishing'])

    // Spreading activation follows the relation to the pack row.
    const r = await plur.inject('zebra deployment checklist')
    const rendered = [r.directives, r.constraints, r.consider].join('\n')
    expect(rendered).toContain('Zebra deployment checklist')
    expect(rendered).toContain('Tag the release commit before publishing')
  })

  it('feedback on the earlier id reaches the pack row', async () => {
    await plur.installPack(source(src, 'a', 'Release Rules', '1.0'))
    await plur.feedback('ENG-TEST-pack-release-rules', 'positive')
    const packFile = listPacks(join(dir, 'packs')).find(p => p.manifest?.name === 'Release Rules')!.path
    const rows = (yaml.load(readFileSync(join(packFile, 'engrams.yaml'), 'utf8')) as { engrams: Array<Record<string, any>> }).engrams
    expect(rows[0].id).toBe('ENG-TEST')
    expect(rows[0].feedback_signals?.positive).toBe(1)
  })
})

describe('upgrading a pack the earlier collision bug installed twice', () => {
  let tmp: string
  let packs: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'plur-stale-pack-'))
    packs = join(tmp, 'packs')
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  async function seedDuplicate(): Promise<void> {
    await installPack(packs, source(tmp, 'a', 'alpha', '1.0'))
    await installPack(packs, source(tmp, 'b', 'beta', '1.0')) // displaced into packs/beta
    uninstallPack(packs, 'pack')
    // What the earlier bug did next: a beta upgrade landed in the freed packs/pack.
    cpSync(source(tmp, 'b2', 'beta', '2.0'), join(packs, 'pack'), { recursive: true })
  }

  it('leaves one authoritative installation with a consistent registry', async () => {
    await seedDuplicate()
    expect(listPacks(packs).filter(p => p.manifest?.name === 'beta')).toHaveLength(2)
    const res = await installPack(packs, source(tmp, 'b3', 'beta', '3.0'))
    const beta = listPacks(packs).filter(p => p.manifest?.name === 'beta')
    expect(beta.map(p => p.manifest?.version)).toEqual(['3.0'])
    expect(res.superseded).toEqual(['beta'])
    const rows = registryRows(packs).filter(r => r.name === 'beta')
    expect(rows).toHaveLength(1)
    expect(rows[0].dir).toBe(res.registry.dir)
    expect(rows[0].version).toBe('3.0')
    // The obsolete content is gone, and only version 3 is loaded.
    const p = new Plur({ path: tmp, autoDiscover: false } as never)
    const all = await p.list()
    const texts = all.map(e => e.statement).filter(s => s.startsWith('Follow release procedure'))
    expect(texts).toEqual(['Follow release procedure version 3.0'])
  })

  it('also when the upgrade lands in the displaced copy', async () => {
    await seedDuplicate()
    // A source directory named after the displaced copy's directory.
    const d = source(tmp, 'b3', 'beta', '3.0')
    const named = join(tmp, 'b3', 'beta')
    cpSync(d, named, { recursive: true })
    const res = await installPack(packs, named)
    expect(res.registry.dir).toBe('beta')
    expect(res.superseded).toEqual(['pack'])
    expect(listPacks(packs).filter(p => p.manifest?.name === 'beta').map(p => p.manifest?.version)).toEqual(['3.0'])
  })

  it('keeps two installations of one pack the user made from differently named sources', async () => {
    await installPack(packs, source(tmp, 'x', 'beta', '1.0'))           // packs/pack
    const other = join(tmp, 'y', 'beta-team')
    cpSync(source(tmp, 'y', 'beta', '1.5'), other, { recursive: true })
    await installPack(packs, other)                                       // packs/beta-team
    const res = await installPack(packs, source(tmp, 'z', 'beta', '2.0')) // upgrades packs/pack
    expect(res.superseded ?? []).toEqual([])
    expect(listPacks(packs).filter(p => p.manifest?.name === 'beta').map(p => p.manifest?.version).sort()).toEqual(['1.5', '2.0'])
  })

  it('keeps genuinely different packs apart', async () => {
    await installPack(packs, source(tmp, 'a', 'alpha', '1.0'))
    await installPack(packs, source(tmp, 'b', 'beta', '1.0'))
    const res = await installPack(packs, source(tmp, 'b2', 'beta', '2.0'))
    expect(res.superseded ?? []).toEqual([])
    const names = listPacks(packs).map(p => `${p.manifest?.name}@${p.manifest?.version}`).sort()
    expect(names).toEqual(['alpha@1.0', 'beta@2.0'])
  })
})
