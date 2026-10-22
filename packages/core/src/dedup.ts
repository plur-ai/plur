import type { Engram } from './schemas/engram.js'
import type { DedupDecision } from './types.js'

/**
 * What each decision means, shared by the single and the batch prompt.
 *
 * The decisions are defined by what the store does with them, which is what the
 * checker is really choosing (owner decision 2026-10-18): NOOP saves nothing,
 * UPDATE saves the new statement as its own memory that SUPERSEDES the old one
 * (the old one stops being given to the agent), ADD and MERGE save it as its
 * own memory beside the old one (MERGE also links the two). No decision ever
 * rewrites an existing memory.
 *
 * The hard cases are pairs that differ by one or two words. Whether those words
 * change WHAT the rule is about (two rules, both true: ADD) or WHAT it says
 * about the same thing (they cannot both be followed: UPDATE) is the question
 * the definitions and examples teach. The examples are invented and generic on
 * purpose; they must never be taken from an evaluation set.
 */
export const DEDUP_DECISION_GUIDE = `How to decide. Compare the new statement with the existing memory closest to it:
- SUBJECT: what the statement is about: the project, product, system, component, kind of item, event, audience or situation it applies to.
- VALUE: what it says about that subject: a number, threshold, duration, timing or order (before/after), state, place, option, behaviour, or the person or role responsible.

Decisions (exactly one):
- NOOP: the same subject and the same value, only worded differently (synonyms, reordered, active or passive voice, shorter or longer phrasing). Every condition, unit, reason and project is kept. Nothing is saved.
- UPDATE: the same subject and the same rule, but the new statement changes a value: a different number, threshold, duration, timing or order, state, place, option, behaviour, or a different person or role responsible. The two cannot both be followed, so the new statement replaces the old memory, which stops being used. Return the ID of the memory it replaces.
- ADD: a different subject or target (another project, system, component, kind of item, event or audience), even when the rest of the wording is identical; or anything that can be true and followed at the same time as every existing memory, such as one more required item next to an existing one. Also ADD when no existing memory is closely related.
- MERGE: rarely needed. The new statement adds a compatible detail to the same subject without changing any value. It is saved as its own memory, linked to the target. When unsure between MERGE and ADD, answer ADD.

When only a few words differ, ask: can someone follow both statements at the same time?
- No, because the new one gives the same subject a different value: UPDATE.
- Yes, because the changed words name a different thing the rule applies to, or an additional item: ADD.
- They mean exactly the same: NOOP.

Examples (invented; they are not from your input):
- "Back up the orders database every 6 hours." / "Back up the orders database every 12 hours." -> UPDATE (same subject, new interval)
- "Back up the orders database every 6 hours." / "Back up the users database every 6 hours." -> ADD (different subject)
- "Back up the orders database every 6 hours." / "The orders database gets a backup at six-hour intervals." -> NOOP (reworded)
- "Release notes are approved by the tech lead." / "Release notes are approved by the product manager." -> UPDATE (the approver changes)
- "Validate the payload before saving it." / "Validate the payload after saving it." -> UPDATE (the order changes)
- "The cleanup job skips archived folders." / "The cleanup job deletes archived folders." -> UPDATE (the behaviour toward the same thing changes)
- "The health check must return a green status before release." / "The health check must return a yellow status before release." -> UPDATE (the required state changes)
- "Warning banners use a yellow background." / "Info banners use a yellow background." -> ADD (a different kind of banner)
- "Each bug ticket must include the reporter's email address." / "Each bug ticket must include the reporter's phone number." -> ADD (one more required item; both can be included)
- "In the billing service, log every retry with its attempt number." / "In the search service, log every retry with its attempt number." -> ADD (another system)`

/**
 * Build the LLM prompt for a deduplication decision.
 * Asks the LLM to compare a new statement against existing candidates and
 * decide ADD, UPDATE, MERGE or NOOP (see DEDUP_DECISION_GUIDE).
 */
export function buildDedupPrompt(
  newStatement: string,
  candidates: Array<{ id: string; statement: string; type: string; domain?: string }>,
): string {
  const candidateList = candidates.map((c, i) =>
    `${i + 1}. [${c.id}] (${c.type}${c.domain ? ', domain: ' + c.domain : ''})\n   "${c.statement}"`
  ).join('\n')

  return `You are the duplicate checker of a memory store. A new statement is about to be saved. Compare it with the existing memories and decide what happens to it.

NEW STATEMENT:
"${newStatement}"

EXISTING ENGRAMS:
${candidateList}

${DEDUP_DECISION_GUIDE}

Respond in this exact format:
DECISION: <ADD|UPDATE|MERGE|NOOP>
TARGET: <engram ID if UPDATE/MERGE/NOOP, or "none" if ADD>
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

  return `You are the duplicate checker of a memory store. Compare each NEW statement with the existing engrams and decide what happens to it.

NEW STATEMENTS:
${stmtList}

EXISTING ENGRAMS:
${engramList}

${DEDUP_DECISION_GUIDE}

Respond with one block per new statement:
STATEMENT_1:
DECISION: <ADD|UPDATE|MERGE|NOOP>
TARGET: <engram ID or "none">

STATEMENT_2:
...`
}

/**
 * Parse the LLM response from a dedup prompt.
 */
export function parseDedupResponse(response: string): {
  decision: DedupDecision
  target_id: string | null
  reason: string
} {
  const decisionMatch = response.match(/DECISION:\s*(ADD|UPDATE|MERGE|NOOP)/i)
  const targetMatch = response.match(/TARGET:\s*([^\n]+)/i)
  const reasonMatch = response.match(/REASON:\s*([^\n]+)/i)

  const decision = (decisionMatch?.[1]?.toUpperCase() ?? 'ADD') as DedupDecision

  const targetRaw = targetMatch?.[1]?.trim() ?? 'none'
  const target_id = targetRaw === 'none' ? null : targetRaw.replace(/[^A-Za-z0-9-]/g, '')

  const reason = reasonMatch?.[1]?.trim() ?? ''

  return { decision, target_id, reason }
}

/**
 * Parse a batch dedup response.
 */
export function parseBatchDedupResponse(response: string, count: number): Array<{
  decision: DedupDecision
  target_id: string | null
}> {
  const results: Array<{ decision: DedupDecision; target_id: string | null }> = []

  for (let i = 1; i <= count; i++) {
    const blockPattern = new RegExp(`STATEMENT_${i}:[\\s\\S]*?DECISION:\\s*(ADD|UPDATE|MERGE|NOOP)[\\s\\S]*?TARGET:\\s*([^\\n]+)`, 'i')
    const match = response.match(blockPattern)

    if (match) {
      const decision = (match[1].toUpperCase()) as DedupDecision
      const targetRaw = match[2].trim()
      results.push({
        decision,
        target_id: targetRaw === 'none' ? null : targetRaw.replace(/[^A-Za-z0-9-]/g, ''),
      })
    } else {
      results.push({ decision: 'ADD', target_id: null })
    }
  }

  return results
}
