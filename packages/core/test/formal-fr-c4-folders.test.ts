/**
 * Formal cluster 4 (field report, 2026-09-29) — replays for
 * spec/formal/PlurSpec/Folders.lean. Findings: spec/formal/findings/folders.md.
 *
 * Tests named "holds:" pin a property the model proves. Tests named
 * "NEEDS-OWNER evidence:" pin CURRENT behaviour that the model shows breaks a
 * documented guarantee; they are left unfixed on purpose (the formal pass does
 * not edit packages/*\/src) and must be flipped when the owner decides.
 *
 * Every test builds its own home and PLUR root under a temp dir; the real
 * ~/.plur is never read or written.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync, realpathSync, renameSync } from 'fs'
import yaml from 'js-yaml'
import { join, sep } from 'path'
import { tmpdir } from 'os'
import {
  resolveFolderPolicy, loadFolderMap, saveFolderMap, folderMapPath, setFolderEntry, removeFolderEntry,
  issueFolderNonce, FolderMapError, isTrustedInMap, type FolderEntry,
} from '../src/folders.js'
import { isDirectoryTrusted, trustDirectory, untrustDirectory } from '../src/trust.js'
import { canonicalize } from '../src/project-config.js'

let base: string
let home: string
let root: string
let savedHome: string | undefined

function mk(...parts: string[]): string {
  const d = join(home, ...parts)
  mkdirSync(d, { recursive: true })
  return d
}
const writeMap = (folders: FolderEntry[]) => saveFolderMap(root, { version: 1, folders })
const policy = (dir: string) => resolveFolderPolicy(dir, { root, home })
const legacy = (): string[] => {
  const f = join(root, 'trust.yaml')
  if (!existsSync(f)) return []
  return ((yaml.load(readFileSync(f, 'utf8')) as { trusted?: string[] } | null)?.trusted) ?? []
}
/** The pre-folder-map reader (main before #1347): raw stored string vs canonical target. */
function oldReader(dir: string): boolean {
  const target = canonicalize(dir)
  return legacy().some(t => target === t || target.startsWith(t + sep))
}
function repo(name: string, plurYaml: string): string {
  const d = mk(name)
  mkdirSync(join(d, '.git'), { recursive: true })
  writeFileSync(join(d, '.plur.yaml'), plurYaml)
  return d
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'plur-fr-c4-')))
  home = join(base, 'home')
  root = join(home, '.plur')
  mkdirSync(root, { recursive: true })
  savedHome = process.env.HOME
  process.env.HOME = home // trust.ts reads os.homedir()
})

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  rmSync(base, { recursive: true, force: true })
})

describe('resolution (Folders.lean §1)', () => {
  it('holds: off wins over a trusted .plur.yaml with a remote and a more specific trusted on entry (off_wins)', () => {
    const d = repo('r', 'scope: group:x/y\nremote_url: https://example.invalid\nremote_token: t\n')
    writeMap([{ path: '~/**', plur: 'off' }, { path: d, plur: 'on', trusted: true, scope: 'project:z' }])
    expect(policy(d)).toEqual({ mode: 'off', remoteAllowed: false, source: 'map' })
  })

  it('holds: a map scope beats a trusted hint (map_scope_overrides_hint)', () => {
    const d = repo('r', 'scope: project:hint\n')
    writeMap([{ path: d, trusted: true }, { path: '~/**', scope: 'project:mine' }])
    expect(policy(d)).toMatchObject({ mode: 'on', scope: 'project:mine', source: 'plur-yaml' })
  })

  it('holds (D1): an untrusted request is never applied; with no map decision it asks (untrusted_asks)', () => {
    const d = repo('r', 'scope: group:evil/x\ndomain: evil\nremote_url: https://example.invalid\nremote_token: t\n')
    const p = policy(d)
    expect(p.mode).toBe('ask')
    expect(p.reason).toBe('untrusted-plur-yaml')
    expect(p.scope).toBeUndefined()
    expect(p.remoteAllowed).toBe(false)
    // Under a map decision: the map's scope, never the hint, never the remote.
    writeMap([{ path: '~/**', scope: 'project:mine' }])
    expect(policy(d)).toEqual({ mode: 'on', scope: 'project:mine', remoteAllowed: false, source: 'map' })
  })

  it('holds: the remote is allowed only with a covering trusted entry (remote_needs_trust); non-vacuous', () => {
    const d = repo('r', 'remote_url: https://example.invalid\nremote_token: t\n')
    expect(policy(d).remoteAllowed).toBe(false)
    writeMap([{ path: d, trusted: true }])
    expect(policy(d)).toMatchObject({ mode: 'on', remoteAllowed: true, source: 'plur-yaml' })
  })
})

describe('fail-closed trust compare (Folders.lean §2)', () => {
  it('holds: the trusted folder swapped for a symlink to a cloned repo is not trusted (swap_target_refused)', () => {
    const d = mk('work', 'repo')
    trustDirectory(d, root)
    const evil = repo('evil', 'remote_url: https://example.invalid\nremote_token: t\n')
    renameSync(d, join(base, 'moved-away'))
    symlinkSync(evil, d)
    expect(isDirectoryTrusted(d, root)).toBe(false)
    expect(policy(d).remoteAllowed).toBe(false)
  })

  it('holds: the trusted folder\'s PARENT swapped for a symlink is not trusted (swap_parent_refused)', () => {
    const d = mk('work', 'team', 'repo')
    trustDirectory(d, root)
    const other = mk('other')
    repo(join('other', 'repo'), 'remote_url: https://example.invalid\nremote_token: t\n')
    renameSync(join(home, 'work', 'team'), join(base, 'team-away'))
    symlinkSync(other, join(home, 'work', 'team'))
    expect(isDirectoryTrusted(d, root)).toBe(false)
    expect(isDirectoryTrusted(join(other, 'repo'), root)).toBe(false)
    expect(policy(d).remoteAllowed).toBe(false)
  })

  it('holds: a link INTO a trusted tree is trusted (trust follows the real location: link_invariant)', () => {
    const d = mk('work', 'repo')
    trustDirectory(d, root)
    const link = join(base, 'shortcut')
    symlinkSync(d, link)
    expect(isDirectoryTrusted(link, root)).toBe(true)
  })
})

describe('trust dual-write (Folders.lean §3)', () => {
  it('holds: grants and untrust through trust.ts reach both files (grant_keeps_inv)', () => {
    const d = mk('dual')
    trustDirectory(d, root)
    expect(isDirectoryTrusted(d, root)).toBe(true)
    expect(oldReader(d)).toBe(true)
    untrustDirectory(d, root)
    expect(isDirectoryTrusted(d, root)).toBe(false)
    expect(oldReader(d)).toBe(false)
  })

  it('NEEDS-OWNER evidence: `plur folders rm` of a trusted entry leaves the trust.yaml grant (rm_breaks_inv)', () => {
    const d = mk('rm-me')
    setFolderEntry(root, d, { mode: 'on', trusted: true }, { configuredScopes: [], home })
    expect(oldReader(d)).toBe(true)
    expect(removeFolderEntry(root, d, home)).toBe(true)
    expect(isDirectoryTrusted(d, root)).toBe(false)   // the new reader: revoked
    expect(oldReader(d)).toBe(true)                    // an adapter on the previous core: still trusted
    expect(legacy()).toContain(d)
    // …and losing folders.yaml re-imports the grant.
    rmSync(folderMapPath(root))
    expect(isDirectoryTrusted(d, root)).toBe(true)
  })

  it('NEEDS-OWNER evidence: a `~`-spelled grant survives untrust in trust.yaml and a re-import revives it (tilde_breaks_inv)', () => {
    const d = mk('src', 'team-repo')
    writeMap([{ path: '~/src/team-repo', scope: 'project:t' }])     // hand-written, as the design note shows
    trustDirectory(d, root)                                          // `plur trust ~/src/team-repo` (shell-expanded)
    expect(loadFolderMap(root).folders).toEqual([{ path: '~/src/team-repo', scope: 'project:t', trusted: true }])
    expect(legacy()).toEqual(['~/src/team-repo'])                   // dual-written as the entry's spelling
    expect(untrustDirectory(d, root)).toBe(true)                     // reported as revoked
    expect(isDirectoryTrusted(d, root)).toBe(false)
    expect(legacy()).toEqual(['~/src/team-repo'])                   // …but still in trust.yaml
    rmSync(folderMapPath(root))
    expect(isDirectoryTrusted(d, root)).toBe(true)                   // resurrected by the import
  })
})

describe('nonces (Folders.lean §4)', () => {
  it('holds: a nonce names one folder and authorises one write (nonce_one_folder, nonce_once)', () => {
    const a = mk('a')
    const b = mk('b')
    const n = issueFolderNonce(root, 'sess', a)
    expect(() => setFolderEntry(root, b, { mode: 'on' }, { configuredScopes: [], nonce: n, home }))
      .toThrow(FolderMapError)
    expect(loadFolderMap(root).folders).toEqual([])
    setFolderEntry(root, a, { mode: 'on' }, { configuredScopes: [], nonce: n, home })
    expect(() => setFolderEntry(root, a, { mode: 'off' }, { configuredScopes: [], nonce: n, home }))
      .toThrow(/already-used|Unknown/)
    expect(loadFolderMap(root).folders).toEqual([{ path: a, plur: 'on' }])
  })

  it('holds: a refused write does not burn the nonce (refused_keeps_nonce)', () => {
    const a = mk('a')
    const n = issueFolderNonce(root, 'sess', a)
    expect(() => setFolderEntry(root, a, { scope: 'group:not/configured' }, { configuredScopes: [], nonce: n, home }))
      .toThrow(/team scope/)
    setFolderEntry(root, a, { mode: 'on' }, { configuredScopes: [], nonce: n, home })
    expect(loadFolderMap(root).folders).toEqual([{ path: a, plur: 'on' }])
  })

  it('NEEDS-OWNER evidence: a failed trust.yaml write after a saved map leaves the nonce live for a second saved write (legacy_fail_two_writes)', () => {
    const a = mk('a')
    mkdirSync(join(root, 'trust.yaml'))   // the dual-write's atomic rename onto it fails
    const n = issueFolderNonce(root, 'sess', a)
    expect(() => setFolderEntry(root, a, { mode: 'on', trusted: true }, { configuredScopes: [], nonce: n, home }))
      .toThrow()
    expect(loadFolderMap(root).folders).toEqual([{ path: a, plur: 'on', trusted: true }])   // write 1 saved
    setFolderEntry(root, a, { mode: 'off' }, { configuredScopes: [], nonce: n, home })     // same nonce accepted
    expect(loadFolderMap(root).folders).toEqual([{ path: a, plur: 'off', trusted: true }]) // write 2 saved
    expect(isTrustedInMap(loadFolderMap(root).folders, a, home)).toBe(true)
  })
})
