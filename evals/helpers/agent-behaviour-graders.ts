// Graders for the agent-behaviour promises (BEH-1, BEH-2, BEH-3).
//
// Pure functions over a parsed transcript, the files a run left behind and the
// memories found by REOPENING the store after the run. No I/O and no model, so
// evals/helpers/agent-behaviour-graders.unit.test.ts proves each one on
// synthetic transcripts (run it with
// `pnpm exec vitest run --config evals/vitest.diagnostics.config.ts`).
//
// Why they are strict (audit B-02, 2026-10-17). The first graders matched a
// word anywhere: "Never Tuesday; deploy Friday" passed a recall check for
// Tuesday; a FAILED learn call whose statement said the opposite rule passed
// the correction check because it contained ".cfg"; any file ending in .cfg
// passed the next session. These graders judge:
//  * meaning, including negation, not word occurrence;
//  * a SUCCESSFUL save whose statement carries the right proposition, and that
//    proposition found on disk after the store is reopened (an agent or a
//    server that only says "saved" fails);
//  * the requested output file with the requested content, and evidence the
//    saved memory was actually retrieved in the next session.
import type { AgentRun, ToolCall } from './agent-behaviour-harness.js'

// ── meaning with negation ───────────────────────────────────────────────────

/** Words that negate what follows them within the same clause. */
const NEGATORS = /\b(never|not|no|don'?t|do not|does not|doesn'?t|cannot|can'?t|won'?t|isn'?t|aren'?t|avoid|avoiding|instead of|rather than|except|without|forbidden|disallowed)\b/i
/** How many words before a term a negator still applies to it. */
const NEGATION_WINDOW = 4

/** Hard clause breaks: a negation never reaches across these. */
const HARD_BREAK = /\.(?=\s|$)|[;:!?()\[\]\n—–]+|\s-\s|\bbut\b|\bhowever\b|\bwhereas\b|\bwhile\b/i
/** A comma-separated item that is one word after connectors ("Saturday", "or on Sunday") continues the list before it. */
const LIST_ITEM = /^(?:(?:and|or|nor|on|in|a|an|the)\s+)*[^\s]+$/i

/**
 * Clauses of `text`, each with whether a negation carries into it from the
 * list it belongs to: in "Not on Friday, Saturday, or Sunday" the "not"
 * covers all three days. A period ends a clause only before a space or the
 * end, so ".cfg" stays one word.
 */
export function clauses(text: string): Array<{ text: string; carried: boolean }> {
  const out: Array<{ text: string; carried: boolean }> = []
  for (const hard of text.split(HARD_BREAK)) {
    let negatedList = false
    for (const raw of (hard ?? '').split(',')) {
      const c = raw.trim()
      if (!c) continue
      const carried: boolean = LIST_ITEM.test(c) && negatedList
      out.push({ text: c, carried })
      negatedList = carried || NEGATORS.test(c)
    }
  }
  return out
}

export interface Stance { affirmed: number; negated: number }

/**
 * How `text` speaks about `term`: each mention counts as negated when a
 * negator appears within NEGATION_WINDOW words before it in the same clause
 * (or the clause continues a negated list), and as affirmed otherwise.
 */
export function stance(text: string, term: RegExp): Stance {
  const out: Stance = { affirmed: 0, negated: 0 }
  const global = new RegExp(term.source, term.flags.includes('g') ? term.flags : term.flags + 'g')
  for (const clause of clauses(text)) {
    for (const m of clause.text.matchAll(global)) {
      const before = clause.text.slice(0, m.index).trim().split(/\s+/).slice(-NEGATION_WINDOW).join(' ')
      if (clause.carried || NEGATORS.test(before)) out.negated++
      else out.affirmed++
    }
  }
  return out
}

/** True when `text` affirms `want`, never negates it, and affirms none of `rivals`. */
export function saysOnly(text: string, want: RegExp, rivals: RegExp[] = []): { ok: boolean; why: string } {
  const w = stance(text, want)
  if (w.affirmed === 0) return { ok: false, why: `does not affirm ${want.source}` }
  if (w.negated > 0) return { ok: false, why: `negates ${want.source} at least once` }
  for (const r of rivals) {
    const s = stance(text, r)
    if (s.affirmed > 0) return { ok: false, why: `also affirms ${r.source}` }
  }
  return { ok: true, why: `affirms ${want.source} only` }
}

// ── transcript helpers ──────────────────────────────────────────────────────

export const RECALL_TOOLS = new Set(['plur_recall', 'plur_recall_hybrid', 'plur_session_start', 'plur_inject', 'plur_inject_hybrid', 'plur_similarity_search'])
export const LEARN_TOOLS = new Set(['plur_learn', 'plur_learn_batch'])

/** Calls to the plur MCP server, with plur_admin { action, args } unwrapped. */
export function plurCalls(run: AgentRun): ToolCall[] {
  return run.toolCalls
    .filter(c => c.name.startsWith('mcp__plur__'))
    .map(c => {
      const short = c.name.slice('mcp__plur__'.length)
      if (short === 'plur_admin' && typeof c.input.action === 'string') {
        const args = (c.input.args && typeof c.input.args === 'object' ? c.input.args : {}) as Record<string, unknown>
        return { ...c, name: String(c.input.action).replace(/^mcp__plur__/, ''), input: args }
      }
      return { ...c, name: short }
    })
}

/**
 * Did this tool call succeed? Not an error result, not PLUR's "memory is off
 * here" answer, not a `success: false` / `error` reply, and it names an id.
 */
export function callSucceeded(c: ToolCall): boolean {
  if (c.isError === true) return false
  const r = c.result
  if (!r) return false
  if (/"plur"\s*:\s*"off"/.test(r)) return false
  if (/"success"\s*:\s*false/.test(r)) return false
  if (/"error"\s*:/.test(r)) return false
  return /\bENG-[A-Za-z0-9-]+/.test(r)
}

export interface LearnAttempt { statement: string; ok: boolean; tool: string }

/** Every statement passed to a learn call, with whether that call succeeded. */
export function learnAttempts(runs: AgentRun[]): LearnAttempt[] {
  const out: LearnAttempt[] = []
  for (const r of runs) {
    for (const c of plurCalls(r).filter(c => LEARN_TOOLS.has(c.name))) {
      const ok = callSucceeded(c)
      if (typeof c.input.statement === 'string') out.push({ statement: c.input.statement, ok, tool: c.name })
      const items = (c.input.items ?? c.input.engrams ?? c.input.learnings) as unknown
      if (Array.isArray(items)) {
        for (const it of items) {
          const s = it && typeof it === 'object' ? (it as { statement?: unknown }).statement : undefined
          if (typeof s === 'string') out.push({ statement: s, ok, tool: c.name })
        }
      }
    }
  }
  return out
}

export interface Verdict { ok: boolean; why: string }

/**
 * A memory was saved: a learn call SUCCEEDED with a statement carrying the
 * proposition, AND a memory carrying it is on disk when the store is reopened.
 */
export function gradeSaved(runs: AgentRun[], persisted: string[], proposition: (s: string) => Verdict, what: string): Verdict & { stored?: string } {
  if (runs.some(r => r.timedOut)) return { ok: false, why: 'the session timed out' }
  const attempts = learnAttempts(runs)
  const right = attempts.filter(a => proposition(a.statement).ok)
  const succeeded = right.filter(a => a.ok)
  if (succeeded.length === 0) {
    const seen = attempts.map(a => `${a.ok ? 'ok' : 'FAILED'}: ${JSON.stringify(a.statement.slice(0, 120))} (${proposition(a.statement).why})`)
    return { ok: false, why: `expected a successful plur_learn whose statement says ${what}; learn calls seen: ${seen.length ? seen.join('; ') : 'none'}` }
  }
  const stored = persisted.find(s => proposition(s).ok)
  if (!stored) {
    return { ok: false, why: `the agent saved ${JSON.stringify(succeeded[0].statement.slice(0, 120))} and the server said it succeeded, but no memory saying ${what} is in the store when it is reopened (on disk: ${JSON.stringify(persisted.map(p => p.slice(0, 80)))})` }
  }
  return { ok: true, why: `saved and on disk: ${JSON.stringify(stored.slice(0, 120))}`, stored }
}

/**
 * The next session USED the saved memory: a PLUR lookup in that session
 * succeeded and its reply carries the stored memory's text.
 */
export function gradeRetrieved(run: AgentRun, stored: string): Verdict {
  const lookups = plurCalls(run).filter(c => RECALL_TOOLS.has(c.name))
  if (lookups.length === 0) return { ok: false, why: `no PLUR lookup in the next session; tools: ${run.toolCalls.map(c => c.name).join(', ') || 'none'}` }
  const key = stored.slice(0, 60)
  const hit = lookups.find(c => c.isError !== true && c.result.includes(key))
  if (!hit) return { ok: false, why: `PLUR was asked (${lookups.map(c => c.name).join(', ')}) but no reply carried the saved memory ${JSON.stringify(key)}` }
  return { ok: true, why: `retrieved the saved memory via ${hit.name}` }
}

// ── BEH-1: answers from memory ──────────────────────────────────────────────

export const WEEKDAYS: Record<string, RegExp> = {
  monday: /\bmondays?\b/i, tuesday: /\btuesdays?\b/i, wednesday: /\bwednesdays?\b/i, thursday: /\bthursdays?\b/i,
  friday: /\bfridays?\b/i, saturday: /\bsaturdays?\b/i, sunday: /\bsundays?\b/i,
}

/**
 * BEH-1 memory arm: the agent looked in PLUR, a lookup that succeeded returned
 * the seeded fact, and the final answer MEANS "deploy on `day`": it affirms the
 * day, never negates it, and affirms no other weekday.
 */
export function gradeAnswerFromMemory(run: AgentRun, day: keyof typeof WEEKDAYS, factMarker: RegExp): Verdict {
  if (run.timedOut) return { ok: false, why: 'the session timed out' }
  const lookups = plurCalls(run).filter(c => RECALL_TOOLS.has(c.name))
  if (lookups.length === 0) {
    return { ok: false, why: `expected a PLUR recall or session_start call before answering; saw tools: ${run.toolCalls.map(c => c.name).join(', ') || 'none'}` }
  }
  const fromMemory = lookups.some(c => c.isError !== true && factMarker.test(c.result) && WEEKDAYS[day].test(c.result))
  if (!fromMemory) return { ok: false, why: `PLUR was asked (${lookups.map(c => c.name).join(', ')}) but no successful reply carried the seeded fact` }
  const rivals = Object.entries(WEEKDAYS).filter(([d]) => d !== day).map(([, re]) => re)
  const meaning = saysOnly(run.text, WEEKDAYS[day], rivals)
  if (!meaning.ok) return { ok: false, why: `the final answer does not mean "deploy on ${day}" (${meaning.why}): ${JSON.stringify(run.text.slice(0, 200))}` }
  return { ok: true, why: `recalled via ${lookups.map(c => c.name).join(', ')} and answered ${day}` }
}

// ── BEH-2: a correction sticks ──────────────────────────────────────────────

const CFG = /\.cfg\b/i
const CONF = /\.conf\b/i

/** The corrected rule: config files use .cfg; .conf may appear only negated. */
export function saysCfgNotConf(statement: string): Verdict {
  return saysOnly(statement, CFG, [CONF])
}

/** Normalise a line for comparison: trim, collapse spaces around `=`. */
const norm = (s: string) => s.trim().replace(/\s*=\s*/g, ' = ').replace(/\s+/g, ' ')

/**
 * BEH-2 session 2: exactly the requested file (`expected`, e.g. mailer.cfg)
 * with the requested line, no file with the wrong extension, no other variant.
 */
export function gradeRequestedFile(files: Record<string, string>, expected: string, line: string, wrong: RegExp): Verdict {
  const names = Object.keys(files).filter(f => f !== 'CLAUDE.md')
  const bad = names.filter(f => wrong.test(f))
  if (bad.length) return { ok: false, why: `the mistake came back: ${bad.join(', ')}` }
  if (!(expected in files)) return { ok: false, why: `expected the requested file ${expected}; files were: ${names.join(', ') || 'none'}` }
  const lines = files[expected].split('\n').map(norm).filter(Boolean)
  if (!lines.includes(norm(line))) return { ok: false, why: `${expected} does not hold the line ${JSON.stringify(line)}: ${JSON.stringify(files[expected].slice(0, 120))}` }
  const base = expected.replace(/\.[^.]+$/, '')
  const variants = names.filter(f => f !== expected && f.replace(/\.[^.]+$/, '') === base)
  if (variants.length) return { ok: false, why: `besides ${expected} the run also wrote ${variants.join(', ')}` }
  return { ok: true, why: `wrote ${expected} with the requested line` }
}

// ── BEH-3: an explicit save is used next session ────────────────────────────

/** The saved fact: Larkspur keeps logs for 11 days (the number affirmed, no other day count). */
export function saysElevenDays(statement: string): Verdict {
  if (!/\b(log|logs)\b/i.test(statement)) return { ok: false, why: 'does not mention logs' }
  const other = [...statement.matchAll(/\b(\d+)\s*(?:-\s*)?days?\b/gi)].map(m => m[1]).filter(n => n !== '11')
  if (other.length) return { ok: false, why: `names another day count (${other.join(', ')})` }
  return saysOnly(statement, /\b(11|eleven)\s*(?:-\s*)?days?\b/i)
}

/** BEH-3 session 2: retention.txt holds the number of days, 11, and no other number. */
export function gradeRetentionFile(files: Record<string, string>): Verdict {
  const names = Object.keys(files).filter(f => f !== 'CLAUDE.md')
  if (!('retention.txt' in files)) return { ok: false, why: `expected retention.txt; files were: ${names.join(', ') || 'none'}` }
  const numbers = files['retention.txt'].match(/\d+/g) ?? []
  if (numbers.length !== 1 || numbers[0] !== '11') return { ok: false, why: `retention.txt should hold just 11; it holds ${JSON.stringify(files['retention.txt'].slice(0, 80))}` }
  return { ok: true, why: 'retention.txt holds 11' }
}
