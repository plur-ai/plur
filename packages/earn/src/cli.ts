#!/usr/bin/env node
import { createInterface } from 'readline'
import {
  configExists,
  saveConfig,
  createAgentAccount,
  loadConfig,
  createKeystore,
  backupToSwarm,
  keystorePath,
  ENS_DOMAIN,
} from './identity.js'
import { createErc8004Identity } from './erc8004.js'
import { register } from './register.js'

const rl = createInterface({ input: process.stdin, output: process.stdout })
const ask = (q: string): Promise<string> => new Promise(resolve => rl.question(q, resolve))

async function init() {
  console.log('\n  Welcome to PLUR! Let\'s set up your agent.\n')

  if (configExists()) {
    const existing = loadConfig()
    console.log(`  Existing agent found: ${existing?.name} (${existing?.wallet})`)
    const overwrite = await ask('  Overwrite? [y/N] ')
    if (overwrite.toLowerCase() !== 'y') {
      console.log('  Aborted.')
      rl.close()
      return
    }
  }

  const name = await ask('  Choose a name: ')
  const hub = process.env.PLUR_HUB || 'https://api.plur.ai'

  const password = await ask('  Set a password for your keystore: ')
  console.log('  Generating agent identity...')

  const { wallet, account } = createAgentAccount(name.trim().toLowerCase())
  console.log(`  → Address: ${wallet.address}`)
  console.log(`  → ENS: ${name.trim().toLowerCase()}.${ENS_DOMAIN}`)

  const keystore = await createKeystore(account, password)
  console.log(`  → Keystore saved: ${keystorePath()} (FDS format, interoperable with Fairdrop)`)

  console.log('  Backing up to Swarm...')
  const keystoreRef = await backupToSwarm(JSON.stringify(keystore))
  if (keystoreRef) {
    console.log(`  → Backup ref: ${keystoreRef}`)
  } else {
    console.log('  → Swarm backup unavailable — keep your keystore file safe!')
  }

  console.log('  Creating ERC-8004 identity...')
  const erc8004 = await createErc8004Identity({
    agentAddress: wallet.address as `0x${string}`,
    name: name.trim().toLowerCase(),
    domain: undefined,
  })
  if (erc8004) {
    console.log(`  → Agent ID: ${erc8004.agentId}`)
  } else {
    console.log('  → ERC-8004 skipped (no registry configured)')
  }

  const domain = await ask('  Claim a knowledge domain (optional, e.g. trading/wyckoff): ')
  const priceInput = await ask('  Query price in USDC (0 for free, e.g. 0.10): ')
  const queryPrice = priceInput ? String(Math.round(parseFloat(priceInput) * 1_000_000)) : '0'

  const endpointInput = await ask('  Your agent server URL (leave empty for static-only): ')

  console.log('\n  Registering on PLUR Hub...')
  try {
    const result = await register({
      hub,
      name: name.trim().toLowerCase(),
      wallet: wallet.address,
      forwardTo: endpointInput || undefined,
      domain: domain || undefined,
      queryPrice,
      capabilities: [],
      autoList: true,
      autoListDelay: '24h',
      autoListPrice: String(Math.round(Number(queryPrice) * 0.5)),
    })

    saveConfig({
      name: result.name,
      ensName: `${result.name}.${ENS_DOMAIN}`,
      wallet: wallet.address,
      hub,
      domain: domain || undefined,
      queryPrice,
      forwardTo: endpointInput || undefined,
      keystoreRef: keystoreRef || undefined,
      erc8004Id: erc8004?.agentId,
    })

    console.log(`\n  ✓ Agent registered!`)
    console.log(`  → URL: plur.ai/${result.name}`)
    console.log(`  → ENS: ${result.name}.${ENS_DOMAIN}`)
    console.log(`  → Domain: ${domain || 'none'}`)
    console.log(`  → Price: $${(Number(queryPrice) / 1_000_000).toFixed(2)}/query`)
    console.log(`\n  Top up wallet: plur.ai/topup`)
    console.log(`  View profile: plur.ai/${result.name}\n`)
  } catch (err) {
    console.error(`\n  ✗ Registration failed: ${(err as Error).message}\n`)
  }

  rl.close()
}

async function status() {
  const config = loadConfig()
  if (!config) {
    console.log('No agent configured. Run: npx @plur-ai/earn init')
    return
  }
  console.log(`Agent: ${config.name}`)
  console.log(`URL: plur.ai/${config.name}`)
  if (config.ensName) console.log(`ENS: ${config.ensName}`)
  console.log(`Wallet: ${config.wallet}`)
  console.log(`Domain: ${config.domain || 'none'}`)
  console.log(`Price: $${(Number(config.queryPrice) / 1_000_000).toFixed(2)}/query`)
  console.log(`Hub: ${config.hub}`)
  if (config.keystoreRef) console.log(`Swarm backup: ${config.keystoreRef}`)
  if (config.erc8004Id) console.log(`ERC-8004 ID: ${config.erc8004Id}`)
}

async function main() {
  const cmd = process.argv[2]
  switch (cmd) {
    case 'init': return init()
    case 'status': return status()
    case 'recover': {
      const ref = await ask('Swarm backup reference: ')
      const pwd = await ask('Password: ')
      const { recoverFromSwarm } = await import('./identity.js')
      const account = await recoverFromSwarm(ref, pwd)
      if (account) {
        console.log(`✓ Identity recovered`)
        console.log(`  Subdomain: ${account.subdomain}`)
        console.log(`  Address: ${account.walletAddress}`)
      } else {
        console.log('✗ Recovery failed — check reference and password')
      }
      rl.close()
      return
    }
    default:
      console.log('Usage: npx @plur-ai/earn <command>')
      console.log('  init      Set up your agent')
      console.log('  status    Show agent config')
      console.log('  recover   Restore identity from Swarm backup')
      console.log('  discover  Find listable knowledge')
  }
}

main().catch(console.error)
