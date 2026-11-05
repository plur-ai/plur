import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { atomicWrite, withLock } from '@plur-ai/core'

/**
 * Forensic log for MCP argument-payload drops (a tool call arriving with
 * `received_fields: []`), an intermittent client-side failure recorded as it
 * happens for upstream reports.
 *  - NO VALUES, ever: field NAMES and frame metadata only.
 *  - Bounded to the newest {@link PAYLOAD_DROP_LOG_MAX_ENTRIES} records.
 *  - Best-effort: every failure is swallowed so the tool call never breaks.
 */

/**
 * Newest-N cap applied on every write.
 *
 * Scalar-only partial drops are recorded too, and are dominated by ordinary
 * caller errors far more frequent than a genuine client drop, so the cap must
 * be large enough not to evict the rare events the log exists to preserve. A
 * record is a few hundred bytes of field names.
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
   *                     array-typed ones) did not
   */
  arguments_wire: 'absent' | 'empty_object' | 'partial'
  /** Top-level key NAMES of `request.params` (e.g. name, arguments, _meta). */
  params_keys: string[]
  /** Field NAMES that did arrive — never their values. */
  received_fields: string[]
  /** Schema-required field NAMES that were missing. */
  missing_fields: string[]
  /**
   * The array-typed subset of {@link missing_fields}: missing arrays are the
   * client-drop shape, scalar-only misses usually caller error; `[]` means
   * scalar-only. OPTIONAL for older records, where `undefined` means unknown
   * (array-shaped by construction); ratios must exclude `undefined`.
   */
  missing_array_params?: string[]
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

    // Append AND trim under the same lock. An O_APPEND line is atomic, but the
    // trim replaces the file by rename, so an append landing on the OLD inode
    // between the trimmer's read and its rename would end up on an orphaned
    // inode — lost. Serialising both is cheap: the log is capped and a drop is
    // already an exceptional event.
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
