#!/usr/bin/env npx tsx
/**
 * LongMemEval-S corpus importer for PLUR.
 *
 * Reads the official LongMemEval-S dataset (Wu et al, 2024 — arxiv.org/abs/2410.10813)
 * downloaded from huggingface.co/datasets/xiaowu0162/longmemeval and writes it
 * out in the YAML shape our benchmark harness consumes (see `Scenario` in
 * `benchmark/run.ts`).
 *
 * Why: Sprint 0 audit flagged that `benchmark/data/scenarios.yaml` is a
 * 30-scenario hand-curated fixture sampled with replacement to N=500 — not the
 * real benchmark. gbrain published R@5=97.6% on actual LongMemEval-S. To make
 * any honest comparison we need the real corpus.
 *
 * Usage:
 *   1. Download the source (one-time, ~280 MB):
 *        huggingface-cli download xiaowu0162/longmemeval --repo-type dataset \
 *          --local-dir benchmark/data/longmemeval-source/
 *   2. Run this converter:
 *        npx tsx benchmark/scripts/import-longmemeval.ts
 *      Writes:
 *        - benchmark/data/longmemeval-s.yaml         (full 500-scenario corpus, gitignored)
 *        - benchmark/data/longmemeval-s-smoke.yaml   (30 scenarios, 5/category, committed for tests)
 *
 * Schema mapping (LongMemEval → PLUR Scenario):
 *   question_id          -> id
 *   question_type        -> category (hyphens normalised to underscores)
 *   haystack_sessions    -> conversations[] (each session indexed 1..N)
 *   question             -> query
 *   answer               -> expected_answer
 *   (derived)            -> expected_keywords  (extracted from answer text)
 *
 * The haystack contains ~40-60 sessions per question, only 1-3 of which actually
 * hold the answer. That needle-in-haystack pattern is the whole point of the
 * benchmark — we ingest all of them so retrieval has to discriminate.
 */
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import yaml from '../../packages/core/node_modules/js-yaml/index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ─── Source schema (what huggingface gives us) ──────────────────────

interface LMETurn {
  role: 'user' | 'assistant'
  content: string
  // Some sessions carry an extra `has_answer` flag on the turn that holds
  // the gold answer; we ignore it — our harness doesn't need oracle marking.
  has_answer?: boolean
}

interface LMEEntry {
  question_id: string
  question_type: string
  question: string
  answer: string
  question_date: string
  haystack_dates: string[]
  haystack_session_ids: string[]
  haystack_sessions: LMETurn[][]
  answer_session_ids: string[]
}

export interface ConvertOptions {
  /**
   * Cap haystack sessions per scenario. The full corpus uses every haystack
   * session (40-60 each) so retrieval has to discriminate; the smoke subset
   * trims down so a few hundred KB of YAML is enough for tests.
   * Set to `null` (default for the full corpus) to keep every session.
   */
  maxSessionsPerScenario?: number | null
  /**
   * When `maxSessionsPerScenario` is set, this controls how the cap is applied.
   * `"answer_plus_first"`: keep every answer-bearing session, then top up with
   *   the first non-answer sessions until the cap is reached. Preserves the
   *   needle-in-haystack shape with a smaller haystack.
   * `"answer_only"`: keep only the answer sessions (no distractors). Useful
   *   when YAML size is paramount but loses the discrimination signal.
   */
  capMode?: 'answer_plus_first' | 'answer_only'
}

// ─── Target schema (matches benchmark/run.ts Scenario) ──────────────

interface Scenario {
  id: string
  category: string
  conversations: Array<{ session: number; turns: Array<{ role: string; content: string }> }>
  query: string
  expected_answer: string
  expected_keywords: string[]
}

// ─── Category normalisation ──────────────────────────────────────────
// LongMemEval uses hyphens (single-session-user); our fixture uses underscores.
// Keep the canonical names identical to the fixture so the harness aggregates
// both corpora into the same six buckets.
const CATEGORY_MAP: Record<string, string> = {
  'single-session-user': 'single_session_user',
  'single-session-preference': 'single_session_preference',
  'single-session-assistant': 'single_session_assistant',
  'temporal-reasoning': 'temporal_reasoning',
  'knowledge-update': 'knowledge_updates',
  'multi-session': 'multi_session_reasoning',
}

// ─── Keyword extraction ─────────────────────────────────────────────
// The PLUR harness scores a result as a "hit" when at least one expected
// keyword appears in the retrieved statement. LongMemEval doesn't ship keyword
// labels — only free-form answers. We derive keywords by:
//   1. Pulling capitalised noun phrases / numbers / units out of the answer.
//   2. Falling back to the longest unique content words when (1) is empty.
//
// This is intentionally simple. The downstream consumer can override
// `expected_keywords` per-scenario if the harness needs to be more strict.

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'was', 'are', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
  'and', 'or', 'but', 'nor', 'so', 'yet', 'for', 'with', 'from', 'to',
  'of', 'in', 'on', 'at', 'by', 'as', 'into', 'about', 'after', 'before',
  'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them', 'their',
  'i', 'me', 'my', 'mine', 'you', 'your', 'yours', 'he', 'she', 'him',
  'her', 'his', 'hers', 'we', 'us', 'our', 'ours',
  'user', 'would', 'prefer', 'preferred', 'response', 'responses', 'might',
  'not', 'no', 'yes', 'also', 'maybe', 'acceptable', 'including', 'last',
  'day', 'days', 'time', 'times',
])

/**
 * Extract a small set (1-5) of high-signal keywords from the answer text.
 * Strategy:
 *   - First pull numbers + units (years, counts, durations).
 *   - Then capitalised tokens (proper nouns, acronyms, model names).
 *   - Then unique non-stopword tokens longer than 3 chars.
 *   - De-duplicate; cap at 5.
 */
export function extractKeywords(rawAnswer: unknown): string[] {
  // LongMemEval occasionally encodes numeric answers as bare ints (e.g. 3, 99,
  // 1300). Coerce to string so the regex passes don't crash on .trim().
  const answer = rawAnswer == null ? '' : String(rawAnswer)
  if (!answer.trim()) return []
  const keywords: string[] = []
  const seen = new Set<string>()

  const push = (kw: string) => {
    const k = kw.trim()
    if (!k) return
    const lower = k.toLowerCase()
    if (seen.has(lower)) return
    if (STOPWORDS.has(lower)) return
    seen.add(lower)
    keywords.push(k)
  }

  // 1. Numbers (incl. decimals, times like 8:30, ranges, monetary amounts).
  //    "25 minutes and 50 seconds (or 25:50)" → ["25", "50", "25:50"]
  const numMatches = answer.match(/\b\d+(?::\d+)?(?:\.\d+)?\b/g) || []
  for (const n of numMatches) push(n)

  // 2. Multi-word capitalised proper nouns first ("Business Administration",
  //    "Tesla Model 3", "Adobe Premiere Pro"). Then single capitalised tokens.
  const properPhrase = answer.match(/\b[A-Z][a-zA-Z0-9]*(?:\s+[A-Z][a-zA-Z0-9]*)+\b/g) || []
  for (const p of properPhrase) push(p)
  const properSingle = answer.match(/\b[A-Z][a-zA-Z0-9]{2,}\b/g) || []
  for (const p of properSingle) push(p)

  // 3. Long content words as fallback (only if we still have < 2 keywords).
  if (keywords.length < 2) {
    const tokens = (answer.match(/\b[a-zA-Z]{4,}\b/g) || [])
      .filter(t => !STOPWORDS.has(t.toLowerCase()))
      // Bias toward distinctive content — prefer rarer-looking tokens (longer).
      .sort((a, b) => b.length - a.length)
    for (const t of tokens) {
      push(t)
      if (keywords.length >= 3) break
    }
  }

  // Cap at 5 — harness counts a hit if ANY keyword matches, so more keywords
  // make hits cheaper. Five is generous without being trivial.
  return keywords.slice(0, 5)
}

// ─── Conversion ─────────────────────────────────────────────────────

export function convertEntry(entry: LMEEntry, opts: ConvertOptions = {}): Scenario {
  const category = CATEGORY_MAP[entry.question_type] ?? entry.question_type.replace(/-/g, '_')

  // Decide which haystack-session indices to keep.
  const all = entry.haystack_sessions
  const answerIds = new Set(entry.answer_session_ids)
  const keepIndices: number[] = []

  if (opts.maxSessionsPerScenario == null) {
    for (let i = 0; i < all.length; i++) keepIndices.push(i)
  } else {
    const answerIdxs: number[] = []
    const otherIdxs: number[] = []
    for (let i = 0; i < all.length; i++) {
      if (answerIds.has(entry.haystack_session_ids[i])) answerIdxs.push(i)
      else otherIdxs.push(i)
    }

    if (opts.capMode === 'answer_only') {
      for (const i of answerIdxs) keepIndices.push(i)
    } else {
      // answer_plus_first (default): every answer session, plus distractors
      // from the front of the haystack until we hit the cap.
      const cap = opts.maxSessionsPerScenario
      for (const i of answerIdxs) keepIndices.push(i)
      for (const i of otherIdxs) {
        if (keepIndices.length >= cap) break
        keepIndices.push(i)
      }
      keepIndices.sort((a, b) => a - b)
    }
  }

  const conversations = keepIndices.map((srcIdx, dstIdx) => {
    const turns = all[srcIdx]
    return {
      session: dstIdx + 1,
      turns: turns.map(t => ({
        role: t.role,
        // Trim absurdly long single turns to keep YAML manageable. The benchmark
        // ingests turn-by-turn; a 50k-char single turn would dominate one engram
        // and break the retrieval signal. Long turns get truncated at 4000 chars
        // with a marker so the test still sees the discriminating content.
        content: t.content.length > 4000
          ? t.content.slice(0, 4000) + ' [...truncated]'
          : t.content,
      })),
    }
  })

  return {
    id: entry.question_id,
    category,
    conversations,
    query: entry.question,
    expected_answer: String(entry.answer ?? ''),
    expected_keywords: extractKeywords(entry.answer),
  }
}

// ─── Smoke-subset selection ────────────────────────────────────────
//
// We commit a small subset (5 per category) so unit tests can exercise the
// real schema without pulling the full 280 MB corpus on every CI run. Picks
// the first 5 entries per category — deterministic, no PRNG needed.

function pickSmokeSubset(all: Scenario[], perCategory = 5): Scenario[] {
  const buckets = new Map<string, Scenario[]>()
  for (const s of all) {
    if (!buckets.has(s.category)) buckets.set(s.category, [])
    const bucket = buckets.get(s.category)!
    if (bucket.length < perCategory) bucket.push(s)
  }
  return [...buckets.values()].flat()
}

/** Same as pickSmokeSubset but on the raw LME entries (so we can re-convert
 *  with a tighter session cap for the smoke YAML). */
function pickSmokeEntries(all: LMEEntry[], perCategory = 5): LMEEntry[] {
  const buckets = new Map<string, LMEEntry[]>()
  for (const e of all) {
    const cat = CATEGORY_MAP[e.question_type] ?? e.question_type
    if (!buckets.has(cat)) buckets.set(cat, [])
    const bucket = buckets.get(cat)!
    if (bucket.length < perCategory) bucket.push(e)
  }
  return [...buckets.values()].flat()
}

// ─── Main ───────────────────────────────────────────────────────────

function main() {
  // benchmark/data/longmemeval-source/longmemeval_s — note: the HF download
  // saves the file without an extension, but it is plain JSON.
  const repoRoot = path.resolve(__dirname, '..', '..')
  const srcCandidates = [
    path.join(repoRoot, 'benchmark', 'data', 'longmemeval-source', 'longmemeval_s'),
    path.join(repoRoot, 'benchmark', 'data', 'longmemeval-source', 'longmemeval_s.json'),
  ]
  const src = srcCandidates.find(p => fs.existsSync(p))
  if (!src) {
    console.error(`
[error] LongMemEval-S source not found.

Expected one of:
${srcCandidates.map(p => '  ' + p).join('\n')}

Download with:
  huggingface-cli download xiaowu0162/longmemeval --repo-type dataset \\
    --local-dir benchmark/data/longmemeval-source/
`)
    process.exit(1)
  }

  console.log(`[1/4] Reading ${path.relative(repoRoot, src)} ...`)
  const raw = fs.readFileSync(src, 'utf-8')
  const entries: LMEEntry[] = JSON.parse(raw)
  console.log(`      ${entries.length} questions loaded.`)

  console.log('[2/4] Converting to PLUR Scenario shape ...')
  const scenarios = entries.map(e => convertEntry(e))

  // Stats per category.
  const counts = new Map<string, number>()
  for (const s of scenarios) counts.set(s.category, (counts.get(s.category) ?? 0) + 1)
  console.log('      Per-category counts:')
  for (const [cat, n] of [...counts.entries()].sort()) {
    console.log(`        ${cat.padEnd(32)} ${n}`)
  }
  console.log(`      total                            ${scenarios.length}`)

  const dataDir = path.join(repoRoot, 'benchmark', 'data')
  const fullOut = path.join(dataDir, 'longmemeval-s.yaml')
  const smokeOut = path.join(dataDir, 'longmemeval-s-smoke.yaml')

  console.log(`[3/4] Writing full corpus: ${path.relative(repoRoot, fullOut)}`)
  // noRefs avoids YAML anchors which break round-tripping in some loaders.
  // lineWidth -1 keeps long content on a single line for diff-ability.
  fs.writeFileSync(fullOut, yaml.dump(scenarios, { noRefs: true, lineWidth: -1 }))
  const fullSize = fs.statSync(fullOut).size
  console.log(`      ${(fullSize / (1024 * 1024)).toFixed(1)} MB`)

  console.log(`[4/4] Writing smoke subset: ${path.relative(repoRoot, smokeOut)}`)
  // Smoke subset: 5 scenarios per category, capped at 6 haystack sessions each
  // (every answer session + early distractors). Trims ~15 MB → ~few hundred KB
  // so unit tests can load it cheaply while still exercising real schema.
  const smokeEntries = pickSmokeEntries(entries, 5)
  const smoke = smokeEntries.map(e => convertEntry(e, {
    maxSessionsPerScenario: 6,
    capMode: 'answer_plus_first',
  }))
  fs.writeFileSync(smokeOut, yaml.dump(smoke, { noRefs: true, lineWidth: -1 }))
  const smokeSize = fs.statSync(smokeOut).size
  console.log(`      ${smoke.length} scenarios, ${(smokeSize / 1024).toFixed(1)} KB`)

  console.log('\nDone.')
}

const isMain = (() => {
  try {
    return process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename)
  } catch { return false }
})()

if (isMain) {
  try {
    main()
  } catch (err) {
    console.error(err)
    process.exit(1)
  }
}
