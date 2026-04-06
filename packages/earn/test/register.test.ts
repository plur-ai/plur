import { describe, it, expect } from 'vitest'
import { z } from 'zod'

// Re-export the internal schema for testing without network calls
// We test Zod validation behaviour by constructing the same schema
const RegisterSchema = z.object({
  name: z
    .string()
    .min(3, 'Name must be at least 3 characters')
    .max(32, 'Name must be at most 32 characters')
    .regex(/^[a-z0-9-]+$/, 'Name must be lowercase alphanumeric with hyphens only'),
  wallet: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'Wallet must be a valid Ethereum address (0x + 40 hex chars)'),
  hub: z.string().url('Hub must be a valid URL').default('https://api.plur.ai'),
  domain: z.string().optional(),
  queryPrice: z.string().optional(),
})

const VALID_WALLET = '0xAbCdEf0123456789abcdef0123456789abcdef01'
const VALID_NAME = 'my-agent'
const VALID_HUB = 'https://api.plur.ai'

describe('RegisterSchema validation', () => {
  it('validates a good registration object', () => {
    const result = RegisterSchema.safeParse({
      name: VALID_NAME,
      wallet: VALID_WALLET,
      hub: VALID_HUB,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.name).toBe(VALID_NAME)
      expect(result.data.wallet).toBe(VALID_WALLET)
      expect(result.data.hub).toBe(VALID_HUB)
    }
  })

  it('rejects names that are too short', () => {
    const result = RegisterSchema.safeParse({
      name: 'ab',
      wallet: VALID_WALLET,
      hub: VALID_HUB,
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/at least 3/)
    }
  })

  it('rejects invalid wallet format', () => {
    const result = RegisterSchema.safeParse({
      name: VALID_NAME,
      wallet: 'not-a-wallet',
      hub: VALID_HUB,
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/Ethereum address/)
    }
  })

  it('rejects names with uppercase letters', () => {
    const result = RegisterSchema.safeParse({
      name: 'MyAgent',
      wallet: VALID_WALLET,
      hub: VALID_HUB,
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/lowercase/)
    }
  })

  it('defaults hub to https://api.plur.ai when not provided', () => {
    const result = RegisterSchema.safeParse({
      name: VALID_NAME,
      wallet: VALID_WALLET,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.hub).toBe('https://api.plur.ai')
    }
  })
})
