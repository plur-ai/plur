#!/usr/bin/env node
/**
 * x402 buyer client — sign EIP-3009 transferWithAuthorization, send to Hub.
 *
 * Usage:
 *   BUYER_KEY=0x... HUB_AUTH=team:datahub node x402-buy.mjs <agent-name> "<question>"
 */
import { privateKeyToAccount } from 'viem/accounts'
import { createPublicClient, http, hexToBytes, parseSignature } from 'viem'
import { baseSepolia } from 'viem/chains'
import { randomBytes } from 'crypto'

const BUYER_KEY = process.env.BUYER_KEY
const HUB = process.env.HUB || 'https://hub-staging.plur.ai'
const HUB_AUTH = process.env.HUB_AUTH || 'team:datahub'
const AGENT = process.argv[2]
const QUESTION = process.argv[3] || 'Is SOL in Wyckoff accumulation?'

if (!BUYER_KEY || !AGENT) {
  console.error('Usage: BUYER_KEY=0x... HUB_AUTH=team:datahub node x402-buy.mjs <agent-name> "<question>"')
  process.exit(1)
}

const account = privateKeyToAccount(BUYER_KEY)
const authHeader = `Basic ${Buffer.from(HUB_AUTH, 'utf-8').toString('base64')}`

console.log(`[buyer] address: ${account.address}`)
console.log(`[buyer] hub: ${HUB}`)
console.log(`[buyer] agent: ${AGENT}`)
console.log(`[buyer] question: ${QUESTION}`)
console.log('')

// Step 1: GET 402 challenge
console.log('=== step 1: trigger 402 challenge ===')
const challenge = await fetch(`${HUB}/${AGENT}/query`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: authHeader },
  body: JSON.stringify({ question: QUESTION }),
})
console.log(`status: ${challenge.status}`)
const challengeBody = await challenge.json()
console.log('challenge:', JSON.stringify(challengeBody, null, 2))

if (challenge.status !== 402) {
  console.error('Expected 402, got', challenge.status)
  process.exit(1)
}

const req = challengeBody.paymentRequirements[0]
const { network, maxAmountRequired, payTo, asset } = req
const usdcName = network === 'eip155:8453' ? 'USD Coin' : 'USDC'

console.log('')
console.log('=== step 2: sign EIP-3009 transferWithAuthorization ===')
console.log(`from: ${account.address}`)
console.log(`to: ${payTo}`)
console.log(`value: ${maxAmountRequired} (raw, 6 decimals = $${(Number(maxAmountRequired) / 1_000_000).toFixed(2)})`)
console.log(`network: ${network}`)
console.log(`asset (USDC): ${asset}`)

const now = Math.floor(Date.now() / 1000)
const validAfter = 0n
const validBefore = BigInt(now + 3600) // 1 hour
const nonce = `0x${randomBytes(32).toString('hex')}`

const domain = {
  name: usdcName,
  version: '2',
  chainId: 84532, // Base Sepolia
  verifyingContract: asset,
}

const types = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
}

const message = {
  from: account.address,
  to: payTo,
  value: BigInt(maxAmountRequired),
  validAfter,
  validBefore,
  nonce,
}

const signature = await account.signTypedData({
  domain,
  types,
  primaryType: 'TransferWithAuthorization',
  message,
})

console.log(`signature: ${signature.slice(0, 20)}...${signature.slice(-10)}`)
console.log('')

// Step 3: Build x402 payment payload
console.log('=== step 3: build x402 payment header ===')
const payload = {
  x402Version: 2,
  scheme: 'exact',
  network,
  payload: {
    signature,
    authorization: {
      from: account.address,
      to: payTo,
      value: maxAmountRequired,
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce,
    },
  },
}
const paymentHeader = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64')
console.log(`X-Payment header: ${paymentHeader.length} bytes`)
console.log('')

// Step 4: Submit with payment
console.log('=== step 4: submit with X-Payment header ===')
const final = await fetch(`${HUB}/${AGENT}/query`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: authHeader,
    'X-Payment': paymentHeader,
  },
  body: JSON.stringify({ question: QUESTION }),
})
console.log(`status: ${final.status}`)
const finalBody = await final.json()
console.log('response:', JSON.stringify(finalBody, null, 2))

if (final.status === 200) {
  console.log('')
  console.log('🎉 SUCCESS — paid query completed end-to-end')
} else {
  console.log('')
  console.log('✗ FAILED')
  process.exit(1)
}
