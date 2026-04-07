#!/usr/bin/env npx tsx
/**
 * Micro-benchmark for PLUR core operations.
 *
 * Measures latency of learn(), recall(), inject() to detect
 * regressions or improvements between branches.
 *
 * Usage:
 *   npx tsx benchmark/micro.ts                  # full suite
 *   npx tsx benchmark/micro.ts --iterations 50  # custom count
 *   npx tsx benchmark/micro.ts --label sp1      # tag results
 *
 * Output: prints stats table + saves JSON to benchmark/results/micro-{label}.json
 *
 * To compare branches:
 *   git checkout main && npx tsx benchmark/micro.ts --label main
 *   git checkout integration && npx tsx benchmark/micro.ts --label integration
 *   npx tsx benchmark/micro.ts --compare main integration
 */
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { Plur } from '../packages/core/src/index.js'

interface Stats {
  count: number
  total_ms: number
  mean_ms: number
  median_ms: number
  p95_ms: number
  p99_ms: number
  min_ms: number
  max_ms: number
}

function computeStats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b)
  const sum = samples.reduce((a, b) => a + b, 0)
  return {
    count: samples.length,
    total_ms: Math.round(sum * 100) / 100,
    mean_ms: Math.round((sum / samples.length) * 1000) / 1000,
    median_ms: sorted[Math.floor(sorted.length / 2)],
    p95_ms: sorted[Math.floor(sorted.length * 0.95)],
    p99_ms: sorted[Math.floor(sorted.length * 0.99)],
    min_ms: sorted[0],
    max_ms: sorted[sorted.length - 1],
  }
}

function timeOp(fn: () => any): number {
  const start = process.hrtime.bigint()
  fn()
  const end = process.hrtime.bigint()
  return Number(end - start) / 1_000_000 // ns → ms
}

async function timeOpAsync(fn: () => Promise<any>): Promise<number> {
  const start = process.hrtime.bigint()
  await fn()
  const end = process.hrtime.bigint()
  return Number(end - start) / 1_000_000
}

function generateStatement(i: number): string {
  const topics = [
    'database', 'authentication', 'caching', 'logging', 'testing',
    'deployment', 'monitoring', 'security', 'performance', 'documentation',
  ]
  const verbs = ['use', 'avoid', 'prefer', 'configure', 'always', 'never']
  const tools = ['PostgreSQL', 'Redis', 'JWT', 'webpack', 'vitest', 'docker', 'nginx', 'TypeScript', 'Python', 'Go']
  const t = topics[i % topics.length]
  const v = verbs[i % verbs.length]
  const tool = tools[i % tools.length]
  return `For ${t}, ${v} ${tool} when handling production traffic at scale.`
}

function generateDuplicates(): Array<{ original: string; near: string }> {
  return [
    { original: 'Use PostgreSQL for the production database', near: 'For production database, use PostgreSQL' },
    { original: 'Always run tests before merging', near: 'Run tests before every merge' },
    { original: 'Prefer functional components in React', near: 'In React, use functional components' },
    { original: 'JWT tokens expire after 24 hours', near: 'JWT expiration is 24h' },
    { original: 'Deploy via blue-green strategy', near: 'Use blue-green deployment' },
  ]
}

async function runBench(label: string, iterations: number) {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`PLUR Micro-benchmark — label: ${label}, iterations: ${iterations}`)
  console.log(`${'='.repeat(60)}\n`)

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-micro-'))
  fs.writeFileSync(path.join(tmpDir, 'engrams.yaml'), '[]')
  fs.writeFileSync(path.join(tmpDir, 'episodes.yaml'), '[]')
  fs.writeFileSync(path.join(tmpDir, 'config.yaml'), 'auto_learn: true\nindex: false\n')

  const plur = new Plur({ path: tmpDir })

  // ─── 1. learn() latency ────────────────────────────────────
  console.log(`[1/5] Timing learn() × ${iterations}...`)
  const learnTimes: number[] = []
  for (let i = 0; i < iterations; i++) {
    const t = timeOp(() => plur.learn(generateStatement(i), { type: 'behavioral', domain: 'test' }))
    learnTimes.push(t)
  }
  const learnStats = computeStats(learnTimes)
  console.log(`  mean=${learnStats.mean_ms.toFixed(2)}ms p95=${learnStats.p95_ms.toFixed(2)}ms p99=${learnStats.p99_ms.toFixed(2)}ms`)

  // ─── 2. recall() latency (BM25) ────────────────────────────
  console.log(`\n[2/5] Timing recall() BM25 × ${iterations}...`)
  const queries = [
    'PostgreSQL database', 'authentication tokens', 'caching strategy',
    'production deployment', 'security best practices', 'testing framework',
    'monitoring tools', 'performance optimization', 'documentation',
    'logging configuration',
  ]
  const recallTimes: number[] = []
  for (let i = 0; i < iterations; i++) {
    const t = timeOp(() => plur.recall(queries[i % queries.length], { limit: 10 }))
    recallTimes.push(t)
  }
  const recallStats = computeStats(recallTimes)
  console.log(`  mean=${recallStats.mean_ms.toFixed(2)}ms p95=${recallStats.p95_ms.toFixed(2)}ms`)

  // ─── 3. recallHybrid() latency ─────────────────────────────
  console.log(`\n[3/5] Timing recallHybrid() × ${iterations}...`)
  const hybridTimes: number[] = []
  for (let i = 0; i < iterations; i++) {
    const t = await timeOpAsync(async () => plur.recallHybrid(queries[i % queries.length], { limit: 10 }))
    hybridTimes.push(t)
  }
  const hybridStats = computeStats(hybridTimes)
  console.log(`  mean=${hybridStats.mean_ms.toFixed(2)}ms p95=${hybridStats.p95_ms.toFixed(2)}ms`)

  // ─── 4. inject() latency + token count ─────────────────────
  console.log(`\n[4/5] Timing inject() × ${iterations}...`)
  const injectTimes: number[] = []
  const tokensUsed: number[] = []
  const injectTasks = [
    'Building a new API endpoint with authentication',
    'Setting up monitoring for production database',
    'Refactoring caching layer for performance',
    'Adding test coverage for deployment scripts',
    'Improving security of JWT token validation',
  ]
  for (let i = 0; i < iterations; i++) {
    const task = injectTasks[i % injectTasks.length]
    let result: any
    const t = timeOp(() => { result = plur.inject(task, { budget: 2000 }) })
    injectTimes.push(t)
    if (result?.tokens_used !== undefined) tokensUsed.push(result.tokens_used)
  }
  const injectStats = computeStats(injectTimes)
  const tokenStats = tokensUsed.length > 0 ? computeStats(tokensUsed) : null
  console.log(`  mean=${injectStats.mean_ms.toFixed(2)}ms p95=${injectStats.p95_ms.toFixed(2)}ms`)
  if (tokenStats) console.log(`  tokens: mean=${tokenStats.mean_ms.toFixed(0)} max=${tokenStats.max_ms.toFixed(0)}`)

  // ─── 5. Dedup test ──────────────────────────────────────────
  console.log(`\n[5/5] Testing dedup with intentional near-duplicates...`)
  const dupes = generateDuplicates()
  const dedupResults: Array<{ duplicate_decision: string; latency_ms: number }> = []

  // LLM function from env (OpenRouter or OpenAI compatible)
  const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY
  const baseUrl = process.env.OPENROUTER_API_KEY
    ? 'https://openrouter.ai/api/v1'
    : 'https://api.openai.com/v1'
  const model = process.env.OPENROUTER_API_KEY ? 'openai/gpt-4o-mini' : 'gpt-4o-mini'

  const llmFn = apiKey ? async (prompt: string): Promise<string> => {
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.1 }),
    })
    if (!r.ok) throw new Error(`LLM ${r.status}`)
    const d: any = await r.json()
    return d.choices?.[0]?.message?.content ?? ''
  } : undefined

  if (llmFn) console.log(`  LLM configured: ${model}`)
  else console.log(`  No LLM key (set OPENROUTER_API_KEY or OPENAI_API_KEY)`)

  for (const { original, near } of dupes) {
    plur.learn(original, { type: 'behavioral', domain: 'dedup-test' })
    const start = process.hrtime.bigint()
    try {
      const result: any = await (plur as any).learnAsync(near, {
        type: 'behavioral',
        domain: 'dedup-test',
        llm: llmFn,
      })
      const latency = Number(process.hrtime.bigint() - start) / 1_000_000
      dedupResults.push({ duplicate_decision: result?.decision ?? 'UNKNOWN', latency_ms: latency })
    } catch (err: any) {
      const latency = Number(process.hrtime.bigint() - start) / 1_000_000
      plur.learn(near, { type: 'behavioral', domain: 'dedup-test' })
      dedupResults.push({ duplicate_decision: `ERROR:${err?.message ?? 'unknown'}`, latency_ms: latency })
    }
  }
  const decisions = dedupResults.map(r => r.duplicate_decision)
  const dedupLatencies = dedupResults.map(r => r.latency_ms)
  const avgLat = dedupLatencies.reduce((a, b) => a + b, 0) / dedupLatencies.length
  console.log(`  decisions: ${JSON.stringify(decisions)}`)
  console.log(`  avg latency: ${avgLat.toFixed(0)}ms`)

  // ─── Aggregate ──────────────────────────────────────────────
  const result = {
    label,
    iterations,
    timestamp: new Date().toISOString(),
    operations: {
      learn: learnStats,
      recall_bm25: recallStats,
      recall_hybrid: hybridStats,
      inject: injectStats,
      inject_tokens: tokenStats,
    },
    dedup: {
      tested: dupes.length,
      decisions,
      latencies_ms: dedupLatencies,
      avg_latency_ms: avgLat,
      llm_used: !!llmFn,
      llm_model: llmFn ? model : null,
    },
  }

  // Save
  const resultsDir = path.join(__dirname, 'results')
  fs.mkdirSync(resultsDir, { recursive: true })
  const outPath = path.join(resultsDir, `micro-${label}.json`)
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2))
  console.log(`\nResults saved: ${outPath}`)

  fs.rmSync(tmpDir, { recursive: true, force: true })
  return result
}

function compare(labelA: string, labelB: string) {
  const dir = path.join(__dirname, 'results')
  const a = JSON.parse(fs.readFileSync(path.join(dir, `micro-${labelA}.json`), 'utf-8'))
  const b = JSON.parse(fs.readFileSync(path.join(dir, `micro-${labelB}.json`), 'utf-8'))

  console.log(`\n${'='.repeat(80)}`)
  console.log(`COMPARISON: ${labelA} vs ${labelB}`)
  console.log(`${'='.repeat(80)}\n`)

  console.log(`${'Operation'.padEnd(20)} ${labelA.padEnd(18)} ${labelB.padEnd(18)} ${'Δ mean'.padEnd(12)} ${'Δ %'.padEnd(8)}`)
  console.log('-'.repeat(80))

  const ops = ['learn', 'recall_bm25', 'recall_hybrid', 'inject']
  for (const op of ops) {
    const ma = a.operations[op]?.mean_ms ?? 0
    const mb = b.operations[op]?.mean_ms ?? 0
    const delta = mb - ma
    const pct = ma > 0 ? (delta / ma) * 100 : 0
    const aStr = `${ma.toFixed(2)}ms (p95 ${a.operations[op]?.p95_ms?.toFixed(2) ?? '?'})`
    const bStr = `${mb.toFixed(2)}ms (p95 ${b.operations[op]?.p95_ms?.toFixed(2) ?? '?'})`
    const arrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '='
    console.log(`${op.padEnd(20)} ${aStr.padEnd(18)} ${bStr.padEnd(18)} ${(arrow + ' ' + delta.toFixed(2) + 'ms').padEnd(12)} ${pct.toFixed(1).padEnd(8)}`)
  }

  // Tokens
  const tokA = a.operations.inject_tokens?.mean_ms
  const tokB = b.operations.inject_tokens?.mean_ms
  if (tokA && tokB) {
    const delta = tokB - tokA
    const pct = (delta / tokA) * 100
    const arrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '='
    console.log(`${'inject_tokens'.padEnd(20)} ${tokA.toFixed(0).padEnd(18)} ${tokB.toFixed(0).padEnd(18)} ${(arrow + ' ' + delta.toFixed(0)).padEnd(12)} ${pct.toFixed(1).padEnd(8)}`)
  }

  console.log('\nDedup:')
  console.log(`  ${labelA}: ${a.dedup.decisions.join(', ')}`)
  console.log(`  ${labelB}: ${b.dedup.decisions.join(', ')}`)
  console.log()
}

// CLI
const args = process.argv.slice(2)
let label = 'default'
let iterations = 100
let compareMode: [string, string] | null = null

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--label' && args[i + 1]) label = args[++i]
  if (args[i] === '--iterations' && args[i + 1]) iterations = parseInt(args[++i])
  if (args[i] === '--compare' && args[i + 1] && args[i + 2]) {
    compareMode = [args[++i], args[++i]]
  }
}

if (compareMode) {
  compare(compareMode[0], compareMode[1])
} else {
  runBench(label, iterations).catch(err => { console.error(err); process.exit(1) })
}
