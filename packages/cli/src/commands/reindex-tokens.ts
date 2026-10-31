/**
 * `plur reindex-tokens` — re-derive BM25 tokens on a Postgres-backed store
 * after a tokenizer change.
 *
 * The adapter kicks this in the background the first time it notices stale
 * rows, so most deployments never need to run it. It exists for the cases
 * where "eventually, in the background" is not good enough:
 *
 *   - an operator upgrading deliberately, who wants the pushdown back before
 *     the first user query rather than after it,
 *   - a store that is read rarely, where "on the next recall" could be days,
 *   - anyone who wants a count rather than a log line.
 *
 * Only Postgres persists tokens. Every other tier re-derives them per query,
 * so there is nothing to reindex and this reports that rather than pretending
 * to work.
 */
import type { GlobalFlags } from '../plur.js'
import { PostgresAdapter, detectPlurStorage, loadConfig } from '@plur-ai/core'
import { shouldOutputJson, outputJson, outputText, exit } from '../output.js'

function usage(): never {
  exit(1, [
    'Usage:',
    '  plur reindex-tokens          Re-derive BM25 tokens for rows written by an older tokenizer',
    '',
    'Only applies to Postgres-backed stores (postgres.url / PLUR_POSTGRES_URL).',
    'Other tiers derive tokens per query and need no reindex.',
  ].join('\n'))
}

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) usage()

  // Resolve exactly as the engine does (index.ts `_postgresUrl`): environment
  // first, then config.yaml, so a store configured only in config.yaml is found.
  const paths = detectPlurStorage(flags.path || process.env.PLUR_PATH || undefined)
  const config = loadConfig(paths.config) as { postgres?: { url?: string, schema?: string } }
  const url = process.env.PLUR_POSTGRES_URL || config.postgres?.url
  if (!url) {
    // Not an error: it is the correct and common state. Saying so plainly
    // beats a stack trace for someone following an upgrade note.
    const msg = 'No Postgres store configured (postgres.url / PLUR_POSTGRES_URL). '
      + 'Other tiers derive tokens per query — nothing to reindex.'
    if (shouldOutputJson(flags)) {
      outputJson({ reindexed: 0, applicable: false, reason: 'no-postgres-store' })
    } else {
      outputText(msg)
    }
    return
  }

  // The schema must come from config too. Omitting it fails silently:
  // `initSchema` runs CREATE SCHEMA IF NOT EXISTS, so a store on a custom
  // schema would get an empty default schema, find zero stale rows, and
  // report a false all-clear.
  const adapter = new PostgresAdapter({
    connectionString: url,
    ...(config.postgres?.schema ? { schema: config.postgres.schema } : {}),
  })
  try {
    const started = Date.now()
    const count = await adapter.backfillTokens()
    const ms = Date.now() - started

    if (shouldOutputJson(flags)) {
      outputJson({ reindexed: count, applicable: true, durationMs: ms })
      return
    }
    outputText(count === 0
      ? 'Tokens are already current — nothing to reindex.'
      : `Re-derived tokens for ${count} engram(s) in ${ms}ms. BM25 pushdown is active again.`)
  } finally {
    // The adapter owns a connection pool; leaving it open hangs the process.
    await adapter.close().catch(() => { /* best effort */ })
  }
}
