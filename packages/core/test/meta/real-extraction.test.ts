/**
 * REAL EXTRACTION TEST
 *
 * Runs the full meta-engram pipeline on actual user engrams with a real LLM.
 * This is NOT a unit test — it's an integration smoke test.
 *
 * Run: ANTHROPIC_API_KEY=... pnpm --filter @plur-ai/core exec vitest run test/meta/real-extraction.test.ts
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
    '/Users/gregor/Data/1-datafund/.datacore/learning/engrams.yaml',
    '/Users/gregor/Data/2-datacore/.datacore/learning/engrams.yaml',
    '/Users/gregor/Data/5-plur/2-projects/exchange/.datacore/learning/engrams.yaml',
  ]

  const all: Engram[] = []
  for (const p of paths) {
    if (!existsSync(p)) continue
    try {
      const raw = readFileSync(p, 'utf8')
      const parsed = yaml.load(raw) as any
      const engrams = parsed?.engrams ?? []
      const userEngrams = engrams.filter((e: any) =>
        e.provenance?.origin === 'user/personal' &&
        e.status === 'active'
      )
      all.push(...userEngrams)
    } catch {
      // Skip unparseable files
    }
  }
  return all
}

function createAnthropicLlm(): LlmFunction | null {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return null

  let callCount = 0
  return async (prompt: string): Promise<string> => {
    callCount++
    if (callCount % 10 === 0) process.stdout.write(`  [LLM call ${callCount}]\n`)
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
  it('extracts meta-engrams from 80 real engrams with validation', async () => {
    const allEngrams = loadRealEngrams()
    console.log(`Loaded ${allEngrams.length} real user-created engrams`)
    expect(allEngrams.length).toBeGreaterThan(20)

    // Take 80 engrams: sample broadly across domains, prioritize correction-tagged
    const domains = new Map<string, Engram[]>()
    for (const e of allEngrams) {
      const d = (e.domain ?? 'unknown').split('.')[0]
      if (!domains.has(d)) domains.set(d, [])
      domains.get(d)!.push(e)
    }

    // Prioritize: correction/failure engrams first within each domain
    for (const [, domainEngrams] of domains) {
      domainEngrams.sort((a, b) => {
        const aFail = a.tags?.some((t: string) => ['correction', 'fix', 'bug'].includes(t.toLowerCase())) ? 0 : 1
        const bFail = b.tags?.some((t: string) => ['correction', 'fix', 'bug'].includes(t.toLowerCase())) ? 0 : 1
        if (aFail !== bFail) return aFail - bFail
        return (b.feedback_signals?.negative ?? 0) - (a.feedback_signals?.negative ?? 0)
      })
    }

    const sample: Engram[] = []
    // Round-robin across domains to get diversity
    let round = 0
    while (sample.length < 80) {
      let added = false
      for (const [, domainEngrams] of domains) {
        if (round < domainEngrams.length && sample.length < 80) {
          sample.push(domainEngrams[round])
          added = true
        }
      }
      if (!added) break
      round++
    }

    console.log(`Using ${sample.length} engrams from ${domains.size} domains`)
    console.log(`Domains: ${[...domains.keys()].join(', ')}`)

    const llm = createAnthropicLlm()!

    // Split: 60 for extraction, 20 held-out for validation
    const extractionSet = sample.slice(0, 60)
    const validationSet = sample.slice(60)

    console.log(`Extraction set: ${extractionSet.length}, Validation set: ${validationSet.length}`)

    // Run the full pipeline WITH validation
    const result = await extractMetaEngrams(extractionSet, llm, {
      run_validation: true,
      validation_engrams: validationSet,
    })

    console.log('\n=== EXTRACTION RESULTS ===')
    console.log(`Engrams analyzed (Stage 1): ${result.engrams_analyzed}`)
    console.log(`Clusters found (Stage 2): ${result.clusters_found}`)
    console.log(`Alignments passed (Stage 3): ${result.alignments_passed}`)
    console.log(`Meta-engrams extracted (Stage 4): ${result.meta_engrams_extracted}`)
    console.log(`Rejected as platitudes: ${result.rejected_as_platitudes}`)
    console.log(`Validation results (Stage 5): ${result.validation_results.length}`)
    console.log(`Duration: ${result.duration_ms}ms`)

    for (const meta of result.results) {
      const mf = meta.structured_data?.meta as MetaField | undefined
      console.log(`\n--- ${meta.id} ---`)
      console.log(`Statement: ${meta.statement}`)
      console.log(`Template: ${mf?.structure?.template}`)
      console.log(`Confidence: ${mf?.confidence?.composite?.toFixed(3)}`)
      console.log(`Hierarchy: ${mf?.hierarchy?.level}`)
      console.log(`Evidence: ${mf?.evidence?.length} engrams from domains: ${mf?.domain_coverage?.validated?.join(', ')}`)
      if (mf?.falsification) {
        console.log(`Falsification conditions: ${mf.falsification.expected_conditions?.slice(0, 100)}...`)
        console.log(`Test prediction: ${mf.falsification.test_prediction?.slice(0, 100)}...`)
      }
    }

    if (result.validation_results.length > 0) {
      console.log('\n=== VALIDATION RESULTS (Stage 5) ===')
      for (const vr of result.validation_results) {
        console.log(`  ${vr.meta_engram_id} in ${vr.test_domain}: ${vr.prediction_held ? 'CONFIRMED' : 'REFUTED'} (score: ${vr.alignment_score})`)
        console.log(`    ${vr.rationale}`)
      }
    }

    // Assertions
    expect(result.engrams_analyzed).toBeGreaterThan(0)
    console.log(`\nPipeline ${result.meta_engrams_extracted > 0 ? 'PRODUCED' : 'DID NOT PRODUCE'} meta-engrams`)

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
      // Domain count should now be accurate (not member count)
      expect(mf.confidence.domain_count).toBeLessThanOrEqual(mf.evidence.length)
    }
  }, 300_000) // 5 minute timeout for 80 engrams
})
