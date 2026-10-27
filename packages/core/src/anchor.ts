/**
 * Anchor a session manifest on Swarm and keep a local record of it (#1657).
 *
 * Shared by `plur manifest --anchor` and the MCP server's session end, so both
 * upload the same canonical bytes and write the same record:
 *   <PLUR home>/receipts/<session id>.json  (owner-only)
 * holding the reference, the manifest hash, the notary signature and the
 * manifest itself.
 */
import { mkdirSync, writeFileSync, chmodSync } from 'fs'
import { join } from 'path'
import { canonicalManifestBytes, type SessionManifest, type WormStore } from './session-manifest.js'
import { SwarmGatewayStore, DEFAULT_GATEWAY_URL } from './swarm-store.js'

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
  gatewayUrl?: string,
  store?: WormStore,
): Promise<AnchorRecord> {
  const gateway = gatewayUrl ?? DEFAULT_GATEWAY_URL
  const worm = store ?? new SwarmGatewayStore(gateway)
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
    const safe = manifest.session_id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96) || 'session'
    const file = join(dir, `${safe}.json`)
    writeFileSync(file, JSON.stringify({ ...rec, manifest }, null, 2) + '\n', { mode: 0o600 })
    try { chmodSync(file, 0o600) } catch { /* best-effort on filesystems without modes */ }
  } catch { /* the upload succeeded; a missing local record is not a failed anchor */ }
  return rec
}
