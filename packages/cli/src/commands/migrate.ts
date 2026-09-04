import { runMigrations, rollbackMigrations, getSchemaVersion, CURRENT_SCHEMA_VERSION, exportPgliteEmbeddingsToCache, resolveBackendTier, loadConfig } from '@plur-ai/core'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, outputInfo, exit } from '../output.js'
import { detectPlurStorage } from '@plur-ai/core'

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const path = flags.path || process.env.PLUR_PATH || undefined
  const paths = detectPlurStorage(path)
  const subcommand = args[0] || 'up'

  if (subcommand === 'status') {
    const version = getSchemaVersion(paths.config)
    const result = {
      schema_version: version,
      latest_version: CURRENT_SCHEMA_VERSION,
      pending: CURRENT_SCHEMA_VERSION - version,
    }
    if (shouldOutputJson(flags)) {
      outputJson(result)
    } else {
      outputText(`Schema version: ${version}/${CURRENT_SCHEMA_VERSION}`)
      if (result.pending > 0) {
        outputText(`${result.pending} migration(s) pending. Run 'plur migrate' to apply.`)
      } else {
        outputText('Up to date.')
      }
    }
    return
  }

  if (subcommand === 'up' || subcommand === undefined) {
    try {
      const result = runMigrations(paths.engrams, paths.config)

      // #1046: if an orphaned PGLite store is sitting next to this corpus,
      // carry its embedding vectors into the JSON cache the yaml/sqlite
      // tiers read — otherwise the tier switch re-embeds the whole corpus
      // in the background while hybrid recall silently runs BM25-only.
      // Skipped when the user is explicitly ON pglite (nothing orphaned),
      // and harmless to re-run (existing cache entries win).
      const storageRoot = dirname(paths.engrams)
      const pgliteDir = join(storageRoot, 'store.pglite')
      // Same resolver the engine uses (#1061): `backend: pglite` in
      // config.yaml selects the tier exactly as PLUR_BACKEND does, and a
      // bare env test ran the orphan-export path — and printed "can now be
      // deleted" — against an index the user's config was actively using.
      const pgliteExplicit = resolveBackendTier({
        env: process.env.PLUR_BACKEND,
        config: loadConfig(paths.config).backend,
        engramCount: 0, // irrelevant: pglite is never size-selected
        postgresConfigured: false, // ditto — pglite selection needs no connection string
      }).tier === 'pglite'
      let embeddingsReport: Awaited<ReturnType<typeof exportPgliteEmbeddingsToCache>> | null = null
      if (existsSync(pgliteDir) && !pgliteExplicit) {
        embeddingsReport = await exportPgliteEmbeddingsToCache(storageRoot, paths.engrams, pgliteDir)
      }
      if (shouldOutputJson(flags)) {
        outputJson(embeddingsReport ? { ...result, pglite_embeddings: embeddingsReport } : result)
      } else {
        // Confirmation of a requested mutation → suppressed by --quiet (#730).
        if (embeddingsReport && embeddingsReport.status === 'done' && embeddingsReport.ported > 0) {
          outputInfo(`Ported ${embeddingsReport.ported} embedding vector(s) from the orphaned PGLite store into the embeddings cache`, flags)
          const skipped = embeddingsReport.stale + embeddingsReport.wrongDim
          if (skipped > 0) outputInfo(`  (${skipped} skipped as stale or wrong-dimension — they re-embed automatically)`, flags)
          outputInfo(`  ${pgliteDir} can now be deleted — YAML remains the source of truth.`, flags)
        } else if (embeddingsReport && embeddingsReport.status === 'failed') {
          outputText(`Warning: PGLite embeddings export failed (${embeddingsReport.error}) — the corpus will re-embed in the background instead.`)
        }
        if (result.applied.length === 0) {
          outputInfo('Already up to date.', flags)
        } else {
          outputInfo(`Applied ${result.applied.length} migration(s):`, flags)
          for (const id of result.applied) {
            outputInfo(`  - ${id}`, flags)
          }
          outputInfo(`Schema version: ${result.schema_version}`, flags)
          if (result.backup_path) {
            outputInfo(`Backup: ${result.backup_path}`, flags)
          }
        }
      }
    } catch (err: any) {
      exit(1, err.message)
    }
    return
  }

  if (subcommand === 'down') {
    const targetStr = args[1]
    if (!targetStr) {
      exit(1, 'Usage: plur migrate down <target-version>')
    }
    const target = parseInt(targetStr, 10)
    if (isNaN(target) || target < 0) {
      exit(1, 'Target version must be a non-negative integer')
    }
    try {
      const result = rollbackMigrations(paths.engrams, paths.config, target)
      if (shouldOutputJson(flags)) {
        outputJson(result)
      } else {
        if (result.applied.length === 0) {
          outputInfo('Nothing to roll back.', flags)
        } else {
          outputInfo(`Rolled back ${result.applied.length} migration(s):`, flags)
          for (const id of result.applied) {
            outputInfo(`  - ${id}`, flags)
          }
          outputInfo(`Schema version: ${result.schema_version}`, flags)
        }
      }
    } catch (err: any) {
      exit(1, err.message)
    }
    return
  }

  exit(1, `Unknown subcommand: ${subcommand}. Use 'up', 'down <version>', or 'status'.`)
}
