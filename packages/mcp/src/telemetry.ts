// Telemetry wiring for the MCP server, reusing core's recordEvent / flushIfNeeded / registerFlushOnExit (no
// vendored copy). Privacy is inherited from core: default-off (zero files, zero network when opted out) and
// content-free (daily per-event counts, opaque install UUID, version/platform/date; opt out with
// PLUR_TELEMETRY=off). Call sites: tools.ts (recordEvent) and server.ts (registerFlushOnExit); on a UTC-day
// rollover recordEvent returns true and maybeFlushAfter ships yesterday's snapshot.

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
