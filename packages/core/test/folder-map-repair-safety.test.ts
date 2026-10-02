/**
 * Round 2 of #1526 (review of #1530): a repair may never switch memory on.
 *
 * The hard rule: after a repair, every entry, every key and every value is
 * the one literally written on that entry's own line in the original. The
 * only value a repair may change is an active (uncommented) `plur:` mode, and
 * only to the single mode its case or one letter points at. A commented-out
 * mode, a block scalar, a value nested under another key, or anything the
 * line-based repair might read differently from the YAML parser is refused.
 *
 * Also here: alias / tag names never reach a message (F3), the backup is the
 * original bytes (F6), the repair says in one line what it will change (the
 * agent shows it before `--yes`), a misspelled entry key (`plru:`) is a
 * problem like a misspelled top-level key, and a large broken file is cheap
 * to report (F5). The audit's fuzz harness runs as a test, with block
 * scalars and commented-out modes added to what it generates.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, realpathSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { isDeepStrictEqual } from 'node:util'
import {
  checkFolderMapText, planFolderMapRepair, repairFolderMap, folderMapPath, folderMapProblem, resolveFolderPolicy,
} from '../src/index.js'
import { logger } from '../src/logger.js'

const SECRET = 'zqSECRETzq'

let root: string
beforeEach(() => {
  vi.spyOn(logger, 'warning').mockImplementation(() => {})
  root = realpathSync(mkdtempSync(join(tmpdir(), 'repair-safety-')))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

const refused = (t: string) => {
  const p = planFolderMapRepair(t)
  expect(p.status, `${JSON.stringify(t)} → ${JSON.stringify(p)}`).not.toBe('fixable')
}

describe('F1: a commented-out mode is never turned into a mode', () => {
  for (const t of [
    'version: 1\nfolders:\n  - path: /a\n    plur: #on\n',
    'version: 1\nfolders:\n  - path: /a\n    plur: #off\n',
    'version: 1\nfolders:\n  - path: /a\n    plur: #ask\n',
    'version: 1\nfolders:\n  - plur: #ask\n    path: /a\n',
    'version: 1\nfolder:\n  - path: /a\n    plur: #on\n',
  ]) it(JSON.stringify(t), () => {
    refused(t)
    const c = checkFolderMapText(t)
    expect(c.ok).toBe(false)
    if (!c.ok) expect(c.issues.every(i => !i.fixable || !/plur/.test(i.message))).toBe(true)
  })
})

describe('F2: block scalars and nested values are never re-indented into structure', () => {
  for (const t of [
    '\tfolders:\n  - path: /a\n    note: |\n      - path: /b\n        plur: on\n',
    'folder:\n- path: |\n    plur: ON\n  plur: off\n',
    'version: 1\nfolders:\n  - path: /a\n    note: |\n      plur: On\n    plur: OFF\n',
    'version: 1\nfolders:\n  - path: /a\n    note: >-\n      plur: on\n     plur: off\n',
    'version: 1\nfolders:\n  - path: /a\n    extra:\n      sub: 1\n     plur: off\n',
    'version: 1\nfolder:\n  - path: /a\n    extra:\n      plur: on\n',
  ]) it(JSON.stringify(t), () => refused(t))
})

describe('the hard rule, checked on the parsed result', () => {
  it('fixable repairs only ever produce entries, keys and values written on their own lines', () => {
    const p = planFolderMapRepair('verison: 1\nfolder:\n  - path: /a   # work\n     plur: Off\n - path: /b\n   scope: group:x/y\n   plur: ask\n')
    expect(p.status).toBe('fixable')
    if (p.status !== 'fixable') return
    expect(yaml.load(p.after)).toEqual({ version: 1, folders: [{ path: '/a', plur: 'off' }, { path: '/b', scope: 'group:x/y', plur: 'ask' }] })
  })
})

describe('the repair says what it will change, in one line', () => {
  it('a summary per fix, naming lines and keys but no values', () => {
    const p = planFolderMapRepair(`version: 1\nfolder:\n  - path: /a/${SECRET}\n     plur: Off\n`)
    expect(p.status).toBe('fixable')
    if (p.status !== 'fixable') return
    expect(p.summary).toContain('line 2: `folder:` → `folders:`')
    expect(p.summary).toContain('line 4: indentation')
    expect(p.summary).toContain('line 4: `plur:` set to off')
    expect(p.summary).not.toContain(SECRET)
    expect(p.summary).not.toContain('Off')
  })

  it('folderMapProblem and the resolver carry it for the agent', () => {
    writeFileSync(folderMapPath(root), 'version: 1\nfolder:\n  - path: /a\n')
    expect(folderMapProblem(root)!.repair_summary).toBe('line 2: `folder:` → `folders:`')
    expect(resolveFolderPolicy('/nowhere', { root }).mapError?.repair_summary).toBe('line 2: `folder:` → `folders:`')
  })
})

describe('F3: alias and tag names from a YAML error never reach a message', () => {
  for (const t of [
    `version: 1\nfolders:\n  - path: *${SECRET}alias\n`,
    `version: 1\nfolders:\n  - path: !<${SECRET}%20text> /a\n`,
    `version: 1\nfolders:\n  - path: !${SECRET}tag /a\n`,
    `version: 1\nfolders:\n  - path: &${SECRET}anchor /a\n  - path: *${SECRET}other\n`,
  ]) it(JSON.stringify(t), () => {
    const c = checkFolderMapText(t)
    expect(c.ok).toBe(false)
    if (!c.ok) for (const i of c.issues) expect(i.message).not.toContain(SECRET)
    const p = planFolderMapRepair(t)
    if (p.status === 'unfixable') for (const i of p.issues) expect(i.message).not.toContain(SECRET)
  })
})

describe('F3: a YAML directive line never leaks its name either', () => {
  // js-yaml only warns on an unknown directive, so this map is valid; what
  // matters is that no message ever carries the name.
  it('no leak', () => {
    const c = checkFolderMapText(`%${SECRET} x\n---\nversion: 1\nfolder: []\n`)
    expect(c.ok).toBe(false)
    if (!c.ok) for (const i of c.issues) expect(i.message).not.toContain(SECRET)
  })
})

describe('a misspelled entry key is a problem, repaired only when unambiguous', () => {
  it('`plru:` is reported with did-you-mean, and is malformed for the resolver', () => {
    const t = 'version: 1\nfolders:\n  - path: /a\n    plru: off\n'
    const c = checkFolderMapText(t)
    expect(c.ok).toBe(false)
    if (!c.ok) {
      expect(c.issues[0].line).toBe(4)
      expect(c.issues[0].message).toBe('line 4: unknown key `plru:` in entry 1 — did you mean `plur:`?')
      expect(c.issues[0].fixable).toBe(true)
    }
    writeFileSync(folderMapPath(root), t)
    expect(resolveFolderPolicy('/a', { root }).reason).toBe('malformed-map')
  })

  it('repairs `plru:` → `plur:` keeping the value written on that line', () => {
    const p = planFolderMapRepair('version: 1\nfolders:\n  - path: /a\n    plru: off  # never\n')
    expect(p.status).toBe('fixable')
    if (p.status === 'fixable') expect(p.after).toBe('version: 1\nfolders:\n  - path: /a\n    plur: off  # never\n')
  })

  it('`pth:` (an entry without path) is caught; scope/trusted/literal look-alikes and `note:` are custom keys (round 3, R2)', () => {
    const c = checkFolderMapText('version: 1\nfolders:\n  - pth: /a\n')
    expect(c.ok).toBe(false)
    if (!c.ok) expect(c.issues.map(i => i.message).join('\n')).toContain('did you mean `path:`')
    for (const k of ['litera', 'trsuted', 'sope', 'note']) {
      expect(checkFolderMapText(`version: 1\nfolders:\n  - path: /a\n    ${k}: x\n`).ok, k).toBe(true)
    }
  })

  it('not when the right key is already in the entry', () => {
    refused('version: 1\nfolders:\n  - path: /a\n    plur: on\n    plru: off\n')
  })

  it('an unknown entry key never prints a secret-looking name', () => {
    const c = checkFolderMapText(`version: 1\nfolders:\n  - path: /a\n    ghp_${SECRET}: 1\n  - path: /b\n    plu${SECRET}: x\n`)
    if (!c.ok) for (const i of c.issues) expect(i.message).not.toContain(SECRET)
  })
})

describe('N11: `non` is not guessed as on', () => {
  it('refused', () => refused('version: 1\nfolders:\n  - path: /a\n    plur: non\n'))
})

describe('N3: problem wording', () => {
  it('reads as a sentence for a file-level problem', () => {
    writeFileSync(folderMapPath(root), '# nothing\n')
    expect(folderMapProblem(root)!.problem).toMatch(/^has a problem: the file is empty/)
    writeFileSync(folderMapPath(root), 'version: 1\nfolder: []\n')
    expect(folderMapProblem(root)!.problem).toMatch(/^has a problem at line 2:/)
  })
})

describe('F6: the backup is the original bytes', () => {
  it('a file that is not valid UTF-8 is not repaired (nothing written, no backup)', () => {
    const bytes = Buffer.concat([Buffer.from('# '), Buffer.from([0xff]), Buffer.from('\nversion: 1\nfolder: []\n')])
    writeFileSync(folderMapPath(root), bytes)
    const r = repairFolderMap(root, { apply: true })
    expect(r.status).toBe('unfixable')
    expect(readFileSync(folderMapPath(root)).equals(bytes)).toBe(true)
    expect(readdirSync(root).filter(n => n.includes('plur-backup'))).toEqual([])
  })

  it('a valid file: backup byte-identical (BOM and CRLF included)', () => {
    const bytes = Buffer.from('﻿# é\r\nversion: 1\r\nfolder: []\r\n', 'utf8')
    writeFileSync(folderMapPath(root), bytes)
    const r = repairFolderMap(root, { apply: true })
    expect(r.status).toBe('repaired')
    expect(readFileSync(r.backup!).equals(bytes)).toBe(true)
  })
})

describe('F5: a large broken file is cheap to report', () => {
  it('8,000 comment lines: folderMapProblem stays fast and builds no diff', () => {
    writeFileSync(folderMapPath(root), Array.from({ length: 8000 }, (_, i) => `# line ${i} of a long note`).join('\n') + '\n')
    const t0 = Date.now()
    for (let i = 0; i < 5; i++) folderMapProblem(root)
    expect(Date.now() - t0).toBeLessThan(1500)
  })

  it('a 6,000-line map with one bad indent: fast, and too large to repair automatically', () => {
    const body = Array.from({ length: 3000 }, (_, i) => `  - path: /p${i}\n    plur: off`).join('\n')
    writeFileSync(folderMapPath(root), `version: 1\nfolders:\n${body}\n     plur: on\n`)
    const t0 = Date.now()
    const p = folderMapProblem(root)!
    expect(Date.now() - t0).toBeLessThan(1500)
    expect(p.fixable).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The audit's fuzz harness (pr-1530-fuzz.mjs), as a test: valid maps are never
// touched, a single slip is repaired to exactly the intended map or refused,
// no repair ever adds or changes a mode the original did not hold on that
// entry's own line, comments survive, and no value leaks into a message.
// Block scalars and commented-out modes are added to what it generates.
// ---------------------------------------------------------------------------

describe('fuzz (audit harness, seeded)', () => {
  let seed = 12345
  const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 }
  const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)]
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1))
  const pathVals = [`/home/u/${SECRET}proj`, `~/code/${SECRET}`, `/tmp/a b/${SECRET}`, `/x/${SECRET}/#hash`, `/x/${SECRET}: colon`, `/p/${SECRET}*`]
  const quoteVal = (v: string) => {
    const needs = /[:#]|^[~*!&]|\\/.test(v) || v.includes(' ')
    const style = needs ? pick(['dq', 'sq']) : pick(['plain', 'dq', 'sq'])
    return style === 'dq' ? JSON.stringify(v) : style === 'sq' ? `'${v.replace(/'/g, "''")}'` : v
  }
  function genValid(): { text: string; folders: Array<Record<string, unknown>> } {
    const lines: string[] = []
    const eol = rnd() < 0.15 ? '\r\n' : '\n'
    if (rnd() < 0.25) lines.push('# PLUR folder map', '#   - path: ~/code/secret', '#     plur: off', '')
    const n = int(0, 4)
    const itemIndent = pick([0, 2, 2, 4])
    const gap = pick([1, 1, 2])
    lines.push('version: 1')
    const folders: Array<Record<string, unknown>> = []
    if (n === 0) lines.push('folders: []')
    else {
      lines.push('folders:')
      for (let i = 0; i < n; i++) {
        const e: Record<string, unknown> = { path: pick(pathVals) + i }
        const keys = ['path']
        if (rnd() < 0.8) { e.plur = pick(['on', 'off', 'ask']); keys.push('plur') }
        if (rnd() < 0.3) { e.scope = pick(['project:x', 'group:a/b']); keys.push('scope') }
        if (rnd() < 0.2) { e.trusted = rnd() < 0.5; keys.push('trusted') }
        const kcol = itemIndent + 1 + gap
        const note = rnd() < 0.15
        folders.push(note ? { ...e, note: '- path: /evil\n  plur: on\n' } : e)
        keys.forEach((k, j) => {
          const v = k === 'path' || k === 'scope' ? quoteVal(e[k] as string) : String(e[k])
          const trailing = rnd() < 0.15 ? '  # note' : ''
          lines.push(j === 0 ? ' '.repeat(itemIndent) + '-' + ' '.repeat(gap) + `${k}: ${v}${trailing}` : ' '.repeat(kcol) + `${k}: ${v}${trailing}`)
        })
        // A block scalar holding a YAML-looking example (F2).
        if (note) lines.push(' '.repeat(kcol) + 'note: |', ' '.repeat(kcol + 2) + '- path: /evil', ' '.repeat(kcol + 2) + '  plur: on')
      }
    }
    return { text: lines.join(eol) + eol, folders }
  }
  function mutate(text: string): string | null {
    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    const ls = text.split(/\r?\n/)
    const structural = ls.map((_, i) => i).filter(i => ls[i].trim() && !ls[i].trim().startsWith('#'))
    if (structural.length === 0) return null
    const i = pick(structural)
    let l = ls[i]
    const lead = /^ */.exec(l)![0]
    switch (pick(['indent', 'indent', 'tab', 'topkey', 'mode', 'mode', 'comment-mode', 'entrykey', 'random'])) {
      case 'indent': { const nl = Math.max(0, lead.length + pick([-3, -2, -1, 1, 2, 3])); if (nl === lead.length) return null; l = ' '.repeat(nl) + l.trimStart(); break }
      case 'tab': if (!lead.length) return null; l = '\t' + l.trimStart(); break
      case 'topkey': { const m = /^(version|folders):/.exec(l); if (!m) return null; l = l.replace(m[1], pick(m[1] === 'version' ? ['verison', 'Version'] : ['folder', 'Folders', 'fodlers'])); break }
      case 'mode': { const m = /plur: (on|off|ask)\b/.exec(l); if (!m) return null; l = l.replace(`plur: ${m[1]}`, `plur: ${pick({ on: ['On', 'ON', 'onn', 'of', 'non', 'no'], off: ['Off', 'OFF', 'oof', 'offf', 'of', 'no'], ask: ['Ask', 'aks', 'yes'] }[m[1]]!)}`); break }
      case 'comment-mode': { const m = /plur: (on|off|ask)\b/.exec(l); if (!m) return null; l = l.replace(`plur: ${m[1]}`, `plur: #${pick(['on', 'off', 'ask'])}`); break }
      case 'entrykey': { const m = /\b(plur|path|scope|trusted):/.exec(l); if (!m) return null; l = l.replace(`${m[1]}:`, `${pick({ plur: ['plru', 'pur', 'plu'], path: ['pth', 'pat'], scope: ['sope', 'scop'], trusted: ['trsuted', 'trusted-'] }[m[1]]!)}:`); break }
      default: { const pos = int(0, l.length); l = rnd() < 0.5 ? l.slice(0, pos) + l.slice(pos + 1) : l.slice(0, pos) + pick([' ', '-', ':', '#', '"', '{', '|']) + l.slice(pos) }
    }
    ls[i] = l
    return ls.join(eol)
  }
  const commentsOf = (t: string) => t.split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith('#'))

  it('valid maps are untouched; slips are fixed to the intent or refused; no new mode, no lost comment, no leak', () => {
    const bad: string[] = []
    let fixed = 0
    let refusedN = 0
    for (let k = 0; k < 1500; k++) {
      const v = genValid()
      const parsed = (yaml.load(v.text) as { folders?: unknown })?.folders ?? []
      if (!isDeepStrictEqual(parsed, v.folders)) continue // the generator's own quoting edge case
      if (!checkFolderMapText(v.text).ok || planFolderMapRepair(v.text).status !== 'ok') bad.push(`valid not ok: ${JSON.stringify(v.text)}`)
      for (let r = 0; r < 4; r++) {
        const m = mutate(v.text)
        if (!m) continue
        const c = checkFolderMapText(m)
        if (!c.ok) for (const i of c.issues) if (i.message.includes(SECRET)) bad.push(`leak: ${i.message}`)
        const p = planFolderMapRepair(m)
        if (p.status === 'unfixable') { refusedN++; for (const i of p.issues) if (i.message.includes(SECRET)) bad.push(`leak: ${i.message}`); continue }
        if (p.status !== 'fixable') continue
        fixed++
        if (p.summary.includes(SECRET)) bad.push(`leak in summary: ${p.summary}`)
        const after = (yaml.load(p.after) as { folders?: Array<Record<string, unknown>> })?.folders ?? []
        if (!isDeepStrictEqual(after, v.folders)) bad.push(`changed meaning:\n${m}\n→\n${p.after}`)
        // A commented-out mode is never a mode: a file holding one is never fixable (F1).
        if (/plur\w*:\s*#/.test(m)) bad.push(`fixed a commented-out mode:\n${m}\n→\n${p.after}`)
        for (const c2 of commentsOf(m)) if (!p.after.includes(c2)) bad.push(`lost comment ${c2}:\n${m}`)
      }
    }
    expect(bad.slice(0, 5)).toEqual([])
    expect(fixed).toBeGreaterThan(100)
    expect(refusedN).toBeGreaterThan(100)
  }, 120_000)
})
