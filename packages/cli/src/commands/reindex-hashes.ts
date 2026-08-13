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
 */
import type { GlobalFlags } from '../plur.js'
import { computeContentHash, detectPlurStorage, loadEngrams, saveEngrams } from '@plur-ai/core'
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

  // Read the RAW store, not `Plur.list()`.
  //
  // `list()` goes through `_filterEngrams`, which merges PACKS in and drops
  // inactive/expired engrams. Measured against this store, that gave 5,388
  // scanned / 1 stale / 1,805 missing, where the file itself holds 4,642 / 38 /
  // 961 — it counted pack entries this command does not own as "missing", and
  // hid stale rows on retired engrams. For a repair pass that is not a cosmetic
  // difference: writes would go somewhere other than the file carrying the
  // problem.
  const paths = detectPlurStorage(flags.path || process.env.PLUR_PATH || undefined)
  const engrams = loadEngrams(paths.engrams)

  const stale: Array<{ id: string; statement: string }> = []
  const missing: Array<{ id: string; statement: string }> = []
  for (const e of engrams) {
    if (!e.statement) continue
    const current = (e as { content_hash?: string }).content_hash
    if (!current) missing.push({ id: e.id, statement: e.statement })
    else if (current !== computeContentHash(e.statement)) stale.push({ id: e.id, statement: e.statement })
  }

  // Reported separately on purpose: they are different conditions. A STALE hash
  // is actively wrong and absorbs writes today. A MISSING one predates the
  // field and is inert until something matches on it. One number would
  // overstate the second and bury the first.
  let repaired = 0
  if (apply && (stale.length > 0 || missing.length > 0)) {
    const target = new Set([...stale, ...missing].map(e => e.id))
    for (const e of engrams) {
      if (!target.has(e.id) || !e.statement) continue
      ;(e as { content_hash?: string }).content_hash = computeContentHash(e.statement)
      repaired++
    }
    // Same count in, same count out — this only ever rewrites a field.
    saveEngrams(paths.engrams, engrams)
  }

  if (shouldOutputJson(flags)) {
    outputJson({
      scanned: engrams.length,
      stale: stale.length,
      missing: missing.length,
      repaired,
      applied: apply,
      stale_ids: stale.slice(0, 50).map(e => e.id),
    })
    return
  }

  if (stale.length === 0 && missing.length === 0) {
    outputText(`Scanned ${engrams.length} engrams — every content_hash matches its statement.`)
    return
  }

  const lines = [
    `Scanned ${engrams.length} engrams.`,
    `  stale   ${String(stale.length).padStart(5)}  hash does not match the statement — these absorb unrelated writes (#852)`,
    `  missing ${String(missing.length).padStart(5)}  no hash at all — inert until something matches on them`,
  ]
  if (stale.length > 0) {
    lines.push('', 'Stale:')
    for (const e of stale.slice(0, 10)) lines.push(`  ${e.id}  ${e.statement.slice(0, 68)}`)
    if (stale.length > 10) lines.push(`  … and ${stale.length - 10} more`)
  }
  lines.push('', apply
    ? `Repaired ${repaired}.`
    : 'Run with --apply to rewrite them. Nothing has been written.')
  outputText(lines.join('\n'))
}
