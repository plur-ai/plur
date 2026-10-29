/**
 * Store a session manifest through the provenance gateway (which keeps it on
 * Swarm) and keep a local record of it (#1657).
 *
 * Shared by `plur manifest --anchor` and the MCP server's session end, so both
 * upload the same canonical bytes and write the same record:
 *   <PLUR home>/receipts/<session id>.json  (owner-only)
 * holding the reference, the manifest hash, the notary signature and the
 * manifest itself.
 */
import { mkdirSync, writeFileSync, chmodSync } from 'fs'
import { join } from 'path'
import { canonicalManifestBytes, safeFileName, type SessionManifest, type WormStore } from '@plur-ai/core'
import { ProvenanceGateway, DEFAULT_GATEWAY_URL } from './client.js'

export interface AnchorRecord {
  store: 'swarm'
  gateway: string
  reference: string
  content_hash: string
  signer?: string
  signature?: string
  timestamp?: string
  session_id: string
  uploaded_at: string
}

export async function anchorManifest(
  root: string,
  manifest: SessionManifest,
  receipts: { gateway_url?: string; stamp_id?: string } = {},
  store?: WormStore,
): Promise<AnchorRecord> {
  const gateway = receipts.gateway_url ?? DEFAULT_GATEWAY_URL
  const worm = store ?? new ProvenanceGateway(gateway, receipts.stamp_id ? { stampId: receipts.stamp_id } : {})
  const bytes = canonicalManifestBytes(manifest)
  const put = await worm.put(bytes)
  const rec: AnchorRecord = {
    store: 'swarm',
    gateway,
    reference: put.reference,
    content_hash: put.content_hash ?? '',
    ...(put.signer ? { signer: put.signer } : {}),
    ...(put.signature ? { signature: put.signature } : {}),
    ...(put.timestamp ? { timestamp: put.timestamp } : {}),
    session_id: manifest.session_id,
    uploaded_at: new Date().toISOString(),
  }
  try {
    const dir = join(root, 'receipts')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, `${safeFileName(manifest.session_id)}.json`)
    writeFileSync(file, JSON.stringify({ ...rec, manifest }, null, 2) + '\n', { mode: 0o600 })
    try { chmodSync(file, 0o600) } catch { /* best-effort on filesystems without modes */ }
  } catch { /* the upload succeeded; a missing local record is not a failed anchor */ }
  return rec
}
