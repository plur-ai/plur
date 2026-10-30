/**
 * The provenance gateway's HTTP API — PLUR's only network client for
 * provenance (#1657). The gateway stores on Swarm and signs with its notary;
 * PLUR carries no Swarm or Bee client. The gateway address is a user setting
 * (`receipts.gateway_url`); `DEFAULT_GATEWAY_URL` is the default we ship.
 *
 * Calls (the ones the @datafund/swarm-provenance SDK and the Datacore
 * provenance module's `lib/gateway.py` make):
 *
 *   POST /api/v1/pool/acquire                    {"size":"small"} -> {batch_id}
 *   POST /api/v1/data/?stamp_id=..&sign=notary   multipart file "provenance.json"
 *   GET  /api/v1/data/<reference>                -> {data, content_hash, signatures[]}
 *   GET  /api/v1/notary/info                     -> {enabled, available, address}
 *
 * Every request uses the free tier (`X-Payment-Mode: free`): about three
 * requests a minute, and an upload costs two. Free pool stamps last about a
 * day; `receipts.stamp_id` names a stamp bought through the gateway instead.
 *
 * The uploaded document is the SDK's metadata shape:
 *   {"data": base64(bytes), "content_hash": sha256(bytes), "stamp_id": ...}
 *
 * Network: only when the user turned uploads on (`receipts.store: swarm`) or
 * asked to verify a reference. Lives outside @plur-ai/core, which makes no
 * provenance network calls. Checking the notary's signature (secp256k1,
 * keccak) stays in the CLI (`plur verify --manifest`).
 */
import { createHash, randomUUID } from 'crypto'
import type { WormStore, WormPutResult } from '@plur-ai/core'

export const DEFAULT_GATEWAY_URL = 'https://provenance-gateway.datafund.io'

/** Shown with every manifest upload and check while the feature is a test release. */
export const EXPERIMENTAL_NOTE = 'Experimental: session manifests and Swarm storage are a test feature in 0.23. The manifest format, the gateway and its notary may change.'
/**
 * The notary the default gateway signs with. A signature on a document
 * downloaded from the default gateway is checked against THIS address, not the
 * one the gateway reports about itself, so a compromised gateway cannot vouch
 * for its own forgeries (0.23 code review, finding 9).
 */
export const DEFAULT_NOTARY_ADDRESS = '0x085656cBb5548B07295d2FeBD2fFCEe596c3c63A'

/** True when `url` is the default gateway (trailing slashes and case ignored). */
export function isDefaultGateway(url: string | undefined): boolean {
  if (!url) return true
  return url.replace(/\/+$/, '').toLowerCase() === DEFAULT_GATEWAY_URL.toLowerCase()
}

/**
 * The notary a document downloaded from `gatewayUrl` must be signed by, before
 * asking the gateway anything: the one the user pinned, else the default
 * notary for the default gateway, else none known (null). A null means the
 * caller cannot verify unless the user explicitly trusts the notary the
 * gateway names about itself (`--trust-gateway-notary`).
 */
export function expectedNotaryFor(
  gatewayUrl: string | undefined,
  pinned: string | undefined,
): { address: string; source: 'pinned' | 'default' } | null {
  if (pinned) return { address: pinned, source: 'pinned' }
  if (isDefaultGateway(gatewayUrl)) return { address: DEFAULT_NOTARY_ADDRESS, source: 'default' }
  return null
}

/**
 * Whether the signer a gateway reports for an upload is the notary expected
 * for that gateway (code review of 0.23, R5). A comparison of addresses only —
 * a claim, not a verification: the signature itself is checked by `plur
 * verify --manifest`. `expected` is null when no notary is known for the
 * gateway (not the default one, nothing pinned).
 */
export function notaryClaim(gatewayUrl: string | undefined, signer: string, pinned?: string): { expected: boolean | null; address: string } {
  const exp = expectedNotaryFor(gatewayUrl, pinned)
  return { expected: exp ? exp.address.toLowerCase() === signer.toLowerCase() : null, address: signer }
}

const USER_AGENT = 'plur (session-manifest)'

export class GatewayError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string, readonly retryAfter?: number) {
    super(message)
    this.name = 'GatewayError'
  }
}

export interface NotarySignature {
  signer?: string
  signature?: string
  data_hash?: string
  timestamp?: string
  hashed_fields?: string[]
  signed_message_format?: string
  [k: string]: unknown
}

export interface GatewayDocument {
  data: string
  content_hash?: string
  stamp_id?: string
  signatures?: NotarySignature[]
  [k: string]: unknown
}

type FetchLike = typeof fetch

export class ProvenanceGateway implements WormStore {
  readonly name = 'swarm'
  constructor(
    private readonly baseUrl: string = DEFAULT_GATEWAY_URL,
    private readonly opts: { timeoutMs?: number; fetchImpl?: FetchLike; stampId?: string } = {},
  ) {}

  private async request(method: string, path: string, body?: Uint8Array | string, headers: Record<string, string> = {}): Promise<any> {
    const f = this.opts.fetchImpl ?? fetch
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 30_000)
    let res: Response
    let text: string
    // The abort timer covers the body as well as the headers: a gateway that
    // sends headers and then stalls must not hang the caller (0.23 audit, 18).
    try {
      try {
        res = await f(this.baseUrl.replace(/\/+$/, '') + path, {
          method,
          body: body as RequestInit['body'],
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', 'X-Payment-Mode': 'free', ...headers },
          signal: ctrl.signal,
        })
      } catch (err) {
        throw new GatewayError(`gateway unreachable: ${(err as Error).message}`, undefined, 'CONNECTION_FAILED')
      }
      try {
        text = await res.text()
      } catch (err) {
        throw new GatewayError(`gateway response not read in time: ${(err as Error).message}`, res.status, 'CONNECTION_FAILED')
      }
    } finally {
      clearTimeout(timer)
    }
    let json: any
    try { json = text ? JSON.parse(text) : {} } catch { json = undefined }
    if (!res.ok) {
      const detail = json?.detail
      const message = typeof detail === 'string' ? detail : detail?.message ?? `HTTP ${res.status}`
      const code = json?.code ?? detail?.code
      const raHeader = res.headers.get('retry-after')
      const ra = raHeader === null ? NaN : Number(raHeader)
      throw new GatewayError(message, res.status, code ?? (res.status === 429 ? 'RATE_LIMITED' : undefined), Number.isFinite(ra) ? ra : undefined)
    }
    if (json === undefined) throw new GatewayError('gateway returned non-JSON', res.status, 'BAD_RESPONSE')
    return json
  }

  async put(bytes: Buffer): Promise<WormPutResult> {
    // A stamp the user bought (receipts.stamp_id) outlives the free pool
    // stamps, which expire in about a day. PLUR never buys one itself: the
    // gateway's /api/v1/stamps endpoints do that.
    let stamp = this.opts.stampId
    if (!stamp) {
      const pool = await this.request('POST', '/api/v1/pool/acquire', JSON.stringify({ size: 'small' }), { 'Content-Type': 'application/json' })
      stamp = pool?.batch_id
      if (typeof stamp !== 'string' || !stamp) throw new GatewayError('the gateway pool returned no stamp', undefined, 'POOL_EXHAUSTED')
    }
    const contentHash = createHash('sha256').update(bytes).digest('hex')
    const doc = { data: bytes.toString('base64'), content_hash: contentHash, stamp_id: stamp }
    const boundary = '----plur' + randomUUID().replace(/-/g, '')
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="provenance.json"\r\nContent-Type: application/json\r\n\r\n`),
      Buffer.from(JSON.stringify(doc)),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    const res = await this.request('POST', `/api/v1/data/?stamp_id=${encodeURIComponent(stamp)}&sign=notary`, body, {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    })
    const reference = res?.reference
    if (typeof reference !== 'string' || !reference) throw new GatewayError('upload response has no reference', undefined, 'BAD_RESPONSE')
    let sigs: NotarySignature[] | undefined = res.signatures ?? res.signed_document?.signatures
    // The live gateway answers an upload with the reference (and the stamp's
    // expiry) only; the notary signature is on the stored document. Read it
    // back once, best-effort: the upload has already succeeded either way.
    // On the free tier (about 3 requests a minute) this read-back can be the
    // request over the limit: a short Retry-After is waited out once, a long
    // one is not, and the result says the signature is still to be read
    // (code review of 0.23, R4) — `plur verify --manifest` reads it later.
    let pending = false
    if (sigs === undefined) {
      for (let attempt = 0; attempt < 2 && sigs === undefined; attempt++) {
        try {
          sigs = (await this.document(reference)).signatures ?? []
        } catch (err) {
          const ra = err instanceof GatewayError && err.status === 429 ? err.retryAfter : undefined
          if (attempt === 0 && ra !== undefined && ra > 0 && ra <= 5) { await new Promise(r => setTimeout(r, ra * 1000)); continue }
          break
        }
      }
      if (sigs === undefined) { sigs = []; pending = true }
    }
    const sig = sigs?.[0]
    const expiresAt = typeof res.expires_at === 'string' ? res.expires_at : undefined
    return {
      reference,
      content_hash: contentHash,
      ...(sig?.signer ? { signer: sig.signer } : {}),
      ...(sig?.signature ? { signature: sig.signature } : {}),
      ...(sig?.timestamp ? { timestamp: sig.timestamp } : {}),
      ...(expiresAt ? { expires_at: expiresAt } : {}),
      ...(pending ? { signature_pending: true } : {}),
    }
  }

  /** The stored document, as the gateway returns it. */
  async document(reference: string): Promise<GatewayDocument> {
    if (!/^[0-9a-fA-F]{64}$/.test(reference)) throw new GatewayError(`not a Swarm reference: ${reference}`, undefined, 'BAD_REFERENCE')
    const data = await this.request('GET', `/api/v1/data/${reference}`)
    if (data && typeof data.metadata === 'object' && data.metadata) {
      return { ...data.metadata, signatures: data.signatures ?? [] }
    }
    return data
  }

  async get(reference: string): Promise<{ bytes: Buffer; content_hash?: string; signer?: string; signature?: string; timestamp?: string }> {
    const doc = await this.document(reference)
    if (typeof doc?.data !== 'string') throw new GatewayError('the stored document has no data field', undefined, 'BAD_RESPONSE')
    const sig = doc.signatures?.[0]
    return {
      bytes: Buffer.from(doc.data, 'base64'),
      ...(doc.content_hash ? { content_hash: doc.content_hash } : {}),
      ...(sig?.signer ? { signer: sig.signer } : {}),
      ...(sig?.signature ? { signature: sig.signature } : {}),
      ...(sig?.timestamp ? { timestamp: sig.timestamp } : {}),
    }
  }

  async notaryAddress(): Promise<string | null> {
    const info = await this.request('GET', '/api/v1/notary/info')
    return typeof info?.address === 'string' ? info.address : null
  }
}

