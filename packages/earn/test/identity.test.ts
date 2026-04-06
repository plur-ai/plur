import { describe, it, expect } from 'vitest'

describe('identity', () => {
  // Test generateWallet produces valid format
  it('generates a wallet with valid address and key format', async () => {
    const { generateWallet } = await import('../src/identity.js')
    const { address, privateKeyHex } = generateWallet()
    expect(address).toMatch(/^0x[0-9a-f]{40}$/)
    expect(privateKeyHex).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('generates unique wallets', async () => {
    const { generateWallet } = await import('../src/identity.js')
    const w1 = generateWallet()
    const w2 = generateWallet()
    expect(w1.address).not.toBe(w2.address)
  })
})
