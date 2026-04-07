import { randomBytes, createCipheriv, createDecipheriv, pbkdf2Sync } from 'crypto'
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'

const PLUR_DIR = join(homedir(), '.plur')
const KEYSTORE_PATH = join(PLUR_DIR, 'agent-keystore.json')
const CONFIG_PATH = join(PLUR_DIR, 'agent-config.json')

const PBKDF2_ITER = 100_000
const KEY_LEN = 32

export interface AgentConfig {
  name: string
  wallet: string
  hub: string
  domain?: string
  queryPrice: string
  forwardTo?: string
  keystoreRef?: string  // Swarm backup reference
  erc8004Id?: string
}

export interface EncryptedKeystore {
  version: 1
  address: string
  iv: string  // base64
  salt: string  // base64
  ciphertext: string  // base64
  authTag: string  // base64
}

export function getPlurDir(): string {
  if (!existsSync(PLUR_DIR)) mkdirSync(PLUR_DIR, { recursive: true })
  return PLUR_DIR
}

export function keystorePath(): string { return KEYSTORE_PATH }
export function configPath(): string { return CONFIG_PATH }
export function configExists(): boolean { return existsSync(CONFIG_PATH) }
export function keystoreExists(): boolean { return existsSync(KEYSTORE_PATH) }

export function saveConfig(config: AgentConfig): void {
  getPlurDir()
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
}

export function loadConfig(): AgentConfig | null {
  if (!existsSync(CONFIG_PATH)) return null
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
}

/**
 * Generate a new wallet with proper Ethereum address derivation via viem.
 */
export function generateWallet(): { address: string; privateKeyHex: Hex } {
  const privateKeyBytes = randomBytes(32)
  const privateKeyHex = `0x${privateKeyBytes.toString('hex')}` as Hex
  const account = privateKeyToAccount(privateKeyHex)
  return { address: account.address, privateKeyHex }
}

/**
 * Encrypt a private key with a password and save to disk as a keystore file.
 * Uses PBKDF2 + AES-256-GCM (similar to Ethereum keystore v3 but simpler format).
 */
export function createKeystore(privateKeyHex: Hex, password: string): EncryptedKeystore {
  const account = privateKeyToAccount(privateKeyHex)
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = pbkdf2Sync(password, salt, PBKDF2_ITER, KEY_LEN, 'sha256')

  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([
    cipher.update(privateKeyHex, 'utf8'),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag()

  const keystore: EncryptedKeystore = {
    version: 1,
    address: account.address,
    iv: iv.toString('base64'),
    salt: salt.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    authTag: authTag.toString('base64'),
  }

  getPlurDir()
  writeFileSync(KEYSTORE_PATH, JSON.stringify(keystore, null, 2))
  return keystore
}

/**
 * Decrypt a keystore with a password to recover the private key.
 */
export function decryptKeystore(keystore: EncryptedKeystore, password: string): Hex {
  const salt = Buffer.from(keystore.salt, 'base64')
  const iv = Buffer.from(keystore.iv, 'base64')
  const ciphertext = Buffer.from(keystore.ciphertext, 'base64')
  const authTag = Buffer.from(keystore.authTag, 'base64')

  const key = pbkdf2Sync(password, salt, PBKDF2_ITER, KEY_LEN, 'sha256')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ])
  return plaintext.toString('utf8') as Hex
}

export function loadKeystore(): EncryptedKeystore | null {
  if (!existsSync(KEYSTORE_PATH)) return null
  return JSON.parse(readFileSync(KEYSTORE_PATH, 'utf-8'))
}

/**
 * Upload an encrypted keystore to Swarm for disaster recovery.
 * Returns the Swarm reference (64-char hex) or null on failure.
 */
export async function backupToSwarm(keystoreJson: string): Promise<string | null> {
  const gateway = process.env.SWARM_GATEWAY_URL || 'https://gateway.fairdatasociety.org'
  try {
    const res = await fetch(`${gateway}/bytes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from(keystoreJson),
    })
    if (!res.ok) return null
    const data = await res.json() as { reference?: string }
    return data.reference || null
  } catch {
    return null
  }
}

/**
 * Recover an encrypted keystore from Swarm and verify the password.
 */
export async function recoverFromSwarm(reference: string, password: string): Promise<{ address: string } | null> {
  const gateway = process.env.SWARM_GATEWAY_URL || 'https://gateway.fairdatasociety.org'
  try {
    const res = await fetch(`${gateway}/bytes/${reference}`)
    if (!res.ok) return null
    const keystoreJson = await res.text()
    const keystore = JSON.parse(keystoreJson) as EncryptedKeystore

    // Verify password by attempting decryption
    try {
      decryptKeystore(keystore, password)
    } catch {
      return null  // Wrong password
    }

    getPlurDir()
    writeFileSync(KEYSTORE_PATH, keystoreJson)
    return { address: keystore.address }
  } catch {
    return null
  }
}
