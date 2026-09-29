/**
 * #1319 — the primary engrams.yaml must never be registered again as a
 * secondary (`project:*`) store.
 *
 * Reproduction: the project directory is under $HOME, and $HOME/.plur is the
 * primary store, but the primary path and the discovery walk spell the same
 * directory differently (here: a symlinked home; in the wild also a realpath
 * vs. non-realpath temp dir, or a symlinked ~/.plur). The walk used to compare
 * raw strings (`join(dir, '.plur') === dirname(primary)`), missed the match,
 * and registered the primary file as `project:<home basename>` — so every
 * primary engram was loaded twice under two ids and injected twice.
 *
 * Uses a NON-temp scratch root: discovery short-circuits when the primary
 * root is under the OS temp dir, which would make these assertions vacuous.
 * HOME and PLUR_PATH both point into the scratch tree; the real ~/.plur is
 * never touched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const SCRATCH = join(HERE, '.scratch-duplicate-primary-store')

describe('#1319 primary store is never registered as a secondary store', () => {
  let realHome: string
  let linkHome: string
  let projectDir: string
  let savedHome: string | undefined
  let savedPlurPath: string | undefined

  beforeEach(() => {
    rmSync(SCRATCH, { recursive: true, force: true })
    realHome = join(SCRATCH, 'real-home')
    linkHome = join(SCRATCH, 'link-home')
    projectDir = join(realHome, 'work', 'my-project')
    mkdirSync(join(realHome, '.plur'), { recursive: true })
    mkdirSync(projectDir, { recursive: true })
    // The primary file exists on disk, as it does on any install that has learned once.
    writeFileSync(join(realHome, '.plur', 'engrams.yaml'), 'engrams: []\n')
    // Stop the upward walk at HOME so it cannot escape the scratch tree
    // (HOME itself is still examined before the walk stops).
    mkdirSync(join(realHome, '.git'), { recursive: true })
    symlinkSync(realHome, linkHome, 'dir')
    savedHome = process.env.HOME
    savedPlurPath = process.env.PLUR_PATH
    process.env.HOME = realHome
    process.env.PLUR_PATH = join(linkHome, '.plur')
  })

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    if (savedPlurPath === undefined) delete process.env.PLUR_PATH
    else process.env.PLUR_PATH = savedPlurPath
    rmSync(SCRATCH, { recursive: true, force: true })
  })

  it('discovery from a project under HOME does not register the primary file', async () => {
    const plur = new Plur({ cwd: projectDir })
    const primaryReal = realpathSync(join(realHome, '.plur', 'engrams.yaml'))
    for (const s of await plur.listStores()) {
      if (s.scope === 'global' || !s.path || s.path === plur.paths.engrams) continue
      expect(realpathSync(s.path)).not.toBe(primaryReal)
    }
    let cfg: any = {}
    try { cfg = yaml.load(readFileSync(join(realHome, '.plur', 'config.yaml'), 'utf8')) ?? {} } catch {}
    expect(cfg.stores ?? []).toEqual([])
  })

  it('inject returns each primary engram once', async () => {
    const plur = new Plur({ cwd: projectDir })
    await plur.learn('the billing service deploys with terraform plans', { scope: 'global' })
    const again = new Plur({ cwd: projectDir })
    const res = await again.inject('how does the billing service deploy')
    const all = `${res.directives}\n${res.constraints}\n${res.consider}`
    expect(all.split('terraform plans').length - 1).toBe(1)
    expect(res.count).toBe(1)
  })

  it('addStore refuses a path that canonicalises to the primary store', () => {
    const plur = new Plur({ cwd: projectDir, autoDiscover: false })
    expect(() => plur.addStore(join(realHome, '.plur', 'engrams.yaml'), 'project:alias', { shared: true }))
      .toThrow(/primary store/)
  })

  it('recognises a primary that does not exist yet (fresh install) under a symlinked home', async () => {
    rmSync(join(realHome, '.plur', 'engrams.yaml'))
    const configPath = join(realHome, '.plur', 'config.yaml')
    const configText = yaml.dump({ stores: [{ path: join(realHome, '.plur', 'engrams.yaml'), scope: 'project:real-home', shared: true, readonly: false }] })
    writeFileSync(configPath, configText)
    const plur = new Plur({ cwd: projectDir, autoDiscover: false })
    expect(plur.ignoredDuplicateStores().map(s => s.scope)).toEqual(['project:real-home'])
    expect(() => plur.addStore(join(realHome, '.plur', 'engrams.yaml'), 'project:alias', { shared: true }))
      .toThrow(/primary store/)
    expect(readFileSync(configPath, 'utf8')).toBe(configText)
  })

  it('addStore treats another spelling of a registered store as already registered', () => {
    const plur = new Plur({ cwd: projectDir, autoDiscover: false })
    const teamReal = join(realHome, 'team', 'engrams.yaml')
    const first = plur.addStore(teamReal, 'project:team', { shared: true })
    expect(first.status).toBe('added')
    const second = plur.addStore(join(linkHome, 'team', 'engrams.yaml'), 'project:team-alias', { shared: true })
    expect(second.status).toBe('already_registered')
    expect(second.scope).toBe('project:team')
    const cfg = yaml.load(readFileSync(join(realHome, '.plur', 'config.yaml'), 'utf8')) as any
    expect(cfg.stores.length).toBe(1)
  })

  it('an existing config.yaml duplicate of the primary is ignored at load and left on disk', async () => {
    const primaryAlias = join(realHome, '.plur', 'engrams.yaml') // same file, other spelling
    const configPath = join(realHome, '.plur', 'config.yaml')
    const configText = yaml.dump({ stores: [{ path: primaryAlias, scope: 'project:real-home', shared: true, readonly: false }] })
    writeFileSync(configPath, configText)

    const plur = new Plur({ cwd: projectDir, autoDiscover: false })
    await plur.learn('the billing service deploys with terraform plans', { scope: 'global' })
    const res = await plur.inject('how does the billing service deploy')
    const all = `${res.directives}\n${res.constraints}\n${res.consider}`
    expect(all.split('terraform plans').length - 1).toBe(1)
    expect(res.count).toBe(1)
    expect((await plur.listStores()).some(s => s.scope === 'project:real-home')).toBe(false)
    // Nothing removed from disk: the entry is ignored, not deleted.
    expect(readFileSync(configPath, 'utf8')).toBe(configText)
  })

  it('an existing config.yaml duplicate of another store with the SAME scope is ignored at load', async () => {
    const teamReal = join(realHome, 'team', 'engrams.yaml')
    mkdirSync(join(realHome, 'team'), { recursive: true })
    writeFileSync(teamReal, 'engrams: []\n')
    const configPath = join(realHome, '.plur', 'config.yaml')
    const configText = yaml.dump({ stores: [
      { path: teamReal, scope: 'project:team', shared: true, readonly: false },
      { path: join(linkHome, 'team', 'engrams.yaml'), scope: 'project:team', shared: true, readonly: false },
    ] })
    writeFileSync(configPath, configText)

    const plur = new Plur({ cwd: projectDir, autoDiscover: false })
    expect((await plur.listStores()).filter(s => s.scope === 'project:team').length).toBe(1)
    expect(plur.ignoredDuplicateStores().map(s => s.path)).toEqual([join(linkHome, 'team', 'engrams.yaml')])
    expect(readFileSync(configPath, 'utf8')).toBe(configText)
  })

  /** Write one engram scoped `scope` into `file`, using a throwaway store to produce valid YAML. */
  async function writeScopedEngram(file: string, scope: string, statement: string): Promise<void> {
    const src = join(SCRATCH, `src-${Math.random().toString(36).slice(2)}`)
    const p = new Plur({ path: src, autoDiscover: false })
    await p.learn(statement, { scope: 'global' })
    const text = readFileSync(join(src, 'engrams.yaml'), 'utf8').replace(/scope: global/g, `scope: ${scope}`)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, text)
  }

  it('one file registered under two DIFFERENT scopes keeps loading under both (review finding 1)', async () => {
    const teamReal = join(realHome, 'team', 'engrams.yaml')
    await writeScopedEngram(teamReal, 'group:acme/eng', 'the billing service deploys with terraform plans')
    const configPath = join(realHome, '.plur', 'config.yaml')
    const configText = yaml.dump({ stores: [
      { path: teamReal, scope: 'project:proj', shared: true, readonly: false },
      { path: join(linkHome, 'team', 'engrams.yaml'), scope: 'group:acme/eng', shared: true, readonly: false },
    ] })
    writeFileSync(configPath, configText)

    const plur = new Plur({ cwd: projectDir, autoDiscover: false })
    expect(plur.ignoredDuplicateStores()).toEqual([])
    const scopes = (await plur.listStores()).map(s => s.scope)
    expect(scopes).toContain('project:proj')
    expect(scopes).toContain('group:acme/eng')
    const res = await plur.inject('how does the billing service deploy')
    expect(`${res.directives}\n${res.constraints}\n${res.consider}`).toContain('terraform plans')
    expect(readFileSync(configPath, 'utf8')).toBe(configText)
  })

  it('addStore on the path of an ignored duplicate says so, not "already registered" (review finding 2)', () => {
    const configPath = join(realHome, '.plur', 'config.yaml')
    const alias = join(realHome, '.plur', 'engrams.yaml')
    writeFileSync(configPath, yaml.dump({ stores: [{ path: alias, scope: 'project:real-home', shared: true, readonly: false }] }))
    const plur = new Plur({ cwd: projectDir, autoDiscover: false })
    let message = ''
    try { plur.addStore(alias, 'project:real-home', { shared: true }) } catch (e) { message = (e as Error).message }
    expect(message).toMatch(/primary store/)
    expect(message).toMatch(/ignored/)
    expect(message).toContain('project:real-home')
  })

  it('addStore on another spelling of a same-scope ignored duplicate answers with the entry that is loaded', async () => {
    const teamReal = join(realHome, 'team', 'engrams.yaml')
    mkdirSync(join(realHome, 'team'), { recursive: true })
    writeFileSync(teamReal, 'engrams: []\n')
    const configPath = join(realHome, '.plur', 'config.yaml')
    writeFileSync(configPath, yaml.dump({ stores: [
      { path: join(linkHome, 'team', 'engrams.yaml'), scope: 'project:ghost', shared: true, readonly: false },
      { path: teamReal, scope: 'project:team', shared: true, readonly: false },
      { path: teamReal, scope: 'project:team', shared: false, readonly: true },
    ] }))
    const plur = new Plur({ cwd: projectDir, autoDiscover: false })
    const loaded = (await plur.listStores()).map(s => s.scope)
    const result = plur.addStore(teamReal, 'project:team', { shared: true })
    expect(result.status).toBe('already_registered')
    expect(loaded).toContain(result.scope)
    expect(result.scope).toBe('project:team')
  })
})

describe('#1319 persistScopeMetadata writeback keeps ignored duplicate entries', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-1319-meta-'))
    writeFileSync(join(dir, 'engrams.yaml'), 'engrams: []\n')
  })

  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('changes only the synced metadata and loses no entry or field', () => {
    const url = 'https://memory.example.test'
    const other = join(dir, 'other', 'engrams.yaml')
    mkdirSync(join(dir, 'other'), { recursive: true })
    writeFileSync(other, 'engrams: []\n')
    const original = {
      index: false,
      custom_top_level: { keep: true },
      stores: [
        { url, token: 'tok', scope: 'group:acme/eng', shared: true, readonly: false, future_field: 'kept' },
        // The primary file under another spelling: ignored at load (#1319).
        { path: `${dir}/./engrams.yaml`, scope: 'project:dup-primary', shared: true, readonly: false, note: 'dup' },
        { path: other, scope: 'project:other', shared: true, readonly: false },
        // The same file as the entry above under another spelling: also ignored.
        { path: `${dir}/other/./engrams.yaml`, scope: 'project:other', shared: false, readonly: true },
      ],
    }
    const configPath = join(dir, 'config.yaml')
    const dump = (o: unknown) => yaml.dump(o, { lineWidth: 120, noRefs: true })
    writeFileSync(configPath, dump(original))

    const plur = new Plur({ path: dir, autoDiscover: false })
    expect(plur.ignoredDuplicateStores().map(s => s.scope).sort()).toEqual(['project:dup-primary', 'project:other'])

    plur.persistScopeMetadata([{
      url, ok: true, authorized: ['group:acme/eng'], registered: ['group:acme/eng'], unregistered: [],
      metadata: [{ scope: 'group:acme/eng', description: 'Engineering', covers: ['acme.engineering'] }],
    } as any])

    const after = yaml.load(readFileSync(configPath, 'utf8')) as typeof original
    // The intended change landed.
    expect(after.stores[0]).toMatchObject({ covers: ['acme.engineering'], description: 'Engineering' })
    // No entry lost, order kept, every field of every entry preserved.
    const expected = structuredClone(original)
    Object.assign(expected.stores[0], { covers: ['acme.engineering'], description: 'Engineering' })
    expect(after).toEqual(expected)
    // Untouched entries and top-level keys are byte-identical in the written file.
    for (const i of [1, 2, 3]) expect(dump(after.stores[i])).toBe(dump(original.stores[i]))
    expect(dump(after.custom_top_level)).toBe(dump(original.custom_top_level))
    // Still ignored after the writeback.
    expect(plur.ignoredDuplicateStores().map(s => s.scope).sort()).toEqual(['project:dup-primary', 'project:other'])
  })
})
