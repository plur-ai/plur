import yaml from 'js-yaml'
import { z } from 'zod'

/**
 * A broken folders.yaml, pinpointed and — where the fix is unambiguous —
 * repaired (#1526). Pure text in, text out: no filesystem here, so the same
 * checks serve the loader, the MCP gate, `plur doctor`, `plur folders list`
 * and `plur folders repair`.
 *
 * Every message names the line (and column, when there is one) and says what
 * is wrong in plain words. It quotes at most the KEY on that line, and only
 * when the key is a plain identifier: never a path, a scope or any other value
 * from the file, which may be private.
 *
 * The repair is line-based, so every comment survives: it only re-indents
 * lines, renames a misspelled top-level key, corrects a `plur:` mode whose case
 * or one letter is wrong (when exactly one mode matches), or gives an empty
 * file the minimal valid map. Anything else is reported as needing a hand fix
 * and nothing is changed — there is no half repair.
 */

export const FolderEntrySchema = z.object({
  path: z.string().min(1),
  plur: z.enum(['on', 'off', 'ask']).optional(),
  scope: z.string().min(1).optional(),
  trusted: z.boolean().optional(),
  literal: z.boolean().optional(),
}).passthrough()

export const FolderMapSchema = z.object({
  version: z.literal(1).optional(),
  folders: z.array(FolderEntrySchema).optional(),
}).passthrough()

export interface FolderMapIssue {
  /** 1-based. Absent when the problem has no single line (an empty file). */
  line?: number
  /** 1-based. */
  column?: number
  /** Plain words, starting with `line N:` when there is a line. */
  message: string
  /** True when `plur folders repair` can fix this one by itself. */
  fixable: boolean
}

export type FolderMapCheck =
  | { ok: true; raw: Record<string, unknown> }
  | { ok: false; issues: FolderMapIssue[] }

export type FolderMapRepairPlan =
  | { status: 'ok' }
  | { status: 'fixable'; after: string; fixes: FolderMapIssue[]; diff: string }
  | { status: 'unfixable'; issues: FolderMapIssue[] }

const TOP_KEYS = ['version', 'folders'] as const
const ENTRY_KEYS = new Set(['path', 'plur', 'scope', 'trusted', 'literal'])
const MODES = ['on', 'off', 'ask'] as const
/** Words that read as a yes/no: never guessed into a mode (`no` is one letter from `on`). */
const YES_NO = new Set(['yes', 'no', 'y', 'n', 'true', 'false', 'none', 'null', '~'])
/** A key PLUR may print: a plain identifier, bounded. Anything else is "a key". */
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,39}$/
const KEY_RE = /^([A-Za-z_][A-Za-z0-9_-]{0,39})[ \t]*:(?=[ \t]|$)/

// ---------------------------------------------------------------------------
// Line scan
// ---------------------------------------------------------------------------

type Kind = 'blank' | 'comment' | 'key' | 'item' | 'other'

interface Line {
  /** 1-based. */
  n: number
  text: string
  lead: string
  body: string
  kind: Kind
  /** `key` lines, and `item` lines with an inline key (`- path: x`). */
  key?: string
  /** `item` lines: the whitespace between `-` and the content. */
  gap?: string
  /** `item` lines whose content is not a key (`- {path: x}`, `- x`). */
  inlineValue?: boolean
}

interface Scan { lines: Line[]; eol: string; bom: boolean; finalNewline: boolean }

function scan(text: string): Scan {
  const bom = text.startsWith('﻿')
  const body = bom ? text.slice(1) : text
  const eol = body.includes('\r\n') ? '\r\n' : '\n'
  const parts = body.split(/\r?\n/)
  const finalNewline = parts.length > 1 && parts[parts.length - 1] === ''
  if (finalNewline || (parts.length === 1 && parts[0] === '')) parts.pop()
  const lines = parts.map((t, i): Line => {
    const lead = /^[ \t]*/.exec(t)![0]
    const rest = t.slice(lead.length)
    const base = { n: i + 1, text: t, lead, body: rest }
    if (rest === '') return { ...base, kind: 'blank' }
    if (rest.startsWith('#')) return { ...base, kind: 'comment' }
    const dash = /^-([ \t]*)/.exec(rest)
    if (dash && (rest.length === 1 || /[ \t]/.test(rest[1]))) {
      const inner = rest.slice(dash[0].length)
      const k = KEY_RE.exec(inner)
      if (k) return { ...base, kind: 'item', key: k[1], gap: dash[1] }
      return { ...base, kind: 'item', gap: dash[1], inlineValue: inner !== '' && !inner.startsWith('#') }
    }
    const k = KEY_RE.exec(rest)
    if (k) return { ...base, kind: 'key', key: k[1] }
    return { ...base, kind: 'other' }
  })
  return { lines, eol, bom, finalNewline }
}

function join(s: Scan, lines: string[]): string {
  return (s.bom ? '﻿' : '') + lines.join(s.eol) + (s.finalNewline && lines.length > 0 ? s.eol : '')
}

// ---------------------------------------------------------------------------
// Structure: which line is a top-level key, a list item, an entry's key.
// ---------------------------------------------------------------------------

type Role =
  | { role: 'top'; key: string }
  | { role: 'item'; entry: number }
  | { role: 'entry-key'; entry: number; key: string }
  | { role: 'stray' }
  | { role: 'none' }

interface Entry { line: Line; keys: Map<string, Line> }

interface Structure { roles: Role[]; entries: Entry[]; tops: Map<string, Line[]> }

/** Damerau (optimal string alignment) distance: a swapped pair counts as one. */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
    }
  }
  return d[a.length][b.length]
}

/** The top-level key a misspelling most likely means, or null. */
function suggestTopKey(key: string): string | null {
  const k = key.toLowerCase()
  if ((TOP_KEYS as readonly string[]).includes(k)) return k
  if (ENTRY_KEYS.has(k)) return null
  const near = TOP_KEYS.filter(t => editDistance(k, t) <= 2)
  return near.length === 1 ? near[0] : null
}

function structure(s: Scan): Structure {
  const roles: Role[] = []
  const entries: Entry[] = []
  const tops = new Map<string, Line[]>()
  let inFolders = false
  let current: Entry | null = null
  for (const l of s.lines) {
    if (l.kind === 'blank' || l.kind === 'comment') { roles.push({ role: 'none' }); continue }
    if (l.kind === 'other') { roles.push({ role: 'stray' }); continue }
    if (l.kind === 'item') {
      if (!inFolders) { roles.push({ role: 'stray' }); continue }
      current = { line: l, keys: new Map(l.key ? [[l.key, l]] : []) }
      entries.push(current)
      roles.push({ role: 'item', entry: entries.length - 1 })
      continue
    }
    // A key line.
    const key = l.key!
    const asTop = l.lead === '' || (!current && suggestTopKey(key) !== null) ||
      (current !== null && !ENTRY_KEYS.has(key) && suggestTopKey(key) !== null)
    if (asTop) {
      roles.push({ role: 'top', key })
      tops.set(key, [...(tops.get(key) ?? []), l])
      inFolders = suggestTopKey(key) === 'folders'
      current = null
      continue
    }
    if (current) {
      current.keys.set(key, l)
      roles.push({ role: 'entry-key', entry: entries.length - 1, key })
      continue
    }
    roles.push({ role: 'stray' })
  }
  return { roles, entries, tops }
}

// ---------------------------------------------------------------------------
// Indentation
// ---------------------------------------------------------------------------

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
/**
 * A key PLUR may name in a message: one of the map's own keys, or a near
 * misspelling of a top-level one. Any other key could be anything the user
 * typed (a token pasted on the wrong line), so it is never printed.
 */
const printable = (k: string | undefined): k is string =>
  !!k && SAFE_KEY.test(k) && ((TOP_KEYS as readonly string[]).includes(k) || ENTRY_KEYS.has(k) || suggestTopKey(k) !== null)
const keyName = (k: string | undefined) => (printable(k) ? `\`${k}:\`` : 'this line')

interface Layout { target: Array<string | null>; issues: FolderMapIssue[] }

/**
 * The indentation every structural line should have, and an issue for each
 * line that differs. Top-level keys at column 1; list items like the first
 * one; an entry's keys in line with the key after its `- `.
 */
function layout(s: Scan, st: Structure): Layout {
  const target: Array<string | null> = s.lines.map(() => null)
  const issues: FolderMapIssue[] = []
  const firstItem = st.entries.find(e => !e.line.lead.includes('\t'))
  const itemIndent = firstItem ? firstItem.line.lead.length : 2
  let entryKeyCol = itemIndent + 2
  let entryRef: Line | null = null
  s.lines.forEach((l, i) => {
    const r = st.roles[i]
    let want: number | null = null
    let what = ''
    if (r.role === 'top') {
      want = 0
      what = `${keyName(r.key)} is a top-level key, so it starts at the beginning of the line`
    } else if (r.role === 'item') {
      want = itemIndent
      const gap = (l.gap ?? ' ').replace(/\t/g, ' ') || ' '
      entryKeyCol = itemIndent + 1 + gap.length
      entryRef = l
      what = firstItem && firstItem.line !== l ? `list items line up with the one on line ${firstItem.line.n}` : 'list items under `folders:` line up'
    } else if (r.role === 'entry-key') {
      want = entryKeyCol
      what = entryRef?.key
        ? `in line with ${keyName(entryRef.key)} on line ${entryRef.n}`
        : `in line with the other keys of the entry on line ${entryRef?.n ?? '?'}`
    } else {
      return
    }
    target[i] = ' '.repeat(want)
    const gapTab = r.role === 'item' && (l.gap ?? '').includes('\t')
    if (l.lead.includes('\t') || gapTab) {
      issues.push({ line: l.n, column: 1, fixable: true,
        message: `line ${l.n}: a tab in the indentation of ${keyName(l.key)} — YAML allows only spaces there` })
    } else if (l.lead.length !== want) {
      const k = r.role === 'item' ? (printable(l.key) ? `\`- ${l.key}:\`` : 'this list item') : keyName(l.key)
      issues.push({ line: l.n, column: l.lead.length + 1, fixable: true,
        message: `line ${l.n}: indentation — ${k} is indented ${plural(l.lead.length, 'space')}, expected ${want} (${what})` })
    }
  })
  return { target, issues }
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

function isEmpty(s: Scan): boolean {
  return s.lines.every(l => l.kind === 'blank' || l.kind === 'comment')
}

const EMPTY_MESSAGE = 'the file is empty — it has only comments or blank lines, and no `version:` or `folders:`'

/** The mode a wrong `plur:` value most likely means, or null when it is not clear. */
export function suggestMode(value: string): string | null {
  const t = value.trim()
  const lower = t.toLowerCase()
  if ((MODES as readonly string[]).includes(lower)) return lower
  if (t.length < 2 || YES_NO.has(lower)) return null
  const near = MODES.filter(m => editDistance(lower, m) === 1)
  return near.length === 1 ? near[0] : null
}

/** The value token of a `key: value` line: [start, end) of the text inside any quotes, and the text. */
function valueSpan(l: Line): { start: number; end: number; value: string } | null {
  const k = KEY_RE.exec(l.kind === 'item' ? l.body.slice(1 + (l.gap ?? '').length) : l.body)
  if (!k) return null
  const offset = l.lead.length + (l.kind === 'item' ? 1 + (l.gap ?? '').length : 0) + k[0].length
  const rest = l.text.slice(offset)
  const ws = /^[ \t]*/.exec(rest)![0]
  let start = offset + ws.length
  const tail = l.text.slice(start)
  let raw: string
  if (tail.startsWith("'") || tail.startsWith('"')) {
    const q = tail[0]
    const close = tail.indexOf(q, 1)
    if (close < 0) return null
    raw = tail.slice(1, close)
    start += 1
  } else {
    raw = tail.replace(/[ \t]+#.*$/, '').replace(/[ \t]+$/, '')
  }
  return { start, end: start + raw.length, value: raw }
}

function yamlError(err: unknown): FolderMapIssue {
  const mark = (err as { mark?: { line?: number; column?: number } }).mark
  // Only the parser's one-line reason: its message carries a code frame (the
  // lines around the fault), which is file content.
  const reason = String((err as { reason?: string }).reason ?? 'it cannot be parsed').split('\n')[0].slice(0, 200)
  if (mark && typeof mark.line === 'number') {
    const line = mark.line + 1
    const column = (mark.column ?? 0) + 1
    return { line, column, fixable: false, message: `line ${line}, column ${column}: not valid YAML (${reason})` }
  }
  return { fixable: false, message: `not valid YAML (${reason})` }
}

function topLine(st: Structure, key: string): Line | undefined {
  return st.tops.get(key)?.[0]
}

/**
 * Check folders.yaml text. Strict where the loader used to be lenient: an
 * empty file and an unknown top-level key are problems (they drop every
 * decision silently), exactly as the MCP gate (#1519) treats them.
 */
export function checkFolderMapText(text: string): FolderMapCheck {
  const s = scan(text)
  if (isEmpty(s)) return { ok: false, issues: [{ fixable: true, message: EMPTY_MESSAGE }] }
  const st = structure(s)
  let raw: unknown
  try {
    raw = yaml.load(text.replace(/^﻿/, ''))
  } catch (err) {
    const lay = layout(s, st)
    const strays = st.roles.some(r => r.role === 'stray')
    if (lay.issues.length > 0 && !strays) return { ok: false, issues: lay.issues }
    if (lay.issues.length > 0) return { ok: false, issues: lay.issues.map(i => ({ ...i, fixable: false })) }
    return { ok: false, issues: [yamlError(err)] }
  }
  if (raw === null || raw === undefined) {
    return { ok: false, issues: [{ fixable: false, message: 'the file holds no settings — it needs `version: 1` and `folders:`' }] }
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, issues: [{ line: 1, column: 1, fixable: false,
      message: 'line 1: the file is not a set of `key: value` settings — it needs `version: 1` and `folders:` at the start of their lines' }] }
  }
  const issues: FolderMapIssue[] = []
  const obj = raw as Record<string, unknown>
  for (const k of Object.keys(obj)) {
    if ((TOP_KEYS as readonly string[]).includes(k)) continue
    const at = topLine(st, k)
    const where = at ? `line ${at.n}: ` : ''
    const want = SAFE_KEY.test(k) ? suggestTopKey(k) : null
    const shown = want !== null ? `\`${k}:\`` : 'an unknown key'
    const taken = want !== null && Object.prototype.hasOwnProperty.call(obj, want)
    if (want && !taken) {
      issues.push({ ...(at ? { line: at.n, column: 1 } : {}), fixable: !!at,
        message: `${where}unknown key ${shown} — did you mean \`${want}:\`?` })
    } else {
      issues.push({ ...(at ? { line: at.n, column: 1 } : {}), fixable: false,
        message: `${where}${want !== null ? `unknown key ${shown}` : shown} — only \`version:\` and \`folders:\` belong at the top level` +
          (want && taken ? ` (\`${want}:\` is already there)` : '') })
    }
  }
  const parsed = FolderMapSchema.safeParse(raw)
  if (!parsed.success) {
    const seen = new Set<string>()
    for (const issue of parsed.error.issues) {
      const [top, idx, key] = issue.path
      let at: Line | undefined
      let message: string
      let fixable = false
      if (top === 'version') {
        at = topLine(st, 'version')
        message = '`version:` must be 1'
      } else if (top === 'folders' && idx === undefined) {
        at = topLine(st, 'folders')
        message = '`folders:` must be a list of entries, each starting with `- path:`'
      } else if (top === 'folders' && typeof idx === 'number' && key === undefined) {
        at = st.entries[idx]?.line
        message = `entry ${idx + 1} is not a set of keys — each entry starts with \`- path:\``
      } else if (top === 'folders' && typeof idx === 'number' && typeof key === 'string') {
        const entry = st.entries[idx]
        at = entry?.keys.get(key) ?? entry?.line
        const value = (obj.folders as Array<Record<string, unknown>> | undefined)?.[idx]?.[key]
        if (key === 'path' && value === undefined) {
          message = `entry ${idx + 1} has no \`path:\``
        } else if (key === 'plur') {
          const span = at && at.key === 'plur' ? valueSpan(at) : null
          const suggestion = span && typeof value === 'string' ? suggestMode(span.value) : null
          fixable = suggestion !== null
          message = `\`plur:\` in entry ${idx + 1} must be on, off or ask` +
            (suggestion ? ` — it looks like \`${suggestion}\` with the wrong case or a typo` : '')
        } else if (key === 'trusted' || key === 'literal') {
          message = `\`${key}:\` in entry ${idx + 1} must be true or false`
        } else {
          message = `\`${key}:\` in entry ${idx + 1} must be non-empty text`
        }
      } else {
        message = 'a value in the file is not valid'
      }
      const line = at?.n
      const text = line !== undefined ? `line ${line}: ${message}` : message
      if (seen.has(text)) continue
      seen.add(text)
      issues.push({ ...(line !== undefined ? { line, column: at!.lead.length + 1 } : {}), fixable, message: text })
    }
  }
  if (issues.length > 0) {
    issues.sort((a, b) => (a.line ?? Infinity) - (b.line ?? Infinity))
    return { ok: false, issues }
  }
  return { ok: true, raw: obj }
}

/** One line for an error message: the first issue, and how many more there are. */
export function describeFolderMapIssues(issues: FolderMapIssue[]): string {
  const more = issues.length - 1
  return issues[0].message + (more > 0 ? ` (and ${plural(more, 'more problem')})` : '')
}

// ---------------------------------------------------------------------------
// Repair
// ---------------------------------------------------------------------------

/**
 * What `plur folders repair` would do with this text. `fixable` carries the
 * new text and a unified diff; `unfixable` the problems that need a hand fix
 * (then nothing may be changed at all).
 */
export function planFolderMapRepair(text: string): FolderMapRepairPlan {
  const check = checkFolderMapText(text)
  if (check.ok) return { status: 'ok' }
  const s = scan(text)
  const fixes: FolderMapIssue[] = []
  let out = s.lines.map(l => l.text)

  if (isEmpty(s)) {
    out = [...out, 'version: 1', 'folders: []']
    fixes.push(check.issues[0])
    const after = (s.bom ? '﻿' : '') + out.join(s.eol) + s.eol
    return finish(text, after, fixes)
  }

  const st = structure(s)
  // 1. Indentation and tabs — only when the parser refuses the file.
  let parses = true
  try { yaml.load(text.replace(/^﻿/, '')) } catch { parses = false }
  if (!parses) {
    if (st.roles.some(r => r.role === 'stray')) return unfixable(check)
    const lay = layout(s, st)
    if (lay.issues.length === 0) return unfixable(check)
    fixes.push(...lay.issues)
    out = s.lines.map((l, i) => {
      const want = lay.target[i]
      if (want === null) {
        // A blank or comment line: only a tab in its indentation is touched.
        if (!l.lead.includes('\t')) return l.text
        if (l.kind === 'blank') return ''
        const next = lay.target.slice(i + 1).find(t => t !== null) ?? ''
        return next + l.body
      }
      if (l.kind === 'item') {
        const inner = l.body.slice(1 + (l.gap ?? '').length)
        const gap = (l.gap ?? ' ').replace(/\t/g, ' ')
        return `${want}-${inner === '' ? '' : gap || ' '}${inner}`
      }
      return want + l.body
    })
  }

  // 2. Misspelled top-level keys, 3. modes: on the (re-indented) text.
  const s2 = scan(join(s, out))
  const st2 = structure(s2)
  const present = new Set([...st2.tops.keys()])
  s2.lines.forEach((l, i) => {
    const r = st2.roles[i]
    if (r.role === 'top' && !(TOP_KEYS as readonly string[]).includes(r.key)) {
      const want = suggestTopKey(r.key)
      if (!want || present.has(want)) return
      present.add(want)
      const at = l.text.indexOf(r.key)
      out[i] = l.text.slice(0, at) + want + l.text.slice(at + r.key.length)
      fixes.push({ line: l.n, column: 1, fixable: true, message: `line ${l.n}: unknown key ${keyName(r.key)} — did you mean \`${want}:\`?` })
    }
    if ((r.role === 'entry-key' && r.key === 'plur') || (r.role === 'item' && l.key === 'plur')) {
      const span = valueSpan(l)
      if (!span || (MODES as readonly string[]).includes(span.value)) return
      const want = suggestMode(span.value)
      if (!want) return
      out[i] = l.text.slice(0, span.start) + want + l.text.slice(span.end)
      fixes.push({ line: l.n, column: span.start + 1, fixable: true, message: `line ${l.n}: \`plur:\` must be on, off or ask — set to \`${want}\`` })
    }
  })

  const after = join(s, out)
  if (after === text) return unfixable(check)
  const recheck = checkFolderMapText(after)
  if (!recheck.ok) return unfixable(recheck)
  return finish(text, after, fixes)
}

function unfixable(check: { ok: false; issues: FolderMapIssue[] }): FolderMapRepairPlan {
  const manual = check.issues.filter(i => !i.fixable)
  const issues = (manual.length > 0 ? manual : check.issues).map(i => ({ ...i, fixable: false }))
  return { status: 'unfixable', issues }
}

function finish(before: string, after: string, fixes: FolderMapIssue[]): FolderMapRepairPlan {
  fixes.sort((a, b) => (a.line ?? Infinity) - (b.line ?? Infinity))
  return { status: 'fixable', after, fixes, diff: unifiedDiff(before, after, 'folders.yaml (now)', 'folders.yaml (repaired)') }
}

// ---------------------------------------------------------------------------
// Unified diff (the files are a few dozen lines: a plain LCS is enough).
// ---------------------------------------------------------------------------

export function unifiedDiff(before: string, after: string, fromLabel: string, toLabel: string, context = 3): string {
  const a = before.replace(/^﻿/, '').split(/\r?\n/)
  const b = after.replace(/^﻿/, '').split(/\r?\n/)
  if (a[a.length - 1] === '') a.pop()
  if (b[b.length - 1] === '') b.pop()
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  type Op = { t: ' ' | '-' | '+'; s: string; ai: number; bi: number }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { ops.push({ t: ' ', s: a[i], ai: i, bi: j }); i++; j++ }
    else if (i < a.length && (j === b.length || lcs[i + 1][j] >= lcs[i][j + 1])) { ops.push({ t: '-', s: a[i], ai: i, bi: j }); i++ }
    else { ops.push({ t: '+', s: b[j], ai: i, bi: j }); j++ }
  }
  const out = [`--- ${fromLabel}`, `+++ ${toLabel}`]
  let k = 0
  while (k < ops.length) {
    if (ops[k].t === ' ') { k++; continue }
    const start = Math.max(0, k - context)
    let end = k
    // Extend the hunk while changes are within 2*context of each other.
    for (;;) {
      while (end < ops.length && ops[end].t !== ' ') end++
      let next = end
      while (next < ops.length && ops[next].t === ' ') next++
      if (next < ops.length && next - end <= 2 * context) { end = next; continue }
      end = Math.min(ops.length, end + context)
      break
    }
    const hunk = ops.slice(start, end)
    const aStart = hunk[0].ai
    const bStart = hunk[0].bi
    const aLen = hunk.filter(o => o.t !== '+').length
    const bLen = hunk.filter(o => o.t !== '-').length
    out.push(`@@ -${aLen === 0 ? aStart : aStart + 1},${aLen} +${bLen === 0 ? bStart : bStart + 1},${bLen} @@`)
    for (const o of hunk) out.push(o.t + o.s)
    k = end
  }
  return out.join('\n') + '\n'
}
