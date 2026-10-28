// A stand-in for the public provenance gateway (Swarm storage + notary
// signature), for the provenance evals. A real in-process HTTP server on
// 127.0.0.1 that counts every request, stores what it is given under a
// content reference, and signs like the gateway's notary: EIP-191
// personal_sign over "{data_hash}|{timestamp}" with a fixed test key.
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
// @noble/* are dependencies of packages/cli only; imported by path.
import { secp256k1 } from '../../packages/cli/node_modules/@noble/curves/secp256k1.js'
import { keccak_256 } from '../../packages/cli/node_modules/@noble/hashes/sha3.js'

const NOTARY_KEY = '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318'

export function notaryAddressFor(keyHex: string): string {
  const pub = secp256k1.getPublicKey(keyHex, false).slice(1)
  return '0x' + Buffer.from(keccak_256(pub).slice(-20)).toString('hex')
}

function personalSign(message: string, keyHex: string): string {
  const msg = Buffer.from(message, 'utf8')
  const digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${msg.length}`, 'utf8'), msg]))
  const sig = secp256k1.sign(digest, keyHex)
  return sig.toCompactHex() + (27 + sig.recovery).toString(16)
}

export interface GatewayStub {
  url: string
  /** Every request, as "METHOD /path", in arrival order. */
  hits: string[]
  /** Stored documents by reference. */
  docs: Map<string, Record<string, unknown>>
  notary: string
  stop(): Promise<void>
}

export async function startGatewayStub(): Promise<GatewayStub> {
  const hits: string[] = []
  const docs = new Map<string, Record<string, unknown>>()
  const notary = notaryAddressFor(NOTARY_KEY)
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0]
      hits.push(`${req.method} ${path}`)
      const body = Buffer.concat(chunks)
      const send = (status: number, obj: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
      if (req.method === 'POST' && path === '/api/v1/pool/acquire') return send(200, { batch_id: 'ab'.repeat(32) })
      if (req.method === 'GET' && path === '/api/v1/notary/info') return send(200, { enabled: true, available: true, address: notary })
      if (req.method === 'POST' && path === '/api/v1/data/') {
        const text = body.toString('utf8')
        const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
        const doc = JSON.parse(json) as { data: string; content_hash: string; stamp_id: string }
        const timestamp = new Date().toISOString()
        const data_hash = createHash('sha256').update(JSON.stringify(doc.data), 'utf8').digest('hex')
        const signature = { type: 'notary', signer: notary, timestamp, data_hash, signature: personalSign(`${data_hash}|${timestamp}`, NOTARY_KEY), hashed_fields: ['data'], signed_message_format: '{data_hash}|{timestamp}' }
        const reference = createHash('sha256').update(json).digest('hex')
        docs.set(reference, { ...doc, signatures: [signature] })
        return send(200, { reference, signed_document: { signatures: [signature] } })
      }
      const m = /^\/api\/v1\/data\/([0-9a-f]{64})$/.exec(path)
      if (req.method === 'GET' && m) {
        const doc = docs.get(m[1])
        return doc ? send(200, doc) : send(404, { detail: 'not found' })
      }
      send(404, { detail: 'no such route' })
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as AddressInfo).port
  return { url: `http://127.0.0.1:${port}`, hits, docs, notary, stop: () => new Promise<void>(r => server.close(() => r())) }
}
