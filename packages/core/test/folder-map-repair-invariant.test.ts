/**
 * Round 3 of #1526 (re-review of #1530 at c94f7c25): the repair is narrowed so
 * that "a repair never switches memory on" holds by construction, and a fuzz
 * checks the promise itself:
 *
 *   for every repaired file, the folders that resolve to `on` afterwards are
 *   a subset of the entries whose ORIGINAL text has a literal, active
 *   `plur: on` line (any case) on that entry.
 *
 * R1  any tag, anchor, alias or block scalar anywhere → no repair at all.
 * R2  entry keys are renamed only to `plur` / `path`, and reported only as a
 *     near-miss of those when the entry lacks that key; other custom keys
 *     (`paths`, `score`, `trust`, `lateral`, …) pass as before.
 * R3  a mode becomes `on` only from a literal `on` in another case; a typo
 *     may become `off` or `ask`, never `on`; words and hidden characters are
 *     never guessed.
 * R4  the summary holds no word from inside a value.
 * R5  a map that is not UTF-8 is reported not fixable everywhere.
 * R6  the line cap counts every line (comments, lone CR); a lone-CR file is
 *     refused and never reported repaired while broken.
 *
 * The re-review's probe, resolver and fuzz scripts are folded in here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, realpathSync, mkdirSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import {
  checkFolderMapText, planFolderMapRepair, repairFolderMap, folderMapPath, folderMapProblem, resolveFolderPolicy,
} from '../src/index.js'
import { logger } from '../src/logger.js'

let root: string
let w: string
beforeEach(() => {
  vi.spyOn(logger, 'warning').mockImplementation(() => {})
  root = realpathSync(mkdtempSync(join(tmpdir(), 'repair-inv-')))
  w = join(root, 'w')
  mkdirSync(join(w, 'a'), { recursive: true })
  mkdirSync(join(w, 'b'), { recursive: true })
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

const L = (...a: string[]) => a.join('\n') + '\n'
const notFixable = (t: string) => {
  const p = planFolderMapRepair(t)
  expect(p.status, `${JSON.stringify(t)} → ${p.status === 'fixable' ? p.after : p.status}`).not.toBe('fixable')
}

describe('R1: a tag, anchor, alias or block scalar anywhere means no repair', () => {
  for (const [name, t] of Object.entries({
    tagBlock: L('\tfolders:', '  - path: /a', '    note: !!str |', '      - path: /b', '        plur: on'),
    anchorBlock: L('\tfolders:', '  - path: /a', '    note: &x |', '      - path: /b', '        plur: on'),
    anchorNested: L('\tfolders:', '  - path: /a', '    note: &x', '      - path: /b', '        plur: on'),
    tagNestedSeq: L('\tfolders:', '  - path: /a', '    note: !!seq', '      - path: /b', '        plur: on'),
    tagNestedMap: L('\tfolders:', '  - path: /a', '    note: !!map', '      plur: on'),
    anchorNestedMapPlur: L('\tfolders:', '  - path: /a', '    plur: off', '    extra: &q', '      plur: on'),
    anchoredFlowEntry: L('\tfolders:', '  - path: /a', '    note: &a', '      - {path: /b, plur: on}'),
    customTag: L('version: 1', 'folder:', '  - path: /a', '    note: !custom x'),
    aliasAnywhere: L('version: 1', 'folder:', '  - path: &p /a', '  - path: *p'),
    plainBlockElsewhere: L('version: 1', 'folder:', '  - path: /a', '    note: >-', '      text'),
    // re-audit fuzz: an empty value whose list sits at the key's own indent, or behind a tab
    emptyValueSameIndentList: L('version: 1', 'folders:', '  - path: /e0', '    note:', '    - path: /hidden0', '        plur: on'),
    emptyValueTabList: L('version: 1', 'folders:', '  - path: /e0', '    plur: off', '    note:', '\t- path: /hidden0', '        plur: on'),
  })) it(name, () => notFixable(t))

  it('R4: text inside a value never reaches the summary (it is refused instead)', () => {
    const p = planFolderMapRepair('folders:\n  - path: /a\n    note: !!str |\n      score: local\n\tversion: 1\n')
    expect(p.status).not.toBe('fixable')
    if (p.status === 'unfixable') for (const i of p.issues) expect(i.message).not.toContain('score')
  })

  it('a `#`, `&`, `*` or `!` inside a quoted path or a comment does not block a repair', () => {
    const p = planFolderMapRepair(L('# notes: see *this* & that!', 'version: 1', 'folder:', "  - path: '/x/#a &b *c !d'", '    plur: off'))
    expect(p.status).toBe('fixable')
  })
})

describe('R2: entry keys are renamed only to plur / path, and only near-misses of those are reported', () => {
  for (const [key, val] of [['untrusted', 'true'], ['trust', 'true'], ['trustee', 'true'], ['score', 'high'], ['escape', 'none'],
    ['scene', 'x'], ['plus', 'on'], ['blur', 'on'], ['scopes', 'x'], ['paths', 'x'], ['pat', 'x'], ['patch', 'x'],
    ['lateral', 'x'], ['literally', 'x'], ['math', 'x'], ['plural', 'x'], ['trsuted', 'true'], ['sope', 'x']]) {
    it(`\`${key}:\` is a custom key: not a problem, never renamed`, () => {
      const t = L('version: 1', 'folders:', '  - path: /a', `    ${key}: ${val}`)
      expect(checkFolderMapText(t).ok, key).toBe(true)
      expect(planFolderMapRepair(L('version: 1', 'folder:', '  - path: /a', `    ${key}: ${val}`)).status).not.toBe('unfixable')
      const p = planFolderMapRepair(L('version: 1', 'folder:', '  - path: /a', `    ${key}: ${val}`))
      if (p.status === 'fixable') expect(p.after).toContain(`    ${key}: ${val}`)
    })
  }

  it('`plru: off` and `pth: /a` are reported and repaired', () => {
    for (const [t, want] of [
      [L('version: 1', 'folders:', '  - path: /a', '    plru: off'), L('version: 1', 'folders:', '  - path: /a', '    plur: off')],
      [L('version: 1', 'folders:', '  - pth: /a', '    plur: off'), L('version: 1', 'folders:', '  - path: /a', '    plur: off')],
    ]) {
      expect(checkFolderMapText(t).ok).toBe(false)
      const p = planFolderMapRepair(t)
      expect(p.status).toBe('fixable')
      if (p.status === 'fixable') expect(p.after).toBe(want)
    }
  })

  it('a near-miss of plur is not a problem when the entry already has plur', () => {
    expect(checkFolderMapText(L('version: 1', 'folders:', '  - path: /a', '    plur: off', '    plru: x')).ok).toBe(true)
  })

  it('`plru: on` is reported but never renamed into memory on', () => {
    expect(checkFolderMapText(L('version: 1', 'folders:', '  - path: /a', '    plru: on')).ok).toBe(false)
    notFixable(L('version: 1', 'folders:', '  - path: /a', '    plru: on'))
  })
})

describe('R3: a mode becomes on only from a literal on', () => {
  for (const v of ['ok', 'in', 'one', 'own', 'nn', 'an', 'onn', '0n', 'oN​', '﻿on', 'of', 'onf', 'non', 'no', 'yes']) {
    it(JSON.stringify(v), () => notFixable(L('version: 1', 'folders:', '  - path: /a', `    plur: ${v}`)))
  }
  for (const [v, want] of [['ON', 'on'], ['On', 'on'], ["'On'", "'on'"], ['OFF', 'off'], ['oof', 'off'], ['offf', 'off'], ['aks', 'ask'], ['Ask', 'ask']]) {
    it(`${v} → ${want}`, () => {
      const p = planFolderMapRepair(L('version: 1', 'folders:', '  - path: /a', `    plur: ${v}`))
      expect(p.status).toBe('fixable')
      if (p.status === 'fixable') expect(p.after).toBe(L('version: 1', 'folders:', '  - path: /a', `    plur: ${want}`))
    })
  }
})

describe('the invariant also refuses an implicit on', () => {
  it('an entry with scope (or trusted) and no plur would resolve on: a slip in it is not repaired', () => {
    notFixable(L('version: 1', 'folders:', '  - path: /a', '\tscope: group:x/y'))
    notFixable(L('version: 1', 'folder:', '  - path: /a', '    trusted: true'))
  })
  it('the same entry with a literal plur: on is repaired', () => {
    expect(planFolderMapRepair(L('version: 1', 'folders:', '  - path: /a', '\tscope: group:x/y', '    plur: on')).status).toBe('fixable')
  })
})

describe('R5: a map that is not UTF-8 is not fixable on any surface', () => {
  it('folderMapProblem, the resolver and repair agree', () => {
    writeFileSync(folderMapPath(root), Buffer.concat([Buffer.from('# caf'), Buffer.from([0xe9]), Buffer.from('\nversion: 1\nfolders:\n  - path: /a\n    plur: On\n')]))
    expect(folderMapProblem(root)!.fixable).toBe(false)
    expect(folderMapProblem(root)!.repair_summary).toBeUndefined()
    expect(resolveFolderPolicy(join(w, 'a'), { root }).mapError?.fixable).toBe(false)
    expect(repairFolderMap(root, { apply: true }).status).toBe('unfixable')
  })
})

describe('R6: the cap counts every line; a lone CR is refused', () => {
  it('a comments-only file over the cap is not planned', () => {
    const t = Array.from({ length: 2500 }, (_, i) => `# ${i}`).join('\n') + '\n'
    expect(planFolderMapRepair(t).status).toBe('unfixable')
  })
  it('lone-CR lines count toward the cap', () => {
    const t = 'folder: []\n' + '#\r'.repeat(2001) + '\n'
    expect(planFolderMapRepair(t).status).not.toBe('fixable')
  })
  it('a valid lone-CR map is fine (as js-yaml reads it); a broken one is refused, never "repaired"', () => {
    expect(checkFolderMapText('# hello\rfolders:\r  - path: /a\r    plur: off\r').ok).toBe(true)
    const broken = '# hello\rfolder:\r  - path: /a\r    plur: off\r'
    expect(checkFolderMapText(broken).ok).toBe(false)
    notFixable(broken)
    writeFileSync(folderMapPath(root), broken)
    expect(repairFolderMap(root, { apply: true }).status).not.toBe('repaired')
    expect(readFileSync(folderMapPath(root), 'utf8')).toBe(broken)
  })
})

// ---------------------------------------------------------------------------
// The invariant, fuzzed (re-review harness + round-2 harness, several seeds).
// ---------------------------------------------------------------------------

/** Paths of entries resolving to on in a parsed map (core's rule: plur on, or no plur with scope / trusted). */
function onPaths(m: unknown): string[] {
  const f = (m as { folders?: unknown })?.folders
  if (!Array.isArray(f)) return []
  return f.filter(e => e && typeof e === 'object' && (
    (e as any).plur === 'on' || ((e as any).plur === undefined && ((e as any).scope !== undefined || (e as any).trusted === true))
  )).map(e => String((e as any).path))
}

/**
 * Per entry in the ORIGINAL text: its literal path (from a `path:` line read
 * on its own) and whether a line of that entry is literally an active
 * `plur: on` in any case. An entry starts at a `- ` line and ends at the next
 * one or at a line at column 0.
 */
function literalOnPaths(text: string): Set<string> {
  // Every scalar written on a line of an entry that has a literal active
  // `plur: on`: the repair keeps values as written, so the entry's path after
  // the repair is one of them (its key may have been a misspelled `path`).
  const out = new Set<string>()
  let values: string[] = []
  let on = false
  let inEntry = false
  const flush = () => { if (inEntry && on) for (const v of values) out.add(v); values = []; on = false; inEntry = false }
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
    const t = raw.replace(/^[ \t]+/, '')
    if (raw !== '' && !/^[ \t]/.test(raw) && !t.startsWith('-')) { flush(); continue }
    let body = t
    if (t.startsWith('-')) { flush(); inEntry = true; body = t.replace(/^-[ \t]*/, '') }
    if (/^plur[ \t]*:[ \t]*(['"]?)on\1[ \t]*(#.*)?$/i.test(body)) on = true
    try {
      const v = yaml.load(body)
      if (v && typeof v === 'object' && !Array.isArray(v)) for (const x of Object.values(v)) if (typeof x === 'string') values.push(x)
    } catch { /* not a single key: value line */ }
  }
  flush()
  return out
}

describe('invariant fuzz: repaired on ⊆ literal plur: on in the original', () => {
  function makeRng(seed: number) {
    let s = seed
    const rnd = () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 }
    return { rnd, pick: <T>(a: T[]): T => a[Math.floor(rnd() * a.length)], int: (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1)) }
  }
  const PREFIX = ['', '!!str ', '&a ', '&b !!str ', '!custom ']
  const CUSTOM = ['untrusted: true', 'trust: true', 'score: high', 'escape: none', 'note: x', 'owner: me', 'scopes: x', 'paths: x', 'plus: on', 'blur: on', 'lateral: x', 'plru: on', 'pth: x']

  function gen(r: ReturnType<typeof makeRng>): string {
    const { rnd, pick, int } = r
    const eol = rnd() < 0.15 ? '\r\n' : '\n'
    const lines: string[] = []
    if (rnd() < 0.2) lines.push('# PLUR folder map', '#   - path: ~/x', '#     plur: on', '')
    lines.push('version: 1', 'folders:')
    const n = int(1, 4)
    for (let i = 0; i < n; i++) {
      lines.push(`  - path: /w/e${i}`)
      const roll = rnd()
      if (roll < 0.5) lines.push(`    plur: ${pick(['on', 'off', 'ask', 'On', 'OFF', 'oof', 'ok', 'in', 'onn', '#on'])}`)
      if (rnd() < 0.3) lines.push(`    ${pick(['scope: group:a/b', 'trusted: true', 'trusted: false'])}`)
      const extra = pick(['block', 'nested', 'nestedMap', 'sameIndent', 'custom', 'custom', 'none', 'none'])
      if (extra === 'block') lines.push(`    note: ${pick(PREFIX)}${pick(['|', '>', '|-', '>+'])}`, `      - path: /w/hidden${i}`, '        plur: on')
      else if (extra === 'nested') lines.push(`    note: ${pick(['', '&a', '!!seq'])}`.trimEnd(), `      - path: /w/hidden${i}`, '        plur: on')
      else if (extra === 'nestedMap') lines.push(`    meta: ${pick(['', '&a', '!!map', '&n !!map'])}`.trimEnd(), '      plur: on', '      trusted: true')
      else if (extra === 'sameIndent') lines.push('    note:', `    - path: /w/hidden${i}`, '      plur: on')
      else if (extra === 'custom') lines.push(`    ${pick(CUSTOM)}`)
    }
    return (rnd() < 0.05 ? '﻿' : '') + lines.join(eol) + eol
  }
  function mutate(text: string, r: ReturnType<typeof makeRng>): string | null {
    const { pick, rnd } = r
    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    const ls = text.split(/\r?\n/)
    const idx = ls.map((_, i) => i).filter(i => ls[i].trim() && !ls[i].trim().startsWith('#'))
    if (!idx.length) return null
    const i = pick(idx)
    const lead = /^ */.exec(ls[i])![0]
    switch (pick(['tab', 'indent', 'indent', 'topkey', 'mode', 'entrykey', 'cr', 'random'])) {
      case 'tab': ls[i] = '\t' + ls[i].trimStart(); break
      case 'indent': ls[i] = ' '.repeat(Math.max(0, lead.length + pick([-2, -1, 1, 2]))) + ls[i].trimStart(); break
      case 'topkey': ls[i] = ls[i].replace(/^(﻿?)folders:/, '$1folder:').replace(/^(﻿?)version:/, '$1verison:'); break
      case 'mode': ls[i] = ls[i].replace(/plur: \S+/, `plur: ${pick(['On', 'ON', 'onn', 'ok', 'in', 'oof', 'Off', 'aks', '﻿on', 'of'])}`); break
      case 'entrykey': ls[i] = ls[i].replace(/\b(plur|path):/, (_m, k: string) => `${pick(k === 'plur' ? ['plru', 'pulr', 'Plur', 'plus', 'blur'] : ['pth', 'paht', 'paths', 'pat'])}:`); break
      case 'cr': ls[i] = ls[i] + '\r'; break
      default: { const pos = Math.floor(rnd() * (ls[i].length + 1)); ls[i] = ls[i].slice(0, pos) + pick([' ', '-', ':', '#', '&', '!', '*', '|', '"']) + ls[i].slice(pos) }
    }
    const m = ls.join(eol)
    return m === text ? null : m
  }

  for (const seed of [1, 2, 3, 4, 5]) {
    it(`seed ${seed}`, () => {
      const r = makeRng(seed)
      const bad: string[] = []
      let fixable = 0
      let refused = 0
      for (let k = 0; k < 1200; k++) {
        const base = gen(r)
        for (let j = 0; j < 3; j++) {
          let m = mutate(base, r)
          if (m && r.rnd() < 0.3) m = mutate(m, r) ?? m
          if (!m) continue
          const p = planFolderMapRepair(m)
          if (p.status === 'unfixable') { refused++; continue }
          if (p.status !== 'fixable') continue
          fixable++
          let after: unknown
          try { after = yaml.load(p.after.replace(/^﻿/, '')) } catch { bad.push(`repaired file does not parse:\n${p.after}`); continue }
          const allowed = literalOnPaths(m)
          for (const path of onPaths(after)) if (!allowed.has(path)) bad.push(`on without a literal plur: on (${path}):\n${JSON.stringify(m)}\n→\n${JSON.stringify(p.after)}`)
          if (!checkFolderMapText(p.after).ok) bad.push(`repaired file still broken:\n${JSON.stringify(p.after)}`)
        }
      }
      ;(globalThis as any).__invariant = [...((globalThis as any).__invariant ?? []), { seed, fixable, refused, bad: bad.length }]
      expect(bad.slice(0, 3)).toEqual([])
      expect(fixable).toBeGreaterThan(50)
    }, 120_000)
  }

  it('reports the numbers', () => {
    // eslint-disable-next-line no-console
    console.log('INVARIANT-FUZZ', JSON.stringify((globalThis as any).__invariant))
  })
})

describe('end to end: repair --yes then resolve (re-review e2e)', () => {
  for (const [name, body] of Object.entries({
    anchorNested: 'version: 1\n\tfolders:\n  - path: @W/a\n    note: &x\n      - path: @W/b\n        plur: on\n',
    tagBlock: 'version: 1\n\tfolders:\n  - path: @W/a\n    note: !!str |\n      - path: @W/b\n        plur: on\n',
    tagNestedMap: 'version: 1\n\tfolders:\n  - path: @W/a\n    note: !!map\n      plur: on\n',
    untrusted: 'version: 1\nfolders:\n  - path: @W/a\n    untrusted: true\n',
    trust: 'version: 1\nfolder:\n  - path: @W/a\n    trust: true\n',
    score: 'version: 1\nfolder:\n  - path: @W/a\n    score: high\n',
    escape: 'version: 1\nfolder:\n  - path: @W/a\n    escape: none\n',
    okMode: 'version: 1\nfolders:\n  - path: @W/a\n    plur: ok\n',
  })) {
    it(`${name}: neither folder is on after the repair`, () => {
      writeFileSync(folderMapPath(root), body.replace(/@W/g, w))
      repairFolderMap(root, { apply: true })
      for (const d of ['a', 'b']) expect(resolveFolderPolicy(join(w, d), { root, home: root }).mode, `${name} ${d}`).not.toBe('on')
      expect(readdirSync(root).length).toBeGreaterThan(0)
    })
  }
})
