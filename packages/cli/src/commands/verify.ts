/**
 * `plur verify` — verify the history chain and optionally checkpoint signatures.
 * Exit codes: 0 verified; 1 broken (each break named); 2 cannot verify (NOT clean).
 * Usage:
 *   plur verify                Human-readable report
 *   plur verify --signatures   Also verify Ed25519 signatures on checkpoints
 *   plur verify --json         Full structured result
 *   plur verify --manifest <file|swarm reference> [--notary <0x address>] [--gateway <url>] [--trust-gateway-notary]
 *                              Re-hash each listed engram: MATCH / CHANGED / NOT AVAILABLE.
 */
import { join } from 'path'
import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText } from '../output.js'
import { verifyChain, hashStoreFile } from '@plur-ai/core'
import { runManifest } from './verify-manifest.js'

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const mi = args.indexOf('--manifest')
  if (mi >= 0) return runManifest(args[mi + 1], args, flags)
  const verifySignatures = args.includes('--signatures')

  // Read-only, like `plur ui`. Verification must not be able to write to the
  // artefact it is examining — and a write-capable handle can, through a lazy
  // path such as a daily backup or a migration that runs on construction.
  // `readonly: true` wraps the store in ReadonlyStoreGuard and makes
  // _assertWritable throw, so "verify never mutates" is enforced rather than
  // assumed from the fact that this function does not call a write method.
  const plur = createPlur(flags, { readonly: true })
  const root = plur.storageRoot
  const outcome = verifyChain(root, { verifySignatures })

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

  // Set by core when the store's content changed after the newest checkpoint
  // and the history records the changes: ordinary use, not a break.
  const changed = (r as { store_changed_since_checkpoint?: { month: string; index: number; events_since: number } | null }).store_changed_since_checkpoint
  if (changed) {
    outputText('')
    outputText(`  store changed since the newest checkpoint (${changed.month} #${changed.index}); ${changed.events_since} recorded change(s) explain it. Run \`plur checkpoint\` to attest the current state.`)
  }

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
    outputText('  Written by a build that did not chain. They carry no hash and no prev,')
    outputText('  so nothing here certifies them — that is expected, not a fault. They')
    outputText('  need not be contiguous: a chained build followed by any non-chaining')
    outputText('  path interleaves them, which is the ordinary rollout shape.')
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
      outputText('    The memories in engrams.yaml differ from what the newest checkpoint')
      outputText('    attested, and no change recorded in the history since explains it:')
      outputText('    the store was edited or replaced outside PLUR (or deleted).')
    }
    if (b.reason === 'signature_invalid') {
      outputText('    The checkpoint signature does not verify against the key registered for')
      outputText('    its signer. A re-generated key for the same identity also does this.')
    }
    if (b.reason === 'declared_gap') {
      outputText('    A writer could not take the chain lock and declared a gap rather')
      outputText('    than chaining from a tail it had not read under exclusion. This is a')
      outputText('    concurrency artifact, NOT evidence of tampering.')
    }
  }

  for (const f of r.forks) {
    outputText('')
    outputText(`  FORK: ${f.claimed_by.length} events claim predecessor ${f.prev ?? '(genesis — no predecessor)'}`)
    for (const c of f.claimed_by) outputText(`    ${c.month} #${c.index} ${c.event_id} -> ${c.hash}`)
    outputText('    Two writers appended from the same predecessor. This is a')
    outputText('    concurrency fault, not evidence of tampering.')
  }

  if (r.signatures !== null && r.signatures.length > 0) {
    outputText('')
    outputText(`  Signature verification (--signatures):`)
    for (const s of r.signatures) {
      const verdictStr = s.verdict === 'valid' ? 'VALID'
        : s.verdict === 'invalid' ? 'INVALID'
        : s.verdict === 'unsigned' ? 'unsigned (L2 — no signature)'
        : `unknown signer: ${s.signer ?? '?'}`
      outputText(`    checkpoint ${s.month} #${s.index}: ${verdictStr}`)
    }
  } else if (verifySignatures && r.checkpoints_checked === 0) {
    outputText('')
    outputText('  No checkpoints found to verify signatures for.')
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
