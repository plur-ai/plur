/**
 * A broken folders.yaml is pinpointed and can be repaired (#1526).
 *
 *  - checkFolderMapText / folderMapProblem name the line (and column) and the
 *    problem in plain words, quoting at most the key on that line — never a
 *    path, scope or any other value from the file;
 *  - planFolderMapRepair fixes only what is unambiguous (indentation, tabs,
 *    misspelled top-level keys, wrong-case / one-letter-typo modes, an empty
 *    file) and keeps every comment; anything else is "unfixable" and nothing
 *    changes;
 *  - repairFolderMap writes a timestamped backup next to the file, writes
 *    atomically, and re-checks the result;
 *  - while the map is broken, the hooks/plugin resolver agrees with the MCP
 *    gate: every folderMapProblem case is `malformed-map` (ask, no memory).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, realpathSync, symlinkSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import {
  checkFolderMapText, planFolderMapRepair, repairFolderMap, folderMapProblem, folderMapPath,
  resolveFolderPolicy, folderAskOnce, folderRepairCommand, setFolderEntry, FolderMapError,
} from '../src/index.js'
import { logger } from '../src/logger.js'

const SECRET = 'sk-live-SECRET-0123456789'

let root: string
let repo: string
beforeEach(() => {
  vi.spyOn(logger, 'warning').mockImplementation(() => {})
  root = realpathSync(mkdtempSync(join(tmpdir(), 'repair-home-')))
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'repair-repo-')))
  // A project marker: with a map read as empty, this meant memory ON.
  writeFileSync(join(repo, '.plur.yaml'), '# plur\n')
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
})

function first(text: string) {
  const r = checkFolderMapText(text)
  expect(r.ok, text).toBe(false)
  if (r.ok) throw new Error('unreachable')
  return r.issues[0]
}

describe('checkFolderMapText pinpoints the problem in plain words', () => {
  it('a valid map is ok, comments and all', () => {
    expect(checkFolderMapText('# mine\nversion: 1\nfolders:\n  - path: /a  # work\n    plur: off\n').ok).toBe(true)
    expect(checkFolderMapText('version: 1\nfolders:\n- path: /a\n  plur: on\n').ok).toBe(true)
    expect(checkFolderMapText('version: 1\nfolders: []\n').ok).toBe(true)
  })

  it('a key indented unlike its entry: line, what, how far, expected', () => {
    const i = first('version: 1\nfolders:\n  - path: /a\n     plur: off\n')
    expect(i.line).toBe(4)
    expect(i.message).toMatch(/^line 4: indentation/)
    expect(i.message).toContain('`plur:`')
    expect(i.message).toMatch(/indented 5 spaces, expected 4/)
    expect(i.message).toContain('`path:` on line 3')
    expect(i.fixable).toBe(true)
  })

  it('a list item indented unlike the first one', () => {
    const i = first('version: 1\nfolders:\n  - path: /a\n    plur: off\n - path: /b\n')
    expect(i.line).toBe(5)
    expect(i.message).toMatch(/^line 5: indentation/)
    expect(i.message).toMatch(/indented 1 space, expected 2/)
    expect(i.fixable).toBe(true)
  })

  it('a tab in the indentation', () => {
    const i = first('version: 1\nfolders:\n  - path: /a\n\tplur: off\n')
    expect(i.line).toBe(4)
    expect(i.message).toMatch(/^line 4: .*tab/)
    expect(i.fixable).toBe(true)
  })

  it('a misspelled top-level key: did you mean', () => {
    const i = first('version: 1\nfolder:\n  - path: /a\n    plur: off\n')
    expect(i.line).toBe(2)
    expect(i.message).toBe('line 2: unknown key `folder:` — did you mean `folders:`?')
    expect(i.fixable).toBe(true)
    expect(first('verison: 1\nfolders: []\n').message).toBe('line 1: unknown key `verison:` — did you mean `version:`?')
  })

  it('an unknown top-level key with no near match: only version and folders belong there', () => {
    const i = first('version: 1\nfolders: []\nzebra: 1\n')
    expect(i.line).toBe(3)
    expect(i.message).toMatch(/^line 3: an unknown key/)
    expect(i.message).not.toContain('zebra')
    expect(i.message).toMatch(/`version:` and `folders:`/)
    expect(i.fixable).toBe(false)
  })

  it('a mode with the wrong case or a typo: names the key and the entry, never the value', () => {
    const i = first('version: 1\nfolders:\n  - path: /a\n    plur: Off\n')
    expect(i.line).toBe(4)
    expect(i.message).toMatch(/^line 4: `plur:` in entry 1 must be on, off or ask/)
    expect(i.message).not.toContain('Off')
    expect(i.fixable).toBe(true)
    // Round 3 (#1530 re-review R3): a typo never becomes `on`; `offf` → off does.
    expect(first('version: 1\nfolders:\n  - path: /a\n    plur: offf\n').fixable).toBe(true)
    expect(first('version: 1\nfolders:\n  - path: /a\n    plur: onn\n').fixable).toBe(false)
    expect(first('version: 1\nfolders:\n  - path: /a\n    plur: aks\n').fixable).toBe(true)
  })

  it('an ambiguous mode (`of` is one letter from both on and off) is not fixable', () => {
    const i = first('version: 1\nfolders:\n  - path: /a\n    plur: of\n')
    expect(i.line).toBe(4)
    expect(i.fixable).toBe(false)
    expect(first('version: 1\nfolders:\n  - path: /a\n    plur: no\n').fixable).toBe(false)
    expect(first('version: 1\nfolders:\n  - path: /a\n    plur: false\n').fixable).toBe(false)
  })

  it('an entry without a path names its line', () => {
    const i = first('version: 1\nfolders:\n  - path: /a\n  - plur: off\n')
    expect(i.line).toBe(4)
    expect(i.message).toMatch(/^line 4: entry 2 has no `path:`/)
    expect(i.fixable).toBe(false)
  })

  it('an empty or comments-only file is empty, and fixable', () => {
    for (const t of ['', '\n\n', '# nothing yet\n  # really\n']) {
      const i = first(t)
      expect(i.message).toMatch(/empty/)
      expect(i.fixable).toBe(true)
    }
  })

  it('a YAML syntax error with no structural cause: line and column from the parser', () => {
    const i = first('version: 1\nfolders:\n  - path: [unclosed\n')
    expect(i.line).toBeGreaterThan(0)
    expect(i.column).toBeGreaterThan(0)
    expect(i.message).toMatch(/^line \d+, column \d+: not valid YAML/)
    expect(i.fixable).toBe(false)
  })

  it('never quotes a value from the file — only the key on that line', () => {
    const texts = [
      `version: 1\nfolders:\n  - path: /a/${SECRET}\n     scope: group:${SECRET}\n`,
      `version: 1\nfolder:\n  - path: /a/${SECRET}\n`,
      `version: 1\nfolders:\n  - path: /a/${SECRET}\n    plur: ${SECRET}\n`,
      `version: 1\nfolders:\n  - path: /a/${SECRET}\n  - scope: ${SECRET}\n`,
      `version: 1\nfolders:\n  - path: [${SECRET}\n`,
      `version: 1\nfolders:\n  - path: /a/${SECRET}\n    trusted: ${SECRET}\n`,
      `version: 1\n${SECRET}: 1\nfolders: []\n`,
    ]
    for (const t of texts) {
      const r = checkFolderMapText(t)
      expect(r.ok, t).toBe(false)
      if (!r.ok) for (const i of r.issues) expect(i.message, t).not.toContain(SECRET)
    }
  })
})

describe('planFolderMapRepair', () => {
  function fixed(text: string): string {
    const p = planFolderMapRepair(text)
    expect(p.status, JSON.stringify(p)).toBe('fixable')
    if (p.status !== 'fixable') throw new Error('unreachable')
    expect(checkFolderMapText(p.after).ok).toBe(true)
    return p.after
  }

  it('a valid map needs nothing', () => {
    expect(planFolderMapRepair('version: 1\nfolders: []\n').status).toBe('ok')
  })

  it('re-indents keys and items and keeps every comment', () => {
    // /b has a literal plur: (round 3: a scope-only entry would resolve on, so it is never repaired).
    const before = '# my folders\nversion: 1\nfolders:\n  # work\n  - path: /a   # the work tree\n     plur: off\n - path: /b\n   scope: group:x/y\n   plur: ask\n'
    expect(fixed(before)).toBe('# my folders\nversion: 1\nfolders:\n  # work\n  - path: /a   # the work tree\n    plur: off\n  - path: /b\n    scope: group:x/y\n    plur: ask\n')
  })

  it('replaces tabs in the indentation', () => {
    expect(fixed('version: 1\nfolders:\n\t- path: /a\n\t  plur: off\n')).toBe('version: 1\nfolders:\n  - path: /a\n    plur: off\n')
  })

  it('renames a misspelled top-level key, keeping the rest of the line', () => {
    expect(fixed('verison: 1   # v\nfolder:\n  - path: /a\n')).toBe('version: 1   # v\nfolders:\n  - path: /a\n')
  })

  it('fixes a mode with the wrong case or a one-letter typo, keeping quotes and comments', () => {
    expect(fixed('version: 1\nfolders:\n  - path: /a\n    plur: OFF  # never here\n')).toBe('version: 1\nfolders:\n  - path: /a\n    plur: off  # never here\n')
    expect(fixed("version: 1\nfolders:\n  - path: /a\n    plur: 'Ask'\n")).toBe("version: 1\nfolders:\n  - path: /a\n    plur: 'ask'\n")
    expect(fixed('version: 1\nfolders:\n  - path: /a\n    plur: offf\n')).toBe('version: 1\nfolders:\n  - path: /a\n    plur: off\n')
  })

  it('turns an empty or comments-only file into a minimal valid map, keeping the comments', () => {
    expect(fixed('')).toBe('version: 1\nfolders: []\n')
    expect(fixed('# keep me\n')).toBe('# keep me\nversion: 1\nfolders: []\n')
  })

  it('fixes several problems at once and shows a unified diff', () => {
    const p = planFolderMapRepair('verison: 1\nfolder:\n  - path: /a\n     plur: Off\n')
    expect(p.status).toBe('fixable')
    if (p.status !== 'fixable') return
    expect(p.after).toBe('version: 1\nfolders:\n  - path: /a\n    plur: off\n')
    expect(p.diff).toMatch(/^--- /m)
    expect(p.diff).toMatch(/^\+\+\+ /m)
    expect(p.diff).toMatch(/^@@ /m)
    expect(p.diff).toContain('-     plur: Off')
    expect(p.diff).toContain('+    plur: off')
    expect(p.fixes.length).toBeGreaterThanOrEqual(3)
  })

  it('keeps CRLF line endings', () => {
    expect(fixed('version: 1\r\nfolder:\r\n  - path: /a\r\n')).toBe('version: 1\r\nfolders:\r\n  - path: /a\r\n')
  })

  it('refuses what it cannot fix unambiguously, pinpointing it', () => {
    for (const t of [
      'version: 1\nfolders:\n  - path: /a\n    plur: of\n',
      'version: 1\nfolders:\n  - path: /a\n  - plur: off\n',
      'version: 1\nfolders:\n  - path: [unclosed\n',
      'version: 1\nfolders: []\nzebra: 1\n',
      // a typo that also has its fix present already: never two `folders:`
      'version: 1\nfolders: []\nfolder:\n  - path: /a\n',
    ]) {
      const p = planFolderMapRepair(t)
      expect(p.status, t).toBe('unfixable')
      if (p.status === 'unfixable') expect(p.issues[0].message, t).toMatch(/^line \d+/)
    }
  })

  it('refuses all of it when one problem is unfixable (no half repair)', () => {
    const p = planFolderMapRepair('folder:\n  - path: /a\n    plur: of\n')
    expect(p.status).toBe('unfixable')
  })
})

describe('repairFolderMap writes safely', () => {
  const file = () => folderMapPath(root)
  const backups = () => readdirSync(root).filter(n => n.startsWith('folders.yaml.plur-backup-'))

  it('dry run (apply false) changes nothing', () => {
    const before = 'version: 1\nfolder:\n  - path: /a\n'
    writeFileSync(file(), before)
    const r = repairFolderMap(root, { apply: false })
    expect(r.status).toBe('fixable')
    expect(r.diff).toContain('+folders:')
    expect(readFileSync(file(), 'utf8')).toBe(before)
    expect(backups()).toEqual([])
  })

  it('apply: backup with the original bytes, new file, re-checked', () => {
    const before = '# mine\nversion: 1\nfolder:\n  - path: /a\n     plur: Off\n'
    writeFileSync(file(), before)
    const r = repairFolderMap(root, { apply: true, now: new Date('2026-10-02T09:08:07.123Z') })
    expect(r.status).toBe('repaired')
    expect(r.backup).toBe(join(root, 'folders.yaml.plur-backup-20261002T090807Z'))
    expect(readFileSync(r.backup!, 'utf8')).toBe(before)
    expect(readFileSync(file(), 'utf8')).toBe('# mine\nversion: 1\nfolders:\n  - path: /a\n    plur: off\n')
    expect(r.problemAfter).toBeNull()
    expect(folderMapProblem(root)).toBeNull()
  })

  it('two repairs in the same second keep both backups', () => {
    const now = new Date('2026-10-02T09:08:07Z')
    writeFileSync(file(), 'version: 1\nfolder:\n  - path: /a\n')
    expect(repairFolderMap(root, { apply: true, now }).status).toBe('repaired')
    writeFileSync(file(), 'verison: 1\nfolders: []\n')
    const r = repairFolderMap(root, { apply: true, now })
    expect(r.status).toBe('repaired')
    expect(r.backup).toBe(join(root, 'folders.yaml.plur-backup-20261002T090807Z-2'))
    expect(backups().sort()).toEqual(['folders.yaml.plur-backup-20261002T090807Z', 'folders.yaml.plur-backup-20261002T090807Z-2'])
  })

  it('apply refuses when the file changed since the diff was shown', () => {
    writeFileSync(file(), 'version: 1\nfolder:\n  - path: /a\n')
    const shown = repairFolderMap(root, { apply: false })
    writeFileSync(file(), 'version: 1\nfolder:\n  - path: /b\n')
    const r = repairFolderMap(root, { apply: true, expect: shown.before })
    expect(r.status).toBe('changed')
    expect(readFileSync(file(), 'utf8')).toBe('version: 1\nfolder:\n  - path: /b\n')
    expect(backups()).toEqual([])
  })

  it('unfixable: nothing changes, no backup', () => {
    const before = 'version: 1\nfolders:\n  - path: /a\n    plur: of\n'
    writeFileSync(file(), before)
    const r = repairFolderMap(root, { apply: true })
    expect(r.status).toBe('unfixable')
    expect(r.issues![0].line).toBe(4)
    expect(readFileSync(file(), 'utf8')).toBe(before)
    expect(backups()).toEqual([])
  })

  it('no file, or a valid file: nothing to do', () => {
    expect(repairFolderMap(root, { apply: true }).status).toBe('absent')
    writeFileSync(file(), 'version: 1\nfolders: []\n')
    expect(repairFolderMap(root, { apply: true }).status).toBe('ok')
    expect(backups()).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('a dangling symlink cannot be repaired and is left alone', () => {
    symlinkSync(join(root, 'nowhere.yaml'), file())
    const r = repairFolderMap(root, { apply: true })
    expect(r.status).toBe('unreadable')
    expect(backups()).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('a symlinked map is repaired at its target; the link stays a link', () => {
    const real = join(root, 'dotfiles')
    mkdirSync(real)
    writeFileSync(join(real, 'folders.yaml'), 'version: 1\nfolder:\n  - path: /a\n')
    symlinkSync(join(real, 'folders.yaml'), file())
    const r = repairFolderMap(root, { apply: true })
    expect(r.status).toBe('repaired')
    expect(readFileSync(join(real, 'folders.yaml'), 'utf8')).toBe('version: 1\nfolders:\n  - path: /a\n')
    expect(realpathSync(file())).toBe(realpathSync(join(real, 'folders.yaml')))
  })
})

describe('folderMapProblem pinpoints and says whether repair can fix it', () => {
  it('line, column, plain words, fixable', () => {
    writeFileSync(folderMapPath(root), 'version: 1\nfolders:\n  - path: /a\n     plur: off\n')
    const p = folderMapProblem(root)!
    expect(p.line).toBe(4)
    expect(p.column).toBe(6)
    expect(p.problem).toContain('line 4: indentation')
    expect(p.fixable).toBe(true)
  })

  it('unfixable is said so', () => {
    writeFileSync(folderMapPath(root), 'version: 1\nfolders:\n  - path: /a\n    plur: of\n')
    expect(folderMapProblem(root)!.fixable).toBe(false)
  })
})

describe('the hooks/plugin resolver agrees with the MCP gate (fail safe)', () => {
  // Every case folderMapProblem refuses is malformed-map for the resolver too:
  // ask, no memory — never `on` from the project marker beside it.
  for (const [name, text] of [
    ['an empty file', ''],
    ['a comments-only file', '# nothing yet\n'],
    ['an unknown top-level key (`folder:`)', 'version: 1\nfolder:\n  - path: REPO\n    plur: off\n'],
    ['a stray top-level key', 'version: 1\nfolders: []\nzebra: 1\n'],
  ] as const) {
    it(`${name}: ask with reason malformed-map, line and problem`, () => {
      writeFileSync(folderMapPath(root), text.replace('REPO', repo))
      expect(folderMapProblem(root)).not.toBeNull()
      const p = resolveFolderPolicy(repo, { root })
      expect(p.mode).toBe('ask')
      expect(p.reason).toBe('malformed-map')
      expect(p.mapError?.file).toBe(folderMapPath(root))
      expect(p.mapError?.problem).toBeTruthy()
    })
  }

  it('a write refuses an empty map too (nothing written while broken), and names the repair', () => {
    writeFileSync(folderMapPath(root), '# nothing yet\n')
    expect(() => setFolderEntry(root, repo, { mode: 'on' }, { configuredScopes: [] })).toThrow(FolderMapError)
    expect(() => setFolderEntry(root, repo, { mode: 'on' }, { configuredScopes: [] })).toThrow(/plur folders repair/)
    expect(readFileSync(folderMapPath(root), 'utf8')).toBe('# nothing yet\n')
  })
})

describe('the hooks/plugin notice offers the repair in agent form', () => {
  it('fixable: pinpoints, and gives the exact command to run after the user agrees', () => {
    writeFileSync(folderMapPath(root), `version: 1\nfolders:\n  - path: ${repo}/${SECRET}\n     plur: off\n`)
    const policy = resolveFolderPolicy(repo, { root })
    const text = folderAskOnce({ dir: repo, policy, sessionId: 'repair-s1', root, claim: () => true })!
    expect(text).toContain('line 4: indentation')
    expect(text).toContain(`plur --path ${root} folders repair --yes`)
    expect(text).toMatch(/agree/)
    // Round 2: what the repair will change, to show the user before --yes.
    expect(text).toContain('line 4: indentation')
    expect(text).toMatch(/show/i)
    expect(text).not.toContain('--nonce')
    expect(text).not.toContain(SECRET)
  })

  it('unfixable: pinpoints, says it must be fixed by hand, and offers no command to run', () => {
    writeFileSync(folderMapPath(root), 'version: 1\nfolders:\n  - path: /a\n    plur: of\n')
    const policy = resolveFolderPolicy(repo, { root })
    const text = folderAskOnce({ dir: repo, policy, sessionId: 'repair-s2', root, claim: () => true })!
    expect(text).toContain('line 4')
    expect(text).toMatch(/by hand/)
    expect(text).not.toContain('repair --yes')
  })

  it('folderRepairCommand: plain for the default store, --path for another, null for an unsafe path', () => {
    expect(folderRepairCommand(join(homedir(), '.plur'))).toBe('plur folders repair --yes')
    expect(folderRepairCommand('/tmp/store')).toBe('plur --path /tmp/store folders repair --yes')
    expect(folderRepairCommand('/tmp/a\nb')).toBeNull()
  })
})
