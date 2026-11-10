/**
 * Shared plumbing for the CLI's plan / apply / undo commands (overhaul W7,
 * W10): a plan is a JSON file a person reads before applying it, and an
 * apply is one change-journal entry that `--undo <change-id>` reverts.
 */
import { readFileSync, writeFileSync } from 'fs'
import type { Plur, ChangeRecord } from '@plur-ai/core'
import { shouldOutputJson, outputJson, outputText, exit } from '../output.js'
import type { GlobalFlags } from '../plur.js'

/** Write a plan to `out` (0600: it quotes memory text), or to stdout as JSON. */
export function emitPlan(plan: unknown, out: string | undefined): void {
  const json = JSON.stringify(plan, null, 2) + '\n'
  if (out) writeFileSync(out, json, { encoding: 'utf8', mode: 0o600 })
  else process.stdout.write(json)
}

/** Read and minimally check a plan file. Exits 1 with a clear message on any problem. */
export function readPlan<T extends { kind: string; items: unknown[] }>(path: string, kind: string): T {
  let parsed: unknown
  try { parsed = JSON.parse(readFileSync(path, 'utf8')) } catch (err) {
    exit(1, `Cannot read plan ${path}: ${(err as Error).message}`)
  }
  const p = parsed as T
  if (!p || typeof p !== 'object' || p.kind !== kind || !Array.isArray(p.items)) {
    exit(1, `${path} is not a ${kind} file.`)
  }
  return p
}

/** Parse `--limit N` (a positive integer). */
export function parseLimit(raw: string | undefined): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) exit(1, `--limit needs a positive whole number, got ${raw ?? '(nothing)'}.`)
  return n
}

/** Undo a journalled change of the given kind; refuses other kinds. */
export async function undoCommand(plur: Plur, changeId: string, kind: string, flags: GlobalFlags): Promise<void> {
  const record: ChangeRecord | null = plur.getChange(changeId)
  if (!record) exit(1, `No change ${changeId} in the change journal.`)
  if (record.kind !== kind) exit(1, `Change ${changeId} is a "${record.kind}" change, not "${kind}"; refusing to undo it from here.`)
  try {
    const undo = await plur.undoChange(changeId)
    if (shouldOutputJson(flags)) outputJson({ undone: changeId, undo_change: undo.id, rows: undo.rows.length })
    else outputText(`Undid ${changeId}: ${undo.rows.length} engram(s) restored (undo recorded as ${undo.id}).`)
  } catch (err) {
    exit(1, `Error: ${(err as Error).message}`)
  }
}
