import type { Engram } from './schemas/engram.js'
import type { DedupDecision } from './types.js'

/**
 * Build the LLM prompt for deduplication decision (Ideas 1 + 2 + 19).
 * Asks the LLM to compare new statement against existing candidates and decide:
 * ADD, UPDATE, MERGE, or NOOP — plus richness comparison and tension detection.
 */
export function buildDedupPrompt(
  newStatement: string,
  candidates: Array<{ id: string; statement: string; type: string; domain?: string }>,
): string {
  const candidateList = candidates.map((c, i) =>
    `${i + 1}. [${c.id}] (${c.type}${c.domain ? ', domain: ' + c.domain : ''})\n   "${c.statement}"`
  ).join('\n')

  return `You are a memory deduplication system. Compare a new memory statement against existing ones.

NEW STATEMENT:
"${newStatement}"

EXISTING ENGRAMS:
${candidateList}

For each existing engram, answer:
1. RELATIONSHIP: Is the new statement a DUPLICATE (same meaning), EVOLUTION (updated version of same knowledge), COMPLEMENTARY (related but different angle), CONTRADICTORY (opposing), or UNRELATED?
2. RICHNESS: Does the new statement contain more specific, actionable information than the existing one? (yes/no)

Then give your OVERALL DECISION (exactly one):
- NOOP: New statement is an exact duplicate of an existing engram. Return the ID.
- UPDATE: New statement is an evolution with MORE information. Return the ID to update.
- MERGE: New statement and an existing one are complementary — combining them preserves both. Return the ID to merge with.
- ADD: New statement is genuinely new knowledge.

Also check: Does the new statement CONTRADICT any existing engram? If yes, list the conflicting IDs.

Respond in this exact format:
DECISION: <ADD|UPDATE|MERGE|NOOP>
TARGET: <engram ID if UPDATE/MERGE/NOOP, or "none" if ADD>
CONFLICTS: <comma-separated IDs, or "none">
REASON: <one sentence explanation>`
}

/**
 * Build a batch dedup prompt for multiple candidates at once (learnBatch).
 */
export function buildBatchDedupPrompt(
  statements: string[],
  existingEngrams: Array<{ id: string; statement: string; type: string; domain?: string }>,
): string {
  const stmtList = statements.map((s, i) => `${i + 1}. "${s}"`).join('\n')
  const engramList = existingEngrams.map((e, i) =>
    `${i + 1}. [${e.id}] (${e.type}${e.domain ? ', domain: ' + e.domain : ''})\n   "${e.statement}"`
  ).join('\n')

  return `You are a memory deduplication system. Compare NEW statements against existing engrams.

NEW STATEMENTS:
${stmtList}

EXISTING ENGRAMS:
${engramList}

For each NEW statement, decide:
- NOOP: Exact duplicate of an existing engram.
- UPDATE: Evolution with more info than existing.
- MERGE: Complementary with existing — combine.
- ADD: Genuinely new knowledge.

Also flag any CONTRADICTIONS.

Respond with one block per new statement:
STATEMENT_1:
DECISION: <ADD|UPDATE|MERGE|NOOP>
TARGET: <engram ID or "none">
CONFLICTS: <comma-separated IDs or "none">

STATEMENT_2:
...`
}

/**
 * Parse the LLM response from a dedup prompt.
 */
export function parseDedupResponse(response: string): {
  decision: DedupDecision
  target_id: string | null
  conflicts: string[]
  reason: string
} {
  const decisionMatch = response.match(/DECISION:\s*(ADD|UPDATE|MERGE|NOOP)/i)
  const targetMatch = response.match(/TARGET:\s*([^\n]+)/i)
  const conflictsMatch = response.match(/CONFLICTS:\s*([^\n]+)/i)
  const reasonMatch = response.match(/REASON:\s*([^\n]+)/i)

  const decision = (decisionMatch?.[1]?.toUpperCase() ?? 'ADD') as DedupDecision

  const targetRaw = targetMatch?.[1]?.trim() ?? 'none'
  const target_id = targetRaw === 'none' ? null : targetRaw.replace(/[^A-Za-z0-9-]/g, '')

  const conflictsRaw = conflictsMatch?.[1]?.trim() ?? 'none'
  const conflicts = conflictsRaw === 'none'
    ? []
    : conflictsRaw.split(',').map(s => s.trim().replace(/[^A-Za-z0-9-]/g, '')).filter(Boolean)

  const reason = reasonMatch?.[1]?.trim() ?? ''

  return { decision, target_id, conflicts, reason }
}

/**
 * Parse a batch dedup response.
 */
export function parseBatchDedupResponse(response: string, count: number): Array<{
  decision: DedupDecision
  target_id: string | null
  conflicts: string[]
}> {
  const results: Array<{ decision: DedupDecision; target_id: string | null; conflicts: string[] }> = []

  for (let i = 1; i <= count; i++) {
    // Find the block for this statement — use [\s\S] to match across newlines
    const blockPattern = new RegExp(`STATEMENT_${i}:[\\s\\S]*?DECISION:\\s*(ADD|UPDATE|MERGE|NOOP)[\\s\\S]*?TARGET:\\s*([^\\n]+)[\\s\\S]*?CONFLICTS:\\s*([^\\n]+)`, 'i')
    const match = response.match(blockPattern)

    if (match) {
      const decision = (match[1].toUpperCase()) as DedupDecision
      const targetRaw = match[2].trim()
      const conflictsRaw = match[3].trim()

      results.push({
        decision,
        target_id: targetRaw === 'none' ? null : targetRaw.replace(/[^A-Za-z0-9-]/g, ''),
        conflicts: conflictsRaw === 'none' ? [] : conflictsRaw.split(',').map(s => s.trim().replace(/[^A-Za-z0-9-]/g, '')).filter(Boolean),
      })
    } else {
      // Default to ADD if we can't parse
      results.push({ decision: 'ADD', target_id: null, conflicts: [] })
    }
  }

  return results
}
