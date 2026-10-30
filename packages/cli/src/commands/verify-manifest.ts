/**
 * `plur verify --manifest <file|reference>` (#1657).
 *
 * Exit codes, as for `plur verify`:
 *   0  every engram this store holds matches, and a downloaded manifest's
 *      content hash and notary signature check out
 *   1  at least one engram CHANGED, or the downloaded bytes or signature do not check
 *   2  cannot verify: no such file, not a manifest, the gateway could not be
 *      reached, the stored document has no notary signature or no notary
 *      address to check it against, or none of the listed engrams is in this
 *      store
 *
 * Which notary a downloaded manifest must be signed by: `--notary <address>`
 * if given; for the default gateway, the default notary; for any other
 * gateway, none — unless `--trust-gateway-notary` accepts the address that
 * gateway reports about itself. Trusting the gateway that served the document
 * to name its own signer would let a compromised gateway vouch for its own
 * forgeries (0.23 code review, finding 9).
 *
 * NOT AVAILABLE (an engram this store does not hold) is counted and shown,
 * never turned into a pass or a failure: it is an unknown.
 */
import { readFileSync, existsSync } from 'fs'
import { createHash } from 'crypto'
import { createPlur, type GlobalFlags } from '../plur.js'
import { shouldOutputJson, outputJson, outputText } from '../output.js'
import type { SessionManifest } from '@plur-ai/core'
import { ProvenanceGateway, DEFAULT_GATEWAY_URL, EXPERIMENTAL_NOTE, expectedNotaryFor } from '@plur-ai/gateway'
import { checkNotarySignature, type NotaryCheck } from '../lib/notary.js'

function cannot(flags: GlobalFlags, reason: string): void {
  if (shouldOutputJson(flags)) outputJson({ status: 'cannot_verify', reason, experimental: EXPERIMENTAL_NOTE })
  else {
    outputText('plur verify --manifest: CANNOT VERIFY')
    outputText(`  reason: ${reason}`)
    outputText('  This is NOT a clean result: nothing is asserted either way.')
    outputText(`  ${EXPERIMENTAL_NOTE}`)
  }
  process.exitCode = 2
}

export async function runManifest(target: string | undefined, args: string[], flags: GlobalFlags): Promise<void> {
  if (!target || target.startsWith('--')) return cannot(flags, 'usage: plur verify --manifest <file|swarm reference> [--notary <address>] [--gateway <url>] [--trust-gateway-notary]')
  const ni = args.indexOf('--notary')
  const pinnedNotary = ni >= 0 ? args[ni + 1] : undefined
  const gi = args.indexOf('--gateway')
  const trustGatewayNotary = args.includes('--trust-gateway-notary')

  const plur = createPlur(flags, { readonly: true })
  let bytes: Buffer
  let source: { kind: 'file' | 'swarm'; reference?: string } = { kind: 'file' }
  let integrity: { content_hash_ok: boolean; notary: NotaryCheck | null; expected_notary: string | null; notary_source: 'pinned' | 'default' | 'gateway' | null } | null = null

  if (existsSync(target)) {
    bytes = readFileSync(target)
  } else if (/^[0-9a-fA-F]{64}$/.test(target)) {
    const gateway = (gi >= 0 ? args[gi + 1] : undefined) ?? plur.receiptsConfig().gateway_url ?? DEFAULT_GATEWAY_URL
    const store = new ProvenanceGateway(gateway)
    source = { kind: 'swarm', reference: target }
    try {
      const doc = await store.document(target)
      if (typeof doc.data !== 'string') return cannot(flags, 'the stored document has no data field')
      bytes = Buffer.from(doc.data, 'base64')
      const actual = createHash('sha256').update(bytes).digest('hex')
      const sig = doc.signatures?.[0]
      // No signature, or no notary to compare it with, is not a pass: the
      // bytes matching their own hash proves nothing about who stored them.
      if (!sig) return cannot(flags, `the stored document carries no notary signature${pinnedNotary ? ` (expected one from ${pinnedNotary})` : ''}`)
      const known = expectedNotaryFor(gateway, pinnedNotary)
      let expected: string | null = known?.address ?? null
      let notarySource: 'pinned' | 'default' | 'gateway' | null = known?.source ?? null
      if (!expected && trustGatewayNotary) { expected = await store.notaryAddress(); notarySource = expected ? 'gateway' : null }
      if (!expected) {
        return cannot(flags, trustGatewayNotary
          ? 'no notary address to check the signature against: the gateway names none; pass --notary <address>'
          : `${gateway} is not the default gateway, so its notary is not known: pass --notary <address>, or --trust-gateway-notary to accept the address that gateway reports about itself`)
      }
      const notary = checkNotarySignature(sig, doc)
      if (notary.recovered && notary.recovered.toLowerCase() !== expected.toLowerCase()) {
        notary.signature_ok = false
        notary.error = `signed by ${notary.recovered}, expected notary ${expected}`
      }
      integrity = { content_hash_ok: actual === doc.content_hash, notary, expected_notary: expected, notary_source: notarySource }
    } catch (err) {
      return cannot(flags, `could not download ${target}: ${(err as Error).message}`)
    }
  } else {
    return cannot(flags, `${target} is neither a file nor a 64-character Swarm reference`)
  }

  let manifest: SessionManifest
  try { manifest = JSON.parse(bytes.toString('utf8')) } catch { return cannot(flags, 'the manifest is not valid JSON') }
  let v
  try { v = await plur.verifyManifest(manifest) } catch (err) { return cannot(flags, (err as Error).message) }

  const integrityOk = integrity === null || (integrity.content_hash_ok && integrity.notary !== null && integrity.notary.signature_ok)
  // Listed engrams of which none matched and none changed: nothing was checked,
  // which is not a pass (0.23 audit, finding 12).
  const nothingChecked = v.results.length > 0 && v.counts.MATCH === 0 && v.counts.CHANGED === 0
  if (integrityOk && nothingChecked) {
    return cannot(flags, `none of the ${v.results.length} listed engram(s) is in this store, so nothing could be checked; run this where those memories are held`)
  }
  const ok = v.counts.CHANGED === 0 && integrityOk
  if (shouldOutputJson(flags)) {
    outputJson({ status: ok ? 'verified' : 'broken', source, integrity, ...v, experimental: EXPERIMENTAL_NOTE })
  } else {
    outputText(ok ? 'plur verify --manifest: OK' : 'plur verify --manifest: BROKEN')
    outputText(`  session : ${v.session_id}`)
    if (source.kind === 'swarm' && integrity) {
      outputText(`  swarm   : ${source.reference}`)
      outputText(`  bytes   : ${integrity.content_hash_ok ? 'match the stored content hash' : 'DO NOT match the stored content hash'}`)
      if (integrity.notary) {
        const who = integrity.notary_source === 'pinned' ? 'the pinned notary' : integrity.notary_source === 'default' ? 'the default gateway\'s notary' : 'the notary the gateway names (trusted with --trust-gateway-notary)'
        outputText(`  notary  : ${integrity.notary.signature_ok ? `signature valid, ${who} (${integrity.notary.recovered}) at ${integrity.notary.timestamp}` : `signature NOT valid${integrity.notary.error ? ` — ${integrity.notary.error}` : ''}`}`)
      } else {
        outputText('  notary  : no signature on the stored document')
      }
    }
    outputText(`  engrams : ${v.counts.MATCH} match, ${v.counts.CHANGED} changed, ${v.counts['NOT AVAILABLE']} not available here`)
    for (const r of v.results) {
      if (r.status === 'MATCH' && !args.includes('--all')) continue
      outputText(`    ${r.status.padEnd(13)} ${r.id} (${r.role})${r.detail ? ` — ${r.detail}` : ''}`)
    }
    outputText('')
    outputText('  These engrams were in the agent\'s context when it acted. The manifest')
    outputText('  does not say they caused anything.')
    outputText(`  ${EXPERIMENTAL_NOTE}`)
  }
  process.exitCode = ok ? 0 : 1
}
