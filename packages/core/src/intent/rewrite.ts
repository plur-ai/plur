/**
 * Deterministic query rewriting (no LLM, no I/O) for the LEXICAL (BM25) leg only;
 * embeddings and the reranker keep the original. Substring matching makes
 * interrogatives non-inert ("what" matches "whatsapp"), so:
 *   1. Question-shaped queries lose interrogatives and did/does/do; role words
 *      like "user"/"assistant" are NEVER stripped.
 *   2. Temporal queries drop RELATIVE phrases; absolute anchors are KEPT.
 * Fewer than MIN_CONTENT_TOKENS left returns the ORIGINAL query;
 * PLUR_QUERY_REWRITE=off disables it ({@link isQueryRewriteDisabled}).
 */
import { classifyQuery, type QueryIntent } from './classifier.js'
import { ftsTokenize } from '../fts.js'

/** Final rewrites keeping fewer content tokens than this revert to the original. */
const MIN_CONTENT_TOKENS = 2

/** Interrogative words — question-shape signal AND strip targets. */
const INTERROGATIVES = new Set([
  'what', 'whats', 'which', 'who', 'whos', 'whose', 'whom',
  'where', 'wheres', 'when', 'whens', 'why', 'how', 'hows',
])

/**
 * Auxiliaries stripped only inside question-shaped queries. Deliberately
 * short: `do`/`did`/`does` are the ones the fts stopword list does NOT
 * already drop. Content-ish verbs (say, mention, remember) are kept.
 */
const QUESTION_AUXILIARIES = new Set(['do', 'did', 'does'])

/**
 * Relative temporal phrases — removed for temporal-intent queries.
 * Mirrors the classifier's TEMPORAL_PATTERNS minus the absolute anchors
 * (iso-date, month-day), which are kept because engram temporal fields
 * are part of the BM25 search text.
 */
const RELATIVE_TEMPORAL_PATTERNS: RegExp[] = [
  /\byesterday\b/gi,
  /\btoday\b/gi,
  /\btomorrow\b/gi,
  /\b(?:just\s+|right\s+)now\b/gi,
  /\bthis (?:morning|afternoon|evening|night|week|month|year|quarter)\b/gi,
  /\blast (?:week|month|year|quarter|night|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi,
  /\bnext (?:week|month|year|quarter)\b/gi,
  /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|few|several) (?:days?|weeks?|months?|years?|hours?|minutes?) ago\b/gi,
  /\brecent(?:ly)?\b/gi,
  /\blately\b/gi,
]

/** True when PLUR_QUERY_REWRITE opts the feature off. Default: enabled. */
export function isQueryRewriteDisabled(): boolean {
  const v = process.env.PLUR_QUERY_REWRITE
  if (!v) return false
  const lower = v.toLowerCase()
  return lower === 'off' || v === '0' || lower === 'false'
}

/**
 * Lowercased word-character core of a whitespace token ("What's" -> "whats").
 *
 * Unicode letters, numbers and marks — the same class `ftsTokenize` keeps. An
 * ASCII-only class would give every CJK / Cyrillic / Devanagari word an empty
 * core, and `stripScaffolding` drops empty-core tokens.
 */
function tokenCore(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}\p{M}]/gu, '')
}

/** True when the query reads as a question: trailing "?" or leading interrogative. */
function isQuestionShaped(query: string): boolean {
  const trimmed = query.trim()
  if (trimmed.endsWith('?')) return true
  const first = tokenCore(trimmed.split(/\s+/)[0] ?? '')
  return INTERROGATIVES.has(first)
}

/** Rule 1: drop interrogative scaffolding + "?" from a question-shaped query. */
function stripScaffolding(query: string): string {
  const kept = query
    .split(/\s+/)
    .filter(w => {
      const core = tokenCore(w)
      if (core.length === 0) return false
      return !INTERROGATIVES.has(core) && !QUESTION_AUXILIARIES.has(core)
    })
    .map(w => w.replace(/\?/g, ''))
    .filter(w => w.length > 0)
  return kept.join(' ').trim()
}

/** Rule 2: drop relative temporal phrases (absolute anchors are untouched). */
function stripRelativeTemporal(query: string): string {
  let out = query
  for (const re of RELATIVE_TEMPORAL_PATTERNS) {
    out = out.replace(re, ' ')
  }
  return out.replace(/\s+/g, ' ').trim()
}

/**
 * Rewrite a query for the LEXICAL (BM25) leg of hybrid recall. Synchronous and
 * hot-path safe; returns the ORIGINAL query when fewer than
 * {@link MIN_CONTENT_TOKENS} content tokens (per `ftsTokenize`) would remain.
 * @param query  The user's query, verbatim.
 * @param intent Optional pre-computed intent; auto-classified when omitted.
 */
export function rewriteLexicalQuery(query: string, intent?: QueryIntent): string {
  const original = query ?? ''
  if (original.trim().length === 0) return original

  let out = original
  if (isQuestionShaped(out)) {
    out = stripScaffolding(out)
  }

  const resolvedIntent: QueryIntent = intent ?? classifyQuery(original).intent
  if (resolvedIntent === 'temporal') {
    out = stripRelativeTemporal(out)
  }

  if (out === original) return original
  // Global guard: never return a rewrite too thin to retrieve on.
  if (ftsTokenize(out).length < MIN_CONTENT_TOKENS) return original
  return out
}
