#!/usr/bin/env node
import { createInterface } from 'readline'
import { configExists, saveConfig, generateWallet, loadConfig } from './identity.js'
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

  console.log('  Generating agent identity...')
  const { address, privateKeyHex } = generateWallet()
  console.log(`  → Address: ${address}`)

  const domain = await ask('  Claim a knowledge domain (optional, e.g. trading/wyckoff): ')
  const priceInput = await ask('  Query price in USDC (0 for free, e.g. 0.10): ')
  const queryPrice = priceInput ? String(Math.round(parseFloat(priceInput) * 1_000_000)) : '0'

  const endpointInput = await ask('  Your agent server URL (leave empty for static-only): ')

  console.log('\n  Registering on PLUR Hub...')
  try {
    const result = await register({
      hub,
      name: name.trim().toLowerCase(),
      wallet: address,
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
      wallet: address,
      hub,
      domain: domain || undefined,
      queryPrice,
      forwardTo: endpointInput || undefined,
    })

    console.log(`\n  ✓ Agent registered!`)
    console.log(`  → URL: plur.ai/${result.name}`)
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
  console.log(`Wallet: ${config.wallet}`)
  console.log(`Domain: ${config.domain || 'none'}`)
  console.log(`Price: $${(Number(config.queryPrice) / 1_000_000).toFixed(2)}/query`)
  console.log(`Hub: ${config.hub}`)
}

async function main() {
  const cmd = process.argv[2]
  switch (cmd) {
    case 'init': return init()
    case 'status': return status()
    default:
      console.log('Usage: npx @plur-ai/earn <command>')
      console.log('  init      Set up your agent')
      console.log('  status    Show agent config')
      console.log('  discover  Find listable knowledge')
  }
}

main().catch(console.error)
