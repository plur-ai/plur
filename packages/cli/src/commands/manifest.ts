/**
 * `plur manifest` — the session memory manifest (#1657): which engrams were in
 * one session's context, with hashes anyone can check later.
 *
 * Usage:
 *   plur manifest --session <id>                 Print the manifest (canonical JSON)
 *   plur manifest --session <id> --out <file>    Write it to a file
 *   plur manifest --session <id> --anchor        Also store it on Swarm (needs receipts.store: swarm)
 *
 * The manifest holds ids and hashes only: never engram text, scope names, tags
 * or domains. Anchoring uploads exactly those bytes to a public network
 * through the provenance gateway's free tier; it never happens unless the user
 * set `receipts.store: swarm` in config.yaml.
 */
import { writeFileSync } from 'fs'
import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText, exit } from '../output.js'
import { canonicalManifestBytes } from '@plur-ai/core'
import { anchorManifest } from '@plur-ai/gateway'

const USAGE = 'Usage: plur manifest --session <id> [--out <file>] [--anchor] [--json]'

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  let session: string | undefined
  let out: string | undefined
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--session' && i + 1 < args.length) session = args[++i]
    else if (args[i] === '--out' && i + 1 < args.length) out = args[++i]
  }
  const anchor = args.includes('--anchor')
  if (!session) exit(2, USAGE)

  const plur = createPlur(flags, { readonly: !anchor })
  const manifest = await plur.sessionManifest(session!)
  const bytes = canonicalManifestBytes(manifest)
  if (manifest.engrams.length === 0) {
    process.stderr.write(`plur manifest: no injected, recalled or written engrams are recorded for session ${session}.\n`)
  }
  if (out) writeFileSync(out, bytes)

  if (!anchor) {
    if (shouldOutputJson(flags) || !out) outputJson(manifest)
    else outputText(`Wrote the manifest for session ${session} (${manifest.engrams.length} engrams) to ${out}`)
    return
  }

  const receipts = plur.receiptsConfig()
  if (receipts.store !== 'swarm') {
    exit(2, 'Anchoring is off. To store manifests on Swarm, set `receipts:\n  store: swarm` in your PLUR config.yaml. Only ids and hashes are uploaded, to a public network.')
  }
  try {
    const rec = await anchorManifest(plur.storageRoot, manifest, receipts)
    if (shouldOutputJson(flags)) {
      outputJson({ ...rec, manifest })
    } else {
      outputText(`Stored on Swarm: ${rec.reference}`)
      outputText(`  manifest sha256: ${rec.content_hash}`)
      if (rec.signer) outputText(`  signed by the gateway notary ${rec.signer} at ${rec.timestamp}`)
      if (rec.expires_at) outputText(`  stored until about ${rec.expires_at} (when its postage stamp runs out)`)
      outputText(`  engrams: ${manifest.engrams.length}`)
      outputText('')
      outputText(`Check it from any machine:  plur verify --manifest ${rec.reference}`)
      if (!receipts.stamp_id) outputText('A free-tier upload stays downloadable for about a day; set receipts.stamp_id to a bought stamp to keep uploads longer.')
    }
  } catch (err) {
    exit(1, `plur manifest: the upload failed — ${(err as Error).message}. Nothing was stored; the manifest is unchanged locally.`)
  }
}
