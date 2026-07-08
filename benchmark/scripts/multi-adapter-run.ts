#!/usr/bin/env npx tsx
/**
 * Multi-adapter benchmark sweep — runs the LongMemEval harness across all
 * four canonical adapter configs for side-by-side comparison (#222).
 *
 * Usage:
 *   npx tsx benchmark/scripts/multi-adapter-run.ts
 *   npx tsx benchmark/scripts/multi-adapter-run.ts --corpus longmemeval-s-smoke
 *   npx tsx benchmark/scripts/multi-adapter-run.ts --reranker   # include hybrid+reranker
 *
 * Configs:
 *   plur-bm25             search_mode=bm25, no reranker
 *   plur-semantic         search_mode=semantic, no reranker
 *   plur-hybrid           search_mode=hybrid, no reranker
 *   plur-hybrid+reranker  search_mode=hybrid, rerank=on  (--reranker flag required)
 *
 * All configs share the same ingested store (--plur-path) so ingestion runs
 * only once. Store is cleaned up after all runs unless --keep-store is passed.
 *
 * Output:
 *   benchmark/results/multi-<sha>-<ts>/   per-config JSON + MD
 *   benchmark/results/multi-<sha>-<ts>/summary.json  comparison table
 */
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'
import { runBenchmark, type RunOptions, type CorpusName } from '../run.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function commitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim() || 'unknown'
  } catch { return 'unknown' }
}

function isoStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

interface AdapterConfig {
  name: string
  searchMode: string
  rerank: 'on' | 'off'
  skipIfNoReranker?: boolean
}

const CONFIGS: AdapterConfig[] = [
  { name: 'plur-bm25',            searchMode: 'bm25',     rerank: 'off' },
  { name: 'plur-semantic',        searchMode: 'semantic',  rerank: 'off' },
  { name: 'plur-hybrid',          searchMode: 'hybrid',    rerank: 'off' },
  { name: 'plur-hybrid+reranker', searchMode: 'hybrid',    rerank: 'on', skipIfNoReranker: true },
]

function parseArgs(argv: string[]): { corpus: CorpusName; includeReranker: boolean; keepStore: boolean; dataDir?: string } {
  let corpus: CorpusName = 'fixture'
  let includeReranker = false
  let keepStore = false
  let dataDir: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--corpus' && argv[i + 1]) corpus = argv[++i] as CorpusName
    else if (a === '--reranker') includeReranker = true
    else if (a === '--keep-store') keepStore = true
    else if (a === '--data-dir' && argv[i + 1]) dataDir = argv[++i]
  }
  return { corpus, includeReranker, keepStore, dataDir }
}

async function main() {
  const { corpus, includeReranker, keepStore, dataDir } = parseArgs(process.argv.slice(2))

  const sha = commitSha()
  const ts = isoStamp()
  const outputDir = path.join(__dirname, '..', 'results', `multi-${sha}-${ts}`)
  fs.mkdirSync(outputDir, { recursive: true })

  // Shared persistent store — ingest once, query across all configs.
  const sharedStore = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-multi-bench-'))

  const configs = includeReranker ? CONFIGS : CONFIGS.filter(c => c.rerank !== 'on')
  const summaries: Record<string, object> = {}

  console.log(`Multi-adapter sweep — ${configs.map(c => c.name).join(', ')}`)
  console.log(`Corpus: ${corpus} | Commit: ${sha}\n`)

  for (const config of configs) {
    if (config.skipIfNoReranker && !includeReranker) continue

    console.log(`\n${'='.repeat(60)}`)
    console.log(`Running: ${config.name}`)
    console.log('='.repeat(60))

    const opts: RunOptions = {
      searchMode: config.searchMode,
      rerank: config.rerank,
      corpus,
      dataDir,
      plurPath: sharedStore,
      outputDir,
      quiet: false,
    }

    try {
      const out = await runBenchmark(opts)
      // Rename outputs to include config name for clarity.
      const base = path.basename(out.jsonPath, '.json')
      const namedJson = path.join(outputDir, `${config.name}-${base}.json`)
      const namedMd = path.join(outputDir, `${config.name}-${base}.md`)
      fs.renameSync(out.jsonPath, namedJson)
      fs.renameSync(out.mdPath, namedMd)
      summaries[config.name] = out.summary
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`  ERROR running ${config.name}: ${msg}`)
      summaries[config.name] = { error: msg }
    }
  }

  // Write comparison summary.
  const summaryPath = path.join(outputDir, 'summary.json')
  fs.writeFileSync(summaryPath, JSON.stringify({ sha, timestamp: new Date().toISOString(), corpus, results: summaries }, null, 2))

  // Print comparison table.
  console.log('\n\nComparison Table')
  console.log('================\n')
  console.log(`${'Adapter'.padEnd(25)} ${'R@1'.padEnd(8)} ${'R@5'.padEnd(8)} ${'MRR'.padEnd(8)} ${'nDCG@5'.padEnd(9)} ${'Acc'.padEnd(8)} ${'p50'.padEnd(8)} ${'Cost/1k'.padEnd(10)}`)
  console.log('-'.repeat(95))
  for (const [name, s] of Object.entries(summaries)) {
    if ('error' in (s as object)) {
      console.log(`${name.padEnd(25)} ERROR`)
      continue
    }
    const m = s as Record<string, number>
    console.log(
      `${name.padEnd(25)} ${(m.r1.toFixed(1) + '%').padEnd(8)} ${(m.r5.toFixed(1) + '%').padEnd(8)} ` +
      `${m.mrr.toFixed(3).padEnd(8)} ${m.ndcg5.toFixed(3).padEnd(9)} ${(m.accuracy.toFixed(1) + '%').padEnd(8)} ` +
      `${(m.latency_p50_ms.toFixed(1) + 'ms').padEnd(8)} ${'$' + m.cost_usd_per_1k.toFixed(4)}`,
    )
  }
  console.log(`\nResults written to: ${outputDir}`)

  // Cleanup shared store unless --keep-store.
  if (!keepStore) {
    fs.rmSync(sharedStore, { recursive: true, force: true })
  } else {
    console.log(`Shared store retained at: ${sharedStore}`)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
