/**
 * `plur checkpoint` — emit a checkpoint history event (#1052).
 *
 * A checkpoint commits to the current state of the store: it records the
 * SHA-256 of engrams.yaml bytes, the active engram count, and chains onto
 * the last event in the hash-chain history log. Once a checkpoint is
 * externally anchored (e.g. published to a ledger), every prior history event
 * becomes tamper-evident — modifying any event breaks every later chain link.
 *
 * This is the CLI surface for Integrity Strength L2 checkpointing per #1047.
 *
 * Usage:
 *   plur checkpoint          Emit a checkpoint and print its hash
 *   plur checkpoint --json   Emit and print full payload as JSON
 */
import { join } from 'path'
import { existsSync } from 'fs'
import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText } from '../output.js'
import { emitCheckpoint, signWithActorKey } from '@plur-ai/core'

export async function run(_args: string[], flags: GlobalFlags & { signatures?: boolean }): Promise<void> {
  // Write engine needed: emitCheckpoint calls appendHistory (a write).
  const plur = createPlur(flags)
  const status = await plur.status()

  const plurRoot = plur.storageRoot
  const engramsPath = join(plurRoot, 'engrams.yaml')

  // A fresh install that has never learned anything has no engrams.yaml, and
  // emitCheckpoint used to die with a raw unhandled ENOENT out of the built
  // CLI. Refuse with an explanation instead: there is genuinely nothing to
  // checkpoint, and that is not an error condition to stack-trace over.
  if (!existsSync(engramsPath)) {
    outputText('Nothing to checkpoint: this store has no engrams.yaml yet.')
    outputText(`  looked in: ${engramsPath}`)
    outputText('  Learn something first, then checkpoint.')
    process.exitCode = 1
    return
  }

  // Resolve signing options if the acting identity has a key configured (#1056).
  // Signing is best-effort: if the key is absent or the identity is unidentified,
  // the checkpoint is still written (unsigned is a valid L2 object).
  const identity = status.provenance_identity
  const keysDir = join(plurRoot, 'keys')
  const signingOptions = (identity && identity !== 'agent:unidentified')
    ? { identity, sign: (data: Buffer) => signWithActorKey(data, identity, keysDir) }
    : undefined

  // engram_count is derived from the bytes that were hashed, inside
  // emitCheckpoint — not passed in. An attested count that is not bound to the
  // hash beside it is not attested at all.
  // attestStore refuses rather than attesting a count of 0 beside a hash of the
  // real file, so an unparseable or non-store engrams.yaml now reaches here as
  // a throw. The command already explains the missing-file case; an unreadable
  // one deserves the same treatment rather than a raw js-yaml stack trace out
  // of the built CLI.
  let data
  try {
    data = emitCheckpoint(plurRoot, engramsPath, 'cli', undefined, signingOptions)
  } catch (err) {
    outputText('Cannot checkpoint: the store could not be read as a store.')
    outputText(`  ${engramsPath}`)
    outputText(`  ${err instanceof Error ? err.message : String(err)}`)
    outputText('  A checkpoint that cannot attest the store is not written at all.')
    process.exitCode = 1
    return
  }

  const signed = typeof data.signature === 'string'

  if (shouldOutputJson(flags)) {
    outputJson({
      // First, because it is the value you anchor.
      event_hash: data.event_hash ?? null,
      chain_head: data.chain_head,
      store_hash: data.store_hash,
      engram_count: data.engram_count,
      actor: data.actor,
      signer: data.signer ?? null,
      signature: data.signature ?? null,
    })
  } else {
    outputText(`Checkpoint emitted`)
    outputText(`  event_hash:   ${data.event_hash ?? '(unstamped)'}   <- anchor this`)
    outputText(`  store_hash:   ${data.store_hash}`)
    outputText(`  chain_head:   ${data.chain_head ?? '(genesis — no prior chained event)'}`)
    outputText(`  engram_count: ${data.engram_count}`)
    outputText(`  actor:        ${data.actor}`)
    if (signed) {
      outputText(`  signer:       ${data.signer}`)
      outputText(`  signature:    (Ed25519, base64 — run 'plur verify --signatures' to check)`)
    } else {
      outputText(`  signature:    (unsigned — run 'plur keys init' to enable L3 signing)`)
    }
  }
}
