/**
 * Per-actor Ed25519 signing keys for engram store checkpoints.
 *   <store>/keys/<identity>.key — PKCS#8 DER, mode 0600 (or PLUR_KEYS_DIR, see
 *                                 keysDirFor); never synced: the store's .gitignore lists keys/
 *   <store-root>/keys.yaml      — public registry (identity → SPKI DER base64, added_at)
 * With a key for the acting identity, `emitCheckpoint` adds an Ed25519
 * `signature` over the event's canonical bytes; `plur verify --signatures`
 * checks it. Unsigned checkpoints stay valid L2; a signature from an unknown
 * identity is a named failure, not a skip. Uses only `node:crypto`.
 */
import * as fs from 'node:fs'
import * as crypto from 'node:crypto'
import * as yaml from 'js-yaml'
import { join, resolve } from 'node:path'

/** Filename suffix for private key files. */
const KEY_FILE_SUFFIX = '.key'

/** Required permission mode for private key files. */
const PRIVATE_KEY_MODE = 0o600

/**
 * An entry in the per-store public key registry.
 */
export interface PublicKeyEntry {
  identity: string
  /** Ed25519 SPKI DER, base64-encoded. */
  public_key: string
  added_at: string
}

/**
 * The per-store public key registry loaded from `keys.yaml`.
 */
export interface KeysRegistry {
  keys: PublicKeyEntry[]
}

/**
 * Derive the path for an identity's private key file.
 * `keysDir` is typically `<store-root>/keys` or `~/.plur/keys`.
 */
export function privateKeyPath(identity: string, keysDir: string): string {
  return join(keysDir, `${safeFileName(identity)}${KEY_FILE_SUFFIX}`)
}

/**
 * A file name for an identity or session id, on every platform.
 *
 * Reversible percent-encoding: every byte outside [A-Za-z0-9._-] becomes %XX
 * (decodeURIComponent undoes it), so `agent/x` and `agent_x` never share a
 * file and no `:` survives (on NTFS it names an alternate data stream). Names
 * longer than 120 characters keep a readable prefix and a hash of the whole
 * id, so they cannot collide either.
 */
export function safeFileName(id: string): string {
  const enc = Array.from(id, ch => /[A-Za-z0-9._-]/.test(ch)
    ? ch
    : Array.from(Buffer.from(ch, 'utf8'), b => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join(''),
  ).join('')
  if (enc.length <= 120) return enc || '%00'
  return `${enc.slice(0, 100)}-${crypto.createHash('sha256').update(id).digest('hex').slice(0, 16)}`
}

/**
 * The one folder private signing keys live in: `PLUR_KEYS_DIR` if set, else
 * `<store>/keys`. `plur keys init`, `plur checkpoint` and the MCP session end
 * all resolve it here, so the key that was made is the key that signs.
 */
export function keysDirFor(storeRoot: string): string {
  const env = process.env.PLUR_KEYS_DIR?.trim()
  // A relative value is taken relative to the store, never to whichever
  // directory a process happens to run in — `plur keys init` in a shell and the
  // MCP server an editor starts must find the same keys.
  return env ? resolve(storeRoot, env) : join(storeRoot, 'keys')
}

/**
 * Derive the path for the store's public key registry.
 */
export function keysRegistryPath(storeRoot: string): string {
  return join(storeRoot, 'keys.yaml')
}

/**
 * Generate an Ed25519 key pair and write the private key as PKCS#8 DER to
 * `keysDir/<identity>.key` (mode 0600). Idempotent: an existing valid key is reused.
 * @param identity - the actor identity string (e.g. `"agent:miles"`)
 * @param keysDir  - directory that holds private keys (e.g. `~/.plur/keys`)
 * @returns the Ed25519 public key as SPKI DER, base64-encoded
 */
export function initActorKey(identity: string, keysDir: string): string {
  const keyFile = privateKeyPath(identity, keysDir)

  // Idempotent: if a valid key already exists, return its public key.
  const existing = loadPrivateKeyBuffer(identity, keysDir)
  if (existing !== null) {
    const keyObj = crypto.createPrivateKey({ key: existing, format: 'der', type: 'pkcs8' })
    const pub = crypto.createPublicKey(keyObj)
    return pub.export({ type: 'spki', format: 'der' }).toString('base64')
  }

  // Generate a fresh Ed25519 key pair.
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    publicKeyEncoding: { type: 'spki', format: 'der' },
  })

  // Create the directory with restricted permissions.
  if (!fs.existsSync(keysDir)) {
    fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 })
  }

  // Write private key to a temp file, then rename — atomic on POSIX.
  const tmp = `${keyFile}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, privateKey as Buffer, { mode: PRIVATE_KEY_MODE })
    fs.chmodSync(tmp, PRIVATE_KEY_MODE)
    fs.renameSync(tmp, keyFile)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* nothing to clean */ }
    throw err
  }

  return (publicKey as Buffer).toString('base64')
}

/**
 * Load a private key's raw DER bytes from disk.
 *
 * Enforces mode 0600: a key readable by group or world is rejected — its
 * exposure surface is unknown, so signing with it cannot be trusted.
 *
 * Returns null (not throws) when the key does not exist — the caller decides
 * whether absence is an error or means "unsigned".
 *
 * @throws if the key file exists but has wrong permissions.
 */
export function loadPrivateKeyBuffer(identity: string, keysDir: string): Buffer | null {
  const keyFile = privateKeyPath(identity, keysDir)
  if (!fs.existsSync(keyFile)) return null

  // Enforce 0600. A world- or group-readable private key cannot be trusted.
  try {
    const st = fs.statSync(keyFile)
    const mode = st.mode & 0o777
    if (mode !== PRIVATE_KEY_MODE) {
      throw new Error(
        `Private key at ${keyFile} has permissions 0${mode.toString(8).padStart(3, '0')} — ` +
        `expected 0600. Refusing to load. Run: chmod 600 ${keyFile}`,
      )
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }

  return fs.readFileSync(keyFile)
}

/**
 * Sign a buffer with the actor's Ed25519 private key.
 *
 * Returns the signature as base64, or null when no private key is found for
 * `identity`. Callers treat null as "no key configured" — unsigned is valid.
 *
 * @throws if the key file exists but has wrong permissions or is corrupted.
 */
export function signWithActorKey(data: Buffer, identity: string, keysDir: string): string | null {
  const raw = loadPrivateKeyBuffer(identity, keysDir)
  if (raw === null) return null
  const privateKey = crypto.createPrivateKey({ key: raw, format: 'der', type: 'pkcs8' })
  const sig = crypto.sign(null, data, privateKey)
  return sig.toString('base64')
}

/**
 * Verify an Ed25519 signature.
 *
 * @param data         - the exact bytes that were signed
 * @param signatureB64 - the signature, base64-encoded
 * @param publicKeyB64 - the signer's public key, SPKI DER base64-encoded
 * @returns true only when the signature is valid for the given key and data
 */
export function verifySignature(data: Buffer, signatureB64: string, publicKeyB64: string): boolean {
  try {
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(publicKeyB64, 'base64'),
      format: 'der',
      type: 'spki',
    })
    const sig = Buffer.from(signatureB64, 'base64')
    return crypto.verify(null, data, publicKey, sig)
  } catch {
    return false
  }
}

/**
 * Load the keys registry from `<storeRoot>/keys.yaml`.
 *
 * Returns an empty registry when the file does not exist — a store with no
 * keys configured is not an error.
 *
 * @throws if the file exists but cannot be parsed as a valid registry.
 */
export function loadKeysRegistry(storeRoot: string): KeysRegistry {
  const registryPath = keysRegistryPath(storeRoot)
  if (!fs.existsSync(registryPath)) return { keys: [] }

  const raw = fs.readFileSync(registryPath, 'utf8')
  const doc = yaml.load(raw) as unknown
  if (doc === null || doc === undefined) return { keys: [] }
  if (typeof doc !== 'object' || !Array.isArray((doc as KeysRegistry).keys)) {
    throw new Error(`[plur] ${registryPath} is not a valid keys registry (expected {keys: [...]}`)
  }
  return doc as KeysRegistry
}

/**
 * Look up the public key for `identity` in the store's registry.
 *
 * Returns null when the identity has no registered key.
 */
export function lookupPublicKey(storeRoot: string, identity: string): string | null {
  try {
    const registry = loadKeysRegistry(storeRoot)
    const entry = registry.keys.find(k => k.identity === identity)
    return entry?.public_key ?? null
  } catch {
    return null
  }
}

/**
 * Register an identity's public key in `<storeRoot>/keys.yaml` (atomic write).
 * Same key: unchanged. Different key: the entry is replaced; rotation is not handled.
 * @param storeRoot   - the store root directory
 * @param identity    - the actor identity string
 * @param publicKeyB64 - the public key to register, SPKI DER base64-encoded
 * @param addedAt     - ISO-8601 timestamp; defaults to now
 */
export function registerPublicKey(
  storeRoot: string,
  identity: string,
  publicKeyB64: string,
  addedAt?: string,
): void {
  const timestamp = addedAt ?? new Date().toISOString()
  const registryPath = keysRegistryPath(storeRoot)

  // A registry that will not parse is refused, never replaced: starting from
  // an empty list here would delete every other registered identity.
  let registry: KeysRegistry
  try {
    registry = loadKeysRegistry(storeRoot)
  } catch (err) {
    throw new Error(
      `[plur] ${registryPath} cannot be read (${(err as Error).message}); it was left as it is. ` +
      `Fix or move it, then register the key again.`,
    )
  }

  const idx = registry.keys.findIndex(k => k.identity === identity)
  if (idx !== -1) {
    if (registry.keys[idx].public_key === publicKeyB64) return // already registered, no-op
    registry.keys[idx] = { identity, public_key: publicKeyB64, added_at: timestamp }
  } else {
    registry.keys.push({ identity, public_key: publicKeyB64, added_at: timestamp })
  }

  const serialized = yaml.dump({ keys: registry.keys }, { lineWidth: 120 })

  // Create store root if it doesn't exist yet (unlikely but defensive).
  if (!fs.existsSync(storeRoot)) fs.mkdirSync(storeRoot, { recursive: true })

  const tmp = `${registryPath}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, serialized, 'utf8')
    fs.renameSync(tmp, registryPath)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* nothing to clean */ }
    throw err
  }
}

/**
 * Compute the SHA-256 fingerprint of a public key.
 *
 * Used for display — a full 44-char base64 key is not human-readable.
 * Returns lowercase hex, truncated to 16 chars (8 bytes) — sufficient to
 * distinguish keys in a small registry.
 */
export function keyFingerprint(publicKeyB64: string): string {
  return crypto
    .createHash('sha256')
    .update(Buffer.from(publicKeyB64, 'base64'))
    .digest('hex')
    .slice(0, 16)
}
