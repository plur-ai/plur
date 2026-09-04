/**
 * W3.1 — Per-actor Ed25519 keys (#1055)
 * W3.2 — Sign checkpoints; verify --signatures (#1056)
 *
 * Tests cover:
 *   - initActorKey: generate, idempotent, correct permissions
 *   - loadPrivateKeyBuffer: absent → null, wrong mode → throws
 *   - signWithActorKey: signs; absent key → null
 *   - verifySignature: valid, invalid, corrupt
 *   - registerPublicKey / lookupPublicKey: round-trip, update
 *   - keyFingerprint: 16 hex chars
 *   - emitCheckpoint with signing: signature + signer in event
 *   - emitCheckpoint without signing: no signature field
 *   - verifyChain({ verifySignatures: true }): valid / unsigned / unknown / invalid
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as crypto from 'node:crypto'

import {
  initActorKey,
  loadPrivateKeyBuffer,
  signWithActorKey,
  verifySignature,
  registerPublicKey,
  lookupPublicKey,
  loadKeysRegistry,
  keyFingerprint,
  privateKeyPath,
} from '../src/actor-keys.js'

import {
  emitCheckpoint,
  appendHistory,
  readHistory,
  canonicalEventBytes,
  computeEventHash,
  type HistoryEvent,
} from '../src/history.js'

import { verifyChain } from '../src/verify-chain.js'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plur-keys-'))
}

// ---------------------------------------------------------------------------
// W3.1 — initActorKey
// ---------------------------------------------------------------------------

describe('initActorKey (#1055)', () => {
  let dir: string

  beforeEach(() => { dir = tmpDir() })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('RED → generates a new key pair and returns a base64 public key', () => {
    const keysDir = path.join(dir, 'keys')
    const pub = initActorKey('agent:test', keysDir)
    expect(typeof pub).toBe('string')
    expect(pub.length).toBeGreaterThan(20)
    expect(() => Buffer.from(pub, 'base64')).not.toThrow()
    // Must be a valid SPKI public key
    expect(() =>
      crypto.createPublicKey({ key: Buffer.from(pub, 'base64'), format: 'der', type: 'spki' }),
    ).not.toThrow()
  })

  it('writes the private key file at <keysDir>/<identity>.key', () => {
    const keysDir = path.join(dir, 'keys')
    initActorKey('agent:test', keysDir)
    const keyFile = privateKeyPath('agent:test', keysDir)
    expect(fs.existsSync(keyFile)).toBe(true)
  })

  it('creates the keys directory with restricted permissions', () => {
    const keysDir = path.join(dir, 'keys')
    expect(fs.existsSync(keysDir)).toBe(false)
    initActorKey('agent:test', keysDir)
    expect(fs.existsSync(keysDir)).toBe(true)
    const dirMode = fs.statSync(keysDir).mode & 0o777
    // Directory must not be world-readable
    expect(dirMode & 0o7).toBe(0)
  })

  it('sets private key file mode to 0600', () => {
    const keysDir = path.join(dir, 'keys')
    initActorKey('agent:test', keysDir)
    const keyFile = privateKeyPath('agent:test', keysDir)
    const mode = fs.statSync(keyFile).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('is idempotent: second call returns the same public key without overwriting', () => {
    const keysDir = path.join(dir, 'keys')
    const pub1 = initActorKey('agent:test', keysDir)
    const keyFile = privateKeyPath('agent:test', keysDir)
    const mtimeBefore = fs.statSync(keyFile).mtimeMs

    const pub2 = initActorKey('agent:test', keysDir)
    const mtimeAfter = fs.statSync(keyFile).mtimeMs

    expect(pub1).toBe(pub2)
    expect(mtimeAfter).toBe(mtimeBefore)
  })

  it('different identities get different key files', () => {
    const keysDir = path.join(dir, 'keys')
    const pub1 = initActorKey('agent:alice', keysDir)
    const pub2 = initActorKey('agent:bob', keysDir)
    expect(pub1).not.toBe(pub2)
    expect(fs.existsSync(privateKeyPath('agent:alice', keysDir))).toBe(true)
    expect(fs.existsSync(privateKeyPath('agent:bob', keysDir))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// W3.1 — loadPrivateKeyBuffer
// ---------------------------------------------------------------------------

describe('loadPrivateKeyBuffer (#1055)', () => {
  let dir: string

  beforeEach(() => { dir = tmpDir() })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('returns null when no key file exists', () => {
    const keysDir = path.join(dir, 'keys')
    expect(loadPrivateKeyBuffer('agent:nobody', keysDir)).toBeNull()
  })

  it('returns the key bytes when the file exists with mode 0600', () => {
    const keysDir = path.join(dir, 'keys')
    initActorKey('agent:test', keysDir)
    const buf = loadPrivateKeyBuffer('agent:test', keysDir)
    expect(buf).not.toBeNull()
    expect(Buffer.isBuffer(buf)).toBe(true)
    // Must be parseable as a PKCS8 private key
    expect(() =>
      crypto.createPrivateKey({ key: buf!, format: 'der', type: 'pkcs8' }),
    ).not.toThrow()
  })

  it('throws when the key file has wrong permissions (group-readable)', () => {
    const keysDir = path.join(dir, 'keys')
    initActorKey('agent:test', keysDir)
    const keyFile = privateKeyPath('agent:test', keysDir)
    fs.chmodSync(keyFile, 0o640)
    expect(() => loadPrivateKeyBuffer('agent:test', keysDir)).toThrow(/0600/)
  })

  it('throws when the key file has world-readable permissions', () => {
    const keysDir = path.join(dir, 'keys')
    initActorKey('agent:test', keysDir)
    const keyFile = privateKeyPath('agent:test', keysDir)
    fs.chmodSync(keyFile, 0o644)
    expect(() => loadPrivateKeyBuffer('agent:test', keysDir)).toThrow(/0600/)
  })
})

// ---------------------------------------------------------------------------
// W3.1 — signWithActorKey / verifySignature
// ---------------------------------------------------------------------------

describe('signWithActorKey / verifySignature (#1055, #1056)', () => {
  let dir: string

  beforeEach(() => { dir = tmpDir() })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('returns null when no key is found for the identity', () => {
    const keysDir = path.join(dir, 'keys')
    const sig = signWithActorKey(Buffer.from('hello'), 'agent:nobody', keysDir)
    expect(sig).toBeNull()
  })

  it('returns a base64 signature when key exists', () => {
    const keysDir = path.join(dir, 'keys')
    initActorKey('agent:test', keysDir)
    const sig = signWithActorKey(Buffer.from('hello'), 'agent:test', keysDir)
    expect(sig).not.toBeNull()
    expect(typeof sig).toBe('string')
    expect(() => Buffer.from(sig!, 'base64')).not.toThrow()
  })

  it('verifySignature: valid signature verifies', () => {
    const keysDir = path.join(dir, 'keys')
    const pubB64 = initActorKey('agent:test', keysDir)
    const data = Buffer.from('canonical event bytes')
    const sig = signWithActorKey(data, 'agent:test', keysDir)!
    expect(verifySignature(data, sig, pubB64)).toBe(true)
  })

  it('verifySignature: wrong data → false', () => {
    const keysDir = path.join(dir, 'keys')
    const pubB64 = initActorKey('agent:test', keysDir)
    const data = Buffer.from('original data')
    const sig = signWithActorKey(data, 'agent:test', keysDir)!
    expect(verifySignature(Buffer.from('tampered data'), sig, pubB64)).toBe(false)
  })

  it('verifySignature: wrong key → false', () => {
    const keysDir = path.join(dir, 'keys')
    const pubA = initActorKey('agent:alice', keysDir)
    initActorKey('agent:bob', keysDir)
    const data = Buffer.from('some data')
    const sig = signWithActorKey(data, 'agent:bob', keysDir)!
    // Bob's signature, checked against Alice's key
    expect(verifySignature(data, sig, pubA)).toBe(false)
  })

  it('verifySignature: corrupt signature → false (no throw)', () => {
    const keysDir = path.join(dir, 'keys')
    const pubB64 = initActorKey('agent:test', keysDir)
    const data = Buffer.from('data')
    const badSig = Buffer.from('not a valid ed25519 signature aaaaaa').toString('base64')
    expect(() => verifySignature(data, badSig, pubB64)).not.toThrow()
    expect(verifySignature(data, badSig, pubB64)).toBe(false)
  })

  it('CJK test vector: signs and verifies multibyte UTF-8 content', () => {
    const keysDir = path.join(dir, 'keys')
    const pubB64 = initActorKey('agent:test', keysDir)
    // CJK characters per runbook §3 requirement
    const cjkData = Buffer.from('学習した内容を覚える 記憶エンジン 持続的学習', 'utf8')
    const sig = signWithActorKey(cjkData, 'agent:test', keysDir)!
    expect(verifySignature(cjkData, sig, pubB64)).toBe(true)
    // Different bytes → invalid
    expect(verifySignature(Buffer.from('other data'), sig, pubB64)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// W3.1 — registerPublicKey / lookupPublicKey
// ---------------------------------------------------------------------------

describe('registerPublicKey / lookupPublicKey (#1055)', () => {
  let dir: string

  beforeEach(() => { dir = tmpDir() })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('lookupPublicKey returns null when no registry exists', () => {
    expect(lookupPublicKey(dir, 'agent:test')).toBeNull()
  })

  it('registers and looks up a public key', () => {
    const keysDir = path.join(dir, 'keys')
    const pub = initActorKey('agent:test', keysDir)
    registerPublicKey(dir, 'agent:test', pub)
    expect(lookupPublicKey(dir, 'agent:test')).toBe(pub)
  })

  it('lookup returns null for unknown identity', () => {
    const keysDir = path.join(dir, 'keys')
    const pub = initActorKey('agent:test', keysDir)
    registerPublicKey(dir, 'agent:test', pub)
    expect(lookupPublicKey(dir, 'agent:unknown')).toBeNull()
  })

  it('registering a new identity does not remove others', () => {
    const keysDir = path.join(dir, 'keys')
    const pubA = initActorKey('agent:alice', keysDir)
    const pubB = initActorKey('agent:bob', keysDir)
    registerPublicKey(dir, 'agent:alice', pubA)
    registerPublicKey(dir, 'agent:bob', pubB)
    expect(lookupPublicKey(dir, 'agent:alice')).toBe(pubA)
    expect(lookupPublicKey(dir, 'agent:bob')).toBe(pubB)
  })

  it('registering the same identity with the same key is a no-op (idempotent)', () => {
    const keysDir = path.join(dir, 'keys')
    const pub = initActorKey('agent:test', keysDir)
    registerPublicKey(dir, 'agent:test', pub, '2026-01-01T00:00:00.000Z')
    const before = fs.readFileSync(path.join(dir, 'keys.yaml'), 'utf8')
    registerPublicKey(dir, 'agent:test', pub)
    const after = fs.readFileSync(path.join(dir, 'keys.yaml'), 'utf8')
    expect(after).toBe(before)
  })

  it('registering the same identity with a DIFFERENT key updates the entry', () => {
    const keysDir1 = path.join(dir, 'keys1')
    const keysDir2 = path.join(dir, 'keys2')
    const pub1 = initActorKey('agent:test', keysDir1)
    const pub2 = initActorKey('agent:test', keysDir2)
    registerPublicKey(dir, 'agent:test', pub1)
    registerPublicKey(dir, 'agent:test', pub2)
    const registry = loadKeysRegistry(dir)
    expect(registry.keys.filter(k => k.identity === 'agent:test')).toHaveLength(1)
    expect(lookupPublicKey(dir, 'agent:test')).toBe(pub2)
  })

  it('writes keys.yaml atomically and with required fields', () => {
    const keysDir = path.join(dir, 'keys')
    const pub = initActorKey('agent:test', keysDir)
    registerPublicKey(dir, 'agent:test', pub)
    const registry = loadKeysRegistry(dir)
    expect(registry.keys).toHaveLength(1)
    expect(registry.keys[0].identity).toBe('agent:test')
    expect(registry.keys[0].public_key).toBe(pub)
    expect(typeof registry.keys[0].added_at).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// W3.1 — keyFingerprint
// ---------------------------------------------------------------------------

describe('keyFingerprint (#1055)', () => {
  let dir: string

  beforeEach(() => { dir = tmpDir() })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('returns 16 lowercase hex chars', () => {
    const keysDir = path.join(dir, 'keys')
    const pub = initActorKey('agent:test', keysDir)
    const fp = keyFingerprint(pub)
    expect(fp).toMatch(/^[0-9a-f]{16}$/)
  })

  it('different keys → different fingerprints', () => {
    const keysDir1 = path.join(dir, 'keys1')
    const keysDir2 = path.join(dir, 'keys2')
    const pub1 = initActorKey('agent:a', keysDir1)
    const pub2 = initActorKey('agent:b', keysDir2)
    expect(keyFingerprint(pub1)).not.toBe(keyFingerprint(pub2))
  })

  it('same key → same fingerprint', () => {
    const keysDir = path.join(dir, 'keys')
    const pub = initActorKey('agent:test', keysDir)
    expect(keyFingerprint(pub)).toBe(keyFingerprint(pub))
  })
})

// ---------------------------------------------------------------------------
// W3.2 — emitCheckpoint with signing (#1056)
// ---------------------------------------------------------------------------

describe('emitCheckpoint with signing (#1056)', () => {
  let dir: string
  let engramsPath: string

  beforeEach(() => {
    dir = tmpDir()
    engramsPath = path.join(dir, 'engrams.yaml')
    fs.writeFileSync(engramsPath, 'engrams: []\n', 'utf8')
  })

  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('unsigned checkpoint has no signature or signer', () => {
    const data = emitCheckpoint(dir, engramsPath, 'cli')
    expect(data.signature).toBeUndefined()
    expect(data.signer).toBeUndefined()

    const month = new Date().toISOString().slice(0, 7)
    const events = readHistory(dir, month)
    const cp = events.find(e => e.event === 'checkpoint')
    expect(cp).toBeDefined()
    expect(cp!.signature).toBeUndefined()
  })

  it('signed checkpoint has signature and signer in the returned data', () => {
    const keysDir = path.join(dir, 'keys')
    const pubB64 = initActorKey('agent:test', keysDir)
    registerPublicKey(dir, 'agent:test', pubB64)

    const data = emitCheckpoint(dir, engramsPath, 'cli', undefined, {
      identity: 'agent:test',
      sign: (bytes) => signWithActorKey(bytes, 'agent:test', keysDir),
    })

    expect(typeof data.signature).toBe('string')
    expect(data.signer).toBe('agent:test')
  })

  it('signature is valid over the canonical bytes of the checkpoint event', () => {
    const keysDir = path.join(dir, 'keys')
    const pubB64 = initActorKey('agent:test', keysDir)
    registerPublicKey(dir, 'agent:test', pubB64)

    emitCheckpoint(dir, engramsPath, 'cli', undefined, {
      identity: 'agent:test',
      sign: (bytes) => signWithActorKey(bytes, 'agent:test', keysDir),
    })

    const month = new Date().toISOString().slice(0, 7)
    const events = readHistory(dir, month)
    const cp = events.find(e => e.event === 'checkpoint')
    expect(cp).toBeDefined()
    expect(typeof cp!.signature).toBe('string')

    // canonicalEventBytes excludes both hash and signature
    const canonical = canonicalEventBytes(cp!)
    expect(verifySignature(canonical, cp!.signature!, pubB64)).toBe(true)
  })

  it('the stored hash matches the canonical-bytes hash (signature excluded from canonical bytes)', () => {
    const keysDir = path.join(dir, 'keys')
    const pubB64 = initActorKey('agent:test', keysDir)
    registerPublicKey(dir, 'agent:test', pubB64)

    emitCheckpoint(dir, engramsPath, 'cli', undefined, {
      identity: 'agent:test',
      sign: (bytes) => signWithActorKey(bytes, 'agent:test', keysDir),
    })

    const month = new Date().toISOString().slice(0, 7)
    const events = readHistory(dir, month)
    const cp = events.find(e => e.event === 'checkpoint')!

    // computeEventHash excludes both hash and signature — same canonical form
    const recomputed = computeEventHash(cp)
    expect(recomputed).toBe(cp.hash)
  })

  it('signing failure is best-effort: unsigned checkpoint is written on error', () => {
    const data = emitCheckpoint(dir, engramsPath, 'cli', undefined, {
      identity: 'agent:test',
      sign: (_bytes) => { throw new Error('signing failed') },
    })
    expect(data.event_hash).toBeTruthy()
    expect(data.signature).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// W3.2 — verifyChain with --signatures (#1056)
// ---------------------------------------------------------------------------

describe('verifyChain --signatures (#1056)', () => {
  let dir: string
  let engramsPath: string

  beforeEach(() => {
    dir = tmpDir()
    engramsPath = path.join(dir, 'engrams.yaml')
    fs.writeFileSync(engramsPath, 'engrams: []\n', 'utf8')
  })

  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('without --signatures: signatures field is null', () => {
    emitCheckpoint(dir, engramsPath, 'cli')
    const outcome = verifyChain(dir)
    expect(outcome.status).toBe('verified')
    expect(outcome.result.signatures).toBeNull()
  })

  it('with --signatures: unsigned checkpoint reports "unsigned"', () => {
    emitCheckpoint(dir, engramsPath, 'cli')
    const outcome = verifyChain(dir, { verifySignatures: true })
    expect(outcome.status).toBe('verified') // unsigned is not a break
    expect(outcome.result.signatures).toHaveLength(1)
    expect(outcome.result.signatures![0].verdict).toBe('unsigned')
  })

  it('with --signatures: valid signed checkpoint reports "valid"', () => {
    const keysDir = path.join(dir, 'keys')
    const pubB64 = initActorKey('agent:test', keysDir)
    registerPublicKey(dir, 'agent:test', pubB64)

    emitCheckpoint(dir, engramsPath, 'cli', undefined, {
      identity: 'agent:test',
      sign: (bytes) => signWithActorKey(bytes, 'agent:test', keysDir),
    })

    const outcome = verifyChain(dir, { verifySignatures: true })
    expect(outcome.status).toBe('verified')
    expect(outcome.result.signatures).toHaveLength(1)
    expect(outcome.result.signatures![0].verdict).toBe('valid')
    expect(outcome.result.signatures![0].signer).toBe('agent:test')
  })

  it('with --signatures: unknown signer is "unknown_signer", NOT a chain break', () => {
    const keysDir = path.join(dir, 'keys')
    initActorKey('agent:test', keysDir)
    // NOT registering the public key — signer will be unknown to verifyChain

    emitCheckpoint(dir, engramsPath, 'cli', undefined, {
      identity: 'agent:test',
      sign: (bytes) => signWithActorKey(bytes, 'agent:test', keysDir),
    })

    const outcome = verifyChain(dir, { verifySignatures: true })
    expect(outcome.status).toBe('verified')
    expect(outcome.result.breaks).toHaveLength(0)
    expect(outcome.result.signatures![0].verdict).toBe('unknown_signer')
  })

  it('with --signatures: invalid signature is a named failure AND a break', () => {
    const keysDir = path.join(dir, 'keys')
    const pubB64 = initActorKey('agent:test', keysDir)
    registerPublicKey(dir, 'agent:test', pubB64)

    emitCheckpoint(dir, engramsPath, 'cli', undefined, {
      identity: 'agent:test',
      sign: (bytes) => signWithActorKey(bytes, 'agent:test', keysDir),
    })

    // Tamper: flip a byte in the signature in the JSONL file.
    // canonicalEventBytes excludes `signature`, so the hash is unaffected —
    // the chain stays intact while the signature becomes invalid.
    const month = new Date().toISOString().slice(0, 7)
    const jsonlPath = path.join(dir, 'history', `${month}.jsonl`)
    const content = fs.readFileSync(jsonlPath, 'utf8')
    const lines = content.split('\n').filter(l => l.trim())
    const lastLine = JSON.parse(lines[lines.length - 1]) as HistoryEvent
    if (lastLine.signature) {
      const sigBytes = Buffer.from(lastLine.signature, 'base64')
      sigBytes[0] ^= 0xff
      lastLine.signature = sigBytes.toString('base64')
    }
    // Hash stays the same (signature is excluded from canonical bytes)
    lines[lines.length - 1] = JSON.stringify(lastLine)
    fs.writeFileSync(jsonlPath, lines.join('\n') + '\n', 'utf8')

    const outcome = verifyChain(dir, { verifySignatures: true })
    expect(outcome.result.signatures![0].verdict).toBe('invalid')
    expect(outcome.result.breaks.length).toBeGreaterThan(0)
  })

  it('with --signatures: no checkpoints → empty signatures array, still verified', () => {
    appendHistory(dir, {
      event: 'engram_created',
      engram_id: 'ENG-2026-09-04-001',
      timestamp: new Date().toISOString(),
      data: {},
    })

    const outcome = verifyChain(dir, { verifySignatures: true })
    expect(outcome.status).toBe('verified')
    expect(outcome.result.signatures).toEqual([])
  })
})
