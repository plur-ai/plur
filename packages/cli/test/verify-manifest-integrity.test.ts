/**
 * `plur verify --manifest <reference>` only says verified when the notary's
 * signature covers the manifest and comes from a notary the verifier can name
 * (0.23 release audit, finding 2). A missing signature, a self-signed one, or
 * a real signature over some other field is never a pass.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import { createServer, type Server } from 'http'
import { createHash, randomBytes } from 'crypto'
import type { AddressInfo } from 'net'
import { secp256k1 } from '@noble/curves/secp256k1'
import { keccak_256 } from '@noble/hashes/sha3'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))
const REF = 'ab'.repeat(32)

function addr(priv: Uint8Array): string {
  return '0x' + Buffer.from(keccak_256(secp256k1.getPublicKey(priv, false).slice(1)).slice(-20)).toString('hex')
}
function canon(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']'
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon((v as Record<string, unknown>)[k])).join(',') + '}'
  return JSON.stringify(v)
}
function sign(priv: Uint8Array, dataHash: string, ts: string): string {
  const msg = Buffer.from(`${dataHash}|${ts}`)
  const d = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${msg.length}`), msg]))
  const s = secp256k1.sign(d, priv)
  return '0x' + s.toCompactHex() + (27 + s.recovery).toString(16)
}

const NOTARY_KEY = new Uint8Array(32).fill(0x11)
const NOTARY = addr(NOTARY_KEY)
const manifest = { schema: 'plur/session-manifest/v1', session_id: 's1', actor: 'unidentified', window: { from: null, to: null }, engrams: [], created_at: '2026-10-28T00:00:00.000Z' }
const bytes = Buffer.from(JSON.stringify(manifest))
const data = bytes.toString('base64')
const TS = '2026-10-28T00:00:00Z'
const DH = createHash('sha256').update(canon(data)).digest('hex')

type Scenario = { signatures: unknown[]; notaryInfo: Record<string, unknown>; extra?: Record<string, unknown> }

let server: Server | undefined
const dirs: string[] = []
afterEach(async () => {
  await new Promise<void>(r => (server ? server.close(() => r()) : r()))
  server = undefined
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function gateway(s: Scenario): Promise<string> {
  const doc = { data, content_hash: createHash('sha256').update(bytes).digest('hex'), ...(s.extra ?? {}) }
  server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url?.startsWith('/api/v1/notary/info')) return void res.end(JSON.stringify(s.notaryInfo))
    if (req.url?.startsWith('/api/v1/data/')) return void res.end(JSON.stringify({ metadata: doc, signatures: s.signatures }))
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise<void>(r => server!.listen(0, '127.0.0.1', () => r()))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
}

function verify(url: string, extra: string[] = []): Promise<{ code: number | null; out: Record<string, any> }> {
  const store = mkdtempSync(join(tmpdir(), 'plur-vm-int-'))
  dirs.push(store)
  return new Promise((resolve, reject) => {
    const p = spawn('node', [CLI, 'verify', '--manifest', REF, '--gateway', url, '--json', ...extra], {
      env: { ...process.env, PLUR_PATH: store, PLUR_DISABLE_EMBEDDINGS: '1' },
    })
    let stdout = ''
    p.stdout.on('data', c => { stdout += c })
    p.on('error', reject)
    p.on('close', code => {
      try { resolve({ code, out: JSON.parse(stdout) }) } catch { reject(new Error(`not JSON: ${stdout}`)) }
    })
  })
}

describe('verify --manifest: the notary signature must cover the manifest and come from a known notary', () => {
  it('a real notary signature over the data, from the pinned notary, verifies (control)', async () => {
    const url = await gateway({ signatures: [{ signer: NOTARY, data_hash: DH, timestamp: TS, signature: sign(NOTARY_KEY, DH, TS) }], notaryInfo: { address: NOTARY } })
    const r = await verify(url, ['--notary', NOTARY])
    expect(r.out.status, JSON.stringify(r.out)).toBe('verified')
    expect(r.code).toBe(0)
  })

  it('a non-default gateway naming its own notary is not trusted by default: cannot verify (0.23 review, finding 9)', async () => {
    const url = await gateway({ signatures: [{ signer: NOTARY, data_hash: DH, timestamp: TS, signature: sign(NOTARY_KEY, DH, TS) }], notaryInfo: { address: NOTARY } })
    const r = await verify(url)
    expect(r.out.status, JSON.stringify(r.out)).toBe('cannot_verify')
    expect(r.code).toBe(2)
  })

  it('--trust-gateway-notary takes the notary the gateway names, and says so', async () => {
    const url = await gateway({ signatures: [{ signer: NOTARY, data_hash: DH, timestamp: TS, signature: sign(NOTARY_KEY, DH, TS) }], notaryInfo: { address: NOTARY } })
    const r = await verify(url, ['--trust-gateway-notary'])
    expect(r.out.status, JSON.stringify(r.out)).toBe('verified')
    expect(r.out.integrity?.notary_source).toBe('gateway')
  })

  it('no signature with a pinned notary is not verified', async () => {
    const url = await gateway({ signatures: [], notaryInfo: { address: NOTARY } })
    const r = await verify(url, ['--notary', NOTARY])
    expect(r.out.status, JSON.stringify(r.out)).not.toBe('verified')
    expect(r.code).not.toBe(0)
  })

  it('no signature at all is not verified', async () => {
    const url = await gateway({ signatures: [], notaryInfo: { address: NOTARY } })
    const r = await verify(url)
    expect(r.out.status, JSON.stringify(r.out)).not.toBe('verified')
    expect(r.code).not.toBe(0)
  })

  it('a self-signed document, when the gateway names no notary, cannot be verified (exit 2)', async () => {
    const k = randomBytes(32)
    const url = await gateway({ signatures: [{ signer: addr(k), data_hash: DH, timestamp: TS, signature: sign(k, DH, TS) }], notaryInfo: {} })
    const r = await verify(url, ['--trust-gateway-notary'])
    expect(r.out.status, JSON.stringify(r.out)).toBe('cannot_verify')
    expect(r.code).toBe(2)
  })

  it('a real notary signature over another field does not cover the manifest', async () => {
    const other = 'something the notary really signed'
    const h = createHash('sha256').update(canon({ other })).digest('hex')
    const url = await gateway({
      signatures: [{ signer: NOTARY, data_hash: h, timestamp: TS, hashed_fields: ['other'], signature: sign(NOTARY_KEY, h, TS) }],
      notaryInfo: { address: NOTARY },
      extra: { other },
    })
    const r = await verify(url, ['--notary', NOTARY])
    expect(r.out.status, JSON.stringify(r.out)).not.toBe('verified')
    expect(r.code).not.toBe(0)
  })
})
