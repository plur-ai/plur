import * as fs from 'fs'
import * as path from 'path'
import type { Engram } from './schemas/engram.js'
import type { LlmFunction } from './types.js'

export interface ProfileCache {
  profile: string
  generated_at: string
  engram_count: number
  dirty: boolean
}

const PROFILE_PROMPT = `You are analyzing a user's memory engrams to create a brief cognitive profile.
Below are the user's stored learnings, grouped by domain. Synthesize a concise profile (3-5 sentences) describing:
- Key preferences and working style
- Technical domains and expertise areas
- Constraints and things to avoid
- Notable patterns in their knowledge

Be specific and actionable. Write in second person ("You prefer...", "You work with...").

Engrams by domain:
{engrams_by_domain}

Profile:`

function getCachePath(storagePath: string): string {
  return path.join(storagePath, 'profile_cache.json')
}

export function loadProfileCache(storagePath: string): ProfileCache | null {
  try { return JSON.parse(fs.readFileSync(getCachePath(storagePath), 'utf8')) as ProfileCache }
  catch { return null }
}

export function saveProfileCache(storagePath: string, cache: ProfileCache): void {
  fs.writeFileSync(getCachePath(storagePath), JSON.stringify(cache, null, 2))
}

export function markProfileDirty(storagePath: string): void {
  const cache = loadProfileCache(storagePath)
  if (cache) { cache.dirty = true; saveProfileCache(storagePath, cache) }
}

export function profileNeedsRegeneration(cache: ProfileCache | null, cacheTtlHours: number = 24): boolean {
  if (!cache) return true
  if (!cache.dirty) return false
  const hoursSince = (Date.now() - new Date(cache.generated_at).getTime()) / (1000 * 60 * 60)
  return hoursSince >= cacheTtlHours
}

function clusterByDomain(engrams: Engram[]): Map<string, Engram[]> {
  const clusters = new Map<string, Engram[]>()
  for (const e of engrams) {
    const domain = e.domain?.split('.')[0] ?? 'general'
    const list = clusters.get(domain) ?? []
    list.push(e)
    clusters.set(domain, list)
  }
  return clusters
}

function formatClusters(clusters: Map<string, Engram[]>): string {
  const lines: string[] = []
  for (const [domain, engrams] of clusters) {
    lines.push(`\n### ${domain} (${engrams.length} engrams)`)
    for (const e of engrams.slice(0, 10)) lines.push(`- ${e.statement}`)
    if (engrams.length > 10) lines.push(`  ... and ${engrams.length - 10} more`)
  }
  return lines.join('\n')
}

export async function generateProfile(
  engrams: Engram[], llm: LlmFunction, storagePath: string, cacheTtlHours: number = 24,
): Promise<string | null> {
  const cache = loadProfileCache(storagePath)
  if (cache && !profileNeedsRegeneration(cache, cacheTtlHours)) return cache.profile
  if (engrams.length === 0) return null
  const clusters = clusterByDomain(engrams)
  const prompt = PROFILE_PROMPT.replace('{engrams_by_domain}', formatClusters(clusters))
  try {
    const profile = await llm(prompt)
    if (!profile?.trim()) return cache?.profile ?? null
    saveProfileCache(storagePath, {
      profile: profile.trim(), generated_at: new Date().toISOString(),
      engram_count: engrams.length, dirty: false,
    })
    return profile.trim()
  } catch { return cache?.profile ?? null }
}

export function getProfileForInjection(storagePath: string): string | null {
  const cache = loadProfileCache(storagePath)
  return cache?.profile ?? null
}
