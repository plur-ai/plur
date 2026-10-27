/**
 * Swarm as PLUR's first write-once store (#1657), through the public
 * provenance gateway. The only `WormStore` implementation; core defines the
 * interface and makes no network calls itself.
 *
 * The calls are the ones the @datafund/swarm-provenance SDK makes, and the
 * Datacore provenance module's stdlib client (`lib/gateway.py`) mirrors:
 *
 *   POST /api/v1/pool/acquire                    {"size":"small"} -> {batch_id}
 *   POST /api/v1/data/?stamp_id=..&sign=notary   multipart file "provenance.json"
 *   GET  /api/v1/data/<reference>                -> {data, content_hash, signatures[]}
 *   GET  /api/v1/notary/info                     -> {enabled, available, address}
 *
 * Every request uses the free tier (`X-Payment-Mode: free`): about three
 * requests a minute, and an upload costs two. Free-tier stamps are short-lived
 * (roughly a day), so a free upload is a demonstration, not an archive; the
 * caller says so.
 *
 * The uploaded document is the SDK's metadata shape:
 *   {"data": base64(bytes), "content_hash": sha256(bytes), "stamp_id": ...}
 * so `content_hash` is the SHA-256 of the manifest bytes.
 *
 * Network: only when the user turned anchoring on (`receipts.store: swarm`)
 * or asked to verify a reference. Nothing in recall, inject or learn calls it.
 * Checking the notary's signature needs secp256k1 and keccak, so it lives in
 * the CLI (`plur verify --manifest`), not here.
 */
import { createHash, randomUUID } from 'crypto'
import type { WormStore, WormPutResult } from './session-manifest.js'

export const DEFAULT_GATEWAY_URL = 'https://provenance-gateway.datafund.io'
const USER_AGENT = 'plur-cli (session-manifest)'

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

export class SwarmGatewayStore implements WormStore {
  readonly name = 'swarm'
  constructor(
    private readonly baseUrl: string = DEFAULT_GATEWAY_URL,
    private readonly opts: { timeoutMs?: number; fetchImpl?: FetchLike } = {},
  ) {}

  private async request(method: string, path: string, body?: Uint8Array | string, headers: Record<string, string> = {}): Promise<any> {
    const f = this.opts.fetchImpl ?? fetch
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 30_000)
    let res: Response
    try {
      res = await f(this.baseUrl.replace(/\/+$/, '') + path, {
        method,
        body: body as BodyInit | undefined,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', 'X-Payment-Mode': 'free', ...headers },
        signal: ctrl.signal,
      })
    } catch (err) {
      throw new GatewayError(`gateway unreachable: ${(err as Error).message}`, undefined, 'CONNECTION_FAILED')
    } finally {
      clearTimeout(timer)
    }
    const text = await res.text()
    let json: any
    try { json = text ? JSON.parse(text) : {} } catch { json = undefined }
    if (!res.ok) {
      const detail = json?.detail
      const message = typeof detail === 'string' ? detail : detail?.message ?? `HTTP ${res.status}`
      const code = json?.code ?? detail?.code
      const ra = Number(res.headers.get('retry-after'))
      throw new GatewayError(message, res.status, code ?? (res.status === 429 ? 'RATE_LIMITED' : undefined), Number.isFinite(ra) ? ra : undefined)
    }
    if (json === undefined) throw new GatewayError('gateway returned non-JSON', res.status, 'BAD_RESPONSE')
    return json
  }

  async put(bytes: Buffer): Promise<WormPutResult> {
    const pool = await this.request('POST', '/api/v1/pool/acquire', JSON.stringify({ size: 'small' }), { 'Content-Type': 'application/json' })
    const stamp = pool?.batch_id
    if (typeof stamp !== 'string' || !stamp) throw new GatewayError('the gateway pool returned no stamp', undefined, 'POOL_EXHAUSTED')
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
    const sigs: NotarySignature[] = res.signatures ?? res.signed_document?.signatures ?? []
    const sig = sigs[0]
    return {
      reference,
      content_hash: contentHash,
      ...(sig?.signer ? { signer: sig.signer } : {}),
      ...(sig?.signature ? { signature: sig.signature } : {}),
      ...(sig?.timestamp ? { timestamp: sig.timestamp } : {}),
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

