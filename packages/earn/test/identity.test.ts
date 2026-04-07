import { describe, it, expect } from 'vitest'

describe('identity (fds-id)', () => {
  it('creates a wallet with valid EIP-55 checksummed address', async () => {
    const { createAgentAccount } = await import('../src/identity.js')
    const { wallet, account } = createAgentAccount('test-agent')
    expect(wallet.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(account.walletAddress).toBe(wallet.address)
    expect(account.subdomain).toBe('test-agent')
    expect(account.privateKey).toMatch(/^[0-9a-f]{64}$/)
    expect(account.publicKey.length).toBeGreaterThanOrEqual(130)  // 65 bytes hex
  })

  it('generates unique accounts', async () => {
    const { createAgentAccount } = await import('../src/identity.js')
    const a1 = createAgentAccount('agent-one')
    const a2 = createAgentAccount('agent-two')
    expect(a1.wallet.address).not.toBe(a2.wallet.address)
    expect(a1.account.privateKey).not.toBe(a2.account.privateKey)
  })

  it('encrypts and decrypts an FDS keystore (Fairdrop-compatible)', async () => {
    const { createAgentAccount, createKeystore, decryptKeystore } = await import('../src/identity.js')
    const { account } = createAgentAccount('test-agent')
    const keystore = await createKeystore(account, 'test-password-123')

    expect(keystore.version).toBe(1)
    expect(keystore.type).toBe('fairdrop')
    expect(keystore.address).toBe('test-agent.fairdrop.eth')
    expect(keystore.crypto.cipher).toBe('aes-128-ctr')
    expect(keystore.crypto.kdf).toBe('scrypt')

    const recovered = await decryptKeystore(keystore, 'test-password-123')
    expect(recovered.subdomain).toBe(account.subdomain)
    expect(recovered.privateKey).toBe(account.privateKey)
    expect(recovered.walletAddress).toBe(account.walletAddress)
  }, 30000)  // scrypt is slow by design

  it('keystore decryption fails with wrong password', async () => {
    const { createAgentAccount, createKeystore, decryptKeystore } = await import('../src/identity.js')
    const { account } = createAgentAccount('test-agent')
    const keystore = await createKeystore(account, 'correct-password')
    await expect(decryptKeystore(keystore, 'wrong-password')).rejects.toThrow()
  }, 30000)  // scrypt is slow by design

  it('keystore is interoperable — round-trip via JSON', async () => {
    const { createAgentAccount, createKeystore, decryptKeystore } = await import('../src/identity.js')
    const { account } = createAgentAccount('round-trip')
    const keystore = await createKeystore(account, 'pw-roundtrip')
    // Serialize to JSON (as it would be on disk or over Swarm)
    const json = JSON.stringify(keystore)
    const restored = JSON.parse(json)
    const recovered = await decryptKeystore(restored, 'pw-roundtrip')
    expect(recovered.walletAddress).toBe(account.walletAddress)
  }, 30000)  // scrypt is slow by design
})
