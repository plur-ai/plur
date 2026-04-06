import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import { generateProfile, loadProfileCache, saveProfileCache, profileNeedsRegeneration, markProfileDirty, getProfileForInjection } from '../src/profile.js'
import { EngramSchema } from '../src/schemas/engram.js'
import type { ProfileCache } from '../src/profile.js'

describe('cognitive profile', () => {
  const tmpDir = '/tmp/plur-profile-test-' + Date.now()
  beforeEach(() => { fs.mkdirSync(tmpDir, { recursive: true }) })
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  const mkEngram = (id: string, stmt: string, domain?: string) => EngramSchema.parse({
    id, statement: stmt, type: 'behavioral', scope: 'global', status: 'active', domain,
  })

  it('profileNeedsRegeneration: true when no cache', () => {
    expect(profileNeedsRegeneration(null)).toBe(true)
  })

  it('profileNeedsRegeneration: false when fresh and clean', () => {
    const c: ProfileCache = { profile: 'Test', generated_at: new Date().toISOString(), engram_count: 10, dirty: false }
    expect(profileNeedsRegeneration(c)).toBe(false)
  })

  it('profileNeedsRegeneration: false when dirty but within TTL', () => {
    const c: ProfileCache = { profile: 'Test', generated_at: new Date().toISOString(), engram_count: 10, dirty: true }
    expect(profileNeedsRegeneration(c, 24)).toBe(false)
  })

  it('saves and loads cache', () => {
    const c: ProfileCache = { profile: 'TypeScript user', generated_at: new Date().toISOString(), engram_count: 5, dirty: false }
    saveProfileCache(tmpDir, c)
    expect(loadProfileCache(tmpDir)).toEqual(c)
  })

  it('marks dirty', () => {
    saveProfileCache(tmpDir, { profile: 'T', generated_at: new Date().toISOString(), engram_count: 5, dirty: false })
    markProfileDirty(tmpDir)
    expect(loadProfileCache(tmpDir)!.dirty).toBe(true)
  })

  it('getProfileForInjection returns cached', () => {
    saveProfileCache(tmpDir, { profile: 'FP user', generated_at: new Date().toISOString(), engram_count: 10, dirty: false })
    expect(getProfileForInjection(tmpDir)).toBe('FP user')
  })

  it('generateProfile returns null for empty engrams', async () => {
    expect(await generateProfile([], vi.fn(), tmpDir)).toBeNull()
  })

  it('generateProfile calls LLM and caches', async () => {
    const llm = vi.fn().mockResolvedValue('You prefer TypeScript.')
    const engrams = [mkEngram('ENG-2026-0406-001', 'Use TS strict', 'dev')]
    const result = await generateProfile(engrams, llm, tmpDir)
    expect(result).toContain('TypeScript')
    expect(loadProfileCache(tmpDir)!.dirty).toBe(false)
  })

  it('generateProfile returns stale on LLM failure', async () => {
    saveProfileCache(tmpDir, { profile: 'Stale', generated_at: '2025-01-01T00:00:00Z', engram_count: 5, dirty: true })
    const llm = vi.fn().mockRejectedValue(new Error('fail'))
    const result = await generateProfile([mkEngram('ENG-2026-0406-001', 'T', 'dev')], llm, tmpDir, 0)
    expect(result).toBe('Stale')
  })
})
