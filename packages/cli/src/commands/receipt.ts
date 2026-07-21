import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText } from '../output.js'
import type { Receipt } from '@plur-ai/core'

const n = (x: number) => x.toLocaleString('en-US')
const pct = (x: number) => `${Math.round(x * 100)}%`

/**
 * Human-readable memory receipt.
 *
 * Every line is a counted fact. No monetary or token-savings figure is shown:
 * for subscription users marginal token cost is zero, and the value of an
 * avoided rediscovery is not measurable from this data.
 *
 * Leads with DELIVERY — how many times a memory you taught PLUR was put in
 * front of the model — because that scales with real usage. Activation rate is
 * kept as a labelled store-health signal, not a success score, because it is
 * roughly injection_budget ÷ store_size and falls as you teach more.
 */
export function renderReceipt(r: Receipt): string {
  const L: string[] = []
  L.push('Your Memory Receipt')
  L.push('===================')

  if (r.coverage.source === 'none') {
    L.push('')
    if (r.window.windowed) {
      L.push(`  No retrievals in the last ${r.window.requested_days} days.`)
      L.push('  Try a wider window, or run a few sessions and check back.')
    } else {
      L.push('  No data yet.')
      L.push('')
      L.push('  PLUR records a retrieval each time it selects engrams for a query.')
      L.push('  Run a few sessions and check back.')
    }
    L.push('')
    L.push(`  Engrams stored: ${n(r.stored.total)}`)
    return L.join('\n')
  }

  const windowLabel = r.window.windowed
    ? `last ${r.window.requested_days} days`
    : `${r.window.from} .. ${r.window.to}`
  L.push(`  ${windowLabel}  (${n(r.window.sessions)} sessions)`)
  L.push('')

  // ---- Lead: what memory delivered ----
  L.push(`  ${n(r.retrieved.taught_pairs)} times a memory you taught PLUR`)
  L.push('  was put in front of the model.')
  L.push('')
  L.push(`  across ${n(r.retrieved.retrievals)} retrievals in ${n(r.window.sessions)} sessions`)
  L.push(`  ${n(r.retrieved.engrams)} distinct engrams did the work`)
  if (r.retrieved.pack_pairs > 0) {
    L.push(`  (+ ${n(r.retrieved.pack_pairs)} from installed packs)`)
  }
  if (r.external_retrieved > 0) {
    L.push(`  (+ ${n(r.external_retrieved)} retrievals from team stores, not counted here)`)
  }

  // ---- Reuse (stored-only population; suppressed when nothing live) ----
  if (r.retrieved.engrams > 0) {
    L.push('')
    L.push('  REUSE  (per engram retrieved and still stored)')
    L.push(`    median                        ${n(r.reuse.median).padStart(8)}x`)
    L.push(`    mean                          ${r.reuse.mean.toFixed(1).padStart(8)}x`)
    L.push(`    most-reused                   ${n(r.reuse.max).padStart(8)}x`)
    const live = r.reuse.top.filter(t => !t.retired).slice(0, 5)
    if (live.length > 0) {
      L.push('')
      L.push('  MOST-RELIED-ON')
      for (const t of live) {
        L.push(`    ${(n(t.count) + 'x').padStart(5)}  ${t.statement ?? t.id}`)
      }
    }
  }

  // ---- Store health (activation rate lives here, framed as coverage) ----
  // Numbers lead in a fixed-width column so variable-length labels below can't
  // knock them out of alignment.
  const row = (count: number, label: string) => `    ${n(count).padStart(8)}   ${label}`
  // "never" is unverifiable: logging began at complete_from, so we report only
  // what we can observe — retrievals since that date.
  const dormantLabel = r.window.windowed
    ? `not retrieved in the last ${r.window.requested_days} days (${pct(1 - r.retrieved.activation_rate)})`
    : `not retrieved since ${r.coverage.complete_from} (${pct(1 - r.retrieved.activation_rate)})`
  L.push('')
  L.push('  STORE HEALTH')
  L.push(row(r.stored.total, `engrams stored (you: ${n(r.stored.own)}, packs: ${n(r.stored.pack)})`))
  L.push(row(r.retrieved.engrams, `retrieved at least once (${pct(r.retrieved.activation_rate)} of store)`))
  L.push(row(r.dormant.never_retrieved, dormantLabel))
  if (r.dormant.unavailable_but_retrieved > 0) {
    L.push(row(r.dormant.unavailable_but_retrieved, 'retrieved but since removed'))
  }
  L.push('    Over a short logging window a low rate is expected, not a fault —')
  L.push('    memory is meant to be selective, and much of the store predates')
  L.push('    logging. A large dormant tail is a prompt to prune, and to keep teaching.')

  // ---- Provenance / coverage caveats ----
  L.push('')
  L.push(`  Counted from retrievals recorded since ${r.coverage.complete_from}.`)
  L.push('  Anything before that date is not included.')
  if (r.coverage.session_id_coverage < 1) {
    L.push(`  Session ID present on ${pct(r.coverage.session_id_coverage)} of retrievals; the rest`)
    L.push('  are counted as separate anonymous sessions, which can inflate the')
    L.push('  session and pair counts.')
  }
  return L.join('\n')
}

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const daysIdx = args.indexOf('--days')
  let days: number | undefined
  if (daysIdx >= 0) {
    days = Number(args[daysIdx + 1])
    if (!Number.isFinite(days) || days <= 0) {
      throw new Error('--days requires a positive number')
    }
  }

  const plur = createPlur(flags)
  const receipt = plur.receipt(days ? { days } : undefined)

  if (shouldOutputJson(flags)) {
    outputJson(receipt)
  } else {
    outputText(renderReceipt(receipt))
  }
}
