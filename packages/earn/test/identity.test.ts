import { describe, it, expect } from 'vitest'

describe('identity', () => {
  it('generates a wallet with valid Ethereum address (via viem)', async () => {
    const { generateWallet } = await import('../src/identity.js')
    const { address, privateKeyHex } = generateWallet()
    // Real Ethereum address — checksummed format from viem
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(privateKeyHex).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('generates unique wallets', async () => {
    const { generateWallet } = await import('../src/identity.js')
    const w1 = generateWallet()
    const w2 = generateWallet()
    expect(w1.address).not.toBe(w2.address)
    expect(w1.privateKeyHex).not.toBe(w2.privateKeyHex)
  })

  it('encrypts and decrypts a keystore with password', async () => {
    const { generateWallet, createKeystore, decryptKeystore } = await import('../src/identity.js')
    const { privateKeyHex } = generateWallet()
    const keystore = createKeystore(privateKeyHex, 'test-password-123')
    const recovered = decryptKeystore(keystore, 'test-password-123')
    expect(recovered).toBe(privateKeyHex)
  })

  it('keystore decryption fails with wrong password', async () => {
    const { generateWallet, createKeystore, decryptKeystore } = await import('../src/identity.js')
    const { privateKeyHex } = generateWallet()
    const keystore = createKeystore(privateKeyHex, 'correct-password')
    expect(() => decryptKeystore(keystore, 'wrong-password')).toThrow()
  })

  it('derives same address from same private key (deterministic)', async () => {
    const { generateWallet } = await import('../src/identity.js')
    const { privateKeyToAccount } = await import('viem/accounts')
    const { address, privateKeyHex } = generateWallet()
    const reAccount = privateKeyToAccount(privateKeyHex)
    expect(reAccount.address).toBe(address)
  })
})
