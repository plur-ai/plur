import { openSync, readSync, fstatSync, statSync, closeSync, writeSync, constants } from 'fs'

/**
 * Signal detection for the Stop-hook memory check (hook-learn-check).
 *
 * The memory check forces one extra model turn. Fired blindly every 3rd
 * response, that turn usually ended in a bare "ok" — noise for the user. It
 * now fires when the user's LAST typed message reads as a correction,
 * preference or decision aimed at how the agent works, plus a rare fallback
 * (every PLUR_LEARN_FALLBACK_INTERVAL-th Stop) for the corrections no keyword
 * catches.
 *
 * The rule of the list: a nudge costs a forced turn every time it fires, a
 * miss costs one memory the fallback may still catch. So a phrase is on the
 * list only if it is rarely anything BUT a correction or a standing rule.
 * Plain task wording stays off it, even when it contains "should", "instead",
 * "stop", "always" or a bare "no" ("It should return 200", "call it from the
 * parser instead", "Stop the dev server", "no" answering a question).
 *
 * Before matching (normaliseForSignal):
 *   - typographic quotes become ASCII (’ → ')
 *   - code fences, quoted lines (`>`), indented code and log-like lines
 *     (`Error: …`, stack frames, timestamps, `[warn]`) are dropped: pasted
 *     text is not the user speaking
 * Then, per sentence, skipping questions (a trailing "ok?" / "right?" tag
 * does not make a rule a question):
 *   - correction: "no, / ne, / nein," followed by an instruction
 *     ("no, use pnpm"); "that's wrong", "not what I asked", "the wrong file",
 *     "wrong port, …", "that's not how we …", "you should have …";
 *     narobe / napačno (sl), falsch / das stimmt nicht (de)
 *   - preference: "I prefer", "I'd rather"; raje (sl); lieber (de)
 *   - standing rule: "from now on", "going forward", "next time",
 *     "remember that", "keep in mind"; od zdaj naprej, zapomni si (sl);
 *     ab jetzt, merk dir, künftig (de)
 *   - a sentence that starts with don't / do not / never / always (sl:
 *     nikoli / vedno, de: nie / immer), unless it is scoped to the task at
 *     hand ("Always run the tests before you push this branch")
 *   - "you shouldn't …", "you must not …"
 *   - "use X, not Y" / "use X not Y" / "use X instead of Y"
 *   - a decision-board answer: a "*.decisions.json" path, or "apply decisions"
 */

const QUOTES: Array<[RegExp, string]> = [[/[‘’ʼ′]/g, "'"], [/[“”„]/g, '"']]

// A line that is pasted output, not prose: log levels, error lines, stack
// frames, timestamps, shell prompts, diff/code markers.
const PASTED_LINE = new RegExp([
  /^\s*>/.source, // quoted
  /^(\t| {4,})/.source, // indented code
  /^\s*(at\s|\$\s|#|\/\/|\+\+\+|---|@@)/.source,
  /^\s*\[?\d{4}-\d{2}-\d{2}/.source, // timestamp
  /^\s*\[?(error|err|warn|warning|info|debug|trace|fatal|panic)\b[\]:]?/.source,
  /^\s*[\w.$]*(error|exception)\b[^:\n]{0,40}:/.source, // "Error: …", "TypeError: …"
].join('|'), 'i')

/** The user's own words: smart quotes normalised, pasted code and logs removed. */
export function normaliseForSignal(text: string): string {
  let t = text.slice(0, 4000) // a long paste is not a correction; bound the work
  for (const [re, to] of QUOTES) t = t.replace(re, to)
  t = t.replace(/```[\s\S]*?(```|$)/g, '\n') // fenced blocks, closed or not
  t = t.replace(/`([^`\n]*)`/g, '$1') // inline code keeps its words
  return t.split('\n').filter((line) => !PASTED_LINE.test(line)).join('\n')
}

// "no, <instruction>" — a bare "no", "No — go ahead", "no, not yet" are
// answers, not corrections.
const NO_THEN_INSTRUCTION = new RegExp(
  '^\\s*(no|nope|nah|ne|nein)\\s*[,.!:;\\u2013\\u2014-]+\\s*(please\\s+|just\\s+|bitte\\s+|prosim\\s+)?' +
  '(use|put|keep|do|don\'?t|never|always|revert|undo|change|move|rename|call|make|leave|switch|remove|delete|drop|' +
  'add|write|go back|try|stop|that\'?s (wrong|not)|it\'?s (wrong|not)|wrong|not (that|this|like|what|there|here)|' +
  'uporabi|naredi|daj|pusti|spremeni|odstrani|zamenjaj|vrni|ne |nikoli|vedno|to ni|' +
  'nimm|benutze|verwende|mach|lass|nicht|nie|immer|das ist (falsch|nicht))\\b',
  'i',
)

const SIGNALS: RegExp[] = [
  // correction
  /\b(that|this|it)('s| is| was) (wrong|incorrect|not (right|correct|it|what i))\b/i,
  /\bnot what i (asked|meant|wanted|said|want)\b/i,
  /\bthe wrong (\w+)\b/i,
  /^wrong \w+/i,
  /\bthat's not how (we|i|it|you)\b/i,
  /\byou('re| are) wrong\b/i,
  /\byou should(n't| not)? have\b/i,
  /\b(narobe|napačno|napacno)\b/i,
  /\bto ni (prav|pravilno|res)\b/i,
  /\b(falsch|das stimmt nicht)\b/i,
  // preference
  /\bi('d| would)? (prefer|rather)\b/i,
  /^prefer\b/i,
  /\b(raje|lieber)\b/i,
  /\bich (bevorzuge|möchte lieber)\b/i,
  // standing rule
  /\b(from now on|going forward|from here on|next time|in future)\b/i,
  /\b(remember|keep in mind) (that|this|to)\b/i,
  /\bod (zdaj|sedaj) (naprej|dalje)\b/i,
  /\b(zapomni si|v prihodnje)\b/i,
  /\b(ab (jetzt|sofort)|merk dir|in zukunft|künftig)\b/i,
  // prohibition aimed at the agent
  /\byou (shouldn't|should not|must not|mustn't)\b/i,
  // "use X, not Y"
  /\buse \S+( \S+)?,? (not|instead of|rather than) \S/i,
]

// A rule-shaped sentence start. Scoped to this task ("…this branch", "for
// now") it is an instruction, not a standing rule.
const RULE_START = /^(please\s+|bitte\s+|prosim\s+)?(don't(?! (worry|bother|mind))|do not|never(?! mind)|always|nikoli|vedno|nie|immer)\b/i
const TASK_SCOPED = /\b(this|that) (branch|pr|commit|file|time|one|run)\b|\b(right now|for now|today|yet)\b/i

// "Don't use npm, ok?" is a rule with a tag, not a question.
const TAG_QUESTION = /,?\s*(ok|okay|right|alright|got it|understood|yes|ja|prav|v redu|gut|klar)\s*\?+\s*$/i

const DECISIONS = [/\.decisions\.json\b/i, /\bapply (the |these |my )?decisions\b/i]

export function hasLearnSignal(text: string): boolean {
  if (!text || !text.trim()) return false
  const t = normaliseForSignal(text)
  if (NO_THEN_INSTRUCTION.test(t)) return true
  // A decisions path is matched on the whole message (its dots would split a
  // sentence); a message asking about the file is not an answer.
  if (DECISIONS.some((re) => re.test(t)) && !t.trim().endsWith('?')) return true
  // Sentences keep their terminator so a question can be told apart.
  const sentences = t.match(/[^.!?\n;]+[.!?;]*/g) ?? []
  for (const raw of sentences) {
    let s = raw.trim().replace(/^[-–—*\s]+/, '')
    if (!s) continue
    s = s.replace(TAG_QUESTION, '.')
    if (s.endsWith('?')) continue
    if (SIGNALS.some((re) => re.test(s))) return true
    if (RULE_START.test(s) && !TASK_SCOPED.test(s)) return true
  }
  return false
}

/** How much of the transcript tail is read. A Stop hook runs on every response. */
export const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024

export interface UserMessage {
  id: string
  text: string
  /** The agent already called plur_learn after this message (in that reply). */
  learned: boolean
}

// User lines Claude Code writes that the human did not type: slash-command and
// shell echoes, local-command output, task notifications, reminders.
const ECHO_TAG = /^\s*<(command-name|command-message|command-args|local-command-[a-z-]+|bash-[a-z-]+|task-notification|system-reminder|user-prompt-submit-hook)>/
// Auto-compaction summary on builds that do not set isCompactSummary.
const COMPACTION_PREFIX = /^\s*This session is being continued from a previous conversation/

type Block = { type?: unknown; text?: unknown; name?: unknown; input?: unknown }

function textOf(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const blocks = content as Block[]
  // A line carrying a tool result is tool output; text beside it was not typed.
  if (blocks.some((b) => b && b.type === 'tool_result')) return null
  const parts = blocks
    .filter((b) => !!b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
  return parts.length ? parts.join('\n') : null
}

function callsPlurLearn(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  return (content as Block[]).some((b) => {
    if (!b || b.type !== 'tool_use' || typeof b.name !== 'string') return false
    if (/plur_learn/.test(b.name)) return true
    const action = (b.input as { action?: unknown } | undefined)?.action
    return /plur_admin$/.test(b.name) && typeof action === 'string' && /learn/.test(action)
  })
}

function readTail(path: string): string | null {
  // A FIFO, socket or device would block the open or the read: regular files only.
  const st = statSync(path)
  if (!st.isFile()) return null
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
  try {
    const fst = fstatSync(fd)
    if (!fst.isFile()) return null // swapped between stat and open
    const size = fst.size
    const len = Math.min(size, TRANSCRIPT_TAIL_BYTES)
    if (len <= 0) return null
    const buf = Buffer.alloc(len)
    const n = readSync(fd, buf, 0, len, size - len)
    return buf.subarray(0, n).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/**
 * The last message the human typed, from a Claude Code transcript (JSONL; the
 * Stop payload's `transcript_path`), and whether the agent called plur_learn
 * after it. The transcript format is internal to Claude Code; the fields used
 * here were checked against real transcripts (2026-10-02):
 *   - skipped: isMeta, isSidechain, tool results (toolUseResult,
 *     sourceToolAssistantUUID, tool_result blocks), origin.kind other than
 *     "human", promptSource "system", and echo lines (<command-name>,
 *     <local-command-stdout>, <bash-…>, <task-notification>, …)
 *   - a compaction summary (isCompactSummary, or its text prefix on older
 *     builds) or a compact_boundary line ends the search: what precedes it
 *     is history, not the last message.
 * Reads at most the trailing TRANSCRIPT_TAIL_BYTES of a regular file;
 * anything unreadable or unparseable is null, never an error.
 */
export function lastUserMessage(transcriptPath: unknown): UserMessage | null {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null
  let raw: string | null
  try {
    raw = readTail(transcriptPath)
  } catch {
    return null
  }
  if (!raw) return null
  const lines = raw.split('\n')
  let learned = false
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line) continue
    let d: Record<string, unknown>
    try { d = JSON.parse(line) } catch { continue } // torn first line, garbage
    if (!d || typeof d !== 'object') continue
    if (d.type === 'system' && d.subtype === 'compact_boundary') return null
    const message = d.message as { content?: unknown } | undefined
    if (d.type === 'assistant') {
      if (callsPlurLearn(message?.content)) learned = true
      continue
    }
    if (d.type !== 'user') continue
    if (d.isCompactSummary === true) return null
    if (d.isMeta === true || d.isSidechain === true || d.isVisibleInTranscriptOnly === true) continue
    if (d.toolUseResult !== undefined || d.sourceToolAssistantUUID !== undefined) continue
    const origin = d.origin as { kind?: unknown } | undefined
    if (origin && typeof origin === 'object' && origin.kind !== 'human') continue
    if (d.promptSource === 'system') continue
    const text = textOf(message?.content)
    if (text === null) continue
    if (COMPACTION_PREFIX.test(text)) return null
    if (ECHO_TAG.test(text)) continue
    const id = typeof d.uuid === 'string' && d.uuid ? d.uuid : `len:${text.length}:${text.slice(0, 64)}`
    return { id, text, learned }
  }
  return null
}

/**
 * Claim the one nudge a message gets: create `markerPath` exclusively, never
 * following a symlink. true = this Stop owns the nudge. false = it was
 * already claimed (by an earlier or a racing Stop), or the marker cannot be
 * written — and an unwritable marker means "do not nudge", so a broken state
 * dir can never turn into a nudge on every Stop.
 */
export function claimNudge(markerPath: string, content = ''): boolean {
  let fd: number | null = null
  try {
    fd = openSync(markerPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    if (content) writeSync(fd, content)
    return true
  } catch {
    return false
  } finally {
    if (fd !== null) try { closeSync(fd) } catch { /* already claimed; close is best-effort */ }
  }
}

/**
 * Every Nth Stop without a signal still gets a check. 0 turns the fallback off.
 * Default 10: the signal list is now deliberately narrow, so the fallback is
 * the only check for keyword-free corrections — every 10th response keeps
 * forced turns at a third of the old every-3rd cadence while still checking a
 * typical working session several times. It also lands on the same Stop as
 * the checkpoint (PLUR_CHECKPOINT_INTERVAL, default 10).
 */
export function learnFallbackInterval(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PLUR_LEARN_FALLBACK_INTERVAL
  if (raw === undefined || raw === '') return 10
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : 10
}
