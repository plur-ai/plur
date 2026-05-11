/**
 * Claw runtime — audit adapter.
 *
 * Surfaces the OpenClaw runtime's "working memory" so `plur audit` can scan it
 * for conflicts/duplicates/staleness against the engram store.
 *
 * Status: STUB. Working-memory schema for Claw is not yet stable.
 *
 * Likely sources to scan once schema settles:
 *   - ~/.openclaw/state/*.json — per-session state files
 *   - <claw-data-dir>/context-cache/ — assembled context snapshots
 *   - openclaw.json — runtime config (skip — that's static config, not memory)
 *   - learner.ts emissions — short-lived corrections before promotion to engrams
 *
 * Once implemented, the CLI can call this from packages/cli/src/commands/audit.ts
 * by replacing the `loadClawMemory()` stub there with a call into this module.
 *
 * The shape returned MUST match MemoryEntry in audit.ts:
 *   { source, topic, description, body, filepath, ageDays }
 */

export interface ClawMemoryEntry {
  source: string
  topic: string
  description: string
  body: string
  filepath: string
  ageDays: number
}

export function loadClawMemory(): ClawMemoryEntry[] {
  // TODO: enumerate Claw state files, read schema-defined fields, return entries.
  // Reference: see packages/cli/src/commands/audit.ts loadClaudeCodeMemory()
  // for the working Claude Code adapter pattern.
  return []
}
