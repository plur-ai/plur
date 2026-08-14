/**
 * `plur reindex-hashes` — repair engrams whose `content_hash` no longer
 * describes their statement (#852).
 *
 * ## Why this needs a command rather than a background fix
 *
 * `content_hash` is what `_hashDedup` matches on. An engram whose hash points at
 * text it no longer contains becomes an ATTRACTOR: a later write matching that
 * old text hash-matches it and is absorbed into an engram that now says
 * something else. Each absorption raises its `write_count`, making it a stronger
 * attractor still.
 *
 * The source of the drift is fixed — procedure evolution now recomputes the
 * hash, as the UPDATE and MERGE paths always did — so no NEW stale hashes
 * appear. But the ones already on disk stay until something rewrites them, and
 * they keep absorbing writes in the meantime.
 *
 * ## Why not silently, on read
 *
 * Recomputing during `loadEngrams` would fix it invisibly and is exactly the
 * wrong shape: it mutates the YAML source of truth as a side effect of reading,
 * which is the class of behaviour #766 and #794 exist because of. It would also
 * hide the count, and the count is the interesting part — 38 stale hashes in one
 * store is a finding, not a chore.
 *
 * ## Why not under `plur doctor`
 *
 * `doctor` diagnoses INTEGRATION (Claude Code / Desktop wiring, MCP entries,
 * embedder health) and has no repair mode at all. This rewrites stored engrams.
 * Putting a store rewrite behind the command people run casually to check their
 * setup is the wrong affordance. `doctor` reports; this repairs — the same split
 * `reindex-tokens` already established.
 *
 * ## Why this file is thin
 *
 * The scan and the write live in `Plur.repairContentHashes()`, not here. This
 * command's first cut did `loadEngrams` → mutate → `saveEngrams` inline, which
 * is an UNLOCKED whole-corpus read-modify-write: the 2026-08-13 data-loss audit
 * reproduced it destroying a concurrent writer's engram 6/6 on a real-sized
 * store. Going through the engine gets the store lock, the #799 daily backup,
 * and a targeted UPDATE on stores that support one — and it means the repair
 * also reaches an injected non-YAML primary store, which reading
 * `paths.engrams` directly never could.
 */
import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, exit } from '../output.js'

function usage(): never {
  exit(1, [
    'Usage:',
    '  plur reindex-hashes            Report engrams whose content_hash is stale or missing',
    '  plur reindex-hashes --apply    Rewrite them',
    '',
    'A stale content_hash makes an engram absorb unrelated writes (#852).',
    'Runs read-only by default: nothing is written without --apply.',
  ].join('\n'))
}

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) usage()
  const apply = args.includes('--apply')

  // `readonly: true` without `--apply` is not cosmetic: it makes the reporting
  // mode structurally incapable of writing, so a scan cannot be the thing that
  // damages a store the user ran it to inspect.
  const plur = createPlur(flags, apply ? undefined : { readonly: true })
  const { scanned, stale, missing, unhashable, repaired } = await plur.repairContentHashes({ apply })

  if (shouldOutputJson(flags)) {
    outputJson({
      scanned,
      stale: stale.length,
      missing: missing.length,
      unhashable: unhashable.length,
      repaired,
      applied: apply,
      stale_ids: stale.slice(0, 50).map(e => e.id),
      unhashable_ids: unhashable.slice(0, 50).map(e => e.id),
    })
    return
  }

  if (stale.length === 0 && missing.length === 0 && unhashable.length === 0) {
    outputText(`Scanned ${scanned} engrams — every content_hash matches its statement.`)
    return
  }

  const lines = [
    `Scanned ${scanned} engrams.`,
    `  stale      ${String(stale.length).padStart(5)}  hash does not match the statement — these absorb unrelated writes (#852)`,
    `  missing    ${String(missing.length).padStart(5)}  no hash at all — inert until something matches on them`,
    `  unhashable ${String(unhashable.length).padStart(5)}  statement normalizes to nothing — SKIPPED, a shared hash is worse than none (#896)`,
  ]
  if (stale.length > 0) {
    lines.push('', 'Stale:')
    for (const e of stale.slice(0, 10)) lines.push(`  ${e.id}  ${e.statement.slice(0, 68)}`)
    if (stale.length > 10) lines.push(`  … and ${stale.length - 10} more`)
  }
  if (unhashable.length > 0) {
    lines.push('', 'Unhashable (not written):')
    for (const e of unhashable.slice(0, 10)) lines.push(`  ${e.id}  ${e.statement.slice(0, 68)}`)
    if (unhashable.length > 10) lines.push(`  … and ${unhashable.length - 10} more`)
  }
  lines.push('', apply
    ? `Repaired ${repaired}.`
    : 'Run with --apply to rewrite them. Nothing has been written.')
  outputText(lines.join('\n'))
}
