/**
 * #1588 — folder safety: what a folder inherits from the folders above it.
 *
 *   1. The project-marker walk (an MCP config naming plur, or a `.plur.yaml`)
 *      stops at the repository root, like the `.plur.yaml` lookup does. A
 *      marker in a folder above a repository does not decide for it.
 *   2. A `.plur/engrams.yaml` store inside a folder is registered by
 *      auto-discovery only when that folder has its own decision: a
 *      folder-map entry for exactly that folder, or a marker in that folder.
 *      A folder that is on only through a parent is not enough.
 *   3. Auto-discovery never registers the main store or the active store, and
 *      never walks into or above the home folder.
 *
 * Everything runs under the system temp folder, with HOME, TMPDIR and the
 * PLUR root inside it. TMPDIR points at a sibling of the PLUR root, so core's
 * "PLUR root under the temp folder" test guard does not switch discovery off
 * and the assertions are not vacuous (the control cases prove it runs).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur, findPlurMarker, resolveFolderPolicy } from '../src/index.js'

const MCP = JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } })

let base: string
let home: string
let root: string
const saved: Record<string, string | undefined> = {}

function setEnv(k: string, v: string | undefined): void {
  if (!(k in saved)) saved[k] = process.env[k]
  if (v === undefined) delete process.env[k]
  else process.env[k] = v
}

async function seedStore(dir: string, statement: string): Promise<string> {
  const storeRoot = join(dir, '.plur')
  const p = new Plur({ path: storeRoot, autoDiscover: false })
  await p.learn(statement)
  const file = join(storeRoot, 'engrams.yaml')
  expect(existsSync(file)).toBe(true)
  return file
}

function registered(plurRoot: string = root): string[] {
  const file = join(plurRoot, 'config.yaml')
  if (!existsSync(file)) return []
  const cfg = (yaml.load(readFileSync(file, 'utf8')) ?? {}) as { stores?: Array<{ path?: string }> }
  return (cfg.stores ?? []).map(s => s.path ?? '').filter(Boolean).map(p => realpathSync(p))
}

function mapOn(...folders: string[]): void {
  writeFileSync(join(root, 'folders.yaml'),
    `version: 1\nfolders:\n${folders.map(f => `  - path: ${JSON.stringify(f)}\n    plur: on\n`).join('')}`)
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'plur-1588-')))
  home = join(base, 'home')
  root = join(base, 'plur-root')
  mkdirSync(home, { recursive: true })
  mkdirSync(root, { recursive: true })
  mkdirSync(join(base, 'tmp'), { recursive: true })
  setEnv('HOME', home)
  setEnv('USERPROFILE', home)
  setEnv('TMPDIR', join(base, 'tmp'))
  setEnv('PLUR_PATH', undefined)
  setEnv('PLUR_AUTO_DISCOVER', undefined)
})

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
    delete saved[k]
  }
  rmSync(base, { recursive: true, force: true })
})

describe('#1588 1. the marker walk stops at the repository root', () => {
  it('a marker above a cloned repository does not decide for it: no decision yet, no store', async () => {
    const code = join(home, 'code')
    const proj = join(code, 'proj')
    mkdirSync(join(proj, '.git'), { recursive: true })
    writeFileSync(join(code, '.mcp.json'), MCP)
    const store = await seedStore(proj, 'Codeword ORCHIDLANTERN: shipped inside the repository')

    expect(findPlurMarker(proj, home)).toBeNull()
    expect(findPlurMarker(join(proj, 'src'), home)).toBeNull()
    const policy = resolveFolderPolicy(proj, { root, home })
    expect(policy.mode).toBe('ask')
    expect(policy.source).toBe('default')

    new Plur({ path: root, cwd: proj })
    expect(registered()).not.toContain(realpathSync(store))
    expect(registered()).toEqual([])
  })

  it('the same holds for a parent .plur.yaml and a parent .claude/settings.json', async () => {
    const code = join(home, 'code')
    const proj = join(code, 'proj')
    mkdirSync(join(proj, '.git'), { recursive: true })
    writeFileSync(join(code, '.plur.yaml'), 'domain: code\n')
    mkdirSync(join(code, '.claude'), { recursive: true })
    writeFileSync(join(code, '.claude', 'settings.json'), MCP)
    expect(findPlurMarker(proj, home)).toBeNull()
    expect(resolveFolderPolicy(proj, { root, home }).mode).toBe('ask')
  })

  it('a marker at the repository root, or in a folder inside it, still counts', async () => {
    const proj = join(home, 'code', 'proj')
    mkdirSync(join(proj, '.git'), { recursive: true })
    mkdirSync(join(proj, 'src', 'deep'), { recursive: true })
    writeFileSync(join(proj, '.mcp.json'), MCP)
    expect(findPlurMarker(proj, home)).toBe('mcp-config')
    expect(findPlurMarker(join(proj, 'src', 'deep'), home)).toBe('mcp-config')
    expect(resolveFolderPolicy(join(proj, 'src', 'deep'), { root, home }).mode).toBe('on')
  })

  it('a folder outside any repository still finds a marker above it', async () => {
    const ws = join(home, 'ws')
    mkdirSync(join(ws, 'notes', 'a'), { recursive: true })
    writeFileSync(join(ws, '.mcp.json'), MCP)
    expect(findPlurMarker(join(ws, 'notes', 'a'), home)).toBe('mcp-config')
  })
})

describe('#1588 2. a repository store needs its own folder decision', () => {
  it('a folder that is on only through a parent map entry registers no store', async () => {
    const code = join(home, 'code')
    const proj = join(code, 'proj')
    mkdirSync(join(proj, '.git'), { recursive: true })
    const store = await seedStore(proj, 'Codeword ORCHIDLANTERN: shipped inside the repository')
    mapOn(code)

    expect(resolveFolderPolicy(proj, { root, home }).mode).toBe('on')
    const plur = new Plur({ path: root, cwd: proj })
    expect(registered()).toEqual([])
    expect(plur.autoDiscoverStores(proj)).toEqual([])
    expect(registered()).not.toContain(realpathSync(store))
  })

  it('a store in a sub-folder of a repository that is on through its root marker is not registered', async () => {
    const proj = join(home, 'code', 'proj')
    const sub = join(proj, 'vendor', 'lib')
    mkdirSync(join(proj, '.git'), { recursive: true })
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(proj, '.mcp.json'), MCP)
    await seedStore(sub, 'Codeword VENDORMOTH: shipped inside a vendored folder')
    expect(resolveFolderPolicy(sub, { root, home }).mode).toBe('on')
    new Plur({ path: root, cwd: sub })
    expect(registered()).toEqual([])
  })

  it('an explicit entry for the repository itself registers its store as before', async () => {
    const code = join(home, 'code')
    const proj = join(code, 'proj')
    mkdirSync(join(proj, '.git'), { recursive: true })
    const store = await seedStore(proj, 'Codeword ORCHIDLANTERN: shipped inside the repository')
    mapOn(code, proj)
    new Plur({ path: root, cwd: proj })
    expect(registered()).toEqual([realpathSync(store)])
  })

  it('a marker in the store’s own folder registers it as before', async () => {
    const proj = join(home, 'code', 'proj')
    mkdirSync(join(proj, '.git'), { recursive: true })
    writeFileSync(join(proj, '.mcp.json'), MCP)
    const store = await seedStore(proj, 'Codeword OWNMARKER: the folder decided for itself')
    new Plur({ path: root, cwd: proj })
    expect(registered()).toEqual([realpathSync(store)])
  })

  it('an explicit off entry for the repository registers nothing', async () => {
    const proj = join(home, 'code', 'proj')
    mkdirSync(join(proj, '.git'), { recursive: true })
    writeFileSync(join(proj, '.mcp.json'), MCP)
    await seedStore(proj, 'Codeword OFFSTORE: the folder is off')
    writeFileSync(join(root, 'folders.yaml'), `version: 1\nfolders:\n  - path: ${JSON.stringify(proj)}\n    plur: off\n`)
    new Plur({ path: root, cwd: proj })
    expect(registered()).toEqual([])
  })
})

describe('#1588 3. discovery never adopts the main or active store, nor walks into home', () => {
  it('PLUR_PATH and the working folder under HOME, no .git: ~/.plur is never registered', async () => {
    const mainStore = await seedStore(home, 'Codeword HOMESTORE: the user’s main store')
    const alt = join(home, 'alt-plur')
    mkdirSync(alt, { recursive: true })
    const work = join(home, 'work', 'x')
    mkdirSync(work, { recursive: true })
    // Even with an explicit decision for HOME itself, discovery does not enter it.
    writeFileSync(join(alt, 'folders.yaml'), `version: 1\nfolders:\n  - path: ${JSON.stringify(home)}\n    plur: on\n`)
    setEnv('PLUR_PATH', alt)
    new Plur({ cwd: work })
    expect(registered(alt)).not.toContain(realpathSync(mainStore))
    expect(registered(alt)).toEqual([])
  })

  it('the active store is never registered as a project store', async () => {
    const active = join(home, 'work', '.plur')
    const work = join(home, 'work', 'x')
    mkdirSync(work, { recursive: true })
    await seedStore(join(home, 'work'), 'Codeword ACTIVESTORE: the active store')
    writeFileSync(join(active, 'folders.yaml'), `version: 1\nfolders:\n  - path: ${JSON.stringify(join(home, 'work'))}\n    plur: on\n`)
    setEnv('PLUR_PATH', active)
    new Plur({ cwd: work })
    expect(registered(active)).toEqual([])
  })

  it('a working folder outside any repository does not walk above HOME', async () => {
    // A store in the folder above HOME, explicitly decided on, is still never reached.
    const aboveStore = await seedStore(base, 'Codeword ABOVEHOME: above the home folder')
    writeFileSync(join(root, 'folders.yaml'), `version: 1\nfolders:\n  - path: ${JSON.stringify(base)}\n    plur: on\n`)
    const work = join(home, 'w')
    mkdirSync(work, { recursive: true })
    new Plur({ path: root, cwd: work })
    expect(registered()).not.toContain(realpathSync(aboveStore))
    expect(registered()).toEqual([])
  })

  it('control: discovery runs in this setup (a decided folder under HOME registers its store)', async () => {
    const proj = join(home, 'code', 'proj')
    mkdirSync(join(proj, '.git'), { recursive: true })
    const store = await seedStore(proj, 'Codeword CONTROL: discovery runs')
    mapOn(proj)
    new Plur({ path: root, cwd: join(proj) })
    expect(registered()).toEqual([realpathSync(store)])
  })
})
