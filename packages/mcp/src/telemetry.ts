// Telemetry wiring for the MCP server.
//
// @plur-ai/mcp is the widest install surface, but historically emitted no
// engagement counters — only @plur-ai/claw did. This module wires the SAME
// opt-in, content-free counters into the MCP server by reusing the
// implementation exported from @plur-ai/core (recordEvent / flushIfNeeded /
// registerFlushOnExit). No vendored copy lives here — one implementation,
// imported.
//
// Privacy guarantees are inherited unchanged from core:
//   - Default-off. recordEvent self-gates on isTelemetryEnabled(); an opted-out
//     install writes zero telemetry files and makes zero network calls.
//   - Content-free. Only daily per-event counts + an opaque install UUID +
//     version/platform/date are ever transmitted. No engram text, no query
//     text. Opt out with PLUR_TELEMETRY=off.
//
// Call sites live in tools.ts (recordEvent at learn/recall) and server.ts
// (registerFlushOnExit at startup). recordEvent returns true on a UTC-day
// rollover; maybeFlushAfter ships yesterday's pending snapshot then.

import { recordEvent, flushIfNeeded, registerFlushOnExit } from '@plur-ai/core'
import type { CounterEvent } from '@plur-ai/core'

export { registerFlushOnExit }

/**
 * Record an engagement counter event and, if recording rolled the UTC day,
 * fire-and-forget the pending-snapshot flush. Mirrors claw's wiring. Never
 * throws; an opted-out install is a no-op.
 */
export function recordTelemetry(event: CounterEvent): void {
  try {
    const rolledOver = recordEvent(event)
    if (rolledOver) void flushIfNeeded({}).catch(() => {})
  } catch {
    // Telemetry must never disturb a tool call.
  }
}
