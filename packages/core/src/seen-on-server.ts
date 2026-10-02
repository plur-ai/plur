/**
 * Ids this machine has seen on a server (#1532 re-audit R2).
 *
 * Every store mints `ENG-<date>-NNN` from its own counter, so a bare id can
 * name a local engram and an unrelated team engram at once. Recall prints
 * team engrams under their bare server id, and a caller (an agent, the Hermes
 * bridge) can later pass that id to `forget`. When the team store then
 * rejects the token, the collision probe cannot look, and the only evidence
 * left is what this machine remembers. Recall used to leave no trace, and the
 * outbox id map is capped and lives under `cache/`.
 *
 * So: an append-only JSONL record in the plur dir (not `cache/`, which is
 * pruned; not synced), one line per sighting — `{"id","scope","at"}`.
 *
 * Bounded by ROTATION, never by rewriting (#1532 re-audit 2, S1/S7). When the
 * live file passes {@link SEEN_ON_SERVER_GENERATION_BYTES} it is renamed over
 * the previous generation, and lookups read both. A rename is atomic and moves
 * the inode, so a line another process appends at that moment lands either in
 * the generation just renamed (still read) or in the fresh live file — it is
 * never overwritten by a snapshot, which is how the first version, a
 * read-compact-rename of the live file, lost concurrent lines. The total size
 * is a real byte bound, about two generations, whatever the line length.
 *
 * Appends are best effort: this is evidence for a refusal, never a gate on
 * recall, so every failure is swallowed.
 */
import * as fs from 'fs'
import { join } from 'path'

export const SEEN_ON_SERVER_FILE = 'seen-on-server.jsonl'
/** The previous generation, read alongside the live file. */
export const SEEN_ON_SERVER_PREVIOUS_FILE = 'seen-on-server.1.jsonl'
/** Rotate the live file past this size. Total on disk stays about twice this. */
export const SEEN_ON_SERVER_GENERATION_BYTES = 8 * 1024 * 1024
const ROTATE_LOCK = 'seen-on-server.rotate.lock'
/** A rotate lock older than this belongs to a writer that died holding it. */
const STALE_LOCK_MS = 30_000

export interface SeenOnServer { id: string; scope: string; at: number }

/** Record server ids just seen (recall results, delivered outbox rows, a confirmed save). */
export function recordSeenOnServer(root: string, entries: ReadonlyArray<{ id: string; scope: string }>): void {
  if (entries.length === 0) return
  try {
    const at = Date.now()
    const seen = new Set<string>()
    let lines = ''
    for (const e of entries) {
      if (typeof e.id !== 'string' || !e.id || seen.has(e.id)) continue
      seen.add(e.id)
      lines += JSON.stringify({ id: e.id, scope: e.scope, at }) + '\n'
    }
    if (!lines) return
    fs.mkdirSync(root, { recursive: true })
    const path = join(root, SEEN_ON_SERVER_FILE)
    const fd = fs.openSync(path, 'a+', 0o600)
    let size = 0
    try {
      size = fs.fstatSync(fd).size
      // A writer killed mid-append leaves a last line with no newline; glued
      // to it, this append would be one unparseable line (S2). Start on a
      // fresh line instead — empty lines are skipped on read.
      if (size > 0) {
        const last = Buffer.alloc(1)
        fs.readSync(fd, last, 0, 1, size - 1)
        if (last[0] !== 0x0a) lines = '\n' + lines
      }
      fs.writeSync(fd, lines)
    } finally {
      fs.closeSync(fd)
    }
    if (size + Buffer.byteLength(lines) > SEEN_ON_SERVER_GENERATION_BYTES) rotate(root)
  } catch { /* evidence only — never fail the caller */ }
}

/**
 * The most recent valid sighting of a bare server id, or null. Reads both
 * generations. A record without a string `id` or a numeric `at` is damaged
 * (hand-edited, torn) and ignored, never an error (S3).
 */
export function seenOnServer(root: string, id: string): SeenOnServer | null {
  const needle = JSON.stringify(id)
  let found: SeenOnServer | null = null
  for (const name of [SEEN_ON_SERVER_PREVIOUS_FILE, SEEN_ON_SERVER_FILE]) {
    let text: string
    try { text = fs.readFileSync(join(root, name), 'utf8') } catch { continue }
    for (const line of text.split('\n')) {
      if (!line.includes(needle)) continue
      try {
        const row = JSON.parse(line) as Partial<SeenOnServer>
        if (row.id === id && typeof row.at === 'number' && Number.isFinite(row.at)) {
          found = { id: row.id, scope: typeof row.scope === 'string' ? row.scope : '', at: row.at }
        }
      } catch { /* torn line */ }
    }
  }
  return found
}

/**
 * Move the live file over the previous generation. One rotator at a time
 * (an O_EXCL lock), and it re-checks the size under the lock, so two writers
 * that both crossed the bound rotate once — a second rename would push the
 * generation just rotated out before anyone could read it.
 */
function rotate(root: string): void {
  const lock = join(root, ROTATE_LOCK)
  let fd: number
  try {
    fd = fs.openSync(lock, 'wx', 0o600)
  } catch {
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > STALE_LOCK_MS) fs.rmSync(lock, { force: true })
    } catch { /* gone already */ }
    return // someone else is rotating; the next append retries if still needed
  }
  try {
    fs.closeSync(fd)
    const live = join(root, SEEN_ON_SERVER_FILE)
    if (fs.statSync(live).size <= SEEN_ON_SERVER_GENERATION_BYTES) return
    fs.renameSync(live, join(root, SEEN_ON_SERVER_PREVIOUS_FILE))
  } catch { /* best effort */ } finally {
    try { fs.rmSync(lock, { force: true }) } catch { /* ignore */ }
  }
}
