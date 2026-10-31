/**
 * `plur reindex-hashes` — repair engrams whose `content_hash` no longer
 * describes their statement.
 *
 * `content_hash` is what `_hashDedup` matches on. An engram whose hash points at
 * text it no longer contains becomes an ATTRACTOR: a later write matching that
 * old text hash-matches it and is absorbed into an engram that now says
 * something else, and each absorption raises its `write_count`. Stale hashes
 * already on disk stay until something rewrites them.
 *
 * Not done silently during `loadEngrams`: that would mutate the YAML source of
 * truth as a side effect of reading, and hide the count, which is worth seeing.
 *
 * Not under `plur doctor`: `doctor` diagnoses integration and never repairs;
 * this rewrites stored engrams. `doctor` reports; this repairs — the same split
 * as `reindex-tokens`.
 *
 * The scan and the write live in `Plur.repairContentHashes()`, not here. An
 * inline `loadEngrams` → mutate → `saveEngrams` would be an unlocked
 * whole-corpus read-modify-write that can destroy a concurrent writer's engram.
 * Going through the engine gets the store lock, the daily backup and a targeted
 * UPDATE on stores that support one, and also reaches an injected non-YAML
 * primary store.
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
