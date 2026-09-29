/**
 * Folder map (#1347, design r2): resolveFolderPolicy, folders.yaml load/save,
 * the one-time trust.yaml import, nonces and the write guards.
 *
 * Every test builds its own home and PLUR root under a temp dir and passes
 * them explicitly — the real ~/.plur is never read or written.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  resolveFolderPolicy, loadFolderMap, saveFolderMap, folderMapPath, setFolderEntry, removeFolderEntry,
  folderPatternMatches, folderPatternSpecificity, issueFolderNonce, consumeFolderNonce,
  endFolderNonceSession, FolderMapError, FOLDER_NONCE_TTL_MS, type FolderEntry,
} from '../src/folders.js'
import { isDirectoryTrusted, trustDirectory, untrustDirectory, listTrustedDirectories } from '../src/trust.js'
import { logger } from '../src/logger.js'

let base: string
let home: string
let root: string

function mk(...parts: string[]): string {
  const d = join(home, ...parts)
  mkdirSync(d, { recursive: true })
  return d
}

function writeMap(folders: FolderEntry[]): void {
  saveFolderMap(root, { version: 1, folders })
}

const policy = (dir: string) => resolveFolderPolicy(dir, { root, home })

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'plur-folders-')))
  home = join(base, 'home')
  root = join(home, '.plur')
  mkdirSync(root, { recursive: true })
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('resolveFolderPolicy', () => {
  it('an unmapped folder asks, and so does $HOME itself', () => {
    const d = mk('notes')
    expect(policy(d)).toEqual({ mode: 'ask', remoteAllowed: false, source: 'default' })
    expect(policy(home)).toEqual({ mode: 'ask', remoteAllowed: false, source: 'default' })
  })

  it('off wins over a more specific on entry and over a .plur.yaml', () => {
    const repo = mk('work', 'secret', 'repo')
    mkdirSync(join(repo, '.git'))
    writeFileSync(join(repo, '.plur.yaml'), 'scope: project:repo\n')
    writeMap([
      { path: '~/work/secret/**', plur: 'off' },
      { path: repo, plur: 'on', scope: 'project:mine' },
    ])
    expect(policy(repo)).toEqual({ mode: 'off', remoteAllowed: false, source: 'map' })
    expect(policy(join(home, 'work', 'secret'))).toMatchObject({ mode: 'off' })
  })

  it('the most specific matching entry decides; a later entry wins a tie', () => {
    const d = mk('work', 'app', 'src')
    writeMap([
      { path: '~/work/**', scope: 'project:work' },
      { path: '~/work/app', plur: 'ask' },
    ])
    expect(policy(d)).toEqual({ mode: 'ask', remoteAllowed: false, source: 'map' })
    expect(policy(mk('work', 'other'))).toEqual({ mode: 'on', scope: 'project:work', remoteAllowed: false, source: 'map' })

    writeMap([
      { path: '~/work/app', plur: 'ask' },
      { path: '~/work/app', plur: 'on' },
    ])
    expect(policy(d).mode).toBe('on')
  })

  it('an entry with only scope or trusted defaults to on; a bare dir covers everything below it', () => {
    const d = mk('notes', 'deep', 'er')
    writeMap([{ path: join(home, 'notes'), trusted: true }])
    expect(policy(d)).toEqual({ mode: 'on', remoteAllowed: false, source: 'map' })
    // A sibling with a shared prefix is not covered.
    expect(policy(mk('notesX')).mode).toBe('ask')
  })

  it('a .plur.yaml means on with its scope hint, unless a map entry sets scope', () => {
    const repo = mk('src', 'repo')
    mkdirSync(join(repo, '.git'))
    writeFileSync(join(repo, '.plur.yaml'), 'scope: project:hint\ndomain: x.y\n')
    expect(policy(repo)).toEqual({ mode: 'on', scope: 'project:hint', remoteAllowed: false, source: 'plur-yaml' })

    writeMap([{ path: '~/src/**', scope: 'project:mine' }])
    expect(policy(repo)).toEqual({ mode: 'on', scope: 'project:mine', remoteAllowed: false, source: 'plur-yaml' })

    // An explicit ask entry does not turn a .plur.yaml folder off (only off does).
    writeMap([{ path: repo, plur: 'ask' }])
    expect(policy(repo).mode).toBe('on')
  })

  it('a project MCP config means on', () => {
    const proj = mk('mcp-proj')
    writeFileSync(join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { plur: { command: 'plur' } } }))
    expect(policy(join(proj))).toEqual({ mode: 'on', remoteAllowed: false, source: 'mcp-config' })
  })

  it('trusted gates the .plur.yaml remote', () => {
    const repo = mk('src', 'remote-repo')
    mkdirSync(join(repo, '.git'))
    writeFileSync(join(repo, '.plur.yaml'),
      'scope: project:r\nremote_url: http://127.0.0.1:9\nremote_token: t\nremote_scopes:\n  - project:r\n')
    expect(policy(repo).remoteAllowed).toBe(false)

    writeMap([{ path: repo, trusted: true }])
    expect(policy(repo)).toEqual({ mode: 'on', scope: 'project:r', remoteAllowed: true, source: 'plur-yaml' })
    // A subfolder of the trusted tree is covered.
    expect(policy(mk('src', 'remote-repo', 'pkg')).remoteAllowed).toBe(true)

    // Off still wins, and turns the remote off too.
    writeMap([{ path: repo, trusted: true }, { path: repo, plur: 'off' }])
    expect(policy(repo)).toEqual({ mode: 'off', remoteAllowed: false, source: 'map' })
  })

  it('a symlinked path resolves to the same entry, and a symlink swapped in later is not trusted', () => {
    const real = mk('real-repo')
    const link = join(home, 'link-repo')
    symlinkSync(real, link)
    writeMap([{ path: link, plur: 'on', scope: 'project:linked' }])
    // The entry is stored as the symlink spelling; the target is canonical.
    // Parent canonicalised + last segment kept (#1334) — the link itself is
    // not followed, so the real folder is NOT covered by the link entry.
    expect(policy(real).mode).toBe('ask')

    writeMap([{ path: real, plur: 'on', scope: 'project:real' }])
    expect(policy(link)).toEqual({ mode: 'on', scope: 'project:real', remoteAllowed: false, source: 'map' })
  })

  it('an entry under a symlinked parent (e.g. a symlinked home) still matches', () => {
    const realHome = join(base, 'real-home')
    mkdirSync(join(realHome, 'proj'), { recursive: true })
    const linkHome = join(base, 'link-home')
    symlinkSync(realHome, linkHome)
    writeMap([{ path: join(linkHome, 'proj'), scope: 'project:p' }])
    expect(resolveFolderPolicy(join(realHome, 'proj'), { root, home: linkHome }).scope).toBe('project:p')
    // And `~` expands against the (symlinked) home.
    writeMap([{ path: '~/proj', plur: 'off' }])
    expect(resolveFolderPolicy(join(realHome, 'proj'), { root, home: linkHome }).mode).toBe('off')
  })
})

describe('folders.yaml load', () => {
  it('a missing file is empty and is not created when there is nothing to import', () => {
    expect(loadFolderMap(root)).toEqual({ version: 1, folders: [] })
    expect(existsSync(folderMapPath(root))).toBe(false)
  })

  it('a malformed file is empty with one warning, never a throw', () => {
    const warn = vi.spyOn(logger, 'warning').mockImplementation(() => {})
    const d = mk('proj')
    writeFileSync(folderMapPath(root), 'folders: [[[ not yaml')
    expect(() => policy(d)).not.toThrow()
    expect(policy(d).mode).toBe('ask')
    expect(loadFolderMap(root).folders).toEqual([])
    expect(warn.mock.calls.filter(c => String(c[0]).includes('folders.yaml')).length).toBe(1)
  })

  it('a schema-invalid file (bad plur value) is also treated as empty', () => {
    vi.spyOn(logger, 'warning').mockImplementation(() => {})
    writeFileSync(folderMapPath(root), 'version: 1\nfolders:\n  - path: /x\n    plur: maybe\n')
    expect(loadFolderMap(root).folders).toEqual([])
  })

  it('a write refuses a malformed file rather than overwriting it', () => {
    vi.spyOn(logger, 'warning').mockImplementation(() => {})
    const bad = 'folders: [[[ not yaml'
    writeFileSync(folderMapPath(root), bad)
    expect(() => setFolderEntry(root, mk('p'), { mode: 'on' }, { configuredScopes: [], home }))
      .toThrow(FolderMapError)
    expect(readFileSync(folderMapPath(root), 'utf8')).toBe(bad)
  })
})

describe('trust.yaml import', () => {
  it('imports trust entries once, as trusted entries; trust.yaml is left byte-identical', () => {
    const a = mk('a')
    const b = mk('b')
    const trustYaml = `version: 1\ntrusted:\n  - ${a}\n  - ${b}\n`
    writeFileSync(join(root, 'trust.yaml'), trustYaml)

    expect(loadFolderMap(root).folders).toEqual([{ path: a, trusted: true }, { path: b, trusted: true }])
    expect(existsSync(folderMapPath(root))).toBe(true)
    const afterFirst = readFileSync(folderMapPath(root), 'utf8')

    // Idempotent: a second read does not re-import or rewrite.
    expect(loadFolderMap(root).folders).toHaveLength(2)
    expect(readFileSync(folderMapPath(root), 'utf8')).toBe(afterFirst)
    expect(readFileSync(join(root, 'trust.yaml'), 'utf8')).toBe(trustYaml)

    // After import, folders.yaml is the only file read: untrust in the map
    // sticks even though trust.yaml still lists the folder.
    expect(untrustDirectory(a, root)).toBe(true)
    expect(isDirectoryTrusted(a, root)).toBe(false)
    expect(readFileSync(join(root, 'trust.yaml'), 'utf8')).toBe(trustYaml)
  })

  it('trust / untrust keep their results, through the map', () => {
    const d = mk('t')
    expect(trustDirectory(d, root)).toBe(realpathSync(d))
    trustDirectory(d, root)
    expect(listTrustedDirectories(root)).toEqual([realpathSync(d)])
    expect(isDirectoryTrusted(join(d), root)).toBe(true)
    expect(existsSync(join(root, 'trust.yaml'))).toBe(false)
    expect(untrustDirectory(d, root)).toBe(true)
    expect(untrustDirectory(d, root)).toBe(false)
    // A trust-only entry is removed entirely when its grant is cleared.
    expect(loadFolderMap(root).folders).toEqual([])
  })

  it('untrust keeps an entry that still holds another decision', () => {
    const d = mk('keep')
    setFolderEntry(root, d, { scope: 'project:k', trusted: true }, { configuredScopes: ['project:k'], home })
    expect(untrustDirectory(d, root)).toBe(true)
    expect(loadFolderMap(root).folders).toEqual([{ path: realpathSync(d), scope: 'project:k' }])
  })
})

describe('win32 paths (pure matcher)', () => {
  it('matches case-insensitively with either separator', () => {
    expect(folderPatternMatches('C:\\Users\\a\\work', 'c:\\users\\A\\work\\repo', 'win32')).toBe(true)
    expect(folderPatternMatches('C:/Users/a/work/**', 'C:\\Users\\a\\work\\x\\y', 'win32')).toBe(true)
    expect(folderPatternMatches('C:\\Users\\a\\work\\*', 'C:\\Users\\a\\work\\x\\deep', 'win32')).toBe(true)
    expect(folderPatternMatches('C:\\Users\\a\\work', 'C:\\Users\\a\\workshop', 'win32')).toBe(false)
    expect(folderPatternMatches('C:\\Users\\a\\work', 'D:\\Users\\a\\work', 'win32')).toBe(false)
  })

  it('posix matching stays case-sensitive', () => {
    expect(folderPatternMatches('/home/a/Work', '/home/a/work', 'linux')).toBe(false)
  })

  it('specificity: literal prefix first, then segments', () => {
    const [l1] = folderPatternSpecificity('C:\\Users\\a\\work\\**', 'win32')
    const [l2] = folderPatternSpecificity('C:\\Users\\a\\work\\app', 'win32')
    expect(l2).toBeGreaterThan(l1)
  })
})

describe('writes: nonce and shared-scope guards', () => {
  it('a hand-run set without a nonce is accepted', () => {
    const d = mk('hand')
    expect(setFolderEntry(root, d, { mode: 'off' }, { configuredScopes: [], home }))
      .toEqual({ path: realpathSync(d), plur: 'off' })
  })

  it('an ask-flow nonce works once, for its folder only', () => {
    const d = mk('asked')
    const other = mk('other')
    const n = issueFolderNonce(root, 'sess-1', d)
    expect(() => setFolderEntry(root, other, { mode: 'on' }, { configuredScopes: [], nonce: n, home }))
      .toThrow(expect.objectContaining({ code: 'nonce-folder' }))
    // A folder mismatch does not burn it.
    expect(setFolderEntry(root, d, { mode: 'on' }, { configuredScopes: [], nonce: n, home }).plur).toBe('on')
    expect(() => setFolderEntry(root, d, { mode: 'off' }, { configuredScopes: [], nonce: n, home }))
      .toThrow(expect.objectContaining({ code: 'nonce-unknown' }))
    expect(loadFolderMap(root).folders).toEqual([{ path: realpathSync(d), plur: 'on' }])
  })

  it('a missing or stale nonce is refused and nothing is written', () => {
    const d = mk('stale')
    expect(() => consumeFolderNonce(root, 'deadbeef', d)).toThrow(expect.objectContaining({ code: 'nonce-unknown' }))

    const n1 = issueFolderNonce(root, 'sess-2', d, 1000)
    expect(() => setFolderEntry(root, d, { mode: 'on' }, { configuredScopes: [], nonce: n1, home, now: 1000 + FOLDER_NONCE_TTL_MS + 1 }))
      .toThrow(expect.objectContaining({ code: 'nonce-expired' }))

    const n2 = issueFolderNonce(root, 'sess-2', d)
    endFolderNonceSession(root, 'sess-2')
    expect(() => setFolderEntry(root, d, { mode: 'on' }, { configuredScopes: [], nonce: n2, home }))
      .toThrow(expect.objectContaining({ code: 'nonce-unknown' }))
    expect(existsSync(folderMapPath(root))).toBe(false)
  })

  it('a hostile session id cannot escape the nonce dir', () => {
    const d = mk('x')
    issueFolderNonce(root, '../../escape', d)
    expect(existsSync(join(root, 'folder-nonces', '______escape.yaml'))).toBe(true)
  })

  it('a shared scope needs a configured store; a personal one does not', () => {
    const d = mk('scoped')
    expect(() => setFolderEntry(root, d, { scope: 'group:example/eng' }, { configuredScopes: [], home }))
      .toThrow(expect.objectContaining({ code: 'scope-unconfigured' }))
    expect(existsSync(folderMapPath(root))).toBe(false)
    expect(setFolderEntry(root, d, { scope: 'group:example/eng' }, { configuredScopes: ['group:example/eng'], home }).scope)
      .toBe('group:example/eng')
    expect(setFolderEntry(root, d, { scope: 'user:me' }, { configuredScopes: [], home }).scope).toBe('user:me')
    // project: is shared-family (isSharedScope), so it needs a store too.
    expect(() => setFolderEntry(root, d, { scope: 'project:typo' }, { configuredScopes: [], home }))
      .toThrow(expect.objectContaining({ code: 'scope-unconfigured' }))
  })

  it('--scope alone means on (drops a previous plur field); rm removes the exact entry', () => {
    const d = mk('flip')
    setFolderEntry(root, d, { mode: 'off' }, { configuredScopes: [], home })
    expect(setFolderEntry(root, d, { scope: 'project:f' }, { configuredScopes: ['project:f'], home }))
      .toEqual({ path: realpathSync(d), scope: 'project:f' })
    expect(policy(d).mode).toBe('on')
    expect(removeFolderEntry(root, d, home)).toBe(true)
    expect(removeFolderEntry(root, d, home)).toBe(false)
  })

  it('a glob entry is stored as typed', () => {
    setFolderEntry(root, '~/work/**', { mode: 'ask' }, { configuredScopes: [], home })
    expect(loadFolderMap(root).folders).toEqual([{ path: '~/work/**', plur: 'ask' }])
  })
})
