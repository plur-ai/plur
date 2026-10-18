import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, exit } from '../output.js'
import { folderReadContext } from '../lib/folder-gate.js'

/**
 * Flags this command accepts (#986).
 *
 * `--scope` and `--domain` are passed to core recall as filters, the same
 * semantics as MCP `plur_recall`. They used to be declared here and then
 * skipped by the parser, so the recall ran unfiltered and the remote leg was
 * never dialed for the requested scope. `--tags` and `--type` were declared
 * the same way, but core recall has no filter for them, so they are no longer
 * declared: the argv check refuses them instead of ignoring them.
 */
export const FLAGS_WITH_VALUES = ['--limit', '--scope', '--domain']

export const FLAGS = ['--limit', '--scope', '--domain']

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags)

  let query = ''
  let limit = 10
  let scope: string | undefined
  let domain: string | undefined

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === '--limit' && i + 1 < args.length) { limit = parseInt(args[++i], 10); i++ }
    else if (arg === '--scope' && i + 1 < args.length) { scope = args[++i]; i++ }
    else if (arg === '--domain' && i + 1 < args.length) { domain = args[++i]; i++ }
    // `--` ends flag parsing: the next token is the query, verbatim, even when
    // it starts with `-` (decision S4; formal r2 follow-up). Before, `--`
    // itself became the query.
    else if (arg === '--') { if (!query && i + 1 < args.length) query = args[i + 1]; break }
    else if (!query) { query = arg; i++ }
    else { i++ }
  }

  if (!query) {
    exit(1, 'Usage: plur recall <query> [--limit <n>] [--scope <scope>] [--domain <prefix>]')
  }

  // An explicit scope is also the remote leg's dialing context (#243/#776).
  // Without one, the folder's scope is (L10), by the same rule as MCP (#1566).
  // An off folder, an undecided one (unscoped) or a broken folder map
  // contacts no store at all; local memory is read either way.
  const { session, remote } = folderReadContext(plur, scope)
  // The *WithMeta forms (#1586 audit L6): same results, plus what the server
  // leg did on this call and whether the results are complete.
  const meta = flags.fast
    ? await plur.recallWithMeta(query, { limit, scope, domain, session, remote })
    : await plur.recallHybridWithMeta(query, { limit, scope, domain, session, remote })
  // recallHybrid() sliced to the limit; recall() did not — unchanged.
  const engrams = flags.fast ? meta.engrams : meta.engrams.slice(0, limit ?? 20)
  const hybrid = meta as { mode?: string; degraded_reason?: string; embedderError?: string | null }
  const report = {
    remote: meta.remote ?? { state: 'not_dialed' as const, hosts: [] },
    results_complete: meta.results_complete ?? true,
    // #1586 round 4: which leg is missing and why (hybrid only; added fields).
    ...(hybrid.mode ? { mode: hybrid.mode } : {}),
    ...(hybrid.degraded_reason ? { degraded_reason: hybrid.degraded_reason } : {}),
    ...((hybrid.mode === 'hybrid-degraded' || hybrid.degraded_reason) && hybrid.embedderError ? { embedder_error: hybrid.embedderError } : {}),
  }
  // An incomplete answer is never presented as a plain "no results": say what
  // is missing, by cause (stderr, so piped text output stays the results only).
  const remoteMissing = report.remote.state !== 'ok' && report.remote.state !== 'not_dialed'
  const incompleteNote = report.results_complete ? null
    : meta.local_complete === false
      ? 'Note: the local search did not finish within the recall deadline — results are incomplete; retrying is fine.'
      : hybrid.degraded_reason && hybrid.embedderError
        ? `Note: ${hybrid.embedderError}`
        : remoteMissing
          ? `Note: the team store did not answer this call (${report.remote.state}) — results may be missing team engrams.`
          : 'Note: results are incomplete.'

  // The note goes to stderr in both output modes: stdout stays the results
  // (JSON consumers parse stdout only), and a person or a log still sees why.
  if (incompleteNote) process.stderr.write(`${incompleteNote}\n`)

  if (engrams.length === 0) {
    if (shouldOutputJson(flags)) {
      outputJson({ results: [], count: 0, ...report })
    } else {
      outputText(report.results_complete ? 'No results found.' : 'No results found — the search was incomplete.')
    }
    exit(2)
  }

  if (shouldOutputJson(flags)) {
    outputJson({
      results: engrams.map(e => ({
        // The id `plur learn` returned (F3): a team row keeps its store
        // prefix, so it never shares an id with a local engram, and
        // `plur forget` / feedback / pin route it to its store.
        id: e.id,
        statement: e.statement,
        scope: e.scope,
        type: e.type,
        domain: e.domain ?? null,
        strength: e.activation.retrieval_strength,
      })),
      count: engrams.length,
      ...report,
    })
  } else {
    engrams.forEach((e, idx) => {
      outputText(`${idx + 1}. [${e.id}] ${e.statement}`)
      outputText(`   Scope: ${e.scope} | Type: ${e.type}${e.domain ? ` | Domain: ${e.domain}` : ''} | Strength: ${e.activation.retrieval_strength.toFixed(3)}`)
    })
  }
}
