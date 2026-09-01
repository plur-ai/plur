/**
 * `plur verify` — verify the history chain (#1053).
 *
 * Exit codes are the contract, and all three are distinct:
 *
 *   0  verified        the chain holds over everything it covers
 *   1  broken          at least one break or fork, each one named
 *   2  cannot verify   the log could not be read — NOT the same as clean
 *
 * The third code is the point. A verifier that answered 0 when it could not
 * read the log would report "healthy" for a chain nobody checked, which is the
 * failure this whole surface exists to refuse
 * (docs/design/failure-must-be-distinguishable.md in the enterprise repo
 * states the same rule for the audit chain).
 *
 * Usage:
 *   plur verify           Human-readable report
 *   plur verify --json    Full structured result
 */
import { join } from 'path'
import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText } from '../output.js'
import { verifyChain, hashStoreFile } from '@plur-ai/core'

export async function run(_args: string[], flags: GlobalFlags): Promise<void> {
  const plur = createPlur(flags)
  const root = plur.storageRoot
  const outcome = verifyChain(root)

  if (outcome.status === 'cannot_verify') {
    if (shouldOutputJson(flags)) {
      outputJson({ status: 'cannot_verify', reason: outcome.reason, month: outcome.month ?? null, line: outcome.line ?? null })
    } else {
      outputText('plur verify: CANNOT VERIFY')
      outputText(`  reason: ${outcome.reason}`)
      if (outcome.month) outputText(`  month:  ${outcome.month}${outcome.line ? ` (line ${outcome.line})` : ''}`)
      outputText('')
      outputText('  This is NOT a clean result. The log could not be read in full,')
      outputText('  so nothing is asserted about the chain either way.')
    }
    process.exitCode = 2
    return
  }

  const r = outcome.result
  const storeHash = hashStoreFile(join(root, 'engrams.yaml'))

  if (shouldOutputJson(flags)) {
    outputJson({ status: outcome.status, store_hash: storeHash, ...r })
    process.exitCode = outcome.status === 'verified' ? 0 : 1
    return
  }

  outputText(outcome.status === 'verified' ? 'plur verify: OK' : 'plur verify: BROKEN')
  outputText(`  events total      : ${r.total_events}`)
  outputText(`  verified (chained): ${r.verified_events}`)
  outputText(`  chain head        : ${r.chain_head ?? '(none — no chained events)'}`)
  outputText(`  checkpoints       : ${r.checkpoints_checked}`)

  if (r.torn_tail) {
    outputText('')
    outputText(`  in-flight write: ${r.torn_tail.month} line ${r.torn_tail.line} is incomplete.`)
    outputText('  A writer was mid-append (or crashed mid-flush). Everything before')
    outputText('  it verified — this is not corruption and not a break.')
  }

  if (r.unprotected_legacy) {
    const { from, to, count } = r.unprotected_legacy
    outputText('')
    outputText(`  unprotected legacy range: events ${from}–${to} (${count})`)
    outputText('  Written before the chain existed. They carry no hash and no prev,')
    outputText('  so nothing here certifies them — that is expected, not a fault.')
  }

  for (const b of r.breaks) {
    outputText('')
    outputText(`  BREAK ${b.reason} at ${b.month} #${b.index} (${b.event_id})`)
    if (b.expected !== null) outputText(`    expected: ${b.expected}`)
    if (b.actual !== null)   outputText(`    actual  : ${b.actual}`)
    if (b.reason === 'checkpoint_head_missing') {
      outputText('    A checkpoint pinned a chain head this log no longer contains,')
      outputText('    which means events below it were rewritten wholesale.')
    }
    if (b.reason === 'store_hash_mismatch') {
      outputText('    The newest checkpoint attests a store that is not the one on disk.')
      outputText('    The chain itself is intact — engrams.yaml changed under it. That is')
      outputText('    expected if you have learned anything since; run `plur checkpoint`')
      outputText('    to attest the current state. If you have NOT, the store was replaced.')
    }
    if (b.reason === 'declared_gap') {
      outputText('    A writer could not take the chain lock and declared a gap rather')
      outputText('    than chaining from a tail it had not read under exclusion. This is a')
      outputText('    concurrency artifact, NOT evidence of tampering.')
    }
  }

  for (const f of r.forks) {
    outputText('')
    outputText(`  FORK: ${f.claimed_by.length} events claim predecessor ${f.prev}`)
    for (const c of f.claimed_by) outputText(`    ${c.month} #${c.index} ${c.event_id} -> ${c.hash}`)
    outputText('    Two writers appended from the same predecessor. This is a')
    outputText('    concurrency fault, not evidence of tampering.')
  }

  if (outcome.status === 'verified' && r.verified_events > 0) {
    outputText('')
    outputText('  Note: a hash chain detects edits that do not recompute it. A rewrite')
    outputText('  that recomputes every prev and hash is internally consistent and is')
    outputText('  not detectable from this log alone — an anchored checkpoint is what')
    outputText('  closes that gap.')
  }

  process.exitCode = outcome.status === 'verified' ? 0 : 1
}
