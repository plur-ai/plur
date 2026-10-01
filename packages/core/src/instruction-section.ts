import { copyFileSync, existsSync, writeFileSync } from 'fs'

/**
 * Put PLUR's instruction section into a file the user also writes in
 * (CLAUDE.md, AGENTS.md, Claw's SYSTEM.md), upgrading an older one.
 *
 * The one rule: text PLUR did not write is never removed (#1520 audit B1).
 * Before v4 the sections carried no end marker, so where an old section ends
 * cannot be read off the file. Instead an old section counts as PLUR's only
 * when its lines are, whitespace aside, a text PLUR shipped (the `shipped`
 * list, generated from git history by scripts/extract-plur-section-history.mjs).
 * Such a section is replaced; any other section under the same heading is
 * left exactly as it is, the new section is added beside it, and the result
 * reports it in `keptSections` so the caller can tell the user.
 *
 * Markdown is read with fenced code blocks in mind (S1): a heading or a
 * marker inside a fence is example text, not structure. A byte-order mark is
 * kept (N2), every PLUR section in the file is handled, not just the first
 * (N1), only a marker on a line of its own counts as an installed section
 * (N3), and a CRLF file stays CRLF (N4).
 */

export interface InstructionSectionOptions {
  /** The section to install: starts with the heading line, ends with the marker line. */
  section: string
  /** The heading line that opens a PLUR section, e.g. `## PLUR Memory`. Matched as a whole line. */
  heading: string
  /** The current version marker, e.g. `<!-- plur-instructions-v4 -->`. */
  marker: string
  /** Section texts PLUR has shipped before. Only these are ever replaced. */
  shipped: readonly string[]
  /** First line of a newly created file (e.g. `# CLAUDE.md`). Omitted: the file is just the section. */
  title?: string
}

export interface InstructionSectionResult {
  content: string
  /**
   * created: there was no file. added: the section was appended.
   * upgraded: a shipped section was replaced (and any other shipped copies
   * removed). already: a current section is present and nothing else changed.
   */
  status: 'created' | 'added' | 'upgraded' | 'already'
  /** Sections under the PLUR heading that PLUR did not write, left untouched. */
  keptSections: number
}

const BOM = '﻿'

/** The text a line holds, without a trailing CR. */
const bare = (line: string) => line.endsWith('\r') ? line.slice(0, -1) : line

/** Lines that are part of a fenced code block, fence lines included (CommonMark ``` and ~~~). */
function fencedLines(lines: string[]): boolean[] {
  const inFence: boolean[] = new Array(lines.length).fill(false)
  let open: { char: string; len: number } | null = null
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(bare(lines[i]))
    if (open) {
      inFence[i] = true
      if (m && m[1][0] === open.char && m[1].length >= open.len && m[2].trim() === '') open = null
    } else if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
      inFence[i] = true
      open = { char: m[1][0], len: m[1].length }
    }
  }
  return inFence
}

/** A line's content with surrounding whitespace removed; blank lines are skipped when comparing. */
const norm = (line: string) => bare(line).trim()

/** The non-blank, trimmed lines of a text — the form two texts are compared in. */
function significant(text: string): string[] {
  return text.replace(/^﻿/, '').split('\n').map(norm).filter(l => l !== '')
}

/**
 * If the lines starting at `start` are, ignoring blank lines and surrounding
 * whitespace, exactly the significant lines of one of the shipped texts,
 * return the index of the last line of that match. The longest match wins.
 */
function matchShipped(lines: string[], start: number, shipped: string[][]): number {
  let best = -1
  for (const want of shipped) {
    let i = start
    let k = 0
    let last = -1
    while (k < want.length && i < lines.length) {
      const got = norm(lines[i])
      if (got === '') { i++; continue }
      if (got !== want[k]) break
      last = i
      k++
      i++
    }
    if (k === want.length && last > best) best = last
  }
  return best
}

const isBoundary = (line: string) => /^ {0,3}#{1,2}(?:[ \t]|$)/.test(bare(line))

export function upsertInstructionSection(
  content: string | null,
  opts: InstructionSectionOptions,
): InstructionSectionResult {
  const fresh = opts.section.replace(/^\s+/, '')
  if (content === null) {
    return { content: opts.title ? `${opts.title}\n\n${fresh}` : fresh, status: 'created', keptSections: 0 }
  }

  const bom = content.startsWith(BOM)
  const body = bom ? content.slice(1) : content
  const crlf = body.includes('\r\n')
  const eol = crlf ? '\r\n' : '\n'
  const sectionLines = fresh.replace(/\n$/, '').split('\n').map(l => crlf ? l + '\r' : l)

  const lines = body.split('\n')
  const fenced = fencedLines(lines)
  const heading = opts.heading.trim()
  const shipped = opts.shipped.map(significant).filter(s => s.length > 0)

  type Found = { start: number; end: number; kind: 'current' | 'shipped' | 'user' }
  const found: Found[] = []
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i] || norm(lines[i]) !== heading || !/^ {0,3}#/.test(lines[i])) continue
    // A current section: its marker on a line of its own, outside any fence,
    // before the next level-1/2 heading.
    let current = false
    for (let j = i + 1; j < lines.length; j++) {
      if (fenced[j]) continue
      if (isBoundary(lines[j])) break
      if (norm(lines[j]) === opts.marker.trim()) { current = true; break }
    }
    if (current) { found.push({ start: i, end: i, kind: 'current' }); continue }
    const end = matchShipped(lines, i, shipped)
    found.push(end >= 0 ? { start: i, end, kind: 'shipped' } : { start: i, end: i, kind: 'user' })
  }

  const keptSections = found.filter(f => f.kind === 'user').length
  const shippedFound = found.filter(f => f.kind === 'shipped')
  const hasCurrent = found.some(f => f.kind === 'current')

  if (shippedFound.length === 0) {
    if (hasCurrent) return { content, status: 'already', keptSections }
    const kept = body.replace(/\s+$/, '')
    // Section lines already carry their CR in a CRLF file, so they join with '\n'.
    const out = (kept === '' ? '' : kept + eol + eol) + sectionLines.join('\n') + '\n'
    return { content: (bom ? BOM : '') + out, status: 'added', keptSections }
  }

  // Rebuild: the first shipped section becomes the new one (unless a current
  // section is already present); further shipped copies are removed. The lines
  // between them are copied unchanged.
  const out: string[] = []
  let pos = 0
  let placed = hasCurrent
  const isBlank = (l: string) => norm(l) === ''
  for (const f of shippedFound) {
    const before = lines.slice(pos, f.start)
    let after = f.end + 1
    while (after < lines.length && isBlank(lines[after]) && !(after === lines.length - 1 && lines[after] === '')) after++
    const restEmpty = after >= lines.length || (after === lines.length - 1 && lines[after] === '')
    if (!placed) {
      out.push(...before, ...sectionLines)
      placed = true
      if (!restEmpty) out.push(crlf ? '\r' : '')
    } else {
      // Removing a stale copy: keep one blank line between what came before and what follows.
      while (before.length && isBlank(before[before.length - 1])) before.pop()
      out.push(...before)
      if (!restEmpty && before.length) out.push(crlf ? '\r' : '')
    }
    pos = after
  }
  out.push(...lines.slice(pos))
  let text = out.join('\n')
  if (!text.endsWith('\n')) text += text.endsWith('\r') ? '\n' : eol
  return { content: (bom ? BOM : '') + text, status: 'upgraded', keptSections }
}

/** True when `content` is, whitespace aside, exactly one of the shipped texts. */
export function isShippedText(content: string, shipped: readonly string[]): boolean {
  const got = significant(content).join('\n')
  return shipped.some(s => significant(s).join('\n') === got)
}

/** True when `marker` stands on a line of its own outside any fenced block. */
export function hasStandaloneMarker(content: string, marker: string): boolean {
  const lines = content.replace(/^﻿/, '').split('\n')
  const fenced = fencedLines(lines)
  return lines.some((l, i) => !fenced[i] && norm(l) === marker.trim())
}

/** `name.plur-backup-YYYYMMDDTHHMMSSZ` next to the file. */
export function backupPath(path: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  let candidate = `${path}.plur-backup-${stamp}`
  for (let n = 2; existsSync(candidate); n++) candidate = `${path}.plur-backup-${stamp}-${n}`
  return candidate
}

/** Copy an existing file to a timestamped backup beside it; returns the backup path. */
export function backupFile(path: string): string | null {
  if (!existsSync(path)) return null
  const dest = backupPath(path)
  copyFileSync(path, dest)
  return dest
}

/**
 * Write `content` to `path`, first copying any existing file to a timestamped
 * backup beside it. Returns the backup path, or null when the file is new.
 */
export function writeWithBackup(path: string, content: string): string | null {
  const backup = backupFile(path)
  writeFileSync(path, content)
  return backup
}
