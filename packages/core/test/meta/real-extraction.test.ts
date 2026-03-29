/**
 * REAL EXTRACTION TEST
 *
 * Runs the full meta-engram pipeline on actual user engrams with a real LLM.
 * This is NOT a unit test — it's an integration smoke test.
 *
 * Run: pnpm --filter @plur-ai/core exec vitest run packages/core/test/meta/real-extraction.test.ts
 *
 * Requires: ANTHROPIC_API_KEY environment variable
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import * as yaml from 'js-yaml'
import { extractMetaEngrams } from '../../src/meta/pipeline.js'
import type { Engram } from '../../src/schemas/engram.js'
import type { LlmFunction } from '../../src/types.js'
import type { MetaField } from '../../src/schemas/meta-engram.js'

// Load real engrams from user's personal collection
function loadRealEngrams(): Engram[] {
  const paths = [
    '/Users/gregor/Data/.datacore/learning/engrams.yaml',
    '/Users/gregor/Data/0-personal/.datacore/learning/engrams.yaml',
  ]

  const all: Engram[] = []
  for (const p of paths) {
    if (!existsSync(p)) continue
    try {
      const raw = readFileSync(p, 'utf8')
      const parsed = yaml.load(raw) as any
      const engrams = parsed?.engrams ?? []
      // Filter: user-created, active only
      const userEngrams = engrams.filter((e: any) =>
        e.provenance?.origin === 'user/personal' &&
        e.status === 'active'
      )
      all.push(...userEngrams)
    } catch (err) {
      console.warn(`Failed to load ${p}:`, err)
    }
  }
  return all
}

// Create a real LLM function using Anthropic API
function createAnthropicLlm(): LlmFunction | null {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return null

  return async (prompt: string): Promise<string> => {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        temperature: 0.1,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Anthropic API error: ${response.status} ${text}`)
    }
    const data = await response.json() as any
    return data.content?.[0]?.text ?? ''
  }
}

describe.skipIf(!process.env.ANTHROPIC_API_KEY)('Real extraction pipeline', () => {
  it('extracts meta-engrams from real user engrams', async () => {
    const engrams = loadRealEngrams()
    console.log(`Loaded ${engrams.length} real user-created engrams`)
    expect(engrams.length).toBeGreaterThan(20)

    // Take a diverse sample of 30 engrams from different domains
    const domains = new Map<string, Engram[]>()
    for (const e of engrams) {
      const d = e.domain?.split('.')[0] ?? 'unknown'
      if (!domains.has(d)) domains.set(d, [])
      domains.get(d)!.push(e)
    }
    const sample: Engram[] = []
    for (const [domain, domainEngrams] of domains) {
      const take = Math.min(5, domainEngrams.length)
      sample.push(...domainEngrams.slice(0, take))
      if (sample.length >= 30) break
    }
    console.log(`Using sample of ${sample.length} engrams from ${domains.size} domains`)
    console.log(`Domains: ${[...domains.keys()].join(', ')}`)

    const llm = createAnthropicLlm()!
    expect(llm).toBeTruthy()

    // Run the full pipeline
    const result = await extractMetaEngrams(sample, llm, {
      run_validation: false, // Skip validation for speed
    })

    console.log('\n=== EXTRACTION RESULTS ===')
    console.log(`Engrams analyzed: ${result.engrams_analyzed}`)
    console.log(`Clusters found: ${result.clusters_found}`)
    console.log(`Alignments passed: ${result.alignments_passed}`)
    console.log(`Meta-engrams extracted: ${result.meta_engrams_extracted}`)
    console.log(`Rejected as platitudes: ${result.rejected_as_platitudes}`)
    console.log(`Duration: ${result.duration_ms}ms`)

    for (const meta of result.results) {
      const mf = meta.structured_data?.meta as MetaField | undefined
      console.log(`\n--- ${meta.id} ---`)
      console.log(`Statement: ${meta.statement}`)
      console.log(`Template: ${mf?.structure?.template}`)
      console.log(`Confidence: ${mf?.confidence?.composite}`)
      console.log(`Hierarchy: ${mf?.hierarchy?.level}`)
      console.log(`Evidence: ${mf?.evidence?.length} engrams`)
      if (mf?.falsification) {
        console.log(`Conditions: ${mf.falsification.expected_conditions}`)
        console.log(`Exceptions: ${mf.falsification.expected_exceptions}`)
        console.log(`Test prediction: ${mf.falsification.test_prediction}`)
      }
    }

    // Basic sanity checks
    expect(result.engrams_analyzed).toBeGreaterThan(0)
    // The pipeline should produce SOME output (even if modest)
    // But it's also valid for it to produce 0 if quality gates are strict
    console.log(`\nPipeline ${result.meta_engrams_extracted > 0 ? 'PRODUCED' : 'DID NOT PRODUCE'} meta-engrams`)

    // If any meta-engrams were produced, validate their structure
    for (const meta of result.results) {
      expect(meta.id).toMatch(/^META-/)
      expect(meta.statement.length).toBeGreaterThan(20)
      const mf = meta.structured_data?.meta as MetaField
      expect(mf).toBeTruthy()
      expect(mf.structure.template.length).toBeGreaterThan(10)
      expect(mf.evidence.length).toBeGreaterThanOrEqual(2)
      expect(mf.confidence.composite).toBeGreaterThanOrEqual(0)
      expect(mf.confidence.composite).toBeLessThanOrEqual(1)
      expect(['mop', 'top']).toContain(mf.hierarchy.level)
      expect(mf.falsification.expected_conditions.length).toBeGreaterThan(0)
    }
  }, 120_000) // 2 minute timeout for real LLM calls
})
