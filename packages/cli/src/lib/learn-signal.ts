import { openSync, readSync, fstatSync, statSync, closeSync, writeSync, constants } from 'fs'

/**
 * Signal detection for the Stop-hook memory check (hook-learn-check).
 *
 * The memory check forces one extra model turn. Fired blindly every 3rd
 * response, that turn usually ended in a bare "ok" — noise for the user. It
 * now fires when the user's LAST typed message reads as a correction,
 * preference or standing rule aimed at how the agent works, or a
 * decision-board answer, plus a fallback (every PLUR_LEARN_FALLBACK_INTERVAL-th
 * Stop) for the corrections no phrase here catches.
 *
 * The rule of the list: a nudge costs a forced turn every time it fires, a
 * miss costs one memory the fallback may still catch. So a phrase is on the
 * list only if it is rarely anything BUT a correction or a rule addressed at
 * the agent. A word is not enough: "narobe", "falsch", "the wrong X",
 * "lieber", "vedno" and "immer" are everyday words in bug reports and
 * narrative ("Nekaj je narobe s prijavo", "returns the wrong status code",
 * "Lieber Gregor,", "Immer wenn ich …"). Each fires only in the shape that
 * addresses the agent ("to je narobe", "you used the wrong flag", "lieber
 * nimm …", "vedno uporabi …", "immer pnpm verwenden").
 *
 * Measured on test/fixtures/learn-signal-corpus.ts (en/sl/de, weighted to
 * hard cases); test/learn-signal-corpus.test.ts holds precision >= 85% and
 * recall >= 71%.
 *
 * Before matching (normaliseForSignal): typographic quotes become ASCII;
 * code fences, <pasted-content> and echo blocks, `>` quoted lines, quoted
 * "…" spans, indented code, diff lines and log-like lines (`Error: …`, stack
 * frames, timestamps, `[warn]`) are dropped — pasted text is not the user
 * speaking. Then the text is bounded to its last 4,000 characters, where the
 * typed part usually is. Questions are skipped (a trailing "ok?" tag does
 * not make a rule a question).
 */

// Matching is diacritic-insensitive: Slovenian is often typed without
// č/š/ž ("napacno" = "napačno"), so text and patterns are both folded to
// their base letters. That also keeps plain ASCII `\b` and `\w` correct for
// sl/de words, which is far cheaper than Unicode-aware boundaries: those
// cost ~0.5 s per message, on a hook that runs on every Stop.
export function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '')
}
function re(src: string): RegExp {
  return new RegExp(fold(src), 'i')
}

const QUOTES: Array<[RegExp, string]> = [[/[‘’ʼ′]/g, "'"], [/[“”„]/g, '"']]

// A line that is pasted output, not prose. Markdown headings and sentences
// that start with "At …" are prose; only stack-frame-shaped "at" lines go.
const PASTED_LINE = new RegExp([
  /^\s*>/.source, // quoted
  /^(\t| {4,})/.source, // indented code
  /^\s*(\$\s|\/\/|\+\+\+|---|@@)/.source,
  /^[+-](?![\s+-])/.source, // diff body line ("-always", "+never"); "- item" is a bullet
  /^\s*at\s+\S+\s*(\(|.*:\d+)/.source, // stack frame
  /^\s*\[?\d{4}-\d{2}-\d{2}/.source, // timestamp
  /^\s*\[?(error|err|warn|warning|info|debug|trace|fatal|panic)\b[\]:]?/.source,
  /^\s*[\w.$]*(error|exception)\b[^:\n]{0,40}:/.source, // "Error: …", "TypeError: …"
  /^\s*npm (ERR|WARN)!/.source,
].join('|'), 'i')

// Only a closed block is an echo: a tag the user typed in prose does not
// hide the rest of the message (re-audit H5).
const ECHO_BLOCK = /<(system-reminder|task-notification|pasted-content|local-command-[a-z-]+|bash-[a-z-]+|command-[a-z-]+)\b[^>]*>[\s\S]*?<\/\1>/g

/** The user's own words: quotes normalised, pasted code, logs and quoted text removed, then bounded to the tail. */
export function normaliseForSignal(text: string): string {
  let t = text.length > 200_000 ? text.slice(-200_000) : text // bound the work on a huge paste
  for (const [r, to] of QUOTES) t = t.replace(r, to)
  t = fold(t)
  t = t.replace(/(```|~~~)[\s\S]*?(\1|$)/g, '\n') // fenced blocks, closed or not
  t = t.replace(ECHO_BLOCK, '\n')
  t = t.replace(/`([^`\n]*)`/g, '$1') // inline code keeps its words
  t = t.split('\n').filter((line) => !PASTED_LINE.test(line)).join('\n')
  t = t.replace(/"[^"\n]{1,400}"/g, ' ') // quoted text is someone else's words
  return t.length > 4000 ? t.slice(-4000) : t // the typed text is usually at the end
}

// "no, <instruction>" at a sentence start. A bare "no", "No — go ahead",
// "No, keep going", "No, do both" are answers, not corrections. "Nope, …"
// and "nah, …" are corrections whatever follows.
const NO_THEN_INSTRUCTION = re(
  String.raw`^(no|ne|nein)\s*[,.!:;–—-]+\s*(please\s+|just\s+|bitte\s+|prosim\s+)?` +
  String.raw`(use|put|revert|undo|change|move|rename|call|switch|remove|delete|drop|don't|never|always|stop|wrong|instead|` +
  String.raw`that's (wrong|not)|it's (wrong|not)|not (that|this|like|there|here)|the other|` +
  String.raw`uporabi|pusti|spremeni|odstrani|zamenjaj|vrni|nikoli|vedno|to ni|to je narobe|tako ne|ni tako|ni tko|tko ne|so nicht|` +
  String.raw`nimm|benutze|verwende|lass|nie|immer|nicht so|das ist falsch)\b`,
)
const NOPE = re(String.raw`^(nope|nah|nee)\b\s*[,.!:;–—-]*\s*\S`)

/**
 * Phrases that carry the signal wherever they sit in a statement. Grouped by
 * intent; each is the SHAPE of the intent (a subject addressing the agent, an
 * imperative, a first-person-plural convention), not a lone keyword.
 */
const SIGNALS: RegExp[] = [
  // ── correction, aimed at what the agent did ──
  re(String.raw`\b(that|this|it)('s| is| was)(n't| not)? (wrong|incorrect)\b`),
  re(String.raw`\b(that|this|it)('s| is| was)(n't| not) (right|correct|it|what i)\b`),
  re(String.raw`\b(that|this|it)('s| is| was) the wrong\b`),
  re(String.raw`\bnot what i (asked|meant|wanted|said|want)\b`),
  re(String.raw`^(wrong|incorrect)\b`),
  re(String.raw`\byou('ve| have)? (\w+ ){0,2}(the )?wrong\b`),
  re(String.raw`\byou keep \w+ing\b`),
  re(String.raw`\byou('re| are)? (misread|misunderstood|forgot|ignored|broke|missed|overcomplicat\w*)\b`),
  re(String.raw`\bagain,? you\b|\byou \w+( \w+)? again\b`),
  re(String.raw`\bi (already )?told you\b`),
  re(String.raw`\b(that|your) (fix|change|commit|edit) broke\b`),
  re(String.raw`^not like that\b`),
  re(String.raw`\bthat's not how (we|i|it|you)\b`),
  re(String.raw`\byou('re| are) wrong\b`),
  re(String.raw`\byou should(n't| not)? have (?!(access|received|got|gotten|been|a|an|the|to|it)\b)\w+`),
  re(String.raw`^(undo|revert) (that|it|this)\b|\brevert it\b`),
  re(String.raw`^stop \w+ing\b`),
  //   sl: "to je narobe", "narobe si (razumel)", "nisi pravilno", "si se zmotil", "spet si", "že tretjič ti rečem"
  re(String.raw`\b(to|tole|tisto|ta) (je|ni) (narobe|napač\w*)\b(?! \w+(no|to)\b)`), // not "to je narobe implementirano v knjižnici"
  re(String.raw`\b(to|tole) ni (prav|pravilno|res|tako)\b`),
  re(String.raw`\b(narobe|napač\w*) si(?! je\b)\b|\bsi (\w+ )?narobe\b`),
  re(String.raw`\bnisi (pravilno|prav|dobro)\b|\bsi se zmotil\w*\b`),
  re(String.raw`\bspet si\b|\b(že|spet) (\w+ )?ti (rečem|pravim)\b`),
  re(String.raw`^ne,? (tako|tko)\b`),
  re(String.raw`\b(nehaj|nehaš|prenehaj)\b`),
  re(String.raw`\b(tega|to|tole) nočem\b|\b(tega|to) nisem (rekel|rekla|hotel|hotela)\b`),
  re(String.raw`\bi (never|didn't|did not) (say|ask)\b|\bi don't want (that|this|you to)\b`),
  re(String.raw`\bdas (will|möchte) ich nicht\b|\bich mag es nicht\b|\bdas habe ich nicht (gesagt|gemeint)\b`),
  //   de: "das ist falsch", "du hast … falsch", "falsch verstanden", "nicht gemeint", "du hast schon wieder"
  re(String.raw`\b(das|es|dies) (ist|war) (falsch|nicht richtig|nicht korrekt)\b`),
  re(String.raw`\b(das|es) war (der|die|das) falsche\b|\b(das|es) war nicht (so )?gemeint\b`),
  re(String.raw`\bdas stimmt nicht\b|\bfalsch verstanden\b|\bnicht (so )?gemeint\b`),
  re(String.raw`\bdu hast (\w+ ){0,3}falsch\w*\b|\bdu hast schon wieder\b`),
  re(String.raw`^falsche[rnsm]? \w+`),
  re(String.raw`\blass das( sein)?[.!]*$`),
  // ── preference ──
  re(String.raw`\bi('d| would)? (prefer|rather)\b|^prefer\b`),
  re(String.raw`\braje (uporabi|uporabljaj|piši|napiši|delaj|naredi|daj|dodaj|pusti|vprašaj|bi|imam)\b|\bmi je ljubše\b|\bpreferiram\b|\bmi ni všeč\b`),
  re(String.raw`\bich (bevorzuge|hätte lieber|möchte lieber|mag lieber|will lieber)\b|\blieber (nimm|benutze|verwende|mach|schreib|frag|nutze)\b`),
  // ── standing rule ──
  re(String.raw`\b(from now on|going forward|from here on|in future|in the future)\b|(^|,\s*)next time\b`),
  re(String.raw`\b(remember|keep in mind) (that|this|to)\b|\bremember:`),
  re(String.raw`\bwe (always|never|don't|do not) (?!\w+ed\b)\w+|\bour convention\b|\bmake sure (you )?(always|never)\b`),
  re(String.raw`\bod (zdaj|zdej|sedaj) (naprej|dalje)\b|\b(zapomni si|v prihodnje)\b`),
  re(String.raw`\b(ever|never) again\b|\bnie wieder\b|\bnikoli več\b|\bkeine \w+ mehr\b`),
  //   ask before acting
  re(String.raw`\b(me )?vprašaj (prej|najprej)\b|\bme vprašaj\b|\bfrag (vorher|zuerst)\b|\bask (me )?(first|before)\b`),
  re(String.raw`\b(ab (jetzt|sofort)|merk dir|in zukunft|künftig)\b`),
  //   team conventions in the first person plural: "pri nas … pišemo", "v tem repoju uporabljamo", "bei uns gilt"
  re(String.raw`\b(pri nas|v (tem|našem) (repo\w*|projekt\w*))\b.*\b(\w{3,}mo|vedno|nikoli)\b|\b\w{3,}mo\b.*\bpri nas\b|\btako (delamo|pišemo|imamo)\b`),
  re(String.raw`\bbei uns( \w+){0,2} (gilt|\w+en)\b|\bgilt bei uns\b|\bkonvention\b|\bso arbeiten wir\b`),
  re(String.raw`\b(dogovor\w*|velja dogovor|tako (je|ima) \w* ?dogovorjeno)\b|\bpri nas velja\b|\bthe convention (here )?is\b|\bteam (rule|convention)\b`),
  // ── prohibition aimed at the agent ──
  re(String.raw`\byou (shouldn't|should not|must not|mustn't)\b|\bne smeš\b`),
  re(String.raw`\bkeine \w+(-\w+)*,? bitte\b|^keine \w+.*\bbitte\b`),
  // "use X, not Y"
  re(String.raw`\buse \S+( \S+)?,? (not|rather than) \S`),
  //   "X, not Y" at the end of a statement: "…, ne ameriško", "…, nicht Word"
  re(String.raw`, (not|ne|nicht) (v |na |in )?(?!(yet|now|sure|really|bad|vem|dela|gre|bo|more|še|mehr|schlecht)\b)\w+[.!]*$`),
  // ── decisions and decision-board answers in free text ──
  re(String.raw`\b(i|we)('ve| have)? decided\b|\bodločil[ai]? (sva|sem|smo)( se)?\b|\bodločil[ai]? (sva|sem|smo)\b|\b(sva|smo) se odločil\w*\b|\bwir haben (\w+ )?entschieden\b|\bich habe (\w+ )?entschieden\b`),
  re(String.raw`^(q\d+|vprašanje \d+|odgovor na vprašanje \d*|frage \d+)\s*:|^(decision|odločitev|entscheidung)\s*:`),
  re(String.raw`^(q?\d+)\s*[:.)-]?\s+(da|ne|ja|yes|no|nein)\b`),
  //   answers to the agent's numbered or lettered questions: "1) yes 2) keep it", "a) ja b) nein"
  re(String.raw`(^|\s)(\d|[a-d])\)\s*\w+.*\s(\d|[a-d])\)\s*\w+`),
  re(String.raw`\b(answers? to your questions|zu deinen fragen|glede (tvojih )?vprašanj|odgovori na vprašanja)\b`),
]

/**
 * Rules stated as imperatives. Checked per sentence and skipped when that
 * sentence is scoped to the task at hand ("… here", "… today", "until …",
 * "tukaj", "danes", "zdaj", "heute"): then it is an instruction, not a rule.
 * Narrative ("Never seen this …", "Vedno ko zaženem …", "Nikoli nisem …",
 * "Immer wenn ich …", "Nikoli se ne zgodi …") is not imperative.
 */
const IMPERATIVE_RULES: RegExp[] = [
  // en: don't / do not / never / always + a base-form verb, at the start or after a clause break
  re(String.raw`(^|[,;]\s*)(please )?(don'?t|do not|never|always) (?!(worry|bother|mind|when|whenever|if|seen|been|had|have|got|did|i|it|we|the|a|this|that|so|again)\b)(?!\w+ed\b)(?!\w*[^s]s\b)\w`),
  // sl: negative imperative "ne piši", "prosim, ne …", "tega ne delaj", "nikar ne …"
  re(String.raw`(^|[,;:]\s*|\b(prosim|tega|tole|to|jih|ga|mi|nikar|več)\s+)ne (?!(bi|vem|vidi|dobi|gre|pri|po|ki|ti|mi|si|ji)\b)(?!pozabi,? da\b)\w+(aj|ji|i|te|jte)\b`),
  re(String.raw`\bne \w+(aj|uj)\b`),
  re(String.raw`\bnikar\b(?! ne skrbi)`),
  // sl: vedno / zmeraj + imperative, nikoli … ne + verb ("Datume vedno preveri", "nikoli jih ne piši")
  re(String.raw`\b(vedno|zmeraj) (najprej |prej |sproti )?(?!(mi|ti|si|ki|ji|isti|tisti|znova)\b)\w+(i|j)\b`),
  re(String.raw`(?<!\bse )\bnikoli ((?!se\b)\w+ )?ne \w+`),
  // de: imperative verb first, with a rule word ("Füge niemals …", "Benutze kein npm", "Verwende immer pnpm")
  re(String.raw`^(bitte )?(?!(die|der|das|eine|diese|jede|sie|wie|ich|es|er|keine|seite|datei)\b)\w+e?\b.*\b(nie|niemals|immer|kein\w*|nicht mehr)\b`),
]
const RULE_DE_START = re(String.raw`^(bitte )?(immer|nie|niemals) (?!(wenn|noch|wieder|gesehen)\b)`)
const RULE_DE_INFINITIVE = re(String.raw`\w+(en|ern|eln)[.!]*$`)
const DE_PRONOUN = re(String.raw`\b(ich|du|er|es|wir|ihr|man|mir|mich)\b`)
// A German imperative opens with the verb; a sentence opening with a noun,
// article or pronoun is not one.
const DE_IMPERATIVE_OPENER = re(String.raw`^(bitte )?(benutze|benutz|verwende|nimm|nutze|mach|schreib\w*|frag\w*|lass|füge|füg|setz\w*|änder\w*|lösch\w*|vergiss|pushe|push|committe|teste|prüfe|achte)\b`)

function imperativeRule(s: string): boolean {
  for (let i = 0; i < IMPERATIVE_RULES.length - 1; i++) if (IMPERATIVE_RULES[i].test(s)) return true
  if (DE_IMPERATIVE_OPENER.test(s) && IMPERATIVE_RULES[IMPERATIVE_RULES.length - 1].test(s)) return true
  return RULE_DE_START.test(s) && RULE_DE_INFINITIVE.test(s) && !DE_PRONOUN.test(s)
}

// The task at hand: these scope only their own sentence (re-audit H2).
const TASK_SCOPED = re(String.raw`\b(this|that) (branch|pr|commit|file|time|one|run|refactor|handler|change|function|component|test)\b|\b(right now|for now|today|yet|until|here)\b|\b(when|unless|if) the\b|\b(tukaj|danes|zdaj|zdej|za zdaj|hier|heute|jetzt|vorerst|bis)\b`)

// "Don't use npm, ok?" is a rule with a tag, not a question — but only a bare
// tag after a comma, on a sentence that does not open as a question
// ("A to ni prav, prav?", "Is it true that …, ok?", "…, a je to prav?").
const TAG_QUESTION = re(String.raw`,\s*(ok|okay|right|alright|got it|understood|yes|ja|prav|v redu|gut|klar)\s*\?+\s*$`)
const QUESTION_OPENER = re(String.raw`^(a|ali|al|kaj|zakaj|kako|is|are|do|does|did|can|could|would|will|was|why|what|how|ist|sind|kann|hast|bist|warum|was|wie)\b`)

const DECISIONS = [/\.decisions\.json\b/i, /\bapply (the |these |my )?decisions\b/i]
// A message that asks to read or explain a decisions file is not an answer.
const ABOUT_A_FILE = /\b(read|explain|open|look at|show|summari[sz]e|describe|what)\b/i

export function hasLearnSignal(text: string): boolean {
  if (!text || !text.trim()) return false
  const t = normaliseForSignal(text)
  if (!t.trim()) return false
  // A decisions path is matched on the whole message (its dots would split a sentence).
  if (DECISIONS.some((r) => r.test(t)) && !t.trim().endsWith('?') && !ABOUT_A_FILE.test(t)) return true
  // Sentences keep their terminator so a question can be told apart. A task
  // scope word covers its own sentence, including clauses joined by ";".
  const sentences = t.match(/[^.!?\n]+[.!?]*/g) ?? []
  for (const rawSentence of sentences) {
    let sentence = rawSentence.trim().replace(/^[-–—*#\s]+/, '')
    if (!QUESTION_OPENER.test(sentence)) sentence = sentence.replace(TAG_QUESTION, '.')
    if (!sentence || sentence.endsWith('?')) continue
    const scoped = TASK_SCOPED.test(sentence)
    for (const raw of sentence.match(/[^;]+;?/g) ?? []) {
      const s = raw.trim().replace(/^[-–—*#\s]+/, '')
      if (!s) continue
      if (NO_THEN_INSTRUCTION.test(s) || NOPE.test(s)) return true
      if (SIGNALS.some((r) => r.test(s))) return true
      if (!scoped && imperativeRule(s)) return true
    }
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

type Block = { type?: unknown; text?: unknown; name?: unknown; input?: unknown; id?: unknown }

// Echo spans Claude Code (or a hook) puts inside a user line: removed from
// every text block, not only from the start of the joined text (re-audit R4).
// Only a closed span is an echo; a tag the user typed in prose keeps the rest
// of the message (re-audit H5).
const ECHO_SPAN = /<(command-name|command-message|command-args|local-command-[a-z-]+|bash-[a-z-]+|task-notification|system-reminder|user-prompt-submit-hook)\b[^>]*>[\s\S]*?<\/\1>/g

/** The typed part of one text: echo spans removed. null when nothing typed is left. */
function typedText(raw: string): string | null {
  if (!ECHO_TAG.test(raw) && !raw.includes('<')) return raw
  const t = raw.replace(ECHO_SPAN, '').trim()
  return t ? t : null
}

/**
 * What the human typed on a user line. null = not a human turn (tool output,
 * echoes only). '' = a human turn with no text (an image-only turn): it is
 * still the latest message, so an older correction is not reported as it.
 */
function textOf(content: unknown): string | null {
  if (typeof content === 'string') return typedText(content)
  if (!Array.isArray(content)) return null
  const blocks = (content as Block[]).filter((b) => !!b && typeof b === 'object')
  // A line carrying a tool result is tool output; text beside it was not typed.
  if (blocks.some((b) => b.type === 'tool_result')) return null
  const parts = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => typedText(b.text as string))
    .filter((t): t is string => t !== null)
  if (parts.length) return parts.join('\n')
  return blocks.some((b) => b.type === 'image' || b.type === 'document') ? '' : null
}

// A successful plur_learn call: the exact tool (any MCP prefix), or
// plur_admin with a learn action. A call whose result came back as an error
// did not save anything (re-audit H4).
const LEARN_TOOL = /(^|__)plur_learn(_batch)?$/
const ADMIN_TOOL = /(^|__)plur_admin$/
const LEARN_ACTION = /^(plur_)?learn(_batch)?$/

function callsPlurLearn(content: unknown, failed: Set<string>): boolean {
  if (!Array.isArray(content)) return false
  return (content as Block[]).some((b) => {
    if (!b || b.type !== 'tool_use' || typeof b.name !== 'string') return false
    if (typeof b.id === 'string' && failed.has(b.id)) return false
    if (LEARN_TOOL.test(b.name)) return true
    const action = (b.input as { action?: unknown } | undefined)?.action
    return ADMIN_TOOL.test(b.name) && typeof action === 'string' && LEARN_ACTION.test(action)
  })
}

function failedToolIds(content: unknown, into: Set<string>): void {
  if (!Array.isArray(content)) return
  for (const b of content as Array<{ type?: unknown; tool_use_id?: unknown; is_error?: unknown }>) {
    if (b && b.type === 'tool_result' && b.is_error === true && typeof b.tool_use_id === 'string') into.add(b.tool_use_id)
  }
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
  const failed = new Set<string>() // tool_use ids whose result was an error
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line) continue
    let d: Record<string, unknown>
    try { d = JSON.parse(line) } catch { continue } // torn first line, garbage
    if (!d || typeof d !== 'object') continue
    if (d.type === 'system' && d.subtype === 'compact_boundary') return null
    const message = d.message as { content?: unknown } | undefined
    if (d.type === 'assistant') {
      // A sidechain (subagent) call is not this reply saving the memory.
      if (d.isSidechain !== true && callsPlurLearn(message?.content, failed)) learned = true
      continue
    }
    if (d.type !== 'user') continue
    failedToolIds(message?.content, failed) // results come after their calls; we read backwards
    if (d.isCompactSummary === true) return null
    if (d.isMeta === true || d.isSidechain === true || d.isVisibleInTranscriptOnly === true) continue
    if (d.toolUseResult !== undefined || d.sourceToolAssistantUUID !== undefined) continue
    const origin = d.origin as { kind?: unknown } | undefined
    if (origin && typeof origin === 'object' && origin.kind !== 'human') continue
    if (d.promptSource === 'system') continue
    const rawText = typeof message?.content === 'string' ? message.content : null
    if (rawText !== null && COMPACTION_PREFIX.test(rawText)) return null
    const text = textOf(message?.content)
    if (text === null) continue
    if (COMPACTION_PREFIX.test(text)) return null
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
