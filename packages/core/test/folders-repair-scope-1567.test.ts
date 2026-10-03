/**
 * `plur folders repair` and team-scoped entries (#1567, finding F5 of the
 * second 0.21.1 pre-release check).
 *
 * The folder question's "Yes, with the team scope" (and `plur folders set
 * --scope`) wrote an entry with `scope:` and no `plur:` line. Such an entry is
 * on only implicitly, so the repair's hard rule from #1530 (a repair never
 * switches memory on: repaired `on` ⊆ entries with a literal `plur: on`)
 * refused every file holding one, for a slip anywhere in it, and blamed the
 * team entry's line, which had no problem.
 *
 *  - an entry with `scope:` / `trusted:` AND a literal `plur: on|off|ask` line
 *    is repaired (guard: already true on main);
 *  - PLUR writes `plur: on` next to a scope it records, so a map PLUR wrote
 *    stays repairable, and resolves exactly as before;
 *  - an entry on only through `scope:` / `trusted:` (as 0.21.0 and earlier
 *    wrote it) is repaired when the repair leaves its own lines untouched: the
 *    repair writes `plur: on` beside them, so it means what it meant before
 *    the map broke; a slip on its own lines is refused, naming that line;
 *  - the stderr warning says "fix line N by hand" when repair cannot help.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import {
  planFolderMapRepair, repairFolderMap, folderMapPath, resolveFolderPolicy, setFolderEntry, loadFolderMap, folderMapProblem,
} from '../src/index.js'
import { logger } from '../src/logger.js'

const TEAM = 'group:acme/eng'
let root: string
let work: string
let home: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'repair-scope-store-')))
  work = realpathSync(mkdtempSync(join(tmpdir(), 'repair-scope-work-')))
  home = realpathSync(mkdtempSync(join(tmpdir(), 'repair-scope-home-')))
})
afterEach(() => {
  vi.restoreAllMocks()
  for (const d of [root, work, home]) rmSync(d, { recursive: true, force: true })
})

function mk(name: string): string {
  const d = join(work, name)
  mkdirSync(d, { recursive: true })
  return realpathSync(d)
}
const L = (...a: string[]) => a.join('\n') + '\n'

/** Two slips in OTHER entries: a tab and a 5-space indent (lines 6 and 8 after a two-line team entry). */
function withSlips(team: string[], b: string, c: string): string {
  return L(
    'version: 1',
    'folders:',
    ...team,                    // lines 3..
    `  - path: "${b}"`,
    '\tplur: off',
    `  - path: "${c}"`,
    '     plur: ask',
  )
}

describe('a team entry with a literal plur: line does not block a repair (guard: true on main)', () => {
  for (const mode of ['on', 'off', 'ask'] as const) {
    it(`scope + plur: ${mode}`, () => {
      vi.spyOn(logger, 'warning').mockImplementation(() => {})
      const [t, b, c] = [mk('team'), mk('b'), mk('c')]
      const text = withSlips([`  - path: "${t}"`, `    plur: ${mode}`, `    scope: ${TEAM}`], b, c)
      writeFileSync(folderMapPath(root), text)
      const r = repairFolderMap(root, { apply: true })
      expect(r.status, JSON.stringify(r)).toBe('repaired')
      const p = resolveFolderPolicy(t, { root, home })
      expect(p.mode).toBe(mode)
      if (mode === 'on') expect(p.scope).toBe(TEAM)
      expect(resolveFolderPolicy(b, { root, home }).mode).toBe('off')
      expect(resolveFolderPolicy(c, { root, home }).mode).toBe('ask')
    })
  }

  it('trusted: true + plur: on', () => {
    const [t, b, c] = [mk('team'), mk('b'), mk('c')]
    expect(planFolderMapRepair(withSlips([`  - path: "${t}"`, '    plur: on', '    trusted: true'], b, c)).status).toBe('fixable')
  })
})

describe('PLUR writes plur: on next to a scope it records', () => {
  it('folders set --scope (the "Yes, with the team scope" answer) writes plur: on and the scope', () => {
    const t = mk('team')
    const written = setFolderEntry(root, t, { scope: TEAM }, { configuredScopes: [TEAM], home })
    expect(written).toEqual({ path: t, plur: 'on', scope: TEAM })
    expect(loadFolderMap(root).folders).toEqual([{ path: t, plur: 'on', scope: TEAM }])
    expect(readFileSync(folderMapPath(root), 'utf8')).toMatch(/plur: '?on'?\n/)
    const p = resolveFolderPolicy(t, { root, home })
    expect(p.mode).toBe('on')
    expect(p.scope).toBe(TEAM)
  })

  it('--scope over an existing off entry still means on, written as plur: on', () => {
    const t = mk('team')
    setFolderEntry(root, t, { mode: 'off' }, { configuredScopes: [TEAM], home })
    expect(setFolderEntry(root, t, { scope: TEAM }, { configuredScopes: [TEAM], home })).toEqual({ path: t, plur: 'on', scope: TEAM })
    expect(resolveFolderPolicy(t, { root, home }).mode).toBe('on')
  })

  it('an explicit mode with --scope is kept as given', () => {
    const t = mk('team')
    expect(setFolderEntry(root, t, { scope: TEAM, mode: 'ask' }, { configuredScopes: [TEAM], home }))
      .toEqual({ path: t, plur: 'ask', scope: TEAM })
  })

  it('--trusted alone stays as before (no plur line), so plur untrust still returns the folder to ask', () => {
    const t = mk('team')
    expect(setFolderEntry(root, t, { trusted: true }, { configuredScopes: [], home })).toEqual({ path: t, trusted: true })
  })

  it('the repro: a map PLUR wrote with a team scope, then a slip in another entry, is repaired', () => {
    vi.spyOn(logger, 'warning').mockImplementation(() => {})
    const [t, b, c] = [mk('team'), mk('b'), mk('c')]
    setFolderEntry(root, t, { scope: TEAM }, { configuredScopes: [TEAM], home })
    setFolderEntry(root, b, { mode: 'off' }, { configuredScopes: [TEAM], home })
    setFolderEntry(root, c, { mode: 'ask' }, { configuredScopes: [TEAM], home })
    const file = folderMapPath(root)
    const good = readFileSync(file, 'utf8')
    // A tab slip on b's plur line and a 5-space indent on c's.
    const lines = good.split('\n')
    const bAt = lines.findIndex(l => l.includes(`path: ${b}`) || l.includes(`path: "${b}"`) || l.includes(`path: '${b}'`))
    const cAt = lines.findIndex(l => l.includes(`path: ${c}`) || l.includes(`path: "${c}"`) || l.includes(`path: '${c}'`))
    expect(bAt, good).toBeGreaterThan(-1)
    expect(cAt, good).toBeGreaterThan(-1)
    lines[bAt + 1] = '\t' + lines[bAt + 1].trimStart()
    lines[cAt + 1] = '     ' + lines[cAt + 1].trimStart()
    writeFileSync(file, lines.join('\n'))
    expect(folderMapProblem(root)).not.toBeNull()
    expect(resolveFolderPolicy(t, { root, home }).mode).toBe('ask')   // paused while broken

    const dry = repairFolderMap(root, { apply: false })
    expect(dry.status, JSON.stringify(dry)).toBe('fixable')
    const r = repairFolderMap(root, { apply: true })
    expect(r.status).toBe('repaired')
    const p = resolveFolderPolicy(t, { root, home })
    expect(p.mode).toBe('on')
    expect(p.scope).toBe(TEAM)
    expect(resolveFolderPolicy(b, { root, home }).mode).toBe('off')
    expect(resolveFolderPolicy(c, { root, home }).mode).toBe('ask')
  })
})

describe('a legacy scope-only / trusted-only entry (0.21.0 and earlier) is repaired when its own lines are untouched', () => {
  for (const [name, own] of Object.entries({
    scope: [`    scope: ${TEAM}`],
    trusted: ['    trusted: true'],
    both: [`    scope: ${TEAM}`, '    trusted: true'],
  })) {
    it(`${name}-only entry + a tab slip elsewhere → repaired, plur: on added, the same folders on as before the slip`, () => {
      vi.spyOn(logger, 'warning').mockImplementation(() => {})
      const [t, b, c] = [mk('team'), mk('b'), mk('c')]
      const good = L('version: 1', 'folders:', `  - path: "${t}"`, ...own, `  - path: "${b}"`, '    plur: off', `  - path: "${c}"`, '    plur: ask')
      writeFileSync(folderMapPath(root), good)
      const before = [t, b, c].map(d => resolveFolderPolicy(d, { root, home }))
      expect(before[0].mode).toBe('on')
      // One tab slip in another entry: the map breaks, every folder pauses.
      writeFileSync(folderMapPath(root), good.replace('    plur: off', '\tplur: off'))
      expect(folderMapProblem(root)).not.toBeNull()

      const dry = repairFolderMap(root, { apply: false })
      expect(dry.status, JSON.stringify(dry)).toBe('fixable')
      const r = repairFolderMap(root, { apply: true })
      expect(r.status).toBe('repaired')
      const text = readFileSync(folderMapPath(root), 'utf8')
      // The entry's own lines are kept as written, with `plur: on` added beside them.
      for (const l of [`  - path: "${t}"`, ...own]) expect(text).toContain(l + '\n')
      expect(text).toContain(`  - path: "${t}"\n    plur: on\n`)
      expect(text.match(/plur: on/g)).toHaveLength(1)
      expect(loadFolderMap(root).folders).toHaveLength(3)
      const after = [t, b, c].map(d => resolveFolderPolicy(d, { root, home }))
      expect(after.map(p => [p.mode, p.scope])).toEqual(before.map(p => [p.mode, p.scope]))
    })
  }

  it('the plan names the added line in its summary, without any value', () => {
    const p = planFolderMapRepair(withSlips(['  - path: /w/team', `    scope: ${TEAM}`], '/w/b', '/w/c'))
    expect(p.status).toBe('fixable')
    if (p.status !== 'fixable') return
    expect(p.summary).toMatch(/line 3: adds `plur: on`/)
    expect(p.summary).not.toContain(TEAM)
    expect(p.summary).not.toContain('/w/team')
  })

  for (const [name, team, bad] of [
    ['a tab on its scope line', ['  - path: /w/team', `\tscope: ${TEAM}`], 4],
    ['an indentation slip on its scope line', ['  - path: /w/team', `     scope: ${TEAM}`], 4],
    ['an indentation slip on its trusted line', ['  - path: /w/team', '   trusted: true'], 4],
    ['a tab on its path line', ['\t- path: /w/team', `    scope: ${TEAM}`], 3],
  ] as const) {
    it(`a slip on the entry's own lines (${name}) is still refused, naming that line`, () => {
      const p = planFolderMapRepair(withSlips([...team], '/w/b', '/w/c'))
      expect(p.status).toBe('unfixable')
      if (p.status !== 'unfixable') return
      const msgs = p.issues.map(i => i.message).join('\n')
      const reason = p.issues.find(i => /through `(scope|trusted):`/.test(i.message))
      expect(reason, msgs).toBeDefined()
      expect(reason!.message).toMatch(new RegExp(`fix line ${bad} by hand`))
      expect(msgs).not.toMatch(/add `?plur: on/i)
      expect(msgs).not.toContain(TEAM)
    })
  }
})

describe('the stderr warning does not suggest repair when repair cannot help', () => {
  const warningFor = (root: string, d: string) => {
    const warn = vi.spyOn(logger, 'warning').mockImplementation(() => {})
    resolveFolderPolicy(d, { root, home })
    return warn.mock.calls.map(c => String(c[0])).find(m => m.includes(folderMapPath(root)))
  }

  it('unrepairable: "fix line N by hand", and repair only as the re-check', () => {
    const d = mk('a')
    writeFileSync(folderMapPath(root), withSlips(['  - path: /w/team', `\tscope: ${TEAM}`], '/w/b', '/w/c'))
    expect(folderMapProblem(root)?.fixable).toBe(false)
    const msg = warningFor(root, d)
    expect(msg).toBeDefined()
    expect(msg).toMatch(/paused/)
    expect(msg).toMatch(/fix line 4 by hand/)
    expect(msg).not.toMatch(/Run `[^`]*folders repair` to see the problem and repair it/)
    expect(msg).not.toMatch(/repair it \(it asks first\)/)
  })

  it('repairable: still names plur folders repair as the fix', () => {
    const d = mk('a')
    writeFileSync(folderMapPath(root), L('version: 1', 'folders:', '  - path: /w/x', '\tplur: off'))
    expect(folderMapProblem(root)?.fixable).toBe(true)
    const msg = warningFor(root, d)
    expect(msg).toMatch(/folders repair` to see the problem and repair it/)
  })

  it('a map that cannot be read at all: fix it by hand', () => {
    const d = mk('a')
    mkdirSync(folderMapPath(root))
    const msg = warningFor(root, d)
    expect(msg).toMatch(/paused/)
    expect(msg).toMatch(/by hand/)
    expect(msg).not.toMatch(/to see the problem and repair it/)
  })
})

describe('the invariant: repaired on ⊆ literal plur: on, or an untouched scope-only / trusted-only entry', () => {
  it('a scope-only entry next to a literal-on team entry: both on, the legacy one with plur: on written', () => {
    const p = planFolderMapRepair(L(
      'version: 1', 'folders:',
      '  - path: /w/a', '    plur: on', `    scope: ${TEAM}`,
      '  - path: /w/b', `    scope: ${TEAM}`,
      '  - path: /w/c', '\tplur: off',
    ))
    expect(p.status).toBe('fixable')
    if (p.status !== 'fixable') return
    const after = yaml.load(p.after) as { folders: Array<Record<string, unknown>> }
    expect(after.folders).toEqual([
      { path: '/w/a', plur: 'on', scope: TEAM },
      { path: '/w/b', plur: 'on', scope: TEAM },
      { path: '/w/c', plur: 'off' },
    ])
  })
  it('after a repair, on ⊆ literal plur: on (no scope-only entry)', () => {
    const t = L(
      'version: 1', 'folders:',
      '  - path: /w/a', '    plur: on', `    scope: ${TEAM}`,
      '  - path: /w/b', '    plur: off', `    scope: ${TEAM}`,
      '  - path: /w/c', '    plur: ask', '    trusted: true',
      '  - path: /w/d', '\tplur: off',
    )
    const p = planFolderMapRepair(t)
    expect(p.status).toBe('fixable')
    if (p.status !== 'fixable') return
    const after = yaml.load(p.after) as { folders: Array<Record<string, unknown>> }
    const on = after.folders.filter(e => e.plur === 'on' || (e.plur === undefined && (e.scope !== undefined || e.trusted === true))).map(e => e.path)
    expect(on).toEqual(['/w/a'])
  })
  it('trusted: false alone is not on, and gets no plur line', () => {
    const p = planFolderMapRepair(L('version: 1', 'folder:', '  - path: /w/a', '    trusted: false'))
    expect(p.status).toBe('fixable')
    if (p.status !== 'fixable') return
    expect(p.after).not.toMatch(/plur:/)
  })
})
