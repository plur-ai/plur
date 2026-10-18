// Graders for the agent-behaviour promises (BEH-1, BEH-2, BEH-3).
//
// Pure functions over a parsed transcript, the files a run left behind and the
// memories found by REOPENING the store after the run. No I/O and no model, so
// evals/helpers/agent-behaviour-graders.unit.test.ts proves each one on
// synthetic transcripts (run it with
// `pnpm exec vitest run --config evals/vitest.diagnostics.config.ts`).
//
// Why they are strict.
//  * Audit B-02 (2026-10-17): the first graders matched a word anywhere —
//    "Never Tuesday; deploy Friday" passed, a FAILED learn of the opposite rule
//    passed, any *.cfg file passed.
//  * Audit R-01 (2026-10-18): the negation-aware replacement still looked only
//    BEFORE a term ("Tuesday is forbidden" passed), took a calendar remark
//    ("Today is Sunday") for a second deploy day, accepted any lookup reply
//    containing the first 60 characters of the memory (an error that echoed
//    the query, a truncated statement), "Not 11. Unknown." as the number 11,
//    and the requested line followed by a conflicting assignment.
// So, now:
//  * BEH-1 grades a CONSTRAINED ANSWER: the prompt asks for a final line
//    `ANSWER: <weekday or UNKNOWN>` and only that line is graded, exactly. No
//    prose heuristics decide the deploy day; a missing line fails.
//  * A lookup counts only when its payload parses as JSON, is not an error /
//    `success: false` / memory-off reply, and a RETURNED MEMORY (a `statement`
//    with an id, or an `[ID] statement` line of an injection) contains the
//    COMPLETE expected statement. Echoed queries and truncated text never count.
//  * A save counts only when a learn call SUCCEEDED, its statement means the
//    right thing (negation before OR after the term, in the same clause, counts),
//    and a memory meaning it is on disk when the store is reopened.
//  * Output files are parsed: exactly one `smtp_host` assignment with the value
//    `localhost` and nothing else; retention.txt is exactly `11`.
import type { AgentRun, ToolCall } from './agent-behaviour-harness.js'

// ── meaning with negation (used for SAVED statements) ───────────────────────

/** Words that negate or prohibit a term in the same clause, before OR after it. */
const NEGATORS = /\b(never|not|no|don'?t|do not|does not|doesn'?t|cannot|can'?t|won'?t|isn'?t|aren'?t|avoid|avoiding|instead of|rather than|except|without|forbidden|disallowed|prohibited|banned|wrong|incorrect|deprecated|invalid)\b/i
/** How many words before a rival a negator is taken to belong to that rival ("never .conf"). */
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

const withG = (re: RegExp) => new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')

/**
 * Remove "<negator> … <rival>" spans where the negator is within
 * NEGATION_WINDOW words before the rival: in "use .cfg and never .conf" the
 * "never" belongs to .conf, so it must not count against .cfg.
 */
function stripBoundNegations(text: string, rival: RegExp): string {
  const matches = [...text.matchAll(withG(rival))].reverse()
  let t = text
  for (const m of matches) {
    const at = m.index ?? 0
    const prefix = t.slice(0, at)
    const words = [...prefix.matchAll(/\S+/g)]
    const windowStart = words.length > NEGATION_WINDOW ? (words[words.length - NEGATION_WINDOW].index ?? 0) : 0
    const negs = [...prefix.matchAll(withG(NEGATORS))].filter(n => (n.index ?? 0) >= windowStart)
    if (negs.length === 0) continue
    const from = negs[negs.length - 1].index ?? 0
    t = t.slice(0, from) + ' ' + t.slice(at + m[0].length)
  }
  return t
}

export interface Stance { affirmed: number; negated: number }

/**
 * How `text` speaks about `term`: a mention is NEGATED when its clause holds a
 * negator anywhere — before or after the term ("Tuesday is forbidden") — or
 * continues a negated list; negators bound to one of `rivals` ("…, never
 * .conf") are removed first. Otherwise it is AFFIRMED.
 */
export function stance(text: string, term: RegExp, rivals: RegExp[] = []): Stance {
  const out: Stance = { affirmed: 0, negated: 0 }
  for (const clause of clauses(text)) {
    let t = clause.text
    for (const r of rivals) t = stripBoundNegations(t, r)
    for (const _ of t.matchAll(withG(term))) {
      if (clause.carried || NEGATORS.test(t)) out.negated++
      else out.affirmed++
    }
  }
  return out
}

/** True when `text` affirms `want`, never negates it, and affirms none of `rivals`. */
export function saysOnly(text: string, want: RegExp, rivals: RegExp[] = []): { ok: boolean; why: string } {
  const w = stance(text, want, rivals)
  if (w.affirmed === 0) return { ok: false, why: `does not affirm ${want.source}` }
  if (w.negated > 0) return { ok: false, why: `negates ${want.source} at least once` }
  for (const r of rivals) {
    const s = stance(text, r, [want])
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
 * The JSON payload of a SUCCESSFUL plur tool reply, or why it is not one. The
 * server always answers with a JSON object (packages/mcp/src/server.ts); a
 * protocol error, a non-JSON body, PLUR's "memory is off here" answer, a
 * `success: false` reply or a top-level `error` is not a success.
 */
export function successfulPayload(c: ToolCall): { ok: true; payload: Record<string, unknown> } | { ok: false; why: string } {
  if (c.isError === true) return { ok: false, why: 'protocol error' }
  let payload: unknown
  try { payload = JSON.parse(c.result) } catch { return { ok: false, why: `not a JSON payload: ${JSON.stringify(c.result.slice(0, 80))}` } }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, why: 'payload is not an object' }
  const p = payload as Record<string, unknown>
  if (p.plur === 'off') return { ok: false, why: 'memory is off here' }
  if (p.success === false) return { ok: false, why: 'success: false' }
  if ('error' in p && p.error) return { ok: false, why: `error: ${JSON.stringify(p.error).slice(0, 80)}` }
  return { ok: true, payload: p }
}

/** Did this (learn) call succeed? A successful payload, no error anywhere in it, and it names an id. */
export function callSucceeded(c: ToolCall): boolean {
  if (!successfulPayload(c).ok) return false
  if (/"success"\s*:\s*false/.test(c.result)) return false
  if (/"error"\s*:/.test(c.result)) return false
  return /\bENG-[A-Za-z0-9-]+/.test(c.result)
}

/** Keys whose values are never returned memories: what the caller sent, and the server's commentary. */
const NOT_MEMORY_KEYS = new Set(['query', 'task', 'input', 'args', 'error', 'message', 'warning', 'warnings', 'guide', 'why', 'hint'])
/** Keys whose string values are injection blocks: one `[ID] statement` line per memory. */
const BLOCK_KEYS = new Set(['text', 'directives', 'constraints', 'consider'])
const BLOCK_LINE = /^\s*\[([^\]\s]+)\]\s+(.+)$/

/**
 * The memories a successful lookup payload RETURNED: every `statement` of an
 * object that carries an id (plur_recall results), and every `[ID] statement`
 * line of an injection block (plur_session_start / plur_inject). Never the
 * echoed query or a message.
 */
export function returnedMemories(payload: unknown): string[] {
  const out: string[] = []
  const walk = (node: unknown, key: string): void => {
    if (NOT_MEMORY_KEYS.has(key)) return
    if (Array.isArray(node)) { for (const n of node) walk(n, key); return }
    if (node && typeof node === 'object') {
      const o = node as Record<string, unknown>
      // A failed record nested in the reply is not a returned memory (fourth audit A4-04).
      if (o.success === false || ('error' in o && o.error)) return
      if (typeof o.statement === 'string' && typeof o.id === 'string' && o.id) out.push(o.statement)
      for (const [k, v] of Object.entries(o)) if (k !== 'statement') walk(v, k)
      return
    }
    if (typeof node === 'string' && BLOCK_KEYS.has(key)) {
      for (const line of node.split('\n')) {
        const m = BLOCK_LINE.exec(line)
        if (m) out.push(m[2])
      }
    }
  }
  walk(payload, '')
  return out
}

const normText = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

/** A successful lookup that returned a memory containing the COMPLETE `statement`. */
export function lookupReturned(c: ToolCall, statement: string): { ok: boolean; why: string } {
  const p = successfulPayload(c)
  if (!p.ok) return { ok: false, why: `${c.name}: ${p.why}` }
  const memories = returnedMemories(p.payload)
  const want = normText(statement)
  if (memories.some(m => normText(m).includes(want))) return { ok: true, why: `${c.name} returned it` }
  return { ok: false, why: `${c.name} returned ${memories.length} memor${memories.length === 1 ? 'y' : 'ies'}, none holding the complete statement` }
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
 * succeeded and returned a memory holding the COMPLETE stored statement.
 */
export function gradeRetrieved(run: AgentRun, stored: string): Verdict {
  const lookups = plurCalls(run).filter(c => RECALL_TOOLS.has(c.name))
  if (lookups.length === 0) return { ok: false, why: `no PLUR lookup in the next session; tools: ${run.toolCalls.map(c => c.name).join(', ') || 'none'}` }
  const verdicts = lookups.map(c => lookupReturned(c, stored))
  const hit = verdicts.find(v => v.ok)
  if (!hit) return { ok: false, why: `PLUR was asked but no successful reply returned the saved memory ${JSON.stringify(stored.slice(0, 80))} in full (${verdicts.map(v => v.why).join('; ')})` }
  return { ok: true, why: `retrieved the saved memory: ${hit.why}` }
}

// ── BEH-1: answers from memory ──────────────────────────────────────────────

export const WEEKDAYS: Record<string, RegExp> = {
  monday: /\bmondays?\b/i, tuesday: /\btuesdays?\b/i, wednesday: /\bwednesdays?\b/i, thursday: /\bthursdays?\b/i,
  friday: /\bfridays?\b/i, saturday: /\bsaturdays?\b/i, sunday: /\bsundays?\b/i,
}

/** The sentence BEH-1's prompt ends with: the answer contract. */
export const ANSWER_CONTRACT = 'End your reply with one final line of exactly the form `ANSWER: <weekday>` naming that day, or `ANSWER: UNKNOWN` if you cannot tell.'

const ANSWER_PREFIX = /^[*_`>\s]*ANSWER\s*:/i

/**
 * The value of the reply's contract line: exactly one `ANSWER: …` line, and it
 * is the last non-empty line; its value is a single weekday (singular or
 * plural, any case, markdown emphasis ignored) or UNKNOWN. Anything else —
 * missing, repeated, not last, "Tuesday or Wednesday", "never Tuesday" — is
 * not an answer.
 */
export function finalAnswer(text: string): { ok: true; value: string } | { ok: false; why: string } {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const answers = lines.filter(l => ANSWER_PREFIX.test(l))
  if (answers.length === 0) return { ok: false, why: 'no `ANSWER:` line' }
  if (answers.length > 1) return { ok: false, why: `${answers.length} \`ANSWER:\` lines` }
  if (!ANSWER_PREFIX.test(lines[lines.length - 1])) return { ok: false, why: 'the `ANSWER:` line is not the final line' }
  const raw = answers[0].replace(ANSWER_PREFIX, '').replace(/[*_`]/g, '').trim().replace(/\.$/, '').trim()
  if (/^unknown$/i.test(raw)) return { ok: true, value: 'unknown' }
  const m = /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?$/i.exec(raw)
  if (!m) return { ok: false, why: `the answer line is not a single weekday or UNKNOWN: ${JSON.stringify(raw.slice(0, 60))}` }
  return { ok: true, value: m[1].toLowerCase() }
}

/**
 * BEH-1 memory arm: the agent looked in PLUR, a lookup that succeeded returned
 * the COMPLETE seeded fact, and the contract line answers exactly `day`.
 */
export function gradeAnswerFromMemory(run: AgentRun, day: keyof typeof WEEKDAYS, fact: string): Verdict {
  if (run.timedOut) return { ok: false, why: 'the session timed out' }
  const lookups = plurCalls(run).filter(c => RECALL_TOOLS.has(c.name))
  if (lookups.length === 0) {
    return { ok: false, why: `expected a PLUR recall or session_start call before answering; saw tools: ${run.toolCalls.map(c => c.name).join(', ') || 'none'}` }
  }
  const verdicts = lookups.map(c => lookupReturned(c, fact))
  if (!verdicts.some(v => v.ok)) return { ok: false, why: `PLUR was asked but no successful reply returned the seeded fact in full (${verdicts.map(v => v.why).join('; ')})` }
  const a = finalAnswer(run.text)
  if (!a.ok) return { ok: false, why: `no valid answer line (${a.why}): ${JSON.stringify(run.text.slice(-200))}` }
  if (a.value !== day) return { ok: false, why: `answered ${a.value.toUpperCase()}, expected ${day.toUpperCase()}` }
  return { ok: true, why: `recalled via ${lookups.map(c => c.name).join(', ')} and answered ${day}` }
}

/**
 * BEH-1 control arm (no PLUR): passes unless the agent CLAIMS `day` as the
 * deploy day. Refusals and uncertainty pass even when they name weekdays as
 * calendar context ("Today is Sunday"). The contract line decides; when it is
 * missing or malformed, any mention of `day` fails — a claim and a hedge
 * cannot then be told apart, and failing the control is the safe direction
 * (it makes the promise red, never green).
 */
export function gradeControlAnswer(run: AgentRun, day: keyof typeof WEEKDAYS): Verdict {
  if (run.timedOut || !run.text.trim()) return { ok: false, why: 'the control session did not produce an answer, so it proves nothing' }
  const a = finalAnswer(run.text)
  if (a.ok) {
    if (a.value === day) return { ok: false, why: `without PLUR the agent still answered ${day} — the fact is guessable, so the memory arm proves nothing` }
    return { ok: true, why: `without PLUR the agent answered ${a.value.toUpperCase()}` }
  }
  if (WEEKDAYS[day].test(run.text)) return { ok: false, why: `no valid answer line (${a.why}) and the reply mentions ${day}: cannot tell a guess from a hedge: ${JSON.stringify(run.text.slice(0, 200))}` }
  return { ok: true, why: `no answer line (${a.why}), and the reply never mentions ${day}` }
}

// ── BEH-2: a correction sticks ──────────────────────────────────────────────

const CFG = /\.cfg\b/i
const CONF = /\.conf\b/i

/**
 * The corrected rule: config files use .cfg (affirmed, never negated or
 * prohibited anywhere in its clause), and .conf appears only negated.
 */
const CONFIG_SUBJECT = /\bconfig(?:uration)?s?\b/i
/** Other formats a config-file rule could name instead of .cfg. */
const OTHER_FORMAT = /\.(?!cfg\b|conf\b)[a-z]{2,5}\b|\b(toml|yaml|yml|json|ini|xml)\b/i
/** Sentences: a period before a space or the end, a semicolon or a line break (not a colon or a dash). */
const sentences = (text: string) => text.split(/(?<=\.)\s+|[;\n]+/).map(t => t.trim()).filter(Boolean)

export function saysCfgNotConf(statement: string): Verdict {
  const v = saysOnly(statement, CFG, [CONF])
  if (!v.ok) return v
  // The .cfg must be affirmed in a sentence ABOUT config files, and no sentence about
  // config files may name another format (fourth audit A4-04: ".cfg" as context, the
  // rule saying TOML).
  const about = sentences(statement).filter(t => CONFIG_SUBJECT.test(t))
  if (!about.some(t => stance(t, CFG, [CONF]).affirmed > 0)) return { ok: false, why: '.cfg is not affirmed in a sentence about config files' }
  const rival = about.find(t => OTHER_FORMAT.test(affirmedPart(t)))
  if (rival) return { ok: false, why: `a sentence about config files names another format: ${JSON.stringify(rival.slice(0, 80))}` }
  return v
}

/**
 * What `t` affirms about other formats: "instead of .yaml" and "never .toml"
 * bound to a format are removed, then every negated clause that does not carry
 * the .cfg rule itself ("not .yaml" names no rival).
 */
function affirmedPart(t: string): string {
  const unbound = stripBoundNegations(t, OTHER_FORMAT)
  const negated = (c: { text: string; carried: boolean }) => c.carried || (NEGATORS.test(c.text) && !CFG.test(c.text))
  return clauses(unbound).filter(c => !negated(c)).map(c => c.text).join(', ')
}

const ASSIGNMENT = /^([A-Za-z0-9_.-]+)\s*[=:]\s*(.*)$/

/**
 * BEH-2 session 2: exactly the requested file (`expected`, e.g. mailer.cfg),
 * no file with the wrong extension, no other variant, and its content is the
 * single requested assignment — `key` assigned once, to exactly `value`, and
 * nothing else besides comments and blank lines.
 */
export function gradeRequestedFile(files: Record<string, string>, expected: string, key: string, value: string, wrong: RegExp): Verdict {
  const names = Object.keys(files).filter(f => f !== 'CLAUDE.md')
  const bad = names.filter(f => wrong.test(f))
  if (bad.length) return { ok: false, why: `the mistake came back: ${bad.join(', ')}` }
  if (!(expected in files)) return { ok: false, why: `expected the requested file ${expected}; files were: ${names.join(', ') || 'none'}` }
  const base = expected.replace(/\.[^.]+$/, '')
  const variants = names.filter(f => f !== expected && f.replace(/\.[^.]+$/, '') === base)
  if (variants.length) return { ok: false, why: `besides ${expected} the run also wrote ${variants.join(', ')}` }
  const body = files[expected]
  const lines = body.split(/\r?\n/).map(l => l.trim()).filter(l => l && !/^[#;]/.test(l))
  const assignments = lines.map(l => ASSIGNMENT.exec(l)).filter((m): m is RegExpExecArray => !!m && m[1] === key)
  if (assignments.length !== 1) return { ok: false, why: `${expected} assigns ${key} ${assignments.length} times: ${JSON.stringify(body.slice(0, 160))}` }
  if (lines.length !== 1) return { ok: false, why: `${expected} should hold the single line \`${key} = ${value}\`; it holds ${lines.length} setting lines: ${JSON.stringify(body.slice(0, 160))}` }
  if (assignments[0][2].trim() !== value) return { ok: false, why: `${expected} sets ${key} to ${JSON.stringify(assignments[0][2].trim())}, expected ${JSON.stringify(value)}` }
  return { ok: true, why: `wrote ${expected} with ${key} = ${value} and nothing else` }
}

// ── BEH-3: an explicit save is used next session ────────────────────────────

/** The saved fact: Larkspur keeps logs for 11 days (Larkspur named, the number affirmed, no other day count). */
const ELEVEN = /\b(11|eleven)\s*(?:-\s*)?days?\b/i
const SPELLED = '(?:one|two|three|four|five|six|seven|eight|nine|ten|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)'

export function saysElevenDays(statement: string): Verdict {
  if (!/\blarkspur\b/i.test(statement)) return { ok: false, why: 'does not name Larkspur' }
  if (!/\b(log|logs)\b/i.test(statement)) return { ok: false, why: 'does not mention logs' }
  const other = [...statement.matchAll(/\b(\d+)\s*(?:-\s*)?days?\b/gi)].map(m => m[1]).filter(n => n !== '11')
  const spelled = [...statement.matchAll(new RegExp(`\\b(${SPELLED}(?:[\\s-]${SPELLED})*)\\s*(?:-\\s*)?days?\\b`, 'gi'))].map(m => m[1])
  if (other.length || spelled.length) return { ok: false, why: `names another day count (${[...other, ...spelled].join(', ')})` }
  // The eleven days must be said of Larkspur's logs, in the same sentence (fourth audit A4-04).
  const where = sentences(statement).filter(t => ELEVEN.test(t))
  if (!where.some(t => /\blarkspur\b/i.test(t) && /\b(log|logs)\b/i.test(t))) return { ok: false, why: 'the eleven days are not said of Larkspur\'s logs in one sentence' }
  return saysOnly(statement, ELEVEN)
}

/** BEH-3 session 2: retention.txt holds exactly the number 11 (surrounding whitespace aside). */
export function gradeRetentionFile(files: Record<string, string>): Verdict {
  const names = Object.keys(files).filter(f => f !== 'CLAUDE.md')
  if (!('retention.txt' in files)) return { ok: false, why: `expected retention.txt; files were: ${names.join(', ') || 'none'}` }
  if (files['retention.txt'].trim() !== '11') return { ok: false, why: `retention.txt should hold exactly 11; it holds ${JSON.stringify(files['retention.txt'].slice(0, 80))}` }
  return { ok: true, why: 'retention.txt holds exactly 11' }
}
