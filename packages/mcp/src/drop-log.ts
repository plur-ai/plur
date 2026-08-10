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

/**
 * Newest-N cap applied on every write.
 *
 * Raised from 100 when scalar-only partial drops started being recorded: that
 * population is dominated by ordinary caller errors and is far more frequent
 * than a genuine client drop, so the old cap would evict the rare events the
 * log exists to preserve. A record is a few hundred bytes of field names.
 */
export const PAYLOAD_DROP_LOG_MAX_ENTRIES = 500

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
  /**
   * The subset of {@link missing_fields} that is array-typed.
   *
   * This is the discriminator that makes the log falsifiable. A partial drop
   * missing an array is the #297 shape; one missing only scalars is usually an
   * ordinary caller error. Both are recorded — recording only the former made
   * "every partial drop involves an array" true by construction and so unable
   * to test the hypothesis it appeared to confirm. Empty array = scalar-only.
   */
  missing_array_params: string[]
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

    // Append AND trim under the same lock (#805 F15; audit 2026-08-03 finding 15).
    //
    // The previous shape appended outside the lock, on the reasoning that a
    // single short line through O_APPEND is atomic and therefore never lost.
    // It is atomic, but that is not sufficient: the trim replaces the file by
    // rename, so an append landing on the OLD inode between the trimmer's read
    // and its rename is written to a file that is about to stop being the log.
    // The record survives on an orphaned inode, which is the same as losing it.
    //
    // Serialising both is cheap here — the log is capped at
    // PAYLOAD_DROP_LOG_MAX_ENTRIES and a drop is already an exceptional event —
    // and this is a forensic log whose entire purpose is that an intermittent,
    // unreproducible event leaves a trace. A logger that drops records under
    // concurrency cannot do that job.
    withLock(path, () => {
      appendFileSync(path, JSON.stringify(record) + '\n')
      const lines = readFileSync(path, 'utf8').split('\n').filter(l => l.length > 0)
      if (lines.length > PAYLOAD_DROP_LOG_MAX_ENTRIES) {
        // durable: false — this is diagnostics, and an fsync per dropped
        // payload buys nothing a forensic log needs.
        atomicWrite(path, lines.slice(-PAYLOAD_DROP_LOG_MAX_ENTRIES).join('\n') + '\n', { durable: false })
      }
    })
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
