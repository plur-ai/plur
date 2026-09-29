/**
 * Folder map (#1347, design r2): resolveFolderPolicy, folders.yaml load/save,
 * the one-time trust.yaml import, nonces and the write guards.
 *
 * Every test builds its own home and PLUR root under a temp dir and passes
 * them explicitly — the real ~/.plur is never read or written.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync, realpathSync, chmodSync } from 'fs'
import yaml from 'js-yaml'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  resolveFolderPolicy, loadFolderMap, saveFolderMap, folderMapPath, setFolderEntry, removeFolderEntry,
  folderPatternMatches, folderPatternSpecificity, issueFolderNonce, consumeFolderNonce,
  endFolderNonceSession, FolderMapError, isTrustedInMap, clearFolderTrust, FOLDER_NONCE_TTL_MS, type FolderEntry,
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

  it('an absolute entry under a symlinked parent fails closed; `~` and `off` still match', () => {
    const realHome = join(base, 'real-home')
    mkdirSync(join(realHome, 'proj'), { recursive: true })
    const linkHome = join(base, 'link-home')
    symlinkSync(realHome, linkHome)
    const at = (d: string) => resolveFolderPolicy(d, { root, home: linkHome })
    // Stored entries are never resolved at compare time (#1334 rule), so the
    // symlinked spelling does not cover the canonical folder.
    writeMap([{ path: join(linkHome, 'proj'), scope: 'project:p', trusted: true }])
    expect(at(join(realHome, 'proj')).mode).toBe('ask')
    // `~` is the user's home, expanded against its canonical form too.
    writeMap([{ path: '~/proj', scope: 'project:p' }])
    expect(at(join(realHome, 'proj')).scope).toBe('project:p')
    // `off` matches loosely: the safe direction.
    writeMap([{ path: join(linkHome, 'proj'), plur: 'off' }])
    expect(at(join(realHome, 'proj')).mode).toBe('off')
  })

  // #1357: on a CASE-SENSITIVE filesystem `Proj` and `pROJ` are two folders.
  // Editing one must never take over the other's entry. Runs where the
  // filesystem is case-sensitive (Linux CI); skipped on a case-insensitive one.
  it('a sibling folder that differs only in case keeps its own entry (case-sensitive filesystem)', ({ skip }) => {
    const w = mk('Sib')
    const proj = join(w, 'Proj')
    mkdirSync(proj)
    const other = join(w, 'pROJ')
    try { mkdirSync(other) } catch { skip() } // EEXIST: case-insensitive filesystem
    writeMap([{ path: other, plur: 'off', trusted: true }])

    expect(setFolderEntry(root, proj, { scope: 'project:x' }, { configuredScopes: [], home }))
      .toEqual({ path: proj, scope: 'project:x' })
    expect(loadFolderMap(root).folders).toEqual([
      { path: other, plur: 'off', trusted: true },
      { path: proj, scope: 'project:x' },
    ])
    expect(policy(other).mode).toBe('off')
    expect(isTrustedInMap(loadFolderMap(root).folders, proj, home)).toBe(false)

    expect(removeFolderEntry(root, proj, home)).toBe(true)
    expect(removeFolderEntry(root, proj, home)).toBe(false)
    expect(loadFolderMap(root).folders).toEqual([{ path: other, plur: 'off', trusted: true }])
  })

  it('two entries for one folder (`~/dup` and its absolute form) are both revoked, merged and removed', () => {
    const d = mk('dup')
    const two = () => writeMap([{ path: '~/dup', trusted: true }, { path: d, trusted: true, plur: 'off' }])
    const trusted = () => isTrustedInMap(loadFolderMap(root).folders, d, home)

    two()
    expect(trusted()).toBe(true)
    expect(setFolderEntry(root, d, { trusted: false }, { configuredScopes: [], home }))
      .toEqual({ path: '~/dup', plur: 'off' })
    expect(loadFolderMap(root).folders).toEqual([{ path: '~/dup', plur: 'off' }])
    expect(trusted()).toBe(false)

    two()
    setFolderEntry(root, d, { scope: 'project:d' }, { configuredScopes: [], home })
    expect(loadFolderMap(root).folders).toEqual([{ path: '~/dup', trusted: true, scope: 'project:d' }])

    two()
    expect(removeFolderEntry(root, d, home)).toBe(true)
    expect(loadFolderMap(root).folders).toEqual([])
    expect(trusted()).toBe(false)
  })

  // #1357: `Ⓟ`/`ⓟ` and `Ⅱ`/`ⅱ` are cased but not letters (no \p{L}), so a
  // check that swaps only letters compared such a folder with itself. On a
  // case-sensitive filesystem they are sibling folders; no edit of one may
  // touch the other's entry. Runs on Linux CI; skipped where they collide.
  for (const [upper, lower] of [['Ⓟ', 'ⓟ'], ['Ⅱ', 'ⅱ']]) {
    it(`a sibling folder ${upper} keeps its own entry when ${lower} is edited (case-sensitive filesystem)`, ({ skip }) => {
      const w = mk('Cased')
      const kept = join(w, upper)
      const edited = join(w, lower)
      mkdirSync(kept)
      try { mkdirSync(edited) } catch { skip() } // EEXIST: case-insensitive filesystem
      const theirs = { path: kept, plur: 'off' as const, trusted: true }
      writeMap([theirs])

      expect(removeFolderEntry(root, edited, home)).toBe(false)
      expect(loadFolderMap(root).folders).toEqual([theirs])

      setFolderEntry(root, edited, { mode: 'on' }, { configuredScopes: [], home })
      expect(loadFolderMap(root).folders).toEqual([theirs, { path: edited, plur: 'on' }])

      writeMap([theirs])
      trustDirectory(edited, root)
      expect(loadFolderMap(root).folders).toEqual([theirs, { path: edited, trusted: true }])
      expect(untrustDirectory(edited, root)).toBe(true)
      expect(loadFolderMap(root).folders).toEqual([theirs])
      expect(policy(kept).mode).toBe('off')
      expect(isTrustedInMap(loadFolderMap(root).folders, kept, home)).toBe(true)
    })
  }

  // #1357: canonicalize now folds letter case to the on-disk name. That must
  // never make an `off` entry stop matching. Skipped on a case-sensitive
  // filesystem, where differently-cased paths are different folders.
  describe('letter case on a case-insensitive filesystem (#1357)', () => {
    const caseInsensitive = () => {
      mkdirSync(join(base, 'CaseProbe'), { recursive: true })
      return existsSync(join(base, 'caseprobe'))
    }

    it('an `off` entry spelled in another case covers the folder', ({ skip }) => {
      if (!caseInsensitive()) skip()
      const d = mk('Work', 'Secret')
      writeMap([{ path: join(home, 'work', 'secret'), plur: 'off' }])
      expect(policy(d).mode).toBe('off')
      expect(policy(join(home, 'WORK', 'SECRET')).mode).toBe('off')
    })

    it('an `off` glob that matched the case-preserving spelling still matches', ({ skip }) => {
      if (!caseInsensitive()) skip()
      // On disk: <real>/proj. Checked as <link>/PROJ. The old canonical form
      // was <real>/PROJ (case kept); the folded form is <real>/proj. An `off`
      // glob written against the old form must keep matching.
      const real = join(base, 'real')
      mkdirSync(join(real, 'proj'), { recursive: true })
      const link = join(base, 'link')
      symlinkSync(real, link)
      writeMap([{ path: join(real, 'PRO*'), plur: 'off' }])
      expect(policy(join(link, 'PROJ')).mode).toBe('off')
    })

    it('set and rm find an entry recorded in another case, and set replaces it', ({ skip }) => {
      if (!caseInsensitive()) skip()
      const w = mk('W')
      const onDisk = join(w, 'Proj')
      mkdirSync(onDisk)
      const misCased = join(w, 'proj')
      // Recorded before #1357, from a mis-cased typed path.
      writeMap([{ path: misCased, plur: 'off' }])
      expect(policy(onDisk).mode).toBe('off')

      expect(setFolderEntry(root, onDisk, { mode: 'on' }, { configuredScopes: [], home }))
        .toEqual({ path: onDisk, plur: 'on' })
      expect(loadFolderMap(root).folders).toEqual([{ path: onDisk, plur: 'on' }])
      expect(policy(onDisk).mode).toBe('on')

      writeMap([{ path: misCased, plur: 'off' }])
      expect(removeFolderEntry(root, onDisk, home)).toBe(true)
      expect(loadFolderMap(root).folders).toEqual([])
    })

    it('a mis-cased grant is cleared by untrust and never revived by a later edit', ({ skip }) => {
      if (!caseInsensitive()) skip()
      const w = mk('G')
      const onDisk = join(w, 'Proj')
      mkdirSync(onDisk)
      const misCased = join(w, 'proj')

      writeMap([{ path: misCased, trusted: true }])
      expect(clearFolderTrust(root, onDisk, home)).toBe(true)
      expect(loadFolderMap(root).folders).toEqual([])
      expect(setFolderEntry(root, onDisk, { scope: 'project:x' }, { configuredScopes: [], home }))
        .toEqual({ path: onDisk, scope: 'project:x' })
      expect(isTrustedInMap(loadFolderMap(root).folders, onDisk, home)).toBe(false)

      // An edit that finds a dormant mis-cased grant keeps only its mode.
      writeMap([{ path: misCased, plur: 'ask', trusted: true, scope: 'project:old' }])
      expect(setFolderEntry(root, onDisk, { mode: 'on' }, { configuredScopes: [], home }))
        .toEqual({ path: onDisk, plur: 'on' })
      writeMap([{ path: misCased, plur: 'off', trusted: true, scope: 'project:old' }])
      expect(setFolderEntry(root, onDisk, { trusted: true }, { configuredScopes: [], home }))
        .toEqual({ path: onDisk, plur: 'off', trusted: true })
    })

    it('several entries for the folder in other letter cases merge into one; set --on takes effect', ({ skip }) => {
      if (!caseInsensitive()) skip()
      const w = mk('M')
      const onDisk = join(w, 'Proj')
      mkdirSync(onDisk)
      const unrelated = { path: join(w, 'other'), plur: 'ask' as const }
      const many = () => writeMap([
        { path: join(w, 'proj'), plur: 'on' },
        unrelated,
        { path: join(w, 'PROJ'), plur: 'off' },
        { path: join(w, 'pRoJ'), scope: 'project:old' },
      ])

      many()
      expect(policy(onDisk).mode).toBe('off')
      expect(setFolderEntry(root, onDisk, { mode: 'on' }, { configuredScopes: [], home }))
        .toEqual({ path: onDisk, plur: 'on' })
      expect(loadFolderMap(root).folders).toEqual([{ path: onDisk, plur: 'on' }, unrelated])
      expect(policy(onDisk).mode).toBe('on')

      // Without a mode in the change, the most restrictive old mode stays.
      many()
      expect(setFolderEntry(root, onDisk, { trusted: true }, { configuredScopes: [], home }))
        .toEqual({ path: onDisk, plur: 'off', trusted: true })

      // An exact entry plus a leftover mis-cased `off`: both merge.
      writeMap([{ path: onDisk, plur: 'on' }, { path: join(w, 'proj'), plur: 'off' }])
      expect(policy(onDisk).mode).toBe('off')
      setFolderEntry(root, onDisk, { mode: 'on' }, { configuredScopes: [], home })
      expect(loadFolderMap(root).folders).toEqual([{ path: onDisk, plur: 'on' }])
      expect(policy(onDisk).mode).toBe('on')

      // rm removes every entry for the folder.
      many()
      expect(removeFolderEntry(root, onDisk, home)).toBe(true)
      expect(loadFolderMap(root).folders).toEqual([unrelated])
    })

    it('a `trusted` entry covers every case spelling of its folder, and a mis-cased entry fails closed', ({ skip }) => {
      if (!caseInsensitive()) skip()
      const d = mk('Team')
      writeMap([{ path: join(home, 'team'), trusted: true }])
      expect(isTrustedInMap(loadFolderMap(root).folders, join(home, 'team'), home)).toBe(false)
      // Stored entries are compared as written (fail closed); the checked
      // folder folds to its on-disk case, so the entry must be written that way.
      writeMap([{ path: d, trusted: true }])
      expect(isTrustedInMap(loadFolderMap(root).folders, join(home, 'TEAM'), home)).toBe(true)
    })
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

    // untrust removes the grant from BOTH files: a downgrade (an older CLI
    // or MCP reading trust.yaml) or a re-import after deleting folders.yaml
    // must not bring a revoked grant back. Only removal; never an addition.
    expect(untrustDirectory(a, root)).toBe(true)
    expect(isDirectoryTrusted(a, root)).toBe(false)
    expect(yaml.load(readFileSync(join(root, 'trust.yaml'), 'utf8'))).toEqual({ version: 1, trusted: [b] })
    // Re-import from scratch: a stays revoked, b stays trusted.
    rmSync(folderMapPath(root))
    expect(isDirectoryTrusted(a, root)).toBe(false)
    expect(isDirectoryTrusted(b, root)).toBe(true)
    // trust never writes trust.yaml.
    const c = mk('c')
    trustDirectory(c, root)
    expect(yaml.load(readFileSync(join(root, 'trust.yaml'), 'utf8'))).toEqual({ version: 1, trusted: [b] })
  })

  it('untrust of a grant that exists only in trust.yaml (after import) still reports removed', () => {
    const a = mk('only-legacy')
    writeFileSync(join(root, 'trust.yaml'), `version: 1\ntrusted:\n  - ${a}\n`)
    // folders.yaml already exists without the entry (e.g. written by a newer
    // version before an older one added it to trust.yaml).
    saveFolderMap(root, { version: 1, folders: [] })
    expect(untrustDirectory(a, root)).toBe(true)
    expect(yaml.load(readFileSync(join(root, 'trust.yaml'), 'utf8'))).toEqual({ version: 1, trusted: [] })
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

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a failed save does not consume the nonce',
    () => {
      const d = mk('unwritable')
      const n = issueFolderNonce(root, 'sess-save', d)
      chmodSync(root, 0o555)
      try {
        expect(() => setFolderEntry(root, d, { mode: 'on' }, { configuredScopes: [], nonce: n, home })).toThrow()
      } finally {
        chmodSync(root, 0o755)
      }
      expect(setFolderEntry(root, d, { mode: 'on' }, { configuredScopes: [], nonce: n, home }).plur).toBe('on')
      expect(() => setFolderEntry(root, d, { mode: 'off' }, { configuredScopes: [], nonce: n, home }))
        .toThrow(expect.objectContaining({ code: 'nonce-unknown' }))
    },
  )

  it('rm from the ask flow takes a nonce too, and a failed rm does not consume it', () => {
    const d = mk('rm-nonce')
    setFolderEntry(root, d, { mode: 'off' }, { configuredScopes: [], home })
    const other = mk('rm-other')
    const n = issueFolderNonce(root, 'sess-rm', d)
    expect(() => removeFolderEntry(root, other, home, { nonce: n })).toThrow(expect.objectContaining({ code: 'nonce-folder' }))
    expect(removeFolderEntry(root, d, home, { nonce: n })).toBe(true)
    expect(() => removeFolderEntry(root, d, home, { nonce: n })).toThrow(expect.objectContaining({ code: 'nonce-unknown' }))
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
    // project: scopes live in the local store (isLocalOnlyScope): no store needed.
    expect(setFolderEntry(root, d, { scope: 'project:app' }, { configuredScopes: [], home }).scope).toBe('project:app')
    // Team scopes meant to reach a store still need one.
    for (const scope of ['org:example', 'team:example', 'space:example']) {
      expect(() => setFolderEntry(root, d, { scope }, { configuredScopes: [], home }))
        .toThrow(expect.objectContaining({ code: 'scope-unconfigured' }))
    }
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
