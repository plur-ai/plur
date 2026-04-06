import { randomBytes, createHash } from 'crypto'
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const PLUR_DIR = join(homedir(), '.plur')
const KEYSTORE_PATH = join(PLUR_DIR, 'agent-keystore.json')
const CONFIG_PATH = join(PLUR_DIR, 'agent-config.json')

export interface AgentConfig {
  name: string
  wallet: string
  hub: string
  domain?: string
  queryPrice: string
  forwardTo?: string
  keystoreRef?: string
  erc8004Id?: string
}

export function getPlurDir(): string {
  if (!existsSync(PLUR_DIR)) mkdirSync(PLUR_DIR, { recursive: true })
  return PLUR_DIR
}
export function keystorePath(): string { return KEYSTORE_PATH }
export function configPath(): string { return CONFIG_PATH }
export function configExists(): boolean { return existsSync(CONFIG_PATH) }

export function saveConfig(config: AgentConfig): void {
  getPlurDir()
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
}

export function loadConfig(): AgentConfig | null {
  if (!existsSync(CONFIG_PATH)) return null
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
}

export function generateWallet(): { address: string; privateKeyHex: string } {
  // Simple keypair generation — in production, use fds-id (Task 12)
  const privateKey = randomBytes(32)
  const privateKeyHex = `0x${privateKey.toString('hex')}`
  // Derive a deterministic address from the key (without viem dependency for now)
  const hash = createHash('sha256').update(privateKey).digest('hex')
  const address = `0x${hash.slice(0, 40)}`
  return { address, privateKeyHex }
}
