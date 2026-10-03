import yaml from 'js-yaml'
import { z } from 'zod'
import { isDeepStrictEqual } from 'util'

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

// #1521 (0.22) extends these two: `plur` gains `remote-only`, and an empty
// `folders:` (null) becomes valid. When it lands, change them HERE — this is
// the one schema the loader, the MCP gate and the repair share — and add
// `remote-only` to MODES below.
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
  /** For a fix: what the repair changes on that line, in a few words (no values). */
  change?: string
}

export type FolderMapCheck =
  | { ok: true; raw: Record<string, unknown> }
  | { ok: false; issues: FolderMapIssue[] }

export type FolderMapRepairPlan =
  | { status: 'ok' }
  | {
      status: 'fixable'
      after: string
      fixes: FolderMapIssue[]
      /** One line: what changes where, e.g. "line 4: indentation; line 2: `folder:` → `folders:`". No values. */
      summary: string
      /** Unified diff; '' when planned with `{ diff: false }`. */
      diff: string
    }
  | { status: 'unfixable'; issues: FolderMapIssue[] }

const TOP_KEYS = ['version', 'folders'] as const
const ENTRY_KEYS = new Set(['path', 'plur', 'scope', 'trusted', 'literal'])
const MODES = ['on', 'off', 'ask'] as const
/** Words that read as a yes/no: never guessed into a mode (`no` is one letter from `on`). */
const YES_NO = new Set(['yes', 'no', 'y', 'n', 'true', 'false', 'none', 'non', 'null', '~'])
/** A block scalar indicator (`|`, `>`, with chomping / indentation markers): its lines are text, not structure. */
const BLOCK = /^[|>][-+0-9]*[ \t]*(#.*)?$/
/** Above this, a broken map is pinpointed but never planned for repair (the planner and the diff are not free). */
const MAX_REPAIR_LINES = 2000
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
  /** Key lines (and items with a key): what follows `key:`, trimmed. */
  value?: string
}

interface Scan {
  lines: Line[]
  eol: string
  bom: boolean
  finalNewline: boolean
  /** The text has a CR that is not part of a CRLF (an old-Mac line break). Never repaired. */
  loneCR: boolean
}

function scan(text: string): Scan {
  const bom = text.startsWith('﻿')
  const body = bom ? text.slice(1) : text
  const eol = body.includes('\r\n') ? '\r\n' : '\n'
  // A lone CR is a line break to YAML, so it is one here too: every line
  // counts (the cap, the empty-file check), and the repair refuses such text.
  const parts = body.split(/\r\n|\r|\n/)
  const loneCR = /\r(?!\n)/.test(body)
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
      if (k) return { ...base, kind: 'item', key: k[1], gap: dash[1], value: inner.slice(k[0].length).trim() }
      return { ...base, kind: 'item', gap: dash[1], inlineValue: inner !== '' && !inner.startsWith('#') }
    }
    const k = KEY_RE.exec(rest)
    if (k) return { ...base, kind: 'key', key: k[1], value: rest.slice(k[0].length).trim() }
    return { ...base, kind: 'other' }
  })
  return { lines, eol, bom, finalNewline, loneCR }
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

interface Structure {
  roles: Role[]
  entries: Entry[]
  tops: Map<string, Line[]>
  /** The first line opening a block scalar (`key: |`), whose lines are text. */
  block?: Line
  /** The first key with no value on its line followed by deeper lines (a nested value). */
  nested?: Line
}

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

/**
 * The entry key a misspelling most likely means, or null (#1530 re-review
 * R2). Only `plur` and `path` — the two keys whose loss silently drops a
 * decision — and only a near-miss that reads as the same word typed wrong:
 * another case (`Plur`), two neighbouring letters swapped (`plru`, `paht`),
 * or one inner letter missing (`pur`, `pth`). An added or changed letter is a
 * different word (`paths`, `pat`, `plus`, `blur`), and so is a negation
 * (`un…`, `not…`): those stay custom keys, as before.
 */
export function suggestEntryKey(key: string): string | null {
  const k = key.toLowerCase()
  if (/^(un|not)/.test(k)) return null
  for (const target of ['plur', 'path'] as const) {
    if (k === target) return key === target ? null : target
    if (k.length === target.length) {
      for (let i = 0; i + 1 < k.length; i++) {
        if (k[i] !== target[i] && k[i] === target[i + 1] && k[i + 1] === target[i] &&
            k.slice(0, i) === target.slice(0, i) && k.slice(i + 2) === target.slice(i + 2)) return target
      }
    }
    if (k.length === target.length - 1) {
      for (let i = 1; i < target.length - 1; i++) if (target.slice(0, i) + target.slice(i + 1) === k) return target
    }
  }
  return null
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
  let block: Line | undefined
  let nested: Line | undefined
  /** Inside a block scalar: lines deeper than the line that opened it are its text. */
  let blockLead = -1
  let prevEmptyKey: Line | null = null
  for (const l of s.lines) {
    if (blockLead >= 0) {
      if (l.kind === 'blank' || l.lead.length > blockLead) { roles.push({ role: 'none' }); continue }
      blockLead = -1
    }
    if (l.kind === 'blank' || l.kind === 'comment') { roles.push({ role: 'none' }); continue }
    // A key with no value on its line, followed by deeper lines: its value is
    // nested (a mapping or list). `folders:` is the one key that may do so.
    const keyCol = (k: Line) => k.lead.length + (k.kind === 'item' ? 1 + (k.gap ?? '').length : 0)
    if (prevEmptyKey && l.lead.length > keyCol(prevEmptyKey) && suggestTopKey(prevEmptyKey.key!) === null) {
      nested ??= prevEmptyKey
    }
    prevEmptyKey = (l.kind === 'key' || (l.kind === 'item' && l.key)) && (l.value === '' || l.value!.startsWith('#')) ? l : null
    if (l.value !== undefined && BLOCK.test(l.value)) {
      block ??= l
      blockLead = l.lead.length + (l.kind === 'item' ? 1 + (l.gap ?? '').length : 0)
    }
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
  return { roles, entries, tops, ...(block ? { block } : {}), ...(nested ? { nested } : {}) }
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
  !!k && SAFE_KEY.test(k) && ((TOP_KEYS as readonly string[]).includes(k) || ENTRY_KEYS.has(k) ||
    suggestTopKey(k) !== null || suggestEntryKey(k) !== null)
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
      issues.push({ line: l.n, column: 1, fixable: true, change: 'tab replaced by spaces',
        message: `line ${l.n}: a tab in the indentation of ${keyName(l.key)} — YAML allows only spaces there` })
    } else if (l.lead.length !== want) {
      const k = r.role === 'item' ? (printable(l.key) ? `\`- ${l.key}:\`` : 'this list item') : keyName(l.key)
      issues.push({ line: l.n, column: l.lead.length + 1, fixable: true, change: 'indentation',
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
  // Only ASCII spaces around the token are ignored: a BOM, zero-width or
  // other hidden character means the token is not what it looks like.
  const t = value.replace(/^[ \t]+|[ \t]+$/g, '')
  if (!/^[\x21-\x7e]+$/.test(t)) return null
  const lower = t.toLowerCase()
  // Another case of a literal mode (`ON`, `Off`): that mode (#1530 re-review R3).
  if ((MODES as readonly string[]).includes(lower)) return lower
  if (t.length < 3 || YES_NO.has(lower)) return null
  // One letter off: only ever `off` or `ask`, and only when `on` is not just
  // as close — a guess never switches memory on (`ok`, `in`, `onn` stay put).
  const near = MODES.filter(m => editDistance(lower, m) === 1)
  return near.length === 1 && near[0] !== 'on' ? near[0] : null
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
    // `plur: #on` is a comment, not a value (YAML reads it as null): never a mode.
    if (tail.startsWith('#')) return null
    raw = tail.replace(/[ \t]+#.*$/, '').replace(/[ \t]+$/, '')
  }
  return { start, end: start + raw.length, value: raw }
}

/**
 * The parser's reason without any text from the file. js-yaml quotes alias,
 * anchor, tag and directive names (`unidentified alias "x"`, `unknown tag !<x>`),
 * which are whatever the user typed: those become a fixed phrase, and any other
 * quoted or bracketed token is dropped (#1530 review F3).
 */
function safeReason(reason: string): string {
  if (/alias|anchor/i.test(reason)) return 'it uses a YAML alias or anchor, which a folder map does not support'
  if (/\btag\b/i.test(reason)) return 'it uses a YAML tag, which a folder map does not support'
  if (/directive/i.test(reason)) return 'it holds a YAML directive line, which a folder map does not support'
  return reason.replace(/"[^"]*"|'[^']*'|<[^>]*>|![^\s,]*/g, '…').slice(0, 200)
}

function yamlError(err: unknown): FolderMapIssue {
  const mark = (err as { mark?: { line?: number; column?: number } }).mark
  // Only the parser's one-line reason: its message carries a code frame (the
  // lines around the fault), which is file content.
  const reason = safeReason(String((err as { reason?: string }).reason ?? 'it cannot be parsed').split('\n')[0])
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
  // A misspelled entry key (`plru: off`) would drop that decision silently,
  // exactly like a misspelled top-level key: it is a problem too (#1530
  // review). A key that is not near any of the map's keys (`note:`) passes.
  const entriesRaw = Array.isArray(obj.folders) ? obj.folders as unknown[] : []
  entriesRaw.forEach((e, idx) => {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return
    for (const k of Object.keys(e)) {
      if (ENTRY_KEYS.has(k) || !SAFE_KEY.test(k)) continue
      const want = suggestEntryKey(k)
      // A near-miss is a problem only when the entry lacks the real key:
      // otherwise it is just another custom key (#1530 re-review R2).
      if (!want || Object.prototype.hasOwnProperty.call(e, want)) continue
      const at = st.entries[idx]?.keys.get(k)
      issues.push({ ...(at ? { line: at.n, column: at.lead.length + 1 } : {}), fixable: !!at,
        message: `${at ? `line ${at.n}: ` : ''}unknown key \`${k}:\` in entry ${idx + 1} — did you mean \`${want}:\`?` })
    }
  })
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
export function planFolderMapRepair(text: string, opts: { diff?: boolean } = {}): FolderMapRepairPlan {
  const check = checkFolderMapText(text)
  if (check.ok) return { status: 'ok' }
  const s = scan(text)
  const fixes: FolderMapIssue[] = []
  let out = s.lines.map(l => l.text)

  // Narrow by construction (#1530 re-review): before anything is planned,
  // refuse every file the line-based repair could read differently from
  // YAML. Every line counts toward the cap, comments and lone CRs included.
  if (s.lines.length > MAX_REPAIR_LINES) {
    return refuse(check, `the file has ${s.lines.length} lines, more than plur folders repair changes automatically (${MAX_REPAIR_LINES})`)
  }
  if (s.loneCR) {
    const n = text.replace(/^\uFEFF/, '').split(/\r\n|\n/).findIndex(l => l.includes('\r')) + 1
    return refuse(check, `line ${n}: a lone carriage return (an old-Mac line break); plur folders repair does not change a file that holds one`)
  }
  const yamlOnly = yamlFeatureLine(s)
  if (yamlOnly) {
    return refuse(check, `line ${yamlOnly.n}: a YAML tag, anchor, alias or block of text (\`!\`, \`&\`, \`*\`, \`|\` or \`>\`); plur folders repair does not change a file that holds one`)
  }

  if (isEmpty(s)) {
    out = [...out, 'version: 1', 'folders: []']
    fixes.push({ ...check.issues[0], change: 'adds `version: 1` and `folders: []`' })
    const after = (s.bom ? '\uFEFF' : '') + out.join(s.eol) + s.eol
    const recheck = checkFolderMapText(after)
    if (!recheck.ok) return unfixable(recheck)
    return finish(text, after, fixes, opts)
  }

  const st = structure(s)
  // Lines the line-based repair could read differently from the YAML parser
  // are never touched: the whole repair is refused (#1530 review F2).
  if (st.block) {
    return refuse(check, `line ${st.block.n}: ${keyName(st.block.key)} starts a block of text (\`|\` or \`>\`); plur folders repair does not change a file that holds one`)
  }
  // A key with no value on its own line may take its value from the lines
  // after it — YAML even allows a list at the key's own indentation — so a
  // slip there cannot be read reliably. Only `folders:` may do so.
  const open = s.lines.find((l, i) => {
    const r = st.roles[i]
    if (r.role !== 'item' && r.role !== 'entry-key' && r.role !== 'top') return false
    if (r.role === 'top' && suggestTopKey(r.key) === 'folders') return false
    return l.key !== undefined && (l.value === '' || l.value!.startsWith('#'))
  })
  if (open) {
    return refuse(check, `line ${open.n}: ${keyName(open.key)} has no value on its line; plur folders repair does not change a file where a value may continue on the next lines`)
  }
  if (st.nested) {
    return refuse(check, `line ${st.nested.n}: ${keyName(st.nested.key)} has lines nested under it; plur folders repair does not change a file that holds them`)
  }
  const stray = s.lines.find((_, i) => st.roles[i].role === 'stray')
  if (stray) return refuse(check, `line ${stray.n}: plur folders repair cannot tell where this line belongs`)

  // 1. Indentation and tabs — only when the parser refuses the file.
  let parses = true
  try { yaml.load(text.replace(/^\uFEFF/, '')) } catch { parses = false }
  if (!parses) {
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

  // 2. Misspelled keys, 3. modes: on the (re-indented) text.
  const s2 = scan(join(s, out))
  const st2 = structure(s2)
  const present = new Set([...st2.tops.keys()])
  s2.lines.forEach((l, i) => {
    const r = st2.roles[i]
    if (r.role === 'top' && !(TOP_KEYS as readonly string[]).includes(r.key)) {
      const want = suggestTopKey(r.key)
      if (!want || present.has(want)) return
      present.add(want)
      out[i] = renameKey(l, r.key, want)
      fixes.push({ line: l.n, column: 1, fixable: true, change: `\`${r.key}:\` → \`${want}:\``,
        message: `line ${l.n}: unknown key ${keyName(r.key)} — did you mean \`${want}:\`?` })
      return
    }
    const entryKey = r.role === 'entry-key' ? r.key : r.role === 'item' ? l.key : undefined
    if (entryKey === undefined) return
    let key = entryKey
    if (!ENTRY_KEYS.has(entryKey)) {
      const want = suggestEntryKey(entryKey)
      const entry = st2.entries[r.role === 'item' || r.role === 'entry-key' ? r.entry : -1]
      if (!want || !entry || entry.keys.has(want)) return
      out[i] = renameKey(l, entryKey, want)
      fixes.push({ line: l.n, column: l.lead.length + 1, fixable: true, change: `\`${entryKey}:\` → \`${want}:\``,
        message: `line ${l.n}: unknown key \`${entryKey}:\` — did you mean \`${want}:\`?` })
      key = want
      // A renamed `plur:` keeps its value exactly: it must already be a mode.
      if (key === 'plur') return
    }
    if (key === 'plur') {
      const line = scan(out[i]).lines[0] ?? l
      const span = valueSpan({ ...line, n: l.n })
      if (!span || (MODES as readonly string[]).includes(span.value)) return
      const want = suggestMode(span.value)
      if (!want) return
      out[i] = out[i].slice(0, span.start) + want + out[i].slice(span.end)
      fixes.push({ line: l.n, column: span.start + 1, fixable: true, change: `\`plur:\` set to ${want}`,
        message: `line ${l.n}: \`plur:\` must be on, off or ask — set to \`${want}\`` })
    }
  })

  const after = join(s, out)
  if (after === text) return unfixable(check)
  const recheck = checkFolderMapText(after)
  if (!recheck.ok) return unfixable(recheck)
  // The hard rule (#1530 review): the result holds exactly the entries, keys
  // and values written on their own lines in the original; only an active
  // `plur:` mode may change, and only to the mode its case or letter points at.
  const broken = keepsWhatWasWritten(s, st, after)
  if (broken) return refuse(check, broken)
  const switchedOn = onWithoutLiteralOn(s, st, after)
  if (switchedOn !== null) {
    return refuse(check, `line ${switchedOn}: this entry turns memory on through \`scope:\` or \`trusted:\` (or a \`plur:\` that is not written as a plain \`on\`), and plur folders repair never repairs such an entry — fix the problem named for it by hand`)
  }
  return finish(text, after, fixes, opts)
}

/**
 * A line that uses YAML beyond what a folder map needs — a tag (`!x`, `!!str`),
 * an anchor (`&a`), an alias (`*a`) or a block scalar (`|`, `>`) — anywhere
 * outside quotes and comments, or null. One plain check over the whole file
 * (#1530 re-review R1): such a file is never repaired.
 */
function yamlFeatureLine(s: Scan): Line | null {
  for (const l of s.lines) {
    if (l.kind === 'blank' || l.kind === 'comment') continue
    const bare = l.body
      .replace(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'/g, '""')
      .replace(/(^|[ \t])#.*$/, '$1')
    if (/(^|[\s\-:[{,?])[!&*]\S/.test(bare)) return l
    if (/(^|[\s:\-])[|>][-+0-9]*[ \t]*$/.test(bare)) return l
  }
  return null
}

/**
 * The first line of an entry that would resolve to `on` after the repair
 * although none of its own lines is literally `plur: on` (any case), or null.
 * `on` means `plur: on`, or no `plur` with a `scope` or `trusted: true` —
 * the resolver's rule. This is the promise itself, checked on the result: a
 * repair never switches memory on (#1530 re-review).
 */
function onWithoutLiteralOn(s: Scan, st: Structure, after: string): number | null {
  let parsed: unknown
  try { parsed = yaml.load(after.replace(/^\uFEFF/, '')) } catch { return st.entries[0]?.line.n ?? 1 }
  const folders = (parsed as { folders?: unknown })?.folders
  if (!Array.isArray(folders)) return null
  const literalOn = st.entries.map(() => false)
  s.lines.forEach((l, i) => {
    const r = st.roles[i]
    if ((r.role !== 'item' && r.role !== 'entry-key') || l.key !== 'plur') return
    // The token as written, not the decoded value: an escape (`"\x6fn"`)
    // means `on` to YAML but is not a literal `on` (final review S1).
    const span = valueSpan(l)
    if (span && !span.value.includes('\\') && span.value.toLowerCase() === 'on') literalOn[r.entry] = true
  })
  for (let i = 0; i < folders.length; i++) {
    const e = folders[i] as Record<string, unknown> | null
    if (!e || typeof e !== 'object') continue
    const on = e.plur === 'on' || (e.plur === undefined && (e.scope !== undefined || e.trusted === true))
    if (on && !literalOn[i]) return st.entries[i]?.line.n ?? 1
  }
  return null
}

function renameKey(l: Line, from: string, to: string): string {
  const at = l.text.indexOf(from, l.lead.length)
  return l.text.slice(0, at) + to + l.text.slice(at + from.length)
}

/** The value a single key line holds on its own line, or undefined when that line is not a self-contained `key: value`. */
function lineValue(l: Line): { ok: true; value: unknown } | { ok: false } {
  const content = l.kind === 'item' ? l.body.slice(1 + (l.gap ?? '').length) : l.body
  try {
    const v = yaml.load(content)
    if (l.kind === 'item' && l.inlineValue) return { ok: true, value: v }
    if (!v || typeof v !== 'object' || Array.isArray(v) || !l.key) return { ok: false }
    const keys = Object.keys(v)
    if (keys.length !== 1 || keys[0] !== l.key) return { ok: false }
    return { ok: true, value: (v as Record<string, unknown>)[l.key] }
  } catch {
    return { ok: false }
  }
}

/**
 * Null when `after` parses to exactly what the original says line by line,
 * else why not. Compared on the parsed result, so nothing the line-based
 * repair might misread can slip through: the same number of entries, each
 * with exactly the keys written on its own lines (a misspelled key counts as
 * the key it was renamed to), each value equal to the one on that line —
 * except an active `plur:` value, which may only become suggestMode() of it.
 * A commented-out mode is no value, so it can never become one.
 */
function keepsWhatWasWritten(s: Scan, st: Structure, after: string): string | null {
  const fail = (n?: number) => `${n !== undefined ? `line ${n}: ` : ''}plur folders repair cannot show that the repair keeps every entry exactly as written`
  let parsed: unknown
  try { parsed = yaml.load(after.replace(/^\uFEFF/, '')) } catch { return fail() }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail()
  const obj = parsed as Record<string, unknown>
  const s2 = scan(after)
  if (s2.lines.length !== s.lines.length) return fail()
  const folders = Array.isArray(obj.folders) ? obj.folders as Array<Record<string, unknown>> : obj.folders == null ? [] : null
  if (!folders || folders.length !== st.entries.length) return fail()
  // version, as written.
  for (const [k, ls] of st.tops) {
    const name = suggestTopKey(k)
    if (name !== 'version') continue
    const lv = lineValue(ls[0])
    if (!lv.ok || !isDeepStrictEqual(lv.value, obj.version)) return fail(ls[0].n)
  }
  const seen: Array<Set<string>> = folders.map(() => new Set())
  for (let i = 0; i < s.lines.length; i++) {
    const r = st.roles[i]
    if (r.role !== 'item' && r.role !== 'entry-key') continue
    const l = s.lines[i]
    const entry = folders[r.entry]
    if (!entry || typeof entry !== 'object') return fail(l.n)
    if (r.role === 'item' && l.inlineValue) {
      const lv = lineValue(l)
      if (!lv.ok || !isDeepStrictEqual(lv.value, entry)) return fail(l.n)
      for (const k of Object.keys(entry)) seen[r.entry].add(k)
      continue
    }
    if (r.role === 'item' && !l.key) continue
    const orig = l.key!
    const now = s2.lines[i].key
    if (!now) return fail(l.n)
    if (now !== orig && (ENTRY_KEYS.has(orig) || suggestEntryKey(orig) !== now)) return fail(l.n)
    if (seen[r.entry].has(now)) return fail(l.n)
    seen[r.entry].add(now)
    const lv = lineValue(l)
    if (!lv.ok) return fail(l.n)
    const v = entry[now]
    if (now === 'plur' && !isDeepStrictEqual(lv.value, v)) {
      if (typeof lv.value !== 'string' || suggestMode(lv.value) !== v) return fail(l.n)
    } else if (!isDeepStrictEqual(lv.value, v)) {
      return fail(l.n)
    }
  }
  for (let e = 0; e < folders.length; e++) {
    const keys = Object.keys(folders[e] ?? {})
    if (keys.length !== seen[e].size || keys.some(k => !seen[e].has(k))) return fail(st.entries[e]?.line.n)
  }
  return null
}

/** Unfixable, with the reason the repair refuses first. */
function refuse(check: { ok: false; issues: FolderMapIssue[] }, why: string): FolderMapRepairPlan {
  const m = /^line (\d+): /.exec(why)
  const reason: FolderMapIssue = { ...(m ? { line: Number(m[1]), column: 1 } : {}), fixable: false, message: why }
  const rest = check.issues.map(i => ({ ...i, fixable: false }))
  return { status: 'unfixable', issues: [...rest.slice(0, 1), reason, ...rest.slice(1)] }
}

function unfixable(check: { ok: false; issues: FolderMapIssue[] }): FolderMapRepairPlan {
  const manual = check.issues.filter(i => !i.fixable)
  const issues = (manual.length > 0 ? manual : check.issues).map(i => ({ ...i, fixable: false }))
  return { status: 'unfixable', issues }
}

/** "line 4: indentation; line 2: `folder:` → `folders:`" — what the repair changes, without values. */
function summarize(fixes: FolderMapIssue[]): string {
  return fixes.map(f => (f.line !== undefined ? `line ${f.line}: ` : '') + (f.change ?? 'fixed')).join('; ')
}

function finish(before: string, after: string, fixes: FolderMapIssue[], opts: { diff?: boolean }): FolderMapRepairPlan {
  fixes.sort((a, b) => (a.line ?? Infinity) - (b.line ?? Infinity))
  return {
    status: 'fixable', after, fixes, summary: summarize(fixes),
    diff: opts.diff === false ? '' : unifiedDiff(before, after, 'folders.yaml (now)', 'folders.yaml (repaired)'),
  }
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

// ---------------------------------------------------------------------------
// In-place edits (#1562): `plur folders set` / `rm` keep the user's lines.
// ---------------------------------------------------------------------------

/** Entries a write changes, by their index in the file's `folders:` list. */
export interface FolderMapTextEdit {
  /** How many entries the file holds now (the parsed map's count). */
  count: number
  /** The new entry for an index, or null to remove it. */
  replace: Map<number, Record<string, unknown> | null>
  /** Entries added at the end of the list. */
  append: Array<Record<string, unknown>>
}

const ENTRY_KEY_ORDER = ['path', 'plur', 'scope', 'trusted', 'literal']

/** One value as YAML on a single line, as `yaml.dump` writes it. Null when it needs more. */
function inlineYaml(v: unknown): string | null {
  const out = yaml.dump(v, { flowLevel: 0, lineWidth: -1 }).replace(/\n$/, '')
  return out.includes('\n') ? null : out
}

/**
 * The folder map's text with only the changed entries' lines rewritten (#1562):
 * every comment, blank line and untouched entry stays as the user wrote it,
 * the way `plur folders repair` edits lines in place. A changed entry keeps
 * each of its lines whose key and value did not change (an inline comment
 * there survives); the rest of its lines are rewritten in its own
 * indentation. A removed entry loses its own lines only; new entries go after
 * the last one. Null when the text is not a plain, valid block list this can
 * edit safely (a flow list, a block scalar, an entry not written as
 * `- key: value`, or a count that does not match) — the caller then writes
 * the whole map. The caller checks the result reads back as intended.
 */
export function editFolderMapText(text: string, edit: FolderMapTextEdit): string | null {
  if (!checkFolderMapText(text).ok) return null
  const s = scan(text)
  if (s.loneCR) return null
  const st = structure(s)
  if (st.block || st.nested) return null
  if (st.entries.length !== edit.count) return null
  if (st.entries.some(e => !e.line.key || e.line.inlineValue)) return null
  const first = st.entries[0]?.line
  const itemLead = first ? first.lead : '  '
  const gap = first ? (first.gap || ' ') : ' '
  const keyIndent = ' '.repeat(itemLead.length + 1 + gap.length)
  const render = (entry: Record<string, unknown>, old?: { line: Line; keys: Map<string, Line> }): string[] | null => {
    const keys = [...ENTRY_KEY_ORDER.filter(k => entry[k] !== undefined), ...Object.keys(entry).filter(k => !ENTRY_KEY_ORDER.includes(k) && entry[k] !== undefined)]
    if (keys[0] !== 'path') return null
    const lines: string[] = []
    for (const [i, k] of keys.entries()) {
      const prev = old?.keys.get(k)
      if (prev) {
        const was = lineValue(prev)
        // Unchanged, and on the same kind of line (the item line stays the item line).
        if (was.ok && isDeepStrictEqual(was.value, entry[k]) && (i === 0) === (prev === old!.line)) { lines.push(prev.text); continue }
      }
      if (!/^[A-Za-z_][A-Za-z0-9_-]{0,39}$/.test(k)) return null
      const v = inlineYaml(entry[k])
      if (v === null) return null
      lines.push(i === 0 ? `${old ? old.line.lead : itemLead}-${old ? (old.line.gap || ' ') : gap}${k}: ${v}` : `${old ? ' '.repeat(old.line.lead.length + 1 + (old.line.gap || ' ').length) : keyIndent}${k}: ${v}`)
    }
    return lines
  }
  // Line number → what replaces it ([] drops it). Untouched lines are absent.
  const out = new Map<number, string[]>()
  for (const [idx, next] of edit.replace) {
    const e = st.entries[idx]
    if (!e) return null
    const own = [e.line, ...[...e.keys.values()].filter(l => l !== e.line)]
    for (const l of own) out.set(l.n, [])
    if (next) {
      const lines = render(next, e)
      if (!lines) return null
      out.set(e.line.n, lines)
    }
  }
  const added: string[] = []
  for (const entry of edit.append) {
    const lines = render(entry)
    if (!lines) return null
    added.push(...lines)
  }
  // After the last line of the last entry; with none, right after `folders:`.
  let after: number
  if (st.entries.length > 0) {
    const last = st.entries[st.entries.length - 1]
    after = Math.max(last.line.n, ...[...last.keys.values()].map(l => l.n))
  } else {
    const top = st.tops.get('folders')
    if (added.length > 0 && (!top || top.length !== 1 || (top[0].value !== '' && !top[0].value!.startsWith('#')))) return null
    after = top ? top[0].n : 0
  }
  const result: string[] = []
  for (const l of s.lines) {
    const swap = out.get(l.n)
    result.push(...(swap ?? [l.text]))
    if (l.n === after && added.length > 0) result.push(...added)
  }
  return join(s, result)
}
