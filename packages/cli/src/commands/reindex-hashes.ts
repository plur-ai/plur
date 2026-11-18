/**
 * `plur reindex-hashes` — repair engrams whose `content_hash` no longer describes
 * their statement. A stale hash makes the engram an attractor for `_hashDedup`,
 * absorbing later writes of the old text.
 * - Not done during `loadEngrams` (reading must not mutate the YAML source of truth).
 * - Not under `plur doctor`, which diagnoses and never repairs (as with `reindex-tokens`).
 * - The work lives in `Plur.repairContentHashes()` for the store lock, daily backup,
 *   targeted updates and non-YAML stores; never an inline unlocked read-modify-write.
 */
import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, exit } from '../output.js'

function usage(): never {
  exit(1, [
    'Usage:',
    '  plur reindex-hashes            Report engrams whose content_hash is stale or missing',
    '  plur reindex-hashes --apply    Rewrite them',
    '',
    'A stale content_hash makes an engram absorb unrelated writes.',
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
    `  stale      ${String(stale.length).padStart(5)}  hash does not match the statement — these absorb unrelated writes`,
    `  missing    ${String(missing.length).padStart(5)}  no hash at all — inert until something matches on them`,
    `  unhashable ${String(unhashable.length).padStart(5)}  statement normalizes to nothing — SKIPPED, a shared hash is worse than none`,
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
