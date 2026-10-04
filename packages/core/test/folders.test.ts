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
import { join, sep } from 'path'
import { tmpdir } from 'os'
import {
  resolveFolderPolicy, loadFolderMap, saveFolderMap, folderMapPath, setFolderEntry, removeFolderEntry,
  folderPatternMatches, folderPatternSpecificity, issueFolderNonce, consumeFolderNonce,
  endFolderNonceSession, FolderMapError, isTrustedInMap, clearFolderTrust, FOLDER_NONCE_TTL_MS, coversHomeOrRoot, type FolderEntry,
} from '../src/folders.js'
import { isDirectoryTrusted, trustDirectory, untrustDirectory, listTrustedDirectories } from '../src/trust.js'
import { canonicalize } from '../src/project-config.js'
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

  // Decision D1 (owner, 2026-09-29: "ignore-ask", matching #1228's E3): an
  // UNTRUSTED .plur.yaml's scope/domain hints are ignored and the folder asks.
  it('D1: an untrusted .plur.yaml that requests settings asks, with the reason and what it requests', () => {
    const repo = mk('src', 'repo')
    mkdirSync(join(repo, '.git'))
    writeFileSync(join(repo, '.plur.yaml'), 'scope: project:hint\ndomain: x.y\n')
    expect(policy(repo)).toEqual({
      mode: 'ask', remoteAllowed: false, source: 'plur-yaml',
      reason: 'untrusted-plur-yaml', requested: { scope: 'project:hint', domain: 'x.y' },
    })
    // A remote request is named too (the URL, never the token).
    writeFileSync(join(repo, '.plur.yaml'), 'remote_url: http://127.0.0.1:9\nremote_token: secret-token\n')
    const p = policy(repo)
    expect(p).toMatchObject({ mode: 'ask', reason: 'untrusted-plur-yaml', requested: { remote_url: 'http://127.0.0.1:9' } })
    expect(JSON.stringify(p)).not.toContain('secret-token')
  })

  it('D1: a trusted .plur.yaml behaves exactly as before (on, its scope hint)', () => {
    const repo = mk('src', 'repo')
    mkdirSync(join(repo, '.git'))
    writeFileSync(join(repo, '.plur.yaml'), 'scope: project:hint\ndomain: x.y\n')
    writeMap([{ path: repo, trusted: true }])
    expect(policy(repo)).toEqual({ mode: 'on', scope: 'project:hint', remoteAllowed: false, source: 'plur-yaml' })
    // A map scope still beats the hint.
    writeMap([{ path: repo, trusted: true }, { path: '~/src/**', scope: 'project:mine' }])
    expect(policy(repo)).toEqual({ mode: 'on', scope: 'project:mine', remoteAllowed: false, source: 'plur-yaml' })
    // An explicit ask entry does not turn a trusted .plur.yaml folder off (only off does).
    writeMap([{ path: repo, trusted: true, plur: 'ask' }])
    expect(policy(repo).mode).toBe('on')
  })

  it('D1: an untrusted .plur.yaml under a map decision uses the map, never the hint', () => {
    const repo = mk('src', 'repo')
    mkdirSync(join(repo, '.git'))
    writeFileSync(join(repo, '.plur.yaml'), 'scope: project:hint\n')
    writeMap([{ path: '~/src/**', scope: 'project:mine' }])
    expect(policy(repo)).toEqual({ mode: 'on', scope: 'project:mine', remoteAllowed: false, source: 'map' })
    writeMap([{ path: repo, plur: 'on' }])
    expect(policy(repo)).toEqual({ mode: 'on', remoteAllowed: false, source: 'map' })
    writeMap([{ path: repo, plur: 'ask' }])
    expect(policy(repo)).toMatchObject({ mode: 'ask', source: 'map' })
  })

  it('D1: a .plur.yaml that requests nothing still means on, trusted or not', () => {
    const repo = mk('src', 'plain')
    mkdirSync(join(repo, '.git'))
    writeFileSync(join(repo, '.plur.yaml'), '# nothing here\n')
    expect(policy(repo)).toEqual({ mode: 'on', remoteAllowed: false, source: 'plur-yaml' })
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
    expect(policy(repo)).toMatchObject({ mode: 'ask', remoteAllowed: false, reason: 'untrusted-plur-yaml' })

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

  it('a merge never activates the grant or scope of an entry spelled through a symlink (#778)', () => {
    const real = join(base, 'real')
    mkdirSync(join(real, 'proj'), { recursive: true })
    const link = join(base, 'link')
    symlinkSync(real, link)
    writeMap([
      { path: join(real, 'proj'), plur: 'ask' },
      { path: join(link, 'proj'), trusted: true, scope: 'project:dormant' },
    ])
    const trusted = () => isTrustedInMap(loadFolderMap(root).folders, join(real, 'proj'), home)
    expect(trusted()).toBe(false)
    expect(policy(join(real, 'proj'))).toEqual({ mode: 'ask', remoteAllowed: false, source: 'map' })

    expect(setFolderEntry(root, join(link, 'proj'), { mode: 'ask' }, { configuredScopes: [], home }))
      .toEqual({ path: join(real, 'proj'), plur: 'ask' })
    expect(trusted()).toBe(false)
    expect(policy(join(real, 'proj')).scope).toBeUndefined()

    // With no applied entry at all, the dormant grant is dropped, not revived.
    writeMap([{ path: join(link, 'proj'), trusted: true, scope: 'project:dormant' }])
    expect(setFolderEntry(root, join(link, 'proj'), { mode: 'on' }, { configuredScopes: [], home }))
      .toEqual({ path: join(real, 'proj'), plur: 'on' })
    expect(trusted()).toBe(false)
  })

  it('a name-only `on` (spelled through a symlink) never becomes the mode through trust/untrust or a merge', () => {
    const real = join(base, 'real-on')
    mkdirSync(join(real, 'proj'), { recursive: true })
    const link = join(base, 'link-on')
    symlinkSync(real, link)
    const target = join(real, 'proj')
    writeMap([{ path: join(link, 'proj'), plur: 'on' }])
    expect(policy(target).mode).toBe('ask')

    trustDirectory(target, root)
    expect(untrustDirectory(target, root)).toBe(true)
    expect(policy(target).mode).toBe('ask')

    writeMap([{ path: join(link, 'proj'), plur: 'on' }])
    setFolderEntry(root, join(link, 'proj'), { trusted: false }, { configuredScopes: [], home })
    expect(policy(target).mode).toBe('ask')

    // A name-only `off` still carries over: it applied through the loose match.
    writeMap([{ path: join(link, 'proj'), plur: 'off' }])
    expect(setFolderEntry(root, join(link, 'proj'), { trusted: true }, { configuredScopes: [], home }))
      .toEqual({ path: target, plur: 'off', trusted: true })
  })

  it('a merge that sets no scope keeps the scope the resolver applied', () => {
    const d = mk('dup')
    const two = () => writeMap([{ path: '~/dup', scope: 'group:team' }, { path: d, scope: 'project:local' }])
    two()
    expect(policy(d).scope).toBe('project:local')
    setFolderEntry(root, d, { mode: 'on' }, { configuredScopes: [], home })
    expect(policy(d).scope).toBe('project:local')
    expect(loadFolderMap(root).folders).toEqual([{ path: '~/dup', scope: 'project:local', plur: 'on' }])
    two()
    trustDirectory(d, root)
    expect(policy(d).scope).toBe('project:local')
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

    it('a mis-cased `on` never becomes the mode through trust then untrust', ({ skip }) => {
      if (!caseInsensitive()) skip()
      const w = mk('R6')
      const onDisk = join(w, 'Proj')
      mkdirSync(onDisk)
      writeMap([{ path: join(w, 'pROJ'), plur: 'on' }])
      expect(policy(onDisk).mode).toBe('ask')
      trustDirectory(onDisk, root)
      expect(untrustDirectory(onDisk, root)).toBe(true)
      expect(policy(onDisk).mode).toBe('ask')
    })

    it('a merge never activates the grant or scope of an entry matched only in another case', ({ skip }) => {
      if (!caseInsensitive()) skip()
      const w = mk('R1')
      const onDisk = join(w, 'Proj')
      mkdirSync(onDisk)
      writeMap([{ path: onDisk, plur: 'ask' }, { path: join(w, 'PROJ'), trusted: true, scope: 'project:dormant' }])
      expect(isTrustedInMap(loadFolderMap(root).folders, onDisk, home)).toBe(false)
      expect(setFolderEntry(root, join(w, 'PROJ'), { mode: 'on' }, { configuredScopes: [], home }))
        .toEqual({ path: onDisk, plur: 'on' })
      expect(isTrustedInMap(loadFolderMap(root).folders, onDisk, home)).toBe(false)
      expect(isDirectoryTrusted(onDisk, root)).toBe(false)
      expect(policy(onDisk)).toEqual({ mode: 'on', remoteAllowed: false, source: 'map' })
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

    // #1428 / D1: an untrusted .plur.yaml is ignored unless a covering entry
    // is trusted. A grant recorded in the TYPED case no longer covers the
    // folder (compared as written), so the repo must fail CLOSED — ask — never
    // open with the repo's requested scope.
    it('D1: a trusted entry in the typed case does not trust a .plur.yaml; the repo asks', ({ skip }) => {
      if (!caseInsensitive()) skip()
      const repo = mk('CaseRepo')
      writeFileSync(join(repo, '.plur.yaml'), 'scope: project:caserepo\n')
      writeMap([{ path: join(home, 'caserepo'), trusted: true }])
      for (const d of [repo, join(home, 'caserepo'), join(home, 'CASEREPO')]) {
        expect(policy(d)).toEqual({
          mode: 'ask', remoteAllowed: false, source: 'plur-yaml', reason: 'untrusted-plur-yaml',
          requested: { scope: 'project:caserepo' },
        })
      }
      // Recorded in the on-disk case, the grant applies and the repo is on.
      writeMap([{ path: repo, trusted: true }])
      expect(policy(join(home, 'caserepo'))).toMatchObject({ mode: 'on', scope: 'project:caserepo', source: 'plur-yaml' })
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
    // A new grant is dual-written (see the dual-write describe below).
    const c = mk('c')
    trustDirectory(c, root)
    expect(yaml.load(readFileSync(join(root, 'trust.yaml'), 'utf8'))).toEqual({ version: 1, trusted: [b, realpathSync(c)].sort() })
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
    expect(readFileSync(join(root, 'trust.yaml'), 'utf8')).toContain(realpathSync(d))
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

// #1415 review: `plur remote` records the current folder, and a folder really
// named `proj?` must not become a glob covering its siblings. `?` is not a
// legal file name character on Windows.
describe.skipIf(process.platform === 'win32')('writes: the literal option', () => {
  it('records a folder named proj? literally, so its siblings stay unmapped', () => {
    const q = mk('w/proj?')
    const x = mk('w/projX')
    const deep = mk('w/projY/deep')
    const sub = mk('w/proj?/sub')
    expect(setFolderEntry(root, q, { mode: 'off' }, { configuredScopes: [], home, literal: true }))
      .toEqual({ path: realpathSync(q), plur: 'off', literal: true })
    expect(policy(q).mode).toBe('off')
    expect(policy(sub).mode).toBe('off')
    expect(policy(x).mode).not.toBe('off')
    expect(policy(deep).mode).not.toBe('off')
    // A second literal write updates the same entry.
    setFolderEntry(root, q, { mode: 'on' }, { configuredScopes: [], home, literal: true })
    expect(loadFolderMap(root).folders).toEqual([{ path: realpathSync(q), plur: 'on', literal: true }])
  })

  it('without it, a path with ? is still stored as a glob (plur folders set)', () => {
    mk('w/projX')
    const glob = join(home, 'w', 'proj?')
    expect(setFolderEntry(root, glob, { mode: 'off' }, { configuredScopes: [], home })).toEqual({ path: glob, plur: 'off' })
    expect(policy(join(home, 'w', 'projX')).mode).toBe('off')
  })

  // #1415 + #1357/#1334: a literal entry and a second literal entry for the
  // same folder in another letter case merge into ONE literal entry, and the
  // `?` never starts matching siblings. Needs a case-insensitive filesystem
  // (two spellings of one folder); on a case-sensitive one they would be two
  // different folders, which the #1357 sibling tests above already cover.
  it('a literal proj? and a mis-cased entry for it merge into one literal entry (case-insensitive filesystem)', ({ skip }) => {
    mkdirSync(join(base, 'CaseProbe'), { recursive: true })
    if (!existsSync(join(base, 'caseprobe'))) skip()
    const q = realpathSync(mk('c/Proj?'))
    const x = mk('c/projX')
    writeMap([
      { path: q, plur: 'on', literal: true },
      { path: join(home, 'c', 'PROJ?'), plur: 'off', literal: true },
    ])
    expect(setFolderEntry(root, q, { trusted: true }, { configuredScopes: [], home, literal: true }))
      .toEqual({ path: q, plur: 'off', trusted: true, literal: true })
    expect(loadFolderMap(root).folders).toEqual([{ path: q, plur: 'off', trusted: true, literal: true }])
    expect(policy(q).mode).toBe('off')
    expect(policy(x).source).toBe('default')
    expect(isTrustedInMap(loadFolderMap(root).folders, x, home)).toBe(false)
  })

  it('a literal folder without glob characters is stored exactly as before', () => {
    const d = mk('plain')
    expect(setFolderEntry(root, d, { mode: 'on' }, { configuredScopes: [], home, literal: true }))
      .toEqual({ path: realpathSync(d), plur: 'on' })
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
    const n = issueFolderNonce(root, 'sess-1', d, { mode: 'on' })
    expect(() => setFolderEntry(root, other, { mode: 'on' }, { configuredScopes: [], nonce: n, home }))
      .toThrow(expect.objectContaining({ code: 'nonce-folder' }))
    // A folder mismatch does not burn it.
    expect(setFolderEntry(root, d, { mode: 'on' }, { configuredScopes: [], nonce: n, home }).plur).toBe('on')
    expect(() => setFolderEntry(root, d, { mode: 'on' }, { configuredScopes: [], nonce: n, home }))
      .toThrow(expect.objectContaining({ code: 'nonce-unknown' }))
    expect(loadFolderMap(root).folders).toEqual([{ path: realpathSync(d), plur: 'on' }])
  })

  it('a missing or stale nonce is refused and nothing is written', () => {
    const d = mk('stale')
    expect(() => consumeFolderNonce(root, 'deadbeef', d, { mode: 'on' })).toThrow(expect.objectContaining({ code: 'nonce-unknown' }))

    const n1 = issueFolderNonce(root, 'sess-2', d, { mode: 'on' }, 1000)
    expect(() => setFolderEntry(root, d, { mode: 'on' }, { configuredScopes: [], nonce: n1, home, now: 1000 + FOLDER_NONCE_TTL_MS + 1 }))
      .toThrow(expect.objectContaining({ code: 'nonce-expired' }))

    const n2 = issueFolderNonce(root, 'sess-2', d, { mode: 'on' })
    endFolderNonceSession(root, 'sess-2')
    expect(() => setFolderEntry(root, d, { mode: 'on' }, { configuredScopes: [], nonce: n2, home }))
      .toThrow(expect.objectContaining({ code: 'nonce-unknown' }))
    expect(existsSync(folderMapPath(root))).toBe(false)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a failed save does not consume the nonce',
    () => {
      const d = mk('unwritable')
      const n = issueFolderNonce(root, 'sess-save', d, { mode: 'on' })
      chmodSync(root, 0o555)
      try {
        expect(() => setFolderEntry(root, d, { mode: 'on' }, { configuredScopes: [], nonce: n, home })).toThrow()
      } finally {
        chmodSync(root, 0o755)
      }
      expect(setFolderEntry(root, d, { mode: 'on' }, { configuredScopes: [], nonce: n, home }).plur).toBe('on')
      expect(() => setFolderEntry(root, d, { mode: 'on' }, { configuredScopes: [], nonce: n, home }))
        .toThrow(expect.objectContaining({ code: 'nonce-unknown' }))
    },
  )

  it('rm from the ask flow takes a nonce too, and a failed rm does not consume it', () => {
    const d = mk('rm-nonce')
    setFolderEntry(root, d, { mode: 'off' }, { configuredScopes: [], home })
    const other = mk('rm-other')
    const n = issueFolderNonce(root, 'sess-rm', d, { remove: true })
    expect(() => removeFolderEntry(root, other, home, { nonce: n })).toThrow(expect.objectContaining({ code: 'nonce-folder' }))
    expect(removeFolderEntry(root, d, home, { nonce: n })).toBe(true)
    expect(() => removeFolderEntry(root, d, home, { nonce: n })).toThrow(expect.objectContaining({ code: 'nonce-unknown' }))
  })

  it('a hostile session id cannot escape the nonce dir', () => {
    const d = mk('x')
    issueFolderNonce(root, '../../escape', d, { mode: 'off' })
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

/**
 * Audit follow-up (adversarial M1, data-loss F7): while any published adapter
 * still reads trust.yaml — the opencode plugin pins the pre-folder-map core —
 * every grant and revocation is DUAL-WRITTEN to folders.yaml and trust.yaml.
 * `oldReader` is main's (pre-#1347) isDirectoryTrusted, verbatim in logic.
 */
describe('dual-write to trust.yaml for adapters on the previous core', () => {
  function oldReader(dir: string): boolean {
    const file = join(root, 'trust.yaml')
    if (!existsSync(file)) return false
    const raw = yaml.load(readFileSync(file, 'utf8')) as { trusted?: unknown } | null
    const trusted = Array.isArray(raw?.trusted) ? (raw!.trusted as unknown[]).filter((t): t is string => typeof t === 'string') : []
    const target = canonicalize(dir)
    return trusted.some(t => target === t || target.startsWith(t + sep))
  }

  it('plur trust / untrust are seen by the old reader', () => {
    const d = mk('dual')
    trustDirectory(d, root)
    expect(oldReader(d)).toBe(true)
    expect(oldReader(join(d))).toBe(true)
    expect(untrustDirectory(d, root)).toBe(true)
    expect(oldReader(d)).toBe(false)
    expect(isDirectoryTrusted(d, root)).toBe(false)
  })

  it('folders set --trusted / --no-trusted are seen by the old reader; a re-import agrees', () => {
    const d = mk('dual-set')
    setFolderEntry(root, d, { mode: 'on', trusted: true }, { configuredScopes: [], home })
    expect(oldReader(d)).toBe(true)
    setFolderEntry(root, d, { trusted: false }, { configuredScopes: [], home })
    expect(oldReader(d)).toBe(false)
    // Lose folders.yaml: the re-import from trust.yaml must not resurrect it.
    rmSync(folderMapPath(root))
    expect(isDirectoryTrusted(d, root)).toBe(false)
  })

  it('a grant made by the OLD core after the import is not lost on revocation', () => {
    const d = mk('old-grant')
    trustDirectory(mk('first'), root)   // folders.yaml now exists
    // An adapter on the old core appends to trust.yaml directly.
    const file = join(root, 'trust.yaml')
    const cur = yaml.load(readFileSync(file, 'utf8')) as { trusted: string[] }
    writeFileSync(file, yaml.dump({ version: 1, trusted: [...cur.trusted, realpathSync(d)] }))
    expect(oldReader(d)).toBe(true)
    expect(untrustDirectory(d, root)).toBe(true)
    expect(oldReader(d)).toBe(false)
  })

  // Owner decision F2: revocations are complete in both files.
  function writeLegacy(lines: string[]): void {
    writeFileSync(join(root, 'trust.yaml'), yaml.dump({ version: 1, trusted: lines }))
  }
  const legacyLines = () =>
    (yaml.load(readFileSync(join(root, 'trust.yaml'), 'utf8')) as { trusted: string[] }).trusted

  it('F2: folders rm of a trusted entry also removes its trust.yaml line; no re-import', () => {
    const d = mk('rm-trusted')
    trustDirectory(d, root)
    expect(oldReader(d)).toBe(true)
    expect(removeFolderEntry(root, d, home)).toBe(true)
    expect(oldReader(d)).toBe(false)
    rmSync(folderMapPath(root))
    expect(isDirectoryTrusted(d, root)).toBe(false)
  })

  it('F2: untrust removes a ~-spelled trust.yaml line (the map matcher, not string equality)', () => {
    const d = mk('tilde-proj')
    trustDirectory(d, root)
    // An older tool, or a hand edit, recorded the same folder as ~/tilde-proj.
    writeLegacy([...legacyLines(), '~/tilde-proj'])
    // untrustDirectory expands `~` against os.homedir(): point HOME at the
    // temp home for this call only (never the real one).
    const savedHome = process.env.HOME
    process.env.HOME = home
    try {
      expect(untrustDirectory(d, root)).toBe(true)
    } finally {
      process.env.HOME = savedHome
    }
    expect(legacyLines()).toEqual([])
    rmSync(folderMapPath(root))
    expect(isDirectoryTrusted(d, root)).toBe(false)
  })

  it('F2: folders rm removes a ~-spelled trust.yaml line too', () => {
    const d = mk('tilde-rm')
    setFolderEntry(root, d, { mode: 'on', trusted: true }, { configuredScopes: [], home })
    writeLegacy([...legacyLines(), '~/tilde-rm'])
    expect(removeFolderEntry(root, d, home)).toBe(true)
    expect(legacyLines()).toEqual([])
  })

  const caseInsensitiveFs = (() => {
    const probe = mkdtempSync(join(tmpdir(), 'plur-case-'))
    try {
      mkdirSync(join(probe, 'Ab'))
      return existsSync(join(probe, 'AB'))
    } finally {
      rmSync(probe, { recursive: true, force: true })
    }
  })()

  it.skipIf(!caseInsensitiveFs)('F2: untrust removes a differently-cased trust.yaml line on a case-insensitive filesystem', () => {
    const d = mk('CaseProj')
    trustDirectory(d, root)
    writeLegacy([...legacyLines(), join(realpathSync(home), 'CASEPROJ')])
    expect(untrustDirectory(d, root)).toBe(true)
    expect(legacyLines()).toEqual([])
    expect(oldReader(join(home, 'CASEPROJ'))).toBe(false)
  })

  it('F2: a revocation never adds to trust.yaml and leaves unrelated lines alone', () => {
    const keep = mk('keep-me')
    const d = mk('revoke-me')
    writeLegacy([realpathSync(keep)])
    setFolderEntry(root, d, { mode: 'off' }, { configuredScopes: [], home })
    expect(removeFolderEntry(root, d, home)).toBe(true)
    expect(untrustDirectory(d, root)).toBe(false)
    expect(legacyLines()).toEqual([realpathSync(keep)])
  })

  // Owner decision F3: the nonce is consumed right after folders.yaml is
  // saved, before the trust.yaml write. A failed trust.yaml write then needs a
  // fresh ask.
  it('F3: a failed trust.yaml write after a saved map still consumes the nonce', () => {
    const d = mk('f3')
    mkdirSync(join(root, 'trust.yaml'))   // a directory: the trust.yaml write fails
    const n = issueFolderNonce(root, 'sess-f3', d, { mode: 'on', trusted: true })
    expect(() => setFolderEntry(root, d, { mode: 'on', trusted: true }, { configuredScopes: [], nonce: n, home })).toThrow()
    expect(loadFolderMap(root).folders).toEqual([{ path: realpathSync(d), plur: 'on', trusted: true }])
    rmSync(join(root, 'trust.yaml'), { recursive: true })
    expect(() => setFolderEntry(root, d, { mode: 'on', trusted: true }, { configuredScopes: [], nonce: n, home }))
      .toThrow(expect.objectContaining({ code: 'nonce-unknown' }))
  })

  it('a glob grant is not written to trust.yaml (the old reader cannot express it)', () => {
    setFolderEntry(root, '~/work/**', { trusted: true }, { configuredScopes: [], home })
    expect(existsSync(join(root, 'trust.yaml'))).toBe(false)
  })

  // #1428: rm and untrust match EVERY entry for the folder (#1334: applied
  // and name-only). Each matched grant's trust.yaml line goes too.
  it('F2: rm removes the trust.yaml line of every matched trusted entry, applied and name-only', () => {
    const real = realpathSync(mk('every-real'))
    const link = join(home, 'every-link')
    symlinkSync(real, link)
    writeMap([{ path: real, trusted: true }, { path: link, plur: 'on', trusted: true }])
    writeLegacy([real, link])
    expect(removeFolderEntry(root, link, home)).toBe(true)
    expect(loadFolderMap(root).folders).toEqual([])
    expect(legacyLines()).toEqual([])
  })

  it('F2: untrust and --no-trusted remove the trust.yaml line of every matched trusted entry', () => {
    const real = realpathSync(mk('every-untrust'))
    const link = join(home, 'every-untrust-link')
    symlinkSync(real, link)
    const reset = () => {
      writeMap([{ path: real, trusted: true }, { path: link, plur: 'off', trusted: true }])
      writeLegacy([real, link])
    }
    reset()
    expect(untrustDirectory(real, root)).toBe(true)
    expect(legacyLines()).toEqual([])
    // clearFolderTrust on its own completes the revocation in trust.yaml too.
    reset()
    expect(clearFolderTrust(root, real, home)).toBe(true)
    expect(legacyLines()).toEqual([])
    reset()
    setFolderEntry(root, real, { trusted: false }, { configuredScopes: [], home })
    expect(legacyLines()).toEqual([])
  })

  // #1357 identity rules apply to trust.yaml too: on a CASE-SENSITIVE
  // filesystem `Proj` and `pROJ` are two folders, and revoking one must never
  // remove the other's line. Skipped on a case-insensitive filesystem.
  it('F2: a revocation keeps a sibling folder\'s line that differs only in case (case-sensitive filesystem)', ({ skip }) => {
    const w = mk('CaseSib')
    const proj = join(w, 'Proj')
    const other = join(w, 'pROJ')
    mkdirSync(proj)
    try { mkdirSync(other) } catch { skip() } // EEXIST: case-insensitive filesystem
    trustDirectory(proj, root)
    trustDirectory(other, root)
    expect(untrustDirectory(other, root)).toBe(true)
    expect(legacyLines()).toEqual([realpathSync(proj)])
    expect(oldReader(proj)).toBe(true)
    trustDirectory(other, root)
    setFolderEntry(root, other, { trusted: false }, { configuredScopes: [], home })
    expect(legacyLines()).toEqual([realpathSync(proj)])
    trustDirectory(other, root)
    expect(removeFolderEntry(root, other, home)).toBe(true)
    expect(legacyLines()).toEqual([realpathSync(proj)])
    expect(isDirectoryTrusted(proj, root)).toBe(true)
  })
})

// #1378: a nonce authorises exactly the answer it was issued for (the mode,
// the scope if any, and whether it grants trusted), not just the folder.
describe('nonce binding to the answer (#1378)', () => {
  const opts = (nonce: string) => ({ configuredScopes: ['group:example/eng', 'group:example/ops'], nonce, home })

  it('a nonce for "yes, without its settings" (--on) cannot grant --trusted, and folders.yaml is untouched', () => {
    const d = mk('bind-trusted')
    writeMap([{ path: realpathSync(d), plur: 'ask' }])
    const before = readFileSync(folderMapPath(root))
    const n = issueFolderNonce(root, 'sess-b1', d, { mode: 'on' })
    for (const change of [{ trusted: true }, { mode: 'on' as const, trusted: true }, { mode: 'off' as const }, { scope: 'group:example/eng' }]) {
      expect(() => setFolderEntry(root, d, change, opts(n))).toThrow(expect.objectContaining({ code: 'nonce-answer' }))
    }
    expect(readFileSync(folderMapPath(root)).equals(before)).toBe(true)
    // A refused answer does not burn it: the offered answer still works, once.
    expect(setFolderEntry(root, d, { mode: 'on' }, opts(n)).plur).toBe('on')
    expect(() => setFolderEntry(root, d, { mode: 'on' }, opts(n))).toThrow(expect.objectContaining({ code: 'nonce-unknown' }))
  })

  // #1477 review: the nonce is checked against the key the write records, so
  // a quoted `~/x` is the home's x for both (not `<cwd>/~/x` for the check).
  it('a nonce is checked against the folder the write records: ~ expands to the home', () => {
    const d = mk('victim')
    const other = mk('other')
    const forOther = issueFolderNonce(root, 'sess-h', other, { trusted: true })
    expect(() => setFolderEntry(root, '~/victim', { trusted: true }, opts(forOther))).toThrow(expect.objectContaining({ code: 'nonce-folder' }))
    const rmOther = issueFolderNonce(root, 'sess-h', other, { remove: true })
    expect(() => removeFolderEntry(root, '~/victim', home, { nonce: rmOther })).toThrow(expect.objectContaining({ code: 'nonce-folder' }))
    expect(existsSync(folderMapPath(root))).toBe(false)
    const forD = issueFolderNonce(root, 'sess-h', d, { mode: 'on' })
    expect(setFolderEntry(root, '~/victim', { mode: 'on' }, opts(forD))).toEqual({ path: realpathSync(d), plur: 'on' })
    const rmD = issueFolderNonce(root, 'sess-h', d, { remove: true })
    expect(removeFolderEntry(root, '~/victim', home, { nonce: rmD })).toBe(true)
  })

  it('a scope nonce authorises that scope only; --scope X and --scope X --on are the same answer', () => {
    const d = mk('bind-scope')
    const n = issueFolderNonce(root, 'sess-b2', d, { scope: 'group:example/eng' })
    expect(() => setFolderEntry(root, d, { scope: 'group:example/ops' }, opts(n))).toThrow(expect.objectContaining({ code: 'nonce-answer' }))
    expect(() => setFolderEntry(root, d, { mode: 'on' }, opts(n))).toThrow(expect.objectContaining({ code: 'nonce-answer' }))
    expect(() => setFolderEntry(root, d, { scope: 'group:example/eng', trusted: true }, opts(n))).toThrow(expect.objectContaining({ code: 'nonce-answer' }))
    expect(setFolderEntry(root, d, { mode: 'on', scope: 'group:example/eng' }, opts(n)).scope).toBe('group:example/eng')
  })

  it('a trusted nonce grants trusted; an off nonce cannot remove the entry, a remove nonce cannot set', () => {
    const d = mk('bind-rm')
    const t = issueFolderNonce(root, 'sess-b3', d, { trusted: true })
    expect(setFolderEntry(root, d, { trusted: true }, opts(t)).trusted).toBe(true)
    const off = issueFolderNonce(root, 'sess-b3', d, { mode: 'off' })
    expect(() => removeFolderEntry(root, d, home, { nonce: off })).toThrow(expect.objectContaining({ code: 'nonce-answer' }))
    const rm = issueFolderNonce(root, 'sess-b3', d, { remove: true })
    expect(() => setFolderEntry(root, d, { mode: 'off' }, opts(rm))).toThrow(expect.objectContaining({ code: 'nonce-answer' }))
    expect(removeFolderEntry(root, d, home, { nonce: rm })).toBe(true)
  })

  it('trustDirectory accepts only a nonce bound to the grant; untrustDirectory needs none (#1477 review)', () => {
    const d = mk('bind-trust')
    const on = issueFolderNonce(root, 'sess-b4', d, { mode: 'on' })
    expect(() => trustDirectory(d, root, { nonce: on })).toThrow(expect.objectContaining({ code: 'nonce-answer' }))
    expect(existsSync(folderMapPath(root))).toBe(false)
    const grant = issueFolderNonce(root, 'sess-b4', d, { trusted: true })
    expect(trustDirectory(d, root, { nonce: grant })).toBe(realpathSync(d))
    expect(() => trustDirectory(d, root, { nonce: grant })).toThrow(expect.objectContaining({ code: 'nonce-unknown' }))
    expect(isDirectoryTrusted(d, root)).toBe(true)
    expect(untrustDirectory(d, root)).toBe(true)
    expect(isDirectoryTrusted(d, root)).toBe(false)
  })

  it('a nonce record with no bound answer authorises nothing', () => {
    const d = mk('bind-legacy')
    mkdirSync(join(root, 'folder-nonces'), { recursive: true })
    writeFileSync(join(root, 'folder-nonces', 'old.yaml'),
      yaml.dump({ session: 'old', nonces: [{ nonce: 'abc123', folder: realpathSync(d), issued_at: Date.now() }] }))
    expect(() => setFolderEntry(root, d, { mode: 'on' }, opts('abc123'))).toThrow(expect.objectContaining({ code: 'nonce-answer' }))
  })
})

// #1415 review (blocking 1): `plur remote` checked $HOME/root BEFORE the /me
// round trip, then setFolder canonicalised the folder again when it wrote. A
// folder swapped for a symlink to $HOME in between was recorded as $HOME. The
// refusal now also runs inside the write, under the lock, on the key written.
describe.skipIf(process.platform === 'win32')('writes: refuseCoveringHome', () => {
  const opts = () => ({ configuredScopes: [], home, literal: true, refuseCoveringHome: true })

  it('refuses $HOME, a symlink to it, an ancestor and the filesystem root; nothing is written', () => {
    const link = join(base, 'to-home')
    symlinkSync(home, link)
    for (const dir of [home, link, `${home}/`, base, '/']) {
      expect(() => setFolderEntry(root, dir, { mode: 'on' }, opts()), dir)
        .toThrow(expect.objectContaining({ code: 'covers-home' }))
    }
    expect(existsSync(folderMapPath(root))).toBe(false)
  })

  it('still records a subfolder of $HOME, including one named sub?', () => {
    const d = mk('proj')
    const q = mk('w/sub?')
    expect(setFolderEntry(root, d, { mode: 'on' }, opts())).toEqual({ path: realpathSync(d), plur: 'on' })
    expect(setFolderEntry(root, q, { mode: 'on' }, opts())).toEqual({ path: realpathSync(q), plur: 'on', literal: true })
  })

  it('is checked on the key written: a folder swapped for a symlink to $HOME after the caller checked it is refused', () => {
    const b = join(base, 'a', 'b')
    mkdirSync(b, { recursive: true })
    // The caller's own (early) check passes for the real folder ...
    expect(coversHomeOrRoot(realpathSync(b), home)).toBe(false)
    // ... then the folder is replaced by a symlink to $HOME before the write.
    rmSync(b, { recursive: true })
    symlinkSync(home, b)
    expect(() => setFolderEntry(root, b, { scope: 'project:x' }, opts()))
      .toThrow(expect.objectContaining({ code: 'covers-home' }))
    expect(existsSync(folderMapPath(root))).toBe(false)
    expect(policy(mk('sub')).mode).toBe('ask')
  })

  it('without the option, a write for $HOME is recorded as before (plur folders set)', () => {
    expect(setFolderEntry(root, home, { mode: 'off' }, { configuredScopes: [], home }).plur).toBe('off')
  })
})

// #1415 review (blocking 4): a literal write records the canonical folder,
// so its nonce must be issued and checked against that key too. Before, the
// nonce was issued and checked against the raw `sub?` (a glob as typed) while
// the write recorded the canonical folder, so a nonce for one folder `sub?`
// authorised a literal write of another.
describe.skipIf(process.platform === 'win32')('nonces for literal writes', () => {
  const lit = (nonce: string) => ({ configuredScopes: [], home, literal: true, nonce })

  it('a nonce for sub? issued in one folder does not authorise a literal write of sub? in another', () => {
    const a = mk('a', 'sub?')
    const b = mk('b', 'sub?')
    const cwd = process.cwd()
    try {
      process.chdir(join(home, 'a'))
      const n = issueFolderNonce(root, 'sess-lit', 'sub?', { mode: 'on' }, Date.now(), { home, literal: true })
      process.chdir(join(home, 'b'))
      expect(() => setFolderEntry(root, 'sub?', { mode: 'on' }, lit(n)))
        .toThrow(expect.objectContaining({ code: 'nonce-folder' }))
      expect(existsSync(folderMapPath(root))).toBe(false)
      process.chdir(join(home, 'a'))
      expect(setFolderEntry(root, 'sub?', { mode: 'on' }, lit(n))).toEqual({ path: realpathSync(a), plur: 'on', literal: true })
      expect(loadFolderMap(root).folders.map(e => e.path)).not.toContain(realpathSync(b))
    } finally {
      process.chdir(cwd)
    }
  })

  it('the nonce records the key the literal write records, not the path as typed', () => {
    const real = mk('real', 'sub?')
    const link = join(base, 'link')
    symlinkSync(join(home, 'real'), link)
    const typed = join(link, 'sub?')
    // Issued for the glob (not literal): it names `typed` as typed, which is
    // not what a literal write records, so the literal write refuses it.
    const glob = issueFolderNonce(root, 'sess-lit2', typed, { mode: 'on' })
    expect(() => setFolderEntry(root, typed, { mode: 'on' }, lit(glob)))
      .toThrow(expect.objectContaining({ code: 'nonce-folder' }))
    // Issued literally: bound to the canonical folder, which is what is written.
    const n = issueFolderNonce(root, 'sess-lit2', typed, { mode: 'on' }, Date.now(), { home, literal: true })
    const file = join(root, 'folder-nonces', 'sess-lit2.yaml')
    const recs = (yaml.load(readFileSync(file, 'utf8')) as { nonces: Array<{ nonce: string; folder: string }> }).nonces
    expect(recs.find(r => r.nonce === n)?.folder).toBe(realpathSync(real))
    expect(setFolderEntry(root, typed, { mode: 'on' }, lit(n)).path).toBe(realpathSync(real))
  })
})
