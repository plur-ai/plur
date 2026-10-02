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
 * So: a small append-only JSONL file in the plur dir (not `cache/`, which is
 * pruned), one line per sighting — `{"id","scope","at"}` — bounded to the
 * most recent {@link SEEN_ON_SERVER_MAX} distinct ids by an occasional
 * compaction. Appends are cheap and best-effort: this is evidence for a
 * refusal, never a gate on recall, so every failure is swallowed.
 */
import * as fs from 'fs'
import { join } from 'path'

export const SEEN_ON_SERVER_FILE = 'seen-on-server.jsonl'
/** Distinct ids kept after a compaction. */
export const SEEN_ON_SERVER_MAX = 50_000
/** Compact when the file grows past this many bytes (~2× the kept set). */
const COMPACT_AT_BYTES = 12 * 1024 * 1024

export interface SeenOnServer { id: string; scope: string; at: number }

/** Record server ids just seen (recall results, delivered outbox rows, a confirmed save). */
export function recordSeenOnServer(root: string, entries: ReadonlyArray<{ id: string; scope: string }>): void {
  if (entries.length === 0) return
  try {
    const path = join(root, SEEN_ON_SERVER_FILE)
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
    fs.appendFileSync(path, lines, { mode: 0o600 })
    if (fs.statSync(path).size > COMPACT_AT_BYTES) compact(path)
  } catch { /* evidence only — never fail the caller */ }
}

/** The most recent sighting of a bare server id, or null. Reads the whole file. */
export function seenOnServer(root: string, id: string): SeenOnServer | null {
  let text: string
  try { text = fs.readFileSync(join(root, SEEN_ON_SERVER_FILE), 'utf8') } catch { return null }
  const needle = JSON.stringify(id)
  let found: SeenOnServer | null = null
  for (const line of text.split('\n')) {
    if (!line.includes(needle)) continue
    try {
      const row = JSON.parse(line) as SeenOnServer
      if (row.id === id) found = row
    } catch { /* torn line */ }
  }
  return found
}

/** Keep the most recent sighting of the newest {@link SEEN_ON_SERVER_MAX} ids. */
function compact(path: string): void {
  const latest = new Map<string, string>()
  for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue
    try {
      const row = JSON.parse(line) as SeenOnServer
      if (typeof row.id !== 'string') continue
      latest.delete(row.id) // re-insert so Map order is recency order
      latest.set(row.id, line)
    } catch { /* drop torn lines */ }
  }
  const kept = [...latest.values()].slice(-SEEN_ON_SERVER_MAX)
  const tmp = `${path}.${process.pid}.tmp`
  fs.writeFileSync(tmp, kept.join('\n') + '\n', { mode: 0o600 })
  fs.renameSync(tmp, path)
}
