import { Document, isMap, isScalar, isSeq, parseDocument, stringify, type Pair, type YAMLMap } from 'yaml'

/**
 * The text of `<PLUR home>/folders.yaml`, written so that a person's edits
 * survive the CLI's (owner decision 2026-10-01).
 *
 * A new file starts from {@link FOLDER_MAP_TEMPLATE}: a commented example of
 * every setting, each with one line saying what it does, placed where removing
 * the `# ` makes it a real entry. Every later write edits the file IN PLACE:
 * the `yaml` package's Document API locates each entry and value in the source
 * text, and only the bytes of the entry that changed are rewritten. Comments,
 * blank lines, key order and quoting everywhere else are kept byte for byte.
 *
 * The edit is checked: the result is parsed again and must hold exactly the
 * entries asked for. A file whose shape the surgical edit does not handle (a
 * flow-style list, an entry that is not a mapping, a nested value) falls back
 * to the Document API's own rewrite, which keeps comments but may reformat;
 * only if that also fails to round-trip is the file written plain.
 */

/** Keep this the only place the template lives: tests read it back. */
export const FOLDER_MAP_TEMPLATE = [
  '# PLUR folder map: what PLUR does in each folder.',
  '#',
  '# `plur folders set` / `plur folders rm`, `plur trust` / `plur untrust` and the',
  '# folder question at the start of a session write this file. You can edit it',
  '# by hand too: PLUR keeps your comments and the order of entries when it writes.',
  '#',
  '# An entry names a folder (or a glob such as ~/work/**). The most specific entry',
  '# for a folder wins, and `off` on a folder or any folder above it always wins.',
  '# A folder with no entry and no project setup is asked about once per session.',
  '#',
  '# Examples: to use one, remove the "# " in front of its lines, and the "[]"',
  '# after "folders:" if it is still there.',
  'version: 1',
  'folders: []',
  '  # - path: ~/code/app',
  '  #   plur:     on            # on: memory works here as usual (recall, inject, learn)',
  '  # - path: ~/private/**',
  '  #   plur:     off           # off: PLUR does nothing at all here',
  '  # - path: ~/scratch',
  '  #   plur:     ask           # ask: ask once per session what to do here',
  '  # - path: ~/work/**',
  '  #   scope:    group:acme/eng   # scope: default scope for memories saved here (implies on)',
  '  # - path: ~/src/team-repo',
  '  #   trusted:  true          # trusted: this folder\'s .plur.yaml may set its scope and team server',
  '  # - path: ~/client-work/**',
  '  #   plur:     remote-only   # remote-only: memory lives only on the team server, in `scope`;',
  '  #   scope:    group:acme/client   #   your personal memories are neither read nor written there',
  '',
].join('\n')

type Entry = Record<string, unknown>

interface Edit { start: number; end: number; text: string; seq: number }

function lineStart(src: string, pos: number): number {
  return src.lastIndexOf('\n', pos - 1) + 1
}

/** Offset just past the newline that ends the line holding `pos` (or EOF). */
function lineEndIncl(src: string, pos: number): number {
  const i = src.indexOf('\n', pos)
  return i === -1 ? src.length : i + 1
}

function renderScalar(v: unknown): string {
  return stringify(v, { lineWidth: 0 }).replace(/\n$/, '')
}

/** A new entry's keys in reading order: the folder, then what is decided for it. */
const KEY_ORDER = ['path', 'plur', 'scope', 'trusted', 'literal']

function ordered(e: Entry): Entry {
  const out: Entry = {}
  for (const k of KEY_ORDER) if (k in e && e[k] !== undefined) out[k] = e[k]
  for (const [k, v] of Object.entries(e)) if (!(k in out) && v !== undefined) out[k] = v
  return out
}

function renderItem(e: Entry, indent: number): string {
  const body = new Document(ordered(e)).toString({ lineWidth: 0 }).replace(/\n$/, '')
  const pad = ' '.repeat(indent)
  return body.split('\n').map((l, i) => (i === 0 ? `${pad}- ${l}` : `${pad}  ${l}`)).join('\n') + '\n'
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function sameEntries(a: unknown, b: Entry[]): boolean {
  const arr = Array.isArray(a) ? a : (a === null || a === undefined ? [] : null)
  if (!arr || arr.length !== b.length) return false
  return arr.every((x, i) => {
    if (!x || typeof x !== 'object') return false
    const xo = x as Entry
    const keys = new Set([...Object.keys(xo), ...Object.keys(b[i])])
    for (const k of keys) if (!sameValue(xo[k], b[i][k])) return false
    return true
  })
}

/** True when `text` parses to a map whose `folders` are exactly `next`. */
function holds(text: string, next: Entry[]): boolean {
  try {
    const doc = parseDocument(text)
    if (doc.errors.length > 0) return false
    const js = doc.toJS() as { folders?: unknown } | null
    return sameEntries(js?.folders, next)
  } catch {
    return false
  }
}

function applyEdits(src: string, edits: Edit[]): string {
  const sorted = [...edits].sort((x, y) => (y.start - x.start) || (y.seq - x.seq))
  let out = src
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  return out
}

/** Insert `text` at `pos`, starting a new line first when `pos` is mid-line at EOF. */
function insertAt(src: string, pos: number, text: string, seq: number): Edit {
  const needsNl = pos > 0 && pos === src.length && !src.endsWith('\n')
  return { start: pos, end: pos, text: (needsNl ? '\n' : '') + text, seq }
}

function surgical(src: string, next: Entry[]): string | null {
  const doc = parseDocument(src)
  if (doc.errors.length > 0) return null
  const top = doc.contents
  if (!isMap(top)) return null
  const pairs = top.items as Pair[]
  const idx = pairs.findIndex(p => isScalar(p.key) && p.key.value === 'folders')
  const edits: Edit[] = []
  let seq = 0

  if (idx === -1) {
    // No `folders` key: append one at the end.
    const text = next.length === 0 ? 'folders: []\n' : 'folders:\n' + next.map(e => renderItem(e, 2)).join('')
    edits.push(insertAt(src, src.length, text, seq++))
    return applyEdits(src, edits)
  }

  const pair = pairs[idx]
  const key = pair.key as { range?: [number, number, number] }
  if (!key.range) return null
  const colon = src.indexOf(':', key.range[1])
  if (colon === -1) return null
  // Where a new entry goes when the list is empty: the end of this key's
  // section, which is the start of the next top-level key's line, or EOF.
  const after = pairs[idx + 1]
  const nextKeyStart = after && (after.key as { range?: [number, number, number] })?.range
    ? lineStart(src, (after.key as { range: [number, number, number] }).range[0])
    : src.length
  const value = pair.value as unknown

  const emptyValue = value === null || value === undefined ||
    (isScalar(value) && (value.value === null || value.value === undefined)) ||
    (isSeq(value) && value.items.length === 0)
  if (emptyValue) {
    if (next.length === 0) return src
    if (isSeq(value) && value.flow) {
      const r = (value as { range?: [number, number, number] }).range
      if (!r) return null
      // Remove ` []` (and the spaces before it).
      let s = r[0]
      while (s > colon + 1 && (src[s - 1] === ' ' || src[s - 1] === '\t')) s--
      edits.push({ start: s, end: r[1], text: '', seq: seq++ })
    } else if (isSeq(value)) {
      return null
    }
    edits.push(insertAt(src, nextKeyStart, next.map(e => renderItem(e, 2)).join(''), seq++))
    return applyEdits(src, edits)
  }

  if (!isSeq(value) || value.flow) return null
  const items = value.items
  if (!items.every(i => isMap(i))) return null
  const maps = items as YAMLMap[]

  // Where each item starts (its `- `) and ends (end of its last value's line).
  const spans: Array<{ dash: number; end: number; keyCol: number; map: YAMLMap }> = []
  for (const m of maps) {
    const r = (m as { range?: [number, number, number] }).range
    if (!r || m.items.length === 0) return null
    const ls = lineStart(src, r[0])
    const dash = src.lastIndexOf('-', r[0] - 1)
    if (dash < ls) return null
    const last = m.items[m.items.length - 1] as Pair
    const lv = last.value as { range?: [number, number, number] } | null
    const lk = last.key as { range?: [number, number, number] }
    const endPos = lv?.range ? lv.range[1] : lk?.range ? lk.range[1] : null
    if (endPos === null) return null
    spans.push({ dash, end: lineEndIncl(src, endPos), keyCol: r[0] - ls, map: m })
  }
  const dashIndent = spans[0].dash - lineStart(src, spans[0].dash)

  const removeItem = (k: number) => {
    edits.push({ start: lineStart(src, spans[k].dash), end: spans[k].end, text: '', seq: seq++ })
  }

  const updateItem = (k: number, want: Entry): boolean => {
    const { map, keyCol, end } = spans[k]
    const r = (map as { range?: [number, number, number] }).range!
    const have = map.toJSON() as Entry
    const added: string[] = []
    for (const p of map.items as Pair[]) {
      if (!isScalar(p.key)) return false
      const name = String(p.key.value)
      const kr = (p.key as { range?: [number, number, number] }).range
      if (!kr) return false
      if (!(name in want) || want[name] === undefined) {
        // A key the entry no longer has: drop its line. Not the first key,
        // which shares its line with the `- `.
        if (kr[0] === r[0]) return false
        const v = p.value as { range?: [number, number, number] } | null
        if (v && !isScalar(v)) return false
        const vEnd = v?.range ? v.range[1] : kr[1]
        edits.push({ start: lineStart(src, kr[0]), end: lineEndIncl(src, vEnd), text: '', seq: seq++ })
      } else if (!sameValue(have[name], want[name])) {
        const v = p.value
        if (!isScalar(v) || !(v as { range?: [number, number, number] }).range) return false
        if (want[name] !== null && typeof want[name] === 'object') return false
        const vr = (v as { range: [number, number, number] }).range
        edits.push({ start: vr[0], end: vr[1], text: renderScalar(want[name]), seq: seq++ })
      }
    }
    for (const [name, v] of Object.entries(want)) {
      if (v === undefined || name in have) continue
      if (v !== null && typeof v === 'object') return false
      added.push(`${' '.repeat(keyCol)}${renderScalar(name)}: ${renderScalar(v)}\n`)
    }
    if (added.length) edits.push(insertAt(src, end, added.join(''), seq++))
    return true
  }

  // Greedy in-order match by `path`: CLI writes only update, remove, merge
  // into one place, or append, so file order is kept.
  const paths = maps.map(m => (m.toJSON() as Entry).path)
  let j = 0
  for (const want of next) {
    let k = -1
    for (let x = j; x < maps.length; x++) if (paths[x] === want.path) { k = x; break }
    if (k === -1) {
      const at = j < maps.length ? lineStart(src, spans[j].dash) : spans[spans.length - 1].end
      edits.push(insertAt(src, at, renderItem(want, dashIndent), seq++))
      continue
    }
    for (let x = j; x < k; x++) removeItem(x)
    if (!updateItem(k, want)) return null
    j = k + 1
  }
  for (let x = j; x < maps.length; x++) removeItem(x)
  if (next.length === 0) edits.push({ start: colon + 1, end: colon + 1, text: ' []', seq: seq++ })
  return applyEdits(src, edits)
}

/**
 * The folders.yaml text holding `entries`, as an edit of `previous` (the
 * current file text, or null when there is none yet: the template is used).
 */
export function renderFolderMapText(previous: string | null, entries: Entry[]): string {
  const src = previous ?? FOLDER_MAP_TEMPLATE
  try {
    const out = surgical(src, entries)
    if (out !== null && holds(out, entries)) return out
  } catch { /* fall through to the rewrite */ }
  try {
    const doc = parseDocument(src)
    if (doc.errors.length === 0 && isMap(doc.contents)) {
      doc.set('folders', doc.createNode(entries))
      const out = doc.toString({ lineWidth: 0 })
      if (holds(out, entries)) return out
    }
  } catch { /* fall through to the plain dump */ }
  return new Document({ version: 1, folders: entries }).toString({ lineWidth: 0 })
}
