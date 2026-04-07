import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import {
  Wallet,
  FDSKeystoreManager,
  FDS_DOMAINS,
  type FDSAccount,
  type FDSKeystore,
} from '@fairdatasociety/fds-id'

const PLUR_DIR = join(homedir(), '.plur')
const KEYSTORE_PATH = join(PLUR_DIR, 'agent-keystore.json')
const CONFIG_PATH = join(PLUR_DIR, 'agent-config.json')

// Use 'fairdrop' type so PLUR agents are interoperable with Fairdrop accounts
const KEYSTORE_TYPE = 'fairdrop' as const
export const ENS_DOMAIN = FDS_DOMAINS.FAIRDROP  // 'fairdrop.eth'

export interface AgentConfig {
  name: string                // subdomain (e.g., 'trading-expert')
  ensName: string             // full ENS (e.g., 'trading-expert.fairdrop.eth')
  wallet: string              // EIP-55 checksummed address
  hub: string
  domain?: string             // PLUR knowledge domain (e.g., 'trading/wyckoff')
  queryPrice: string
  forwardTo?: string
  keystoreRef?: string        // Swarm backup reference
  erc8004Id?: string
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
 * Create a new agent identity using fds-id Wallet.
 * Returns the wallet and a complete FDSAccount ready for keystore encryption.
 *
 * publicKey: Wallet.publicKey is Uint8Array (65 bytes, uncompressed, starts with 0x04).
 * bytesToHex encodes all 65 bytes → 130 hex chars starting with '04'.
 * privateKey: Wallet.privateKey is Uint8Array (32 bytes) → 64 hex chars, no 0x prefix.
 */
export function createAgentAccount(subdomain: string): { wallet: Wallet; account: FDSAccount } {
  const wallet = Wallet.create()
  const account: FDSAccount = {
    subdomain,
    publicKey: Buffer.from(wallet.publicKey).toString('hex'),   // 130 hex chars with 04 prefix
    privateKey: Buffer.from(wallet.privateKey).toString('hex'), // 64 hex chars, no 0x
    walletAddress: wallet.address,
    created: Date.now(),
  }
  return { wallet, account }
}

/**
 * Encrypt an FDSAccount to a keystore file and write it to disk.
 * Uses the FDS keystore format — interoperable with Fairdrop/Fairdrive.
 */
export async function createKeystore(account: FDSAccount, password: string): Promise<FDSKeystore> {
  const keystore = await FDSKeystoreManager.encrypt(account, password, {
    type: KEYSTORE_TYPE,
    domain: ENS_DOMAIN,
  })
  getPlurDir()
  writeFileSync(KEYSTORE_PATH, JSON.stringify(keystore, null, 2))
  return keystore
}

/**
 * Load a keystore from disk.
 */
export function loadKeystore(): FDSKeystore | null {
  if (!existsSync(KEYSTORE_PATH)) return null
  const data = JSON.parse(readFileSync(KEYSTORE_PATH, 'utf-8'))
  if (!FDSKeystoreManager.isValid(data)) return null
  return data
}

/**
 * Decrypt a keystore to recover the FDSAccount.
 */
export async function decryptKeystore(keystore: FDSKeystore, password: string): Promise<FDSAccount> {
  return FDSKeystoreManager.decrypt(keystore, password)
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
 * Returns the decrypted account on success.
 */
export async function recoverFromSwarm(reference: string, password: string): Promise<FDSAccount | null> {
  const gateway = process.env.SWARM_GATEWAY_URL || 'https://gateway.fairdatasociety.org'
  try {
    const res = await fetch(`${gateway}/bytes/${reference}`)
    if (!res.ok) return null
    const keystoreJson = await res.text()
    const keystore = JSON.parse(keystoreJson) as FDSKeystore
    if (!FDSKeystoreManager.isValid(keystore)) return null

    // Verify password by decrypting
    const account = await FDSKeystoreManager.decrypt(keystore, password)

    getPlurDir()
    writeFileSync(KEYSTORE_PATH, keystoreJson)
    return account
  } catch {
    return null
  }
}
