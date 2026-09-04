import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { PINNED_HARD_PER_ENGRAM_TOKEN_CAP } from '../src/inject.js'

// Helpers
async function withPlur(fn: (plur: any) => Promise<void>): Promise<void> {
  const { Plur } = await import('../src/index.js')
  const dir = mkdtempSync(join(tmpdir(), 'plur-hard-per-engram-'))
  const plur = new Plur({ path: dir })
  try {
    await fn(plur)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// A statement long enough to exceed PINNED_HARD_PER_ENGRAM_TOKEN_CAP (200 tokens).
// The fixed JSON overhead for a minimal engram is ~100-150 chars, so a 700-char
// statement pushes the estimate past 200 tokens.
const LONG_STATEMENT = 'A'.repeat(700)

describe('pinned_hard per-engram token cap — write-time enforcement', () => {
  it('learn() rejects a hard-tier engram that exceeds PINNED_HARD_PER_ENGRAM_TOKEN_CAP', async () => {
    await withPlur(async (plur) => {
      await expect(
        plur.learn(LONG_STATEMENT, { pinned: true, pin_tier: 'hard' }),
      ).rejects.toThrow(/per-engram cap is 200 tokens/)
    })
  })

  it('learn() rejects with a message naming the token count and cap', async () => {
    await withPlur(async (plur) => {
      await expect(
        plur.learn(LONG_STATEMENT, { pinned: true, pin_tier: 'hard' }),
      ).rejects.toThrow(/PINNED_HARD_PER_ENGRAM_TOKEN_CAP/)
    })
  })

  it('learn() accepts a hard-tier engram within the per-engram cap', async () => {
    await withPlur(async (plur) => {
      const engram = await plur.learn('Always test before deploying to production.', {
        pinned: true,
        pin_tier: 'hard',
      })
      expect(engram.id).toBeTruthy()
      expect((engram as any).pinned).toBe(true)
      expect((engram as any).pinned_tier).toBe('hard')
    })
  })

  it('learn() does NOT reject a soft-tier pinned engram with a long statement', async () => {
    // The per-engram cap only applies to hard tier — soft tier may be large.
    await withPlur(async (plur) => {
      const engram = await plur.learn(LONG_STATEMENT, {
        pinned: true,
        // pin_tier defaults to 'soft' when omitted
      })
      expect(engram.id).toBeTruthy()
    })
  })

  it('learn() does NOT reject an unpinned engram with a long statement', async () => {
    await withPlur(async (plur) => {
      const engram = await plur.learn(LONG_STATEMENT)
      expect(engram.id).toBeTruthy()
    })
  })

  it('PINNED_HARD_PER_ENGRAM_TOKEN_CAP default is 200', () => {
    expect(PINNED_HARD_PER_ENGRAM_TOKEN_CAP).toBe(200)
  })
})
