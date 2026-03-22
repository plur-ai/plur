import type { Engram } from './schemas/engram.js'
import type { LlmFunction } from './types.js'
import { searchEngrams } from './fts.js'

/**
 * Agentic search: uses an LLM to semantically filter and rank engrams.
 *
 * Pipeline:
 * 1. BM25 pre-filter: narrow from all engrams to top candidates (fast, cheap)
 * 2. LLM re-rank: ask the model which candidates are actually relevant (accurate)
 * 3. Return the LLM-selected engrams in order
 *
 * This gives BM25-level speed for the initial filter with LLM-level accuracy
 * for the final selection. The LLM call is small — typically 2-4K tokens.
 */
export async function agenticSearch(
  engrams: Engram[],
  query: string,
  limit: number,
  llm: LlmFunction,
): Promise<Engram[]> {
  // Step 1: BM25 pre-filter to top 30 candidates (cheap, fast)
  const candidates = searchEngrams(engrams, query, Math.min(30, engrams.length))

  if (candidates.length === 0) return []
  if (candidates.length <= limit) {
    // Few enough candidates — let LLM rank them all
    return agenticRerank(candidates, query, limit, llm)
  }

  // Step 2: LLM selects the most relevant ones
  return agenticRerank(candidates, query, limit, llm)
}

/**
 * Ask an LLM to select and rank the most relevant engrams for a query.
 */
async function agenticRerank(
  candidates: Engram[],
  query: string,
  limit: number,
  llm: LlmFunction,
): Promise<Engram[]> {
  // Build the numbered list for the LLM
  const numbered = candidates.map((e, i) => `${i + 1}. [${e.id}] ${e.statement}`).join('\n')

  const prompt = `You are a memory retrieval system. Given a query and a list of memories, select the ${limit} most relevant memories. Return ONLY the numbers of the relevant memories, comma-separated, in order of relevance (most relevant first).

Query: "${query}"

Memories:
${numbered}

Rules:
- Select at most ${limit} memories
- Only select memories that are actually relevant to answering the query
- If fewer than ${limit} memories are relevant, return fewer
- Return ONLY comma-separated numbers, nothing else (e.g., "3,7,1,12")
- If no memories are relevant, return "none"`

  try {
    const response = await llm(prompt)
    const text = response.trim()

    if (text.toLowerCase() === 'none') return []

    // Parse comma-separated numbers
    const indices = text
      .split(',')
      .map(s => parseInt(s.trim(), 10) - 1) // 1-indexed → 0-indexed
      .filter(i => !isNaN(i) && i >= 0 && i < candidates.length)

    // Deduplicate while preserving order
    const seen = new Set<number>()
    const unique: number[] = []
    for (const i of indices) {
      if (!seen.has(i)) {
        seen.add(i)
        unique.push(i)
      }
    }

    return unique.slice(0, limit).map(i => candidates[i])
  } catch {
    // LLM failed — fall back to BM25 results
    return candidates.slice(0, limit)
  }
}
