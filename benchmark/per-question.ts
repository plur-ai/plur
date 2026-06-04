#!/usr/bin/env npx tsx
/**
 * Per-question protocol benchmark for LongMemEval-S.
 *
 * Matches the canonical methodology used by gbrain, mem0, Letta, and the
 * LongMemEval paper. Each question gets its own corpus; we score against
 * LongMemEval's canonical `answer_session_ids`.
 *
 * Imports PLUR's BM25 (`searchEngrams`) and hybrid (`hybridSearchWithMeta`)
 * directly so we test the real production retrieval code paths without
 * paying the per-learn YAML rewrite cost (each call to `plur.learn` would
 * otherwise dominate runtime).
 *
 * Usage:
 *   npx tsx benchmark/per-question.ts --mode bm25
 *   npx tsx benchmark/per-question.ts --mode hybrid
 *   npx tsx benchmark/per-question.ts --mode rerank
 *   npx tsx benchmark/per-question.ts --mode bm25 --limit 25     # smoke
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { searchEngrams, engramSearchText } from '../packages/core/src/fts.js'
import { rrfMerge, applyReranker } from '../packages/core/src/hybrid-search.js'
import { getReranker, resolveRerankerName } from '../packages/core/src/rerankers/index.js'
import { getEmbedder, resolveEmbedderName } from '../packages/core/src/embedders/index.js'
import type { Engram } from '../packages/core/src/schemas/engram.js'

function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-12)
}

// Shared embedding-cache root across all per-question runs in this process.
// Without this, hybridSearchWithMeta tries to mkdir('') and crashes.
const CACHE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-pq-cache-'))
process.on('exit', () => {
  try { fs.rmSync(CACHE_ROOT, { recursive: true, force: true }) } catch { /* ignore */ }
})

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const LMEVAL_PATH = path.join(
  __dirname,
  'data/longmemeval-source/longmemeval_s',
)

interface LMEvalQuestion {
  question_id: string
  question_type: string
  question: string
  answer: string | number
  haystack_session_ids: string[]
  haystack_sessions: Array<Array<{ role?: string; content?: string }>>
  answer_session_ids: string[]
}

interface RunOptions {
  mode: 'bm25' | 'hybrid' | 'rerank'
  limit?: number
  topK: number
  /** Per-question checkpoint dir. Each question writes a JSON; restart skips done. */
  checkpointDir?: string
}

function parseArgs(argv: string[]): RunOptions {
  const opts: RunOptions = { mode: 'bm25', topK: 10 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--mode' && argv[i + 1]) opts.mode = argv[++i] as RunOptions['mode']
    else if (a === '--limit' && argv[i + 1]) opts.limit = parseInt(argv[++i], 10)
    else if (a === '--top-k' && argv[i + 1]) opts.topK = parseInt(argv[++i], 10)
    else if (a === '--checkpoint-dir' && argv[i + 1]) opts.checkpointDir = argv[++i]
  }
  return opts
}

interface Stats {
  n: number
  hit1: number
  hit5: number
  hit10: number
  total_latency_ms: number
}

const emptyStats = (): Stats => ({ n: 0, hit1: 0, hit5: 0, hit10: 0, total_latency_ms: 0 })

/** Construct a minimal Engram object for in-memory search. */
function makeEngram(idCounter: number, statement: string, source: string): Engram {
  return {
    id: `pq-${idCounter}`,
    version: 1,
    status: 'active',
    consolidated: false,
    type: 'behavioral',
    scope: 'global',
    visibility: 'private',
    statement,
    source,
    derivation_count: 0,
    pack: null,
    abstract: null,
    derived_from: null,
    knowledge_type: { memory_class: 'semantic', cognitive_level: 'apply' },
    tags: [],
    activation: {
      retrieval_strength: 0.7,
      storage_strength: 1,
      frequency: 0,
      last_accessed: new Date().toISOString().slice(0, 10),
    },
    associations: [],
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
  } as unknown as Engram
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  console.log(`[setup] mode=${opts.mode} top_k=${opts.topK} limit=${opts.limit ?? 'all'}`)
  const lmeval: LMEvalQuestion[] = JSON.parse(fs.readFileSync(LMEVAL_PATH, 'utf8'))
  console.log(`[setup] ${lmeval.length} questions loaded`)
  const questions = opts.limit ? lmeval.slice(0, opts.limit) : lmeval

  // Resolve adapters up-front so cold-start cost lands outside the timing.
  let embedder: ReturnType<typeof getEmbedder> | null = null
  if (opts.mode === 'hybrid' || opts.mode === 'rerank') {
    const name = resolveEmbedderName()
    console.log(`[setup] embedder=${name}`)
    embedder = getEmbedder(name)
  }
  let reranker: ReturnType<typeof getReranker> | null = null
  if (opts.mode === 'rerank') {
    const name = resolveRerankerName()
    console.log(`[setup] reranker=${name}`)
    reranker = getReranker(name === 'off' ? 'bge-reranker-v2-m3' : name)
  }

  const cats = new Map<string, Stats>()
  const overall = emptyStats()
  const startWall = Date.now()

  // Set up checkpoint dir if provided. Load existing per-question results
  // into the running stats so a restart picks up where it left off.
  if (opts.checkpointDir) {
    fs.mkdirSync(opts.checkpointDir, { recursive: true })
    const existing = fs.readdirSync(opts.checkpointDir).filter(f => f.endsWith('.json'))
    if (existing.length > 0) {
      console.log(`[resume] loading ${existing.length} existing checkpoints from ${opts.checkpointDir}`)
      for (const fname of existing) {
        try {
          const r = JSON.parse(fs.readFileSync(path.join(opts.checkpointDir, fname), 'utf8'))
          const stats = cats.get(r.category) ?? emptyStats()
          stats.n++
          stats.hit1 += r.hit_1 ? 1 : 0
          stats.hit5 += r.hit_5 ? 1 : 0
          stats.hit10 += r.hit_10 ? 1 : 0
          stats.total_latency_ms += r.latency_ms
          cats.set(r.category, stats)
          overall.n++
          overall.hit1 += r.hit_1 ? 1 : 0
          overall.hit5 += r.hit_5 ? 1 : 0
          overall.hit10 += r.hit_10 ? 1 : 0
          overall.total_latency_ms += r.latency_ms
        } catch { /* corrupt checkpoint, will redo */ }
      }
    }
  }

  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi]

    // Skip if checkpoint exists for this question.
    if (opts.checkpointDir) {
      const cp = path.join(opts.checkpointDir, `${q.question_id}.json`)
      if (fs.existsSync(cp)) continue
    }

    // Build in-memory engram set for this question.
    const engrams: Engram[] = []
    const engramSession: number[] = []
    let counter = 0
    for (let si = 0; si < q.haystack_sessions.length; si++) {
      const sessNum = si + 1
      for (const turn of q.haystack_sessions[si]) {
        const content = (turn?.content ?? '').trim()
        if (!content) continue
        engrams.push(makeEngram(counter++, content, `pq:${q.question_id}:s${sessNum}`))
        engramSession.push(sessNum)
      }
    }
    if (engrams.length === 0) continue

    // Canonical session positions for this question.
    const canonical = new Set<number>()
    for (let i = 0; i < q.haystack_session_ids.length; i++) {
      if (q.answer_session_ids.includes(q.haystack_session_ids[i])) {
        canonical.add(i + 1)
      }
    }
    if (canonical.size === 0) continue

    const t0 = process.hrtime.bigint()
    let results: Engram[] = []
    if (opts.mode === 'bm25') {
      results = searchEngrams(engrams, q.question, opts.topK)
    } else if (opts.mode === 'hybrid' || opts.mode === 'rerank') {
      // Custom hybrid that uses embedBatch (50 embeds in one call vs 50
      // sequential `embed()` calls — ~10-30x faster on CPU). Same RRF merge
      // and same searchEngrams BM25 as the production path.
      const fetchN = opts.mode === 'rerank' ? Math.max(opts.topK, 50) : opts.topK
      // 1) BM25 candidates
      const bm25 = searchEngrams(engrams, q.question, Math.min(engrams.length, fetchN * 3))
      // 2) Vector candidates via batched embed
      const adapter = embedder!
      const texts = engrams.map(engramSearchText)
      const [queryVec, engramVecs] = await Promise.all([
        adapter.embed(q.question),
        adapter.embedBatch(texts),
      ])
      const vecScores: Array<{ engram: Engram; score: number }> = []
      for (let i = 0; i < engrams.length; i++) {
        vecScores.push({ engram: engrams[i], score: cosineSim(queryVec, engramVecs[i]) })
      }
      vecScores.sort((a, b) => b.score - a.score)
      const vecTop = vecScores.slice(0, Math.min(engrams.length, fetchN * 2)).map(s => s.engram)
      // 3) RRF merge
      const merged = rrfMerge([bm25, vecTop])
      if (opts.mode === 'rerank') {
        const reranked = await applyReranker(merged, q.question, { reranker: reranker! })
        results = reranked.engrams.slice(0, opts.topK)
      } else {
        results = merged.slice(0, opts.topK)
      }
    }
    const t1 = process.hrtime.bigint()
    const lat_ms = Number(t1 - t0) / 1e6

    // Score: any retrieved engram from a canonical session?
    const idToSession = new Map<string, number>()
    for (let i = 0; i < engrams.length; i++) {
      idToSession.set(engrams[i].id, engramSession[i])
    }
    const sessions = results.map(r => idToSession.get(r.id) ?? -1)
    const hit_1 = sessions.length > 0 && canonical.has(sessions[0])
    const hit_5 = sessions.slice(0, 5).some(s => canonical.has(s))
    const hit_10 = sessions.slice(0, 10).some(s => canonical.has(s))

    const stats = cats.get(q.question_type) ?? emptyStats()
    stats.n++
    stats.hit1 += hit_1 ? 1 : 0
    stats.hit5 += hit_5 ? 1 : 0
    stats.hit10 += hit_10 ? 1 : 0
    stats.total_latency_ms += lat_ms
    cats.set(q.question_type, stats)
    overall.n++
    overall.hit1 += hit_1 ? 1 : 0
    overall.hit5 += hit_5 ? 1 : 0
    overall.hit10 += hit_10 ? 1 : 0
    overall.total_latency_ms += lat_ms

    // Write checkpoint atomically (tmp + rename).
    if (opts.checkpointDir) {
      const cp = path.join(opts.checkpointDir, `${q.question_id}.json`)
      const cpTmp = cp + '.tmp'
      fs.writeFileSync(
        cpTmp,
        JSON.stringify({
          question_id: q.question_id,
          category: q.question_type,
          mode: opts.mode,
          hit_1, hit_5, hit_10, latency_ms: lat_ms,
        }, null, 0) + '\n',
      )
      fs.renameSync(cpTmp, cp)
    }

    if ((qi + 1) % 25 === 0 || qi + 1 === questions.length) {
      const wallSec = (Date.now() - startWall) / 1000
      console.log(
        `[run] ${qi + 1}/${questions.length} ` +
          `R@5=${(overall.hit5 / overall.n * 100).toFixed(1)}% ` +
          `R@1=${(overall.hit1 / overall.n * 100).toFixed(1)}% ` +
          `lat_avg=${(overall.total_latency_ms / overall.n).toFixed(0)}ms ` +
          `wall=${wallSec.toFixed(0)}s`,
      )
    }
  }

  console.log()
  console.log(`Per-question protocol — mode=${opts.mode}`)
  console.log(`Scoring: canonical_doc (any top-K engram from a LongMemEval answer_session)`)
  console.log()
  console.log(
    `  ${'Category'.padEnd(30)} ${'N'.padStart(4)}  ${'R@1'.padStart(7)} ${'R@5'.padStart(7)} ${'R@10'.padStart(7)}  ${'avg ms'.padStart(8)}`,
  )
  const dash = '-'
  console.log(
    `  ${dash.repeat(30)} ${dash.repeat(4)}  ${dash.repeat(7)} ${dash.repeat(7)} ${dash.repeat(7)}  ${dash.repeat(8)}`,
  )
  for (const cat of [...cats.keys()].sort()) {
    const s = cats.get(cat)!
    console.log(
      `  ${cat.padEnd(30)} ${String(s.n).padStart(4)}  ` +
        `${(s.hit1 / s.n * 100).toFixed(1).padStart(6)}% ` +
        `${(s.hit5 / s.n * 100).toFixed(1).padStart(6)}% ` +
        `${(s.hit10 / s.n * 100).toFixed(1).padStart(6)}%  ` +
        `${(s.total_latency_ms / s.n).toFixed(0).padStart(8)}`,
    )
  }
  console.log(
    `  ${dash.repeat(30)} ${dash.repeat(4)}  ${dash.repeat(7)} ${dash.repeat(7)} ${dash.repeat(7)}  ${dash.repeat(8)}`,
  )
  const s = overall
  console.log(
    `  ${'OVERALL'.padEnd(30)} ${String(s.n).padStart(4)}  ` +
      `${(s.hit1 / s.n * 100).toFixed(1).padStart(6)}% ` +
      `${(s.hit5 / s.n * 100).toFixed(1).padStart(6)}% ` +
      `${(s.hit10 / s.n * 100).toFixed(1).padStart(6)}%  ` +
      `${(s.total_latency_ms / s.n).toFixed(0).padStart(8)}`,
  )
  console.log()
  console.log('References:')
  console.log('  gbrain published (hybrid + text-embedding-3-large): R@5 = 97.6%')
  console.log('  gbrain published (BM25-only):                       R@5 = 19.8%')
  console.log('  rank-bm25 baseline (session-level):                 R@5 = 96.0%')
}

main().catch(err => {
  console.error('[fatal]', err)
  process.exit(1)
})
