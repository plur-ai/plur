#!/usr/bin/env npx tsx
/**
 * LongMemEval Benchmark Runner for PLUR
 *
 * Tests memory retrieval quality across 6 categories:
 * - single_session_user, single_session_preference, single_session_assistant
 * - temporal_reasoning, knowledge_updates, multi_session_reasoning
 *
 * Usage:
 *   npx tsx benchmark/run.ts [--search-mode hybrid|bm25|semantic] [--category <cat>]
 */
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import yaml from 'js-yaml'
import { Plur } from '../packages/core/src/index.js'

interface Scenario {
  id: string
  category: string
  conversations: Array<{ session: number; turns: Array<{ role: string; content: string }> }>
  query: string
  expected_answer: string
  expected_keywords: string[]
}

interface ScenarioResult {
  id: string
  category: string
  query: string
  expected_keywords: string[]
  retrieved_statements: string[]
  hit_at_5: boolean
  hit_at_10: boolean
  mrr: number
  accuracy: boolean
  rank: number | null
}

function loadScenarios(filterCategory?: string): Scenario[] {
  const raw = fs.readFileSync(path.join(__dirname, 'data', 'scenarios.yaml'), 'utf-8')
  let scenarios = yaml.load(raw) as Scenario[]
  if (filterCategory) scenarios = scenarios.filter(s => s.category === filterCategory)
  return scenarios
}

function keywordMatch(statement: string, keywords: string[]): boolean {
  const lower = statement.toLowerCase()
  return keywords.some(kw => lower.includes(kw.toLowerCase()))
}

function findRank(results: Array<{ statement: string }>, keywords: string[]): number | null {
  for (let i = 0; i < results.length; i++) {
    if (keywordMatch(results[i].statement, keywords)) return i + 1
  }
  return null
}

async function runBenchmark(searchMode: string, category?: string) {
  const scenarios = loadScenarios(category)
  if (!scenarios.length) { console.error('No scenarios found.'); process.exit(1) }

  // Create isolated temp PLUR instance
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-bench-'))
  const engDir = path.join(tmpDir, 'engrams.yaml')
  const epDir = path.join(tmpDir, 'episodes.yaml')
  const cfgDir = path.join(tmpDir, 'config.yaml')
  fs.writeFileSync(engDir, '[]')
  fs.writeFileSync(epDir, '[]')
  fs.writeFileSync(cfgDir, 'auto_learn: true\nindex: false\n')

  const plur = new Plur({ path: tmpDir })

  // Ingest all conversations
  let engramCount = 0
  for (const scenario of scenarios) {
    for (const session of scenario.conversations) {
      for (const turn of session.turns) {
        if (turn.role === 'user') {
          plur.learn(turn.content, { type: 'behavioral', source: `benchmark:${scenario.id}:s${session.session}` })
          engramCount++
        } else if (turn.role === 'assistant') {
          plur.learn(turn.content, { type: 'behavioral', source: `benchmark:${scenario.id}:s${session.session}:assistant` })
          engramCount++
        }
      }
    }
  }

  console.log(`Ingested ${engramCount} engrams from ${scenarios.length} scenarios.\n`)

  // Run queries
  const results: ScenarioResult[] = []
  for (const scenario of scenarios) {
    let retrieved: Array<{ id: string; statement: string }>

    if (searchMode === 'bm25') {
      retrieved = plur.recall(scenario.query, { limit: 10 })
    } else if (searchMode === 'semantic') {
      retrieved = await plur.recallSemantic(scenario.query, { limit: 10 })
    } else {
      // hybrid (default)
      retrieved = await plur.recallHybrid(scenario.query, { limit: 10 })
    }

    const rank = findRank(retrieved, scenario.expected_keywords)
    const allKeywordsFound = scenario.expected_keywords.every(kw =>
      retrieved.some(r => r.statement.toLowerCase().includes(kw.toLowerCase()))
    )

    const result: ScenarioResult = {
      id: scenario.id,
      category: scenario.category,
      query: scenario.query,
      expected_keywords: scenario.expected_keywords,
      retrieved_statements: retrieved.map(r => r.statement).slice(0, 5),
      hit_at_5: rank !== null && rank <= 5,
      hit_at_10: rank !== null && rank <= 10,
      mrr: rank !== null ? 1 / rank : 0,
      accuracy: allKeywordsFound,
      rank,
    }
    results.push(result)

    const mark = result.hit_at_10 ? '[o]' : '[x]'
    const matches = scenario.expected_keywords.filter(kw =>
      retrieved.some(r => r.statement.toLowerCase().includes(kw.toLowerCase()))
    )
    console.log(`  ${mark} ${scenario.id}: rank=${rank ?? 'miss'} mrr=${result.mrr.toFixed(3)} matches=[${matches.join(', ')}]`)
  }

  // Compute aggregates
  const categories = [...new Set(results.map(r => r.category))]

  console.log('\n\nResults Summary')
  console.log('===============\n')

  const hit5 = results.filter(r => r.hit_at_5).length / results.length * 100
  const hit10 = results.filter(r => r.hit_at_10).length / results.length * 100
  const avgMrr = results.reduce((sum, r) => sum + r.mrr, 0) / results.length
  const accuracy = results.filter(r => r.accuracy).length / results.length * 100

  console.log('Overall:')
  console.log(`  Hit@5:     ${hit5.toFixed(1)}%`)
  console.log(`  Hit@10:    ${hit10.toFixed(1)}%`)
  console.log(`  MRR:       ${avgMrr.toFixed(3)}`)
  console.log(`  Accuracy:  ${accuracy.toFixed(1)}% (all keywords found)`)

  console.log('\nPer Category:')
  console.log(`${'Category'.padEnd(30)} ${'Hit@5'.padEnd(8)} ${'Hit@10'.padEnd(8)} ${'MRR'.padEnd(8)} ${'Accuracy'.padEnd(8)}`)
  console.log('-'.repeat(75))

  for (const cat of categories) {
    const catResults = results.filter(r => r.category === cat)
    const cHit5 = catResults.filter(r => r.hit_at_5).length / catResults.length * 100
    const cHit10 = catResults.filter(r => r.hit_at_10).length / catResults.length * 100
    const cMrr = catResults.reduce((s, r) => s + r.mrr, 0) / catResults.length
    const cAcc = catResults.filter(r => r.accuracy).length / catResults.length * 100
    console.log(`${cat.padEnd(30)} ${(cHit5.toFixed(0) + '%').padEnd(8)} ${(cHit10.toFixed(0) + '%').padEnd(8)} ${cMrr.toFixed(3).padEnd(8)} ${(cAcc.toFixed(0) + '%').padEnd(8)}`)
  }

  // Save results
  const resultsDir = path.join(__dirname, 'results')
  fs.mkdirSync(resultsDir, { recursive: true })
  const date = new Date().toISOString().slice(0, 10)
  const filename = `${date}-${searchMode}.json`
  const outPath = path.join(resultsDir, filename)
  fs.writeFileSync(outPath, JSON.stringify({ date, search_mode: searchMode, overall: { hit5, hit10, mrr: avgMrr, accuracy }, per_category: Object.fromEntries(categories.map(cat => {
    const cr = results.filter(r => r.category === cat)
    return [cat, { hit5: cr.filter(r => r.hit_at_5).length / cr.length * 100, hit10: cr.filter(r => r.hit_at_10).length / cr.length * 100, mrr: cr.reduce((s, r) => s + r.mrr, 0) / cr.length, accuracy: cr.filter(r => r.accuracy).length / cr.length * 100 }]
  })), results }, null, 2))
  console.log(`\nResults saved to: ${outPath}`)

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true })
  console.log('Temp storage cleaned up.')
}

// Parse args
const args = process.argv.slice(2)
let searchMode = 'hybrid'
let category: string | undefined

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--search-mode' && args[i + 1]) searchMode = args[++i]
  if (args[i] === '--category' && args[i + 1]) category = args[++i]
}

runBenchmark(searchMode, category).catch(err => { console.error(err); process.exit(1) })
