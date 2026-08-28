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
import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText } from '../output.js'
import { emitCheckpoint } from '@plur-ai/core'

export async function run(_args: string[], flags: GlobalFlags): Promise<void> {
  // Write engine needed: emitCheckpoint calls appendHistory (a write).
  const plur = createPlur(flags)
  const status = await plur.status()

  const plurRoot = plur.storageRoot
  const engramsPath = join(plurRoot, 'engrams.yaml')

  const data = emitCheckpoint(plurRoot, engramsPath, status.engram_count, 'cli')

  if (shouldOutputJson(flags)) {
    outputJson({
      chain_head: data.chain_head,
      store_hash: data.store_hash,
      engram_count: data.engram_count,
      actor: data.actor,
    })
  } else {
    outputText(`Checkpoint emitted`)
    outputText(`  store_hash:   ${data.store_hash}`)
    outputText(`  chain_head:   ${data.chain_head ?? '(genesis — no prior chained event)'}`)
    outputText(`  engram_count: ${data.engram_count}`)
    outputText(`  actor:        ${data.actor}`)
  }
}
