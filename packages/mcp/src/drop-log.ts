import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { atomicWrite, withLock } from '@plur-ai/core'

/**
 * Forensic log for MCP argument-payload drops (plur-ai/plur#772).
 *
 * The #772 failure signature — a tool call arriving with an EMPTY arguments
 * object (`received_fields: []`) — is intermittent and originates client-side,
 * before the frame reaches this server (the wire-protocol tests from #297/#301
 * prove the server handles the same payloads correctly). That makes it
 * impossible to reproduce on demand; the only way to progress the upstream
 * report is to record each occurrence as it happens in the wild, with exactly
 * the wire-level facts the report needs.
 *
 * Contract:
 *  - NO VALUES, ever. Records carry field NAMES and frame metadata only. A
 *    whole-payload drop has no values by definition; a partial drop does, and
 *    those never enter this file — engram statements can contain anything.
 *  - Bounded. The file is trimmed to the newest {@link PAYLOAD_DROP_LOG_MAX_ENTRIES}
 *    records on every write, so a pathological client cannot grow it unbounded.
 *  - Best-effort. A diagnostics write must never break the tool call it is
 *    diagnosing — every failure path is swallowed.
 */

/** Newest-N cap applied on every write. */
export const PAYLOAD_DROP_LOG_MAX_ENTRIES = 100

export interface PayloadDropRecord {
  /** ISO-8601 timestamp of the drop. */
  ts: string
  /** Tool the dropped call was addressed to. */
  tool: string
  /**
   * How `params.arguments` looked on the wire — the one bit only this boundary
   * can observe, and the first thing an upstream client report needs:
   *  - 'absent'       — the `arguments` key was missing from the frame entirely
   *  - 'empty_object' — the key arrived, carrying `{}`
   *  - 'partial'      — some fields arrived, required ones (observed: trailing
   *                     array-typed ones, #297) did not
   */
  arguments_wire: 'absent' | 'empty_object' | 'partial'
  /** Top-level key NAMES of `request.params` (e.g. name, arguments, _meta). */
  params_keys: string[]
  /** Field NAMES that did arrive — never their values. */
  received_fields: string[]
  /** Schema-required field NAMES that were missing. */
  missing_fields: string[]
  /** JSON-RPC request id, when the SDK exposes it. */
  request_id?: string | number
  /** @plur-ai/mcp version that recorded the drop. */
  server_version: string
}

export function payloadDropLogPath(storageRoot: string): string {
  return join(storageRoot, 'logs', 'payload-drops.jsonl')
}

/**
 * Append one record, keeping only the newest {@link PAYLOAD_DROP_LOG_MAX_ENTRIES}.
 * Never throws.
 */
export function recordPayloadDrop(storageRoot: string, record: PayloadDropRecord): void {
  try {
    const path = payloadDropLogPath(storageRoot)
    mkdirSync(dirname(path), { recursive: true })

    // Append, rather than read-all-and-rewrite (#805, audit F15). The old body
    // read the file, pushed one record, and wrote the whole thing back with a
    // plain writeFileSync and no lock — so two MCP servers (a CLI session and
    // an editor session are the normal case, not the exotic one) each wrote
    // back a copy that predated the other's record, losing it, and a crash
    // mid-rewrite left a truncated file that took the earlier records with it.
    // A single short line through O_APPEND is atomic, so a concurrent server
    // never loses a record even without holding the lock.
    appendFileSync(path, JSON.stringify(record) + '\n')

    // Trimming IS a read-modify-write and does need the lock — it is the only
    // step that can destroy records. Bounded work: the file is at most
    // PAYLOAD_DROP_LOG_MAX_ENTRIES lines plus whatever raced in.
    const lines = readFileSync(path, 'utf8').split('\n').filter(l => l.length > 0)
    if (lines.length > PAYLOAD_DROP_LOG_MAX_ENTRIES) {
      withLock(path, () => {
        const current = readFileSync(path, 'utf8').split('\n').filter(l => l.length > 0)
        if (current.length <= PAYLOAD_DROP_LOG_MAX_ENTRIES) return // another server trimmed first
        // durable: false — this is diagnostics, and an fsync per dropped
        // payload buys nothing a forensic log needs.
        atomicWrite(path, current.slice(-PAYLOAD_DROP_LOG_MAX_ENTRIES).join('\n') + '\n', { durable: false })
      })
    }
  } catch {
    /* diagnostics must never break the tool call being diagnosed */
  }
}

/** Read all records (newest last). Missing or corrupt file → []. */
export function readPayloadDropLog(storageRoot: string): PayloadDropRecord[] {
  try {
    const path = payloadDropLogPath(storageRoot)
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(l => l.length > 0)
      .flatMap(l => {
        try { return [JSON.parse(l) as PayloadDropRecord] } catch { return [] }
      })
  } catch {
    return []
  }
}
