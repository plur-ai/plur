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
 * PLUR root inside it. Core skips discovery for a PLUR root under the temp
 * folder; PLUR_TEST_DISCOVER_IN_TMP=1 (a test-only switch) turns that skip
 * off, so the assertions are not vacuous (the control cases prove it runs).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync, symlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur, findPlurMarker, resolveFolderPolicy, hasOwnFolderDecision, findProjectConfigPath, folderPatternMatches, sameFolderPath, folderSetOnCommand } from '../src/index.js'

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
  setEnv('PLUR_TEST_DISCOVER_IN_TMP', '1')
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

  it('a marker in the store’s own folder is not the user’s decision: no store until an exact entry (owner, 2026-10-05)', async () => {
    const proj = join(home, 'code', 'proj')
    mkdirSync(join(proj, '.git'), { recursive: true })
    writeFileSync(join(proj, '.mcp.json'), MCP)
    const store = await seedStore(proj, 'Codeword OWNMARKER: the repository marked itself')
    expect(resolveFolderPolicy(proj, { root, home }).mode).toBe('on')
    expect(hasOwnFolderDecision(proj, { root, home })).toBe(false)
    const plur = new Plur({ path: root, cwd: proj })
    expect(registered()).toEqual([])
    expect(plur.skippedProjectStores(proj).map(s => realpathSync(s.path))).toEqual([realpathSync(store)])
    mapOn(proj)
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

// ---------------------------------------------------------------------------
// Audit round (PR #1589).
// ---------------------------------------------------------------------------

function storeScopes(plurRoot: string = root): Array<{ path: string; scope: string }> {
  const file = join(plurRoot, 'config.yaml')
  if (!existsSync(file)) return []
  const cfg = (yaml.load(readFileSync(file, 'utf8')) ?? {}) as { stores?: Array<{ path?: string; scope: string }> }
  return (cfg.stores ?? []).filter(s => s.path).map(s => ({ path: realpathSync(s.path!), scope: s.scope }))
}

describe('#1589 audit M1: an untrusted .plur.yaml is not the folder\u2019s own decision', () => {
  it('P8: parent map entry + untrusted .plur.yaml asking for a scope: no store registered', async () => {
    const code = join(home, 'code')
    const proj = join(code, 'proj')
    mkdirSync(join(proj, '.git'), { recursive: true })
    const store = await seedStore(proj, 'Codeword UNTRUSTEDYAML: shipped with a scope request')
    writeFileSync(join(proj, '.plur.yaml'), 'scope: "group:acme/eng"\n')
    mapOn(code)
    const policy = resolveFolderPolicy(proj, { root, home })
    expect(policy.mode).toBe('on')
    expect(policy.source).toBe('map')
    expect(hasOwnFolderDecision(proj, { root, home })).toBe(false)
    new Plur({ path: root, cwd: proj })
    expect(registered()).not.toContain(realpathSync(store))
    expect(registered()).toEqual([])
  })

  it('an exact --on entry with an untrusted scope request: the store is registered, but not under the requested scope', async () => {
    const proj = join(home, 'code', 'proj')
    mkdirSync(join(proj, '.git'), { recursive: true })
    const store = await seedStore(proj, 'Codeword EXACTUNTRUSTED: decided folder, untrusted scope')
    writeFileSync(join(proj, '.plur.yaml'), 'scope: "group:acme/eng"\n')
    mapOn(proj)
    new Plur({ path: root, cwd: proj })
    expect(storeScopes()).toEqual([{ path: realpathSync(store), scope: 'project:proj' }])
  })

  it('a trusted .plur.yaml still names the store\u2019s scope', async () => {
    const proj = join(home, 'code', 'proj')
    mkdirSync(join(proj, '.git'), { recursive: true })
    const store = await seedStore(proj, 'Codeword TRUSTEDYAML: trusted scope')
    writeFileSync(join(proj, '.plur.yaml'), 'scope: "project:trusted-name"\n')
    writeFileSync(join(root, 'folders.yaml'), `version: 1\nfolders:\n  - path: ${JSON.stringify(proj)}\n    trusted: true\n`)
    new Plur({ path: root, cwd: proj })
    expect(storeScopes()).toEqual([{ path: realpathSync(store), scope: 'project:trusted-name' }])
  })
})

describe('#1589 audit L1: the .plur.yaml lookup stops at the real repository root', () => {
  it('P12: a symlink into a repository sub-folder does not pick up a .plur.yaml above the repository', async () => {
    const ws = join(home, 'ws')
    const repo = join(ws, 'repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(repo, 'src'))
    writeFileSync(join(ws, '.plur.yaml'), '')
    const link = join(ws, 'link')
    symlinkSync(join(repo, 'src'), link)
    expect(findProjectConfigPath(link)).toBeNull()
    expect(resolveFolderPolicy(link, { root, home }).mode).toBe('ask')
    expect(resolveFolderPolicy(join(repo, 'src'), { root, home }).mode).toBe('ask')
  })
})

describe('#1589 audit L2: one entry on an outer folder keeps every repository and worktree below it on', () => {
  it('a workspace entry covers nested repositories, worktrees inside a repository, submodules and new worktree paths', () => {
    const ws = join(home, 'ws')
    const repo = join(ws, 'repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mapOn(ws)
    const nested = [
      repo,
      join(ws, 'other-clone'),
      join(repo, '.claude', 'worktrees', 'feat'),
      join(repo, '.claude', 'worktrees', 'feat-2'),
      join(repo, 'vendor', 'sub'),
    ]
    for (const d of nested.slice(1)) {
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, '.git'), 'gitdir: elsewhere\n')
    }
    for (const d of nested) {
      const p = resolveFolderPolicy(d, { root, home })
      expect(`${p.mode}/${p.source}`, d).toBe('on/map')
    }
  })

  it('an entry on the outer repository does the same for worktrees and submodules inside it', () => {
    const repo = join(home, 'code', 'repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    const wt = join(repo, '.claude', 'worktrees', 'feat')
    mkdirSync(wt, { recursive: true })
    writeFileSync(join(wt, '.git'), 'gitdir: elsewhere\n')
    mapOn(repo)
    expect(resolveFolderPolicy(wt, { root, home }).mode).toBe('on')
  })

  it('without an entry, a worktree inside a repository whose marker sits in the repository root asks once', () => {
    const repo = join(home, 'code', 'repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(repo, '.claude'), { recursive: true })
    writeFileSync(join(repo, '.claude', 'settings.local.json'), MCP)
    const wt = join(repo, '.claude', 'worktrees', 'feat')
    mkdirSync(wt, { recursive: true })
    writeFileSync(join(wt, '.git'), 'gitdir: elsewhere\n')
    expect(resolveFolderPolicy(repo, { root, home }).mode).toBe('on')
    expect(resolveFolderPolicy(wt, { root, home }).mode).toBe('ask')
  })
})

describe('#1589 audit L3: stores skipped for lack of their own decision are listed', () => {
  it('skippedProjectStores names the store and its folder; an off folder is not listed', async () => {
    const mono = join(home, 'code', 'mono')
    const pkg = join(mono, 'packages', 'app')
    mkdirSync(join(mono, '.git'), { recursive: true })
    mkdirSync(pkg, { recursive: true })
    const store = await seedStore(pkg, 'Codeword MONOPKG: a sub-folder store')
    mapOn(mono)
    const plur = new Plur({ path: root, cwd: pkg })
    expect(registered()).toEqual([])
    const skipped = plur.skippedProjectStores(pkg)
    expect(skipped.map(s => realpathSync(s.path))).toEqual([realpathSync(store)])
    expect(realpathSync(skipped[0].folder)).toBe(realpathSync(pkg))
    writeFileSync(join(root, 'folders.yaml'),
      `version: 1\nfolders:\n  - path: ${JSON.stringify(mono)}\n    plur: on\n  - path: ${JSON.stringify(pkg)}\n    plur: off\n`)
    expect(plur.skippedProjectStores(pkg)).toEqual([])
  })

  it('a registered store is not listed as skipped', async () => {
    const proj = join(home, 'code', 'proj')
    mkdirSync(join(proj, '.git'), { recursive: true })
    await seedStore(proj, 'Codeword REGISTERED: decided')
    mapOn(proj)
    const plur = new Plur({ path: root, cwd: proj })
    expect(registered().length).toBe(1)
    expect(plur.skippedProjectStores(proj)).toEqual([])
  })
})

describe('#1589 audit L4: the exact-entry check folds case where folder matching does', () => {
  it('sameFolderPath agrees with the folder matcher on each platform', () => {
    expect(sameFolderPath('C:/Work/REPO', 'c:/work/repo', 'win32')).toBe(true)
    expect(folderPatternMatches('C:/Work/REPO', 'c:/work/repo', 'win32', true)).toBe(true)
    expect(sameFolderPath('C:\\Work\\REPO\\', 'c:/work/repo', 'win32')).toBe(true)
    expect(sameFolderPath('/w/REPO', '/w/repo', 'linux')).toBe(false)
    expect(folderPatternMatches('/w/REPO', '/w/repo', 'linux', true)).toBe(false)
    expect(sameFolderPath('/w/repo/', '/w/repo', 'linux')).toBe(true)
    // Exact, not a subtree: the matcher covers children, this does not.
    expect(sameFolderPath('/w', '/w/repo', 'linux')).toBe(false)
  })
})

describe('#1589 audit L5: the temp-folder skip does not follow a user\u2019s symlink', () => {
  it('without the test switch, a root under TMPDIR is skipped, as before', async () => {
    setEnv('PLUR_TEST_DISCOVER_IN_TMP', undefined)
    const tmpRoot = join(base, 'tmp', 'plur')
    mkdirSync(tmpRoot, { recursive: true })
    const proj = join(home, 'code', 'proj')
    mkdirSync(join(proj, '.git'), { recursive: true })
    await seedStore(proj, 'Codeword TMPROOT: skipped')
    writeFileSync(join(tmpRoot, 'folders.yaml'), `version: 1\nfolders:\n  - path: ${JSON.stringify(proj)}\n    plur: on\n`)
    new Plur({ path: tmpRoot, cwd: proj })
    expect(registered(tmpRoot)).toEqual([])
  })

  it.skipIf(process.platform !== 'darwin')('a PLUR_PATH that is a symlink into TMPDIR is not skipped (macOS, where the base is not under /tmp)', async () => {
    setEnv('PLUR_TEST_DISCOVER_IN_TMP', undefined)
    const real = join(base, 'tmp', 'plur')
    mkdirSync(real, { recursive: true })
    const link = join(home, 'linked-plur')
    symlinkSync(real, link)
    const proj = join(home, 'code', 'proj')
    mkdirSync(join(proj, '.git'), { recursive: true })
    const store = await seedStore(proj, 'Codeword LINKROOT: discovered as before')
    writeFileSync(join(real, 'folders.yaml'), `version: 1\nfolders:\n  - path: ${JSON.stringify(proj)}\n    plur: on\n`)
    new Plur({ path: link, cwd: proj })
    expect(registered(real)).toEqual([realpathSync(store)])
  })
})

// ---------------------------------------------------------------------------
// Audit round 2 (PR #1589).
// ---------------------------------------------------------------------------

describe('#1589 audit round 2, R2-L1: the .plur.yaml lookup walks the real path to the real repository root', () => {
  it('P15: an untrusted .plur.yaml at the real repository root makes a symlinked sub-folder ask, as the real path does', () => {
    const ws = join(home, 'ws')
    const repo = join(ws, 'repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(repo, 'src'))
    writeFileSync(join(repo, '.plur.yaml'), 'scope: "group:acme/eng"\n')
    const link = join(ws, 'link')
    symlinkSync(join(repo, 'src'), link)
    expect(findProjectConfigPath(link)).toBe(join(repo, '.plur.yaml'))
    const viaLink = resolveFolderPolicy(link, { root, home })
    const real = resolveFolderPolicy(join(repo, 'src'), { root, home })
    expect(`${viaLink.mode}/${viaLink.reason}`).toBe('ask/untrusted-plur-yaml')
    expect(`${real.mode}/${real.reason}`).toBe('ask/untrusted-plur-yaml')
    // An untrusted .plur.yaml above the repository changes nothing.
    writeFileSync(join(ws, '.plur.yaml'), 'scope: "group:acme/eng"\n')
    expect(resolveFolderPolicy(link, { root, home }).mode).toBe('ask')
    expect(findProjectConfigPath(link)).toBe(join(repo, '.plur.yaml'))
  })

  it('the returned path keeps the spelling the caller used (an unresolved temp-folder path)', () => {
    const typed = mkdtempSync(join(tmpdir(), 'plur-1589-spell-'))
    try {
      const repo = join(typed, 'repo')
      mkdirSync(join(repo, '.git'), { recursive: true })
      mkdirSync(join(repo, 'sub', 'deep'), { recursive: true })
      writeFileSync(join(repo, '.plur.yaml'), 'domain: x\n')
      expect(findProjectConfigPath(join(repo, 'sub', 'deep'))).toBe(join(repo, '.plur.yaml'))
      expect(findProjectConfigPath(repo)).toBe(join(repo, '.plur.yaml'))
    } finally {
      rmSync(typed, { recursive: true, force: true })
    }
  })
})

describe('#1589 audit round 2, R2-L2: the skipped-store walk follows the real path', () => {
  it('through a symlink into a repository sub-folder, a store above the real repository is not listed', async () => {
    const code = join(home, 'code')
    const ws = join(code, 'ws')
    const repo = join(ws, 'repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(repo, 'src'))
    await seedStore(ws, 'Codeword ABOVEREPO: above the real repository')
    const link = join(ws, 'link')
    symlinkSync(join(repo, 'src'), link)
    mapOn(code)
    const plur = new Plur({ path: root, cwd: link })
    expect(plur.skippedProjectStores(link)).toEqual([])
    expect(registered()).toEqual([])
  })
})

describe('#1589 audit round 2, R2-L3: listing skipped stores writes nothing', () => {
  it('a legacy trust.yaml is not imported into folders.yaml by skippedProjectStores', async () => {
    const code = join(home, 'code')
    const proj = join(code, 'proj')
    mkdirSync(join(proj, '.git'), { recursive: true })
    await seedStore(proj, 'Codeword LEGACYTRUST: a store under a legacy trust entry')
    writeFileSync(join(root, 'trust.yaml'), `trusted:\n  - ${JSON.stringify(code)}\n`)
    const plur = new Plur({ path: root, cwd: proj, autoDiscover: false, readonly: true })
    expect(existsSync(join(root, 'folders.yaml'))).toBe(false)
    const skipped = plur.skippedProjectStores(proj)
    expect(existsSync(join(root, 'folders.yaml'))).toBe(false)
    // The legacy entry is still honoured in memory: the parent is trusted, the repository is not decided.
    expect(skipped.map(s => realpathSync(s.folder))).toEqual([realpathSync(proj)])
  })
})

describe('#1589 audit round 2, R2-M1: the command that adds a skipped store is safe to paste', () => {
  const defaultRoot = () => join(home, '.plur')
  it('quotes the folder and offers nothing for a folder the folder question refuses', () => {
    expect(folderSetOnCommand('/w/proj', defaultRoot(), 'linux')).toBe('plur folders set /w/proj --on')
    expect(folderSetOnCommand('/w/x$(touch C)', defaultRoot(), 'linux')).toBe(`plur folders set '/w/x$(touch C)' --on`)
    expect(folderSetOnCommand("/w/it's here", defaultRoot(), 'linux')).toBe(`plur folders set '/w/it'\\''s here' --on`)
    expect(folderSetOnCommand('/w/a\nb', defaultRoot(), 'linux')).toBeNull()
    expect(folderSetOnCommand('/w/a\u202eb', defaultRoot(), 'linux')).toBeNull()
    expect(folderSetOnCommand('/w/x*', defaultRoot(), 'linux')).toBeNull()
    expect(folderSetOnCommand('C:\\w\\x$(a)', 'C:\\Users\\u\\.plur', 'win32')).toBeNull()
  })

  it('names the store with --path when it is not the default one', () => {
    expect(folderSetOnCommand('/w/proj', '/data/my plur', 'linux')).toBe(`plur --path '/data/my plur' folders set /w/proj --on`)
    expect(folderSetOnCommand('/w/proj', '/data/a\nb', 'linux')).toBeNull()
  })
})

describe('#1589 owner decision (2026-10-05): a repository\u2019s own files never count as the user\u2019s decision', () => {
  it('P9: a fresh clone shipping .mcp.json naming plur, or an empty .plur.yaml, plus a store: nothing registered', async () => {
    const a = join(home, 'code', 'a')
    mkdirSync(join(a, '.git'), { recursive: true })
    writeFileSync(join(a, '.mcp.json'), MCP)
    await seedStore(a, 'Codeword CLONEMCP: shipped with an MCP config')
    const b = join(home, 'code', 'b')
    mkdirSync(join(b, '.git'), { recursive: true })
    writeFileSync(join(b, '.plur.yaml'), '')
    await seedStore(b, 'Codeword CLONEYAML: shipped with an empty .plur.yaml')
    new Plur({ path: root, cwd: a })
    new Plur({ path: root, cwd: b })
    expect(registered()).toEqual([])
    expect(hasOwnFolderDecision(a, { root, home })).toBe(false)
    expect(hasOwnFolderDecision(b, { root, home })).toBe(false)
  })

  it('a trust grant for exactly that folder (plur trust) counts', async () => {
    const proj = join(home, 'code', 'proj')
    mkdirSync(join(proj, '.git'), { recursive: true })
    writeFileSync(join(proj, '.mcp.json'), MCP)
    const store = await seedStore(proj, 'Codeword TRUSTED: plur trust on the folder')
    writeFileSync(join(root, 'folders.yaml'), `version: 1\nfolders:\n  - path: ${JSON.stringify(proj)}\n    trusted: true\n`)
    new Plur({ path: root, cwd: proj })
    expect(registered()).toEqual([realpathSync(store)])
  })
})

// ---------------------------------------------------------------------------
// Audit round 3 (PR #1589).
// ---------------------------------------------------------------------------

describe('#1589 audit round 3', () => {
  it('P14 / R3-M1: a trusted parent trusts the .plur.yaml below it, but the repository store still needs its own entry', async () => {
    const code = join(home, 'code')
    const proj = join(code, 'proj')
    mkdirSync(join(proj, '.git'), { recursive: true })
    const store = await seedStore(proj, 'Codeword PARENTTRUST: under a trusted parent')
    writeFileSync(join(proj, '.plur.yaml'), 'scope: "project:requested"\n')
    writeFileSync(join(root, 'folders.yaml'), `version: 1\nfolders:\n  - path: ${JSON.stringify(code)}\n    plur: on\n    trusted: true\n`)
    const p = resolveFolderPolicy(proj, { root, home })
    expect(`${p.mode}/${p.source}/${p.scope}`).toBe('on/plur-yaml/project:requested')
    const plur = new Plur({ path: root, cwd: proj })
    expect(registered()).toEqual([])
    expect(plur.skippedProjectStores(proj).map(s => realpathSync(s.path))).toEqual([realpathSync(store)])
  })

  it('P16 / R3-L1: an off entry that matches the folder as typed stops discovery, even when the real path is on', async () => {
    const real = join(base, 'repos', 'r')
    mkdirSync(join(real, '.git'), { recursive: true })
    const store = await seedStore(real, 'Codeword ALIASOFF: reached through an alias that is off')
    const aliases = join(home, 'aliases')
    mkdirSync(aliases)
    const alias = join(aliases, 'r')
    symlinkSync(real, alias)
    writeFileSync(join(root, 'folders.yaml'),
      `version: 1\nfolders:\n  - path: ${JSON.stringify(join(aliases, '*'))}\n    plur: off\n  - path: ${JSON.stringify(real)}\n    plur: on\n`)
    expect(resolveFolderPolicy(alias, { root, home }).mode).toBe('off')
    const plur = new Plur({ path: root, cwd: alias })
    expect(registered()).toEqual([])
    expect(plur.skippedProjectStores(alias)).toEqual([])
    // From the real path, the user's exact entry applies as before.
    new Plur({ path: root, cwd: real })
    expect(registered()).toEqual([realpathSync(store)])
  })

  it('P17 / R3-L2: discovery never imports a legacy trust.yaml, and still honours it', async () => {
    const repo = join(home, 'code', 'legacy')
    mkdirSync(join(repo, '.git'), { recursive: true })
    const store = await seedStore(repo, 'Codeword LEGACYSCOPE: trusted in trust.yaml')
    writeFileSync(join(repo, '.plur.yaml'), 'scope: "project:legacy-scope"\n')
    writeFileSync(join(root, 'trust.yaml'), `trusted:\n  - ${JSON.stringify(repo)}\n`)
    new Plur({ path: root, cwd: repo })
    expect(existsSync(join(root, 'folders.yaml'))).toBe(false)
    expect(storeScopes()).toEqual([{ path: realpathSync(store), scope: 'project:legacy-scope' }])
  })
})
