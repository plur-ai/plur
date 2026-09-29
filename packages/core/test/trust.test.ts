import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, realpathSync } from 'fs'
import { join, resolve } from 'path'
import yaml from 'js-yaml'
import { tmpdir } from 'os'
import {
  isDirectoryTrusted, trustDirectory, untrustDirectory, listTrustedDirectories, coveringTrustedAncestor,
} from '../src/trust.js'

/**
 * Directory trust (D2, 2026-09 audit) — the `plur trust` model an adapter
 * (opencode's `resolveTrustedScope`) checks before adopting a `.plur.yaml`
 * scope/domain it finds on disk. See trust.ts's module docstring for why
 * this exists: remote/team stores are the LEGITIMATE reason a project
 * declares a scope, so the gate is on the directory, not on where the scope
 * resolves.
 */
describe('trust.ts (D2)', () => {
  let root: string
  let dir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plur-trust-root-'))
    dir = mkdtempSync(join(tmpdir(), 'plur-trust-dir-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  })

  it('a directory is untrusted by default', () => {
    expect(isDirectoryTrusted(dir, root)).toBe(false)
  })

  it('trustDirectory grants trust; isDirectoryTrusted then returns true', () => {
    trustDirectory(dir, root)
    expect(isDirectoryTrusted(dir, root)).toBe(true)
  })

  it('trustDirectory is idempotent — trusting twice does not duplicate the entry', () => {
    trustDirectory(dir, root)
    trustDirectory(dir, root)
    const list = listTrustedDirectories(root)
    expect(list.filter(d => d === realpathSync(dir)).length).toBe(1)
  })

  it('untrustDirectory revokes trust and reports whether an entry was removed', () => {
    trustDirectory(dir, root)
    expect(untrustDirectory(dir, root)).toBe(true)
    expect(isDirectoryTrusted(dir, root)).toBe(false)
    // Second untrust of the same dir: nothing left to remove.
    expect(untrustDirectory(dir, root)).toBe(false)
  })

  it('trust is hierarchical — trusting a directory also trusts its subdirectories', () => {
    trustDirectory(dir, root)
    const sub = join(dir, 'sub', 'deeper')
    mkdirSync(sub, { recursive: true })
    expect(isDirectoryTrusted(sub, root)).toBe(true)
  })

  it('trust is NOT reversed — a subdirectory grant does not trust its parent', () => {
    const sub = join(dir, 'sub')
    mkdirSync(sub, { recursive: true })
    trustDirectory(sub, root)
    expect(isDirectoryTrusted(dir, root)).toBe(false)
    expect(isDirectoryTrusted(sub, root)).toBe(true)
  })

  it('a sibling directory sharing a path prefix is NOT trusted (no accidental prefix match)', () => {
    // Regression guard: string-prefix matching without a separator boundary
    // would treat "/repo" and "/repo-evil" as related.
    trustDirectory(dir, root)
    const sibling = `${dir}-evil`
    mkdirSync(sibling, { recursive: true })
    try {
      expect(isDirectoryTrusted(sibling, root)).toBe(false)
    } finally {
      rmSync(sibling, { recursive: true, force: true })
    }
  })

  it('listTrustedDirectories lists every grant, sorted', () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'plur-trust-dir2-'))
    try {
      trustDirectory(dir2, root)
      trustDirectory(dir, root)
      const list = listTrustedDirectories(root)
      expect(list).toEqual([...list].sort())
      expect(list).toContain(realpathSync(dir))
      expect(list).toContain(realpathSync(dir2))
    } finally {
      rmSync(dir2, { recursive: true, force: true })
    }
  })

  it('canonicalizes a symlinked path before comparing (#778-style — fails OPEN otherwise)', () => {
    const real = mkdtempSync(join(tmpdir(), 'plur-trust-real-'))
    const link = join(root, 'link-to-real')
    try {
      symlinkSync(real, link)
      trustDirectory(link, root)
      // Trusting via the symlink must be visible when checked via the real path too.
      expect(isDirectoryTrusted(real, root)).toBe(true)
    } finally {
      rmSync(real, { recursive: true, force: true })
    }
  })

  it('the trust store persists to <root>/trust.yaml as plain YAML', () => {
    trustDirectory(dir, root)
    const raw = readFileSync(join(root, 'trust.yaml'), 'utf8')
    expect(raw).toContain(realpathSync(dir))
  })

  it('a corrupt trust.yaml is treated as empty rather than throwing', () => {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'trust.yaml'), ': this is not valid yaml: [[[')
    expect(isDirectoryTrusted(dir, root)).toBe(false)
    expect(listTrustedDirectories(root)).toEqual([])
  })

  describe('coveringTrustedAncestor (E3)', () => {
    it('returns null when nothing covers the directory', () => {
      expect(coveringTrustedAncestor(dir, root)).toBeNull()
    })

    it('returns the exact entry when the directory itself is trusted', () => {
      trustDirectory(dir, root)
      expect(coveringTrustedAncestor(dir, root)).toBe(realpathSync(dir))
    })

    it('returns the covering ancestor for an untrusted subdirectory of a trusted repo', () => {
      trustDirectory(dir, root)
      const sub = join(dir, 'packages', 'inner')
      mkdirSync(sub, { recursive: true })
      expect(coveringTrustedAncestor(sub, root)).toBe(realpathSync(dir))
    })

    it('untrusting a covered subdirectory does not remove the ancestor grant, and coveringTrustedAncestor still names it', () => {
      trustDirectory(dir, root)
      const sub = join(dir, 'packages', 'inner')
      mkdirSync(sub, { recursive: true })
      // The subdirectory was never its own entry — nothing to remove.
      expect(untrustDirectory(sub, root)).toBe(false)
      // But it is still trusted, via the ancestor, and isDirectoryTrusted must
      // agree with what coveringTrustedAncestor reports.
      expect(isDirectoryTrusted(sub, root)).toBe(true)
      expect(coveringTrustedAncestor(sub, root)).toBe(realpathSync(dir))
    })
  })

  it('lives under a caller-supplied root, never a hardcoded home path', () => {
    // No env/homedir dependency — same root in, same answer out, regardless
    // of process.env.HOME. This is what lets the opencode plugin (via
    // Plur.isDirectoryTrusted, which passes this.paths.root) and `plur
    // trust`/`plur doctor` --path <dir> agree on the same store.
    const otherRoot = mkdtempSync(join(tmpdir(), 'plur-trust-other-root-'))
    try {
      trustDirectory(dir, root)
      expect(isDirectoryTrusted(dir, otherRoot)).toBe(false)
      expect(isDirectoryTrusted(dir, root)).toBe(true)
    } finally {
      rmSync(otherRoot, { recursive: true, force: true })
    }
  })
})

/**
 * #1319 trust and symlinks. Owner decision (2026-09-29): the trust check fails
 * CLOSED. A stored entry is compared exactly as written against the checked
 * folder's canonical form. It is never resolved at compare time, because
 * resolving it would follow a symlink planted after trust was granted (#778).
 * The cost: a trust that an older version granted for a folder that did not
 * exist yet, under a symlinked parent, was stored in the parent's symlinked
 * spelling and no longer matches once the folder exists. Re-run `plur trust`.
 */
describe('trust.yaml entries and symlinks (#1319)', () => {
  let root: string
  let base: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plur-trust-old-root-'))
    base = mkdtempSync(join(tmpdir(), 'plur-trust-old-base-'))
    mkdirSync(join(base, 'real'))
    symlinkSync(join(base, 'real'), join(base, 'link'), 'dir')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  })

  function writeOldEntry(): { oldEntry: string; text: string } {
    // Exactly what the old `realpathSync(p) catch resolve(p)` stored for a
    // folder that did not exist at trust time.
    const oldEntry = resolve(join(base, 'link', 'later-project'))
    const text = yaml.dump({ version: 1, trusted: [oldEntry] })
    writeFileSync(join(root, 'trust.yaml'), text, 'utf8')
    return { oldEntry, text }
  }

  it('an old-spelling entry does NOT grant trust once the folder exists (owner decision: re-run `plur trust`)', () => {
    const { text } = writeOldEntry()
    mkdirSync(join(base, 'real', 'later-project', 'sub'), { recursive: true })
    expect(isDirectoryTrusted(join(base, 'link', 'later-project'), root)).toBe(false)
    expect(isDirectoryTrusted(join(base, 'real', 'later-project'), root)).toBe(false)
    expect(isDirectoryTrusted(join(base, 'real', 'later-project', 'sub'), root)).toBe(false)
    expect(coveringTrustedAncestor(join(base, 'real', 'later-project', 'sub'), root)).toBeNull()
    expect(readFileSync(join(root, 'trust.yaml'), 'utf8')).toBe(text)
    // Re-running `plur trust` restores it.
    trustDirectory(join(base, 'link', 'later-project'), root)
    expect(isDirectoryTrusted(join(base, 'real', 'later-project', 'sub'), root)).toBe(true)
  })

  it('a trusted folder later replaced by a symlink to another folder is NOT trusted (#778)', () => {
    const proj = join(base, 'real', 'proj')
    mkdirSync(proj)
    mkdirSync(join(base, 'real', 'evil'))
    trustDirectory(proj, root)
    const text = readFileSync(join(root, 'trust.yaml'), 'utf8')
    rmSync(proj, { recursive: true })
    symlinkSync(join(base, 'real', 'evil'), proj, 'dir')
    expect(isDirectoryTrusted(proj, root)).toBe(false)
    expect(isDirectoryTrusted(join(base, 'real', 'evil'), root)).toBe(false)
    expect(coveringTrustedAncestor(proj, root)).toBeNull()
    expect(readFileSync(join(root, 'trust.yaml'), 'utf8')).toBe(text)
  })

  it('plur untrust removes an old-spelling entry by the spelling it was trusted under (owner decision)', () => {
    writeOldEntry()
    mkdirSync(join(base, 'real', 'later-project'))
    expect(untrustDirectory(join(base, 'link', 'later-project'), root)).toBe(true)
    expect(listTrustedDirectories(root)).toEqual([])
  })

  it('a trusted folder whose PARENT is later replaced by a symlink is NOT trusted (#778)', () => {
    mkdirSync(join(base, 'real', 'proj', 'sub'), { recursive: true })
    mkdirSync(join(base, 'real', 'evil', 'sub'), { recursive: true })
    trustDirectory(join(base, 'real', 'proj', 'sub'), root)
    const text = readFileSync(join(root, 'trust.yaml'), 'utf8')
    rmSync(join(base, 'real', 'proj'), { recursive: true })
    symlinkSync(join(base, 'real', 'evil'), join(base, 'real', 'proj'), 'dir')
    expect(isDirectoryTrusted(join(base, 'real', 'proj', 'sub'), root)).toBe(false)
    expect(coveringTrustedAncestor(join(base, 'real', 'proj', 'sub'), root)).toBeNull()
    expect(readFileSync(join(root, 'trust.yaml'), 'utf8')).toBe(text)
  })
})
