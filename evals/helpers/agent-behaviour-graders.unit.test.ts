// Proof that the agent-behaviour graders reject what they must (audits B-02
// and R-01). Not a promise eval: synthetic transcripts, no model, no money.
// Run with
//   pnpm exec vitest run --config evals/vitest.diagnostics.config.ts evals/helpers/agent-behaviour-graders.unit.test.ts
//
// Every counterexample an audit found is reproduced here and must be
// REJECTED; a correct transcript for the same step — including the real
// answers from the 2026-10-18 paid runs that the previous grader wrongly
// rejected — must PASS.
import { describe, expect, it } from 'vitest'
import type { AgentRun, ToolCall } from './agent-behaviour-harness.js'
import {
  finalAnswer, gradeAnswerFromMemory, gradeControlAnswer, gradeRequestedFile, gradeRetentionFile, gradeRetrieved, gradeSaved,
  saysCfgNotConf, saysElevenDays, stance,
} from './agent-behaviour-graders.js'

const FACT = 'The Larkspur project deploys only on Tuesdays, never on Fridays.'
const CORRECT_RULE = 'In Larkspur, config files are named with the .cfg extension, never .conf.'
const STORED_ID = 'ENG-2026-10-17-001'

function call(name: string, input: Record<string, unknown>, result: string, isError: boolean | null = false): ToolCall {
  return { name: `mcp__plur__${name}`, input, result, isError }
}
function run(text: string, toolCalls: ToolCall[], extra: Partial<AgentRun> = {}): AgentRun {
  return { text, exitCode: 0, isError: false, timedOut: false, toolCalls, costUsd: 0, numTurns: 1, sessionId: 's', stderrTail: '', ...extra }
}
const learnOk = (statement: string) =>
  call('plur_learn', { statement, scope: 'global' }, JSON.stringify({ id: STORED_ID, statement, scope: 'global', decision: 'ADD' }, null, 2))
const recallHit = (result: string) => call('plur_recall', { query: 'Larkspur' }, result)
/** What plur_recall really returns (packages/mcp/src/tools.ts recallHandler), pretty-printed as the server does. */
const recallOf = (...statements: string[]) =>
  recallHit(JSON.stringify({ results: statements.map((statement, i) => ({ id: `ENG-2026-10-18-00${i + 1}`, statement, scope: 'global' })), count: statements.length }, null, 2))
/** What plur_session_start really returns: one `[ID] statement` line per memory inside engrams.text. */
const sessionStartOf = (...statements: string[]) =>
  call('plur_session_start', { task: 'deploy Larkspur' }, JSON.stringify({
    session_id: 'abc', engrams: { text: `## DIRECTIVES\n\n${statements.map((s, i) => `[ENG-2026-10-18-00${i + 1}] ${s}\n  Domain: larkspur`).join('\n')}`, count: statements.length, injected_ids: [] },
  }, null, 2))

// The real BEH-1 memory-arm answer from a 2026-10-18 paid run (rejected by the
// old grader as "also affirms sundays"), and the real control-arm refusal.
const REAL_BEH1_ANSWER = 'Larkspur deploys on **Tuesdays** only, and never on Fridays. Today is Sunday, 2026-10-18, so the next Tuesday is 2026-10-20.'
const REAL_CONTROL_REFUSAL = 'I can\'t tell you. The working directory is empty, and my memory has nothing on Larkspur — no deploy schedule, runbook or calendar. Today is Sunday, 2026-10-18, but that does not tell me which day Larkspur deploys.'

describe('negation-aware meaning', () => {
  it('counts a negated mention as negated, and an affirmed one as affirmed', () => {
    expect(stance('Never Tuesday; deploy Friday', /tuesday/i)).toEqual({ affirmed: 0, negated: 1 })
    expect(stance('Deploy on Tuesday, never on Friday', /friday/i)).toEqual({ affirmed: 0, negated: 1 })
    expect(stance('Use .cfg instead of .conf', /\.conf\b/i)).toEqual({ affirmed: 0, negated: 1 })
    expect(stance('Use .cfg instead of .conf', /\.cfg\b/i, [/\.conf\b/i])).toEqual({ affirmed: 1, negated: 0 })
    expect(stance('Not sure, but Tuesday', /tuesday/i)).toEqual({ affirmed: 1, negated: 0 })
    expect(stance('Deploy on Tuesday. Not on Friday, Saturday, or Sunday.', /saturday|sunday/i)).toEqual({ affirmed: 0, negated: 2 })
    expect(stance('Not on Friday. Tuesday works.', /tuesday/i)).toEqual({ affirmed: 1, negated: 0 })
    expect(stance('Not Friday, deploy on Tuesday', /tuesday/i)).toEqual({ affirmed: 1, negated: 0 })
  })

  it('R-01: a negation AFTER the term negates it too', () => {
    expect(stance('Tuesday is not a deployment day.', /tuesday/i)).toEqual({ affirmed: 0, negated: 1 })
    expect(stance('Tuesday is forbidden.', /tuesday/i)).toEqual({ affirmed: 0, negated: 1 })
    expect(stance('Files ending in .cfg are forbidden.', /\.cfg\b/i)).toEqual({ affirmed: 0, negated: 1 })
  })
})

describe('the BEH-1 answer contract: a final `ANSWER: <weekday or UNKNOWN>` line', () => {
  it('reads the final line exactly', () => {
    expect(finalAnswer('Larkspur deploys on Tuesdays.\n\nANSWER: Tuesday')).toEqual({ ok: true, value: 'tuesday' })
    expect(finalAnswer('ANSWER: Tuesdays')).toEqual({ ok: true, value: 'tuesday' })
    expect(finalAnswer('**ANSWER: Tuesday**')).toEqual({ ok: true, value: 'tuesday' })
    expect(finalAnswer('ANSWER: UNKNOWN')).toEqual({ ok: true, value: 'unknown' })
  })

  it('a missing, non-final, repeated or compound answer line is not an answer', () => {
    expect(finalAnswer('Tuesday.').ok).toBe(false)
    expect(finalAnswer('ANSWER: Tuesday\nHope that helps!').ok).toBe(false)
    expect(finalAnswer('ANSWER: Friday\nANSWER: Tuesday').ok).toBe(false)
    expect(finalAnswer('ANSWER: Tuesday or Wednesday').ok).toBe(false)
    expect(finalAnswer('ANSWER: never Tuesday').ok).toBe(false)
    expect(finalAnswer('ANSWER: next Tuesday (2026-10-20)').ok).toBe(false)
  })
})

describe('BEH-1 recall grader (memory arm)', () => {
  const lookup = recallOf(FACT)
  const grade = (text: string, calls: ToolCall[] = [lookup]) => gradeAnswerFromMemory(run(text, calls), 'tuesday', FACT)

  it('audit false positive 1: "Never Tuesday; deploy Friday" after a tool result mentioning Tuesday is rejected', () => {
    expect(grade('Never Tuesday; deploy Friday').ok).toBe(false)
    expect(grade('Never Tuesday; deploy Friday\nANSWER: Friday').ok).toBe(false)
  })

  it('R-01 wrong meanings are rejected, as prose and with their honest answer line', () => {
    for (const text of [
      'Tuesday is not a deployment day.',
      'Tuesday is not a deployment day.\nANSWER: UNKNOWN',
      'Tuesday is forbidden.',
      'Tuesday is forbidden.\nANSWER: UNKNOWN',
      'I do not know whether deployments happen on Tuesday.',
      'I do not know whether deployments happen on Tuesday.\nANSWER: UNKNOWN',
      'Tuesday or Wednesday',
      'Tuesday or Wednesday\nANSWER: Tuesday or Wednesday',
      'You can deploy on Tuesday or Wednesday.\nANSWER: Wednesday',
    ]) {
      const v = grade(text)
      expect(v.ok, `${JSON.stringify(text)} → ${v.why}`).toBe(false)
    }
  })

  it('a right answer with no successful lookup is rejected (the fact must come from memory)', () => {
    const failed = call('plur_recall', { query: 'Larkspur' }, `failed: ${FACT}`, true)
    expect(grade('ANSWER: Tuesday', [failed]).ok).toBe(false)
    expect(grade('ANSWER: Tuesday', []).ok).toBe(false)
  })

  it('R-01: a success:false / error lookup that echoes the fact in its query is not a lookup that returned it', () => {
    const echoed = recallHit(JSON.stringify({ success: false, error: 'lookup failed', query: FACT }))
    expect(grade('ANSWER: Tuesday', [echoed]).ok).toBe(false)
    const echoedOk = recallHit(JSON.stringify({ results: [], count: 0, query: FACT }))
    expect(grade('ANSWER: Tuesday', [echoedOk]).ok).toBe(false)
  })

  it('R-01: a lookup truncated before the crucial value is not a lookup that returned it', () => {
    const truncated = recallOf('The Larkspur project deploys only on [truncated]')
    expect(grade('ANSWER: Tuesday', [truncated]).ok).toBe(false)
  })

  it('the real 2026-10-18 answers pass — calendar context ("Today is Sunday") is not a deploy day', () => {
    for (const text of [
      `${REAL_BEH1_ANSWER}\n\nANSWER: Tuesday`,
      'Deploys happen on Tuesday.\nANSWER: Tuesday',
      'Tuesday.\nANSWER: Tuesday',
      'Larkspur deploys only on Tuesdays — never on Fridays.\n\n**ANSWER: Tuesday**',
    ]) {
      const v = grade(text)
      expect(v.ok, `${JSON.stringify(text)} → ${v.why}`).toBe(true)
    }
  })

  it('the fact may arrive through plur_session_start (an `[ID] statement` line), or through plur_admin', () => {
    expect(grade('ANSWER: Tuesday', [sessionStartOf('Use pnpm, not npm.', FACT)]).ok).toBe(true)
    const viaAdmin = call('plur_admin', { action: 'plur_recall', args: { query: 'Larkspur' } }, JSON.stringify({ results: [{ id: STORED_ID, statement: FACT }] }))
    expect(grade('ANSWER: Tuesday', [viaAdmin]).ok).toBe(true)
  })

  it('without the contract line, even a right prose answer is not graded as right', () => {
    expect(grade(REAL_BEH1_ANSWER).ok).toBe(false)
  })
})

describe('BEH-1 control grader (no PLUR)', () => {
  const grade = (text: string, extra: Partial<AgentRun> = {}) => gradeControlAnswer(run(text, [], extra), 'tuesday')

  it('a refusal or uncertainty passes, even when it names a weekday as calendar context', () => {
    for (const text of [
      `${REAL_CONTROL_REFUSAL}\n\nANSWER: UNKNOWN`,
      REAL_CONTROL_REFUSAL, // the real run had no contract line yet; it never names Tuesday
      'I do not know whether Larkspur deploys on Tuesday or any other day.\nANSWER: UNKNOWN',
      'Many teams deploy mid-week, but I have nothing on Larkspur.\nANSWER: Wednesday', // a wrong guess: the fact is not guessable
    ]) {
      const v = grade(text)
      expect(v.ok, `${JSON.stringify(text)} → ${v.why}`).toBe(true)
    }
  })

  it('an answer claiming Tuesday fails', () => {
    expect(grade('Probably Tuesday.\nANSWER: Tuesday').ok).toBe(false)
    expect(grade('ANSWER: Tuesdays').ok).toBe(false)
  })

  it('no contract line AND Tuesday mentioned cannot be told apart from a guess, so it fails (the safe direction)', () => {
    expect(grade('Deploy on Tuesday.').ok).toBe(false)
  })

  it('no answer at all proves nothing', () => {
    expect(grade('', { timedOut: true }).ok).toBe(false)
    expect(grade('', { isError: true }).ok).toBe(false)
  })
})

describe('BEH-2 correction graders', () => {
  it('audit false positive 2: a FAILED learn call whose statement says the opposite rule is rejected', () => {
    const failedOpposite = call('plur_learn', { statement: 'Never use .cfg; use .conf' }, 'Error: store locked', true)
    const v = gradeSaved([run('', [failedOpposite])], [], saysCfgNotConf, 'config files use .cfg')
    expect(v.ok, v.why).toBe(false)
  })

  it('a SUCCESSFUL learn of the opposite rule is rejected (the proposition is judged, not the token)', () => {
    const v = gradeSaved([run('', [learnOk('Never use .cfg; use .conf')])], ['Never use .cfg; use .conf'], saysCfgNotConf, 'config files use .cfg')
    expect(v.ok, v.why).toBe(false)
  })

  it('R-01: a SUCCESSFUL, persisted save of "Files ending in .cfg are forbidden" is rejected', () => {
    const wrong = 'Files ending in .cfg are forbidden.'
    const v = gradeSaved([run('', [learnOk(wrong)])], [wrong], saysCfgNotConf, 'config files use .cfg')
    expect(v.ok, v.why).toBe(false)
  })

  it('wrong rules in other words are rejected', () => {
    for (const s of [
      'Larkspur config files use .conf, not .cfg.',
      '.cfg files are not allowed in Larkspur; use .conf.',
      'Do not name Larkspur config files with .cfg.',
      'Larkspur config files may use .cfg or .conf.',
      'Use .conf instead of .cfg for Larkspur config files.',
      'Larkspur config files must never end in .cfg.',
      // Fourth audit A4-04: .cfg mentioned as context, the rule about config files says something else.
      'The documentation contains an example filename sample.cfg. Configuration files use TOML.',
      'The old README mentions .cfg. Larkspur config files use .yaml.',
      'Larkspur config files use the .cfg extension; Larkspur config files also use .toml.',
    ]) expect(saysCfgNotConf(s).ok, s).toBe(false)
  })

  it('the right rule in other words is accepted', () => {
    for (const s of [
      CORRECT_RULE,
      'Larkspur config files use .cfg, not .conf.',
      'Use .cfg instead of .conf for Larkspur config files.',
      'Larkspur: name config files with the .cfg extension — never .conf.',
      'Config files in Larkspur must use the .cfg extension and never .conf.',
      'In the Larkspur project, configuration files use the .cfg extension (not .conf).',
      'Larkspur naming convention: config files end in .cfg. Never use .conf.',
      'Use .cfg instead of .yaml or .conf for Larkspur config files.',
      'Larkspur config files use .cfg, not .toml and not .conf.',
    ]) expect(saysCfgNotConf(s).ok, `${s} → ${saysCfgNotConf(s).why}`).toBe(true)
  })

  it('a failed learn of the right rule is rejected, even if the text is right', () => {
    const failed = call('plur_learn', { statement: CORRECT_RULE }, JSON.stringify({ success: false, error: 'pinned_quota_exceeded' }))
    expect(gradeSaved([run('', [failed])], [CORRECT_RULE], saysCfgNotConf, 'config files use .cfg').ok).toBe(false)
  })

  it('folder-off answers are not a save', () => {
    const off = call('plur_learn', { statement: CORRECT_RULE }, JSON.stringify({ plur: 'off', message: 'memory is off here' }))
    expect(gradeSaved([run('', [off])], [], saysCfgNotConf, 'config files use .cfg').ok).toBe(false)
  })

  it('acknowledge without persisting: the server says saved but the reopened store does not have it — rejected', () => {
    const v = gradeSaved([run('Saved.', [learnOk(CORRECT_RULE)])], ['Use pnpm, not npm.'], saysCfgNotConf, 'config files use .cfg')
    expect(v.ok, v.why).toBe(false)
  })

  it('a correct session 1 passes: successful learn of the right rule, and it is on disk', () => {
    const v = gradeSaved([run('', []), run('Noted.', [learnOk(CORRECT_RULE)])], [CORRECT_RULE], saysCfgNotConf, 'config files use .cfg')
    expect(v.ok, v.why).toBe(true)
    expect(v.stored).toBe(CORRECT_RULE)
  })

  it('audit false positive 3: files holding only unrelated.cfg are rejected', () => {
    const v = gradeRequestedFile({ 'unrelated.cfg': 'x = 1\n' }, 'mailer.cfg', 'smtp_host', 'localhost', /\.conf$/)
    expect(v.ok, v.why).toBe(false)
  })

  it('the requested file with the wrong content, or a .conf beside it, is rejected', () => {
    expect(gradeRequestedFile({ 'mailer.cfg': 'smtp_host = example.org\n' }, 'mailer.cfg', 'smtp_host', 'localhost', /\.conf$/).ok).toBe(false)
    expect(gradeRequestedFile({ 'mailer.cfg': 'smtp_host = localhost\n', 'mailer.conf': 'smtp_host = localhost\n' }, 'mailer.cfg', 'smtp_host', 'localhost', /\.conf$/).ok).toBe(false)
  })

  it('R-01: the requested line followed by a conflicting assignment is rejected', () => {
    const g = (body: string) => gradeRequestedFile({ 'mailer.cfg': body }, 'mailer.cfg', 'smtp_host', 'localhost', /\.conf$/)
    expect(g('smtp_host = localhost\nsmtp_host = malicious.invalid\n').ok).toBe(false)
    expect(g('smtp_host = localhost\nsmtp_host: malicious.invalid\n').ok).toBe(false)
    expect(g('smtp_host = localhost\nsmtp_port = 25\n').ok).toBe(false) // asked for a single line
    expect(g('smtp_host = localhost extra\n').ok).toBe(false)
  })

  it('the next session must retrieve the saved memory, not merely create the file', () => {
    expect(gradeRetrieved(run('Done.', []), CORRECT_RULE).ok).toBe(false)
    expect(gradeRetrieved(run('Done.', [recallHit(JSON.stringify({ results: [] }))]), CORRECT_RULE).ok).toBe(false)
  })

  it('R-01: an unsuccessful lookup that echoes the saved text, or a truncated one, is not a retrieval', () => {
    const echoedFail = recallHit(JSON.stringify({ success: false, error: 'lookup failed', query: CORRECT_RULE }))
    expect(gradeRetrieved(run('', [echoedFail]), CORRECT_RULE).ok).toBe(false)
    const echoedError = recallHit(JSON.stringify({ error: 'timeout', results: [{ id: STORED_ID, statement: CORRECT_RULE }] }))
    expect(gradeRetrieved(run('', [echoedError]), CORRECT_RULE).ok).toBe(false)
    const protocolError = call('plur_recall', { query: CORRECT_RULE }, JSON.stringify({ results: [{ id: STORED_ID, statement: CORRECT_RULE }] }), true)
    expect(gradeRetrieved(run('', [protocolError]), CORRECT_RULE).ok).toBe(false)
    const notJson = recallHit(`Found: ${CORRECT_RULE}`)
    expect(gradeRetrieved(run('', [notJson]), CORRECT_RULE).ok).toBe(false)
    const truncated = recallOf(`${CORRECT_RULE.slice(0, 45)} [truncated]`)
    expect(gradeRetrieved(run('', [truncated]), CORRECT_RULE).ok).toBe(false)
  })

  it('a correct session 2 passes: retrieved the rule and wrote mailer.cfg with the line', () => {
    const s2 = run('Created mailer.cfg.', [recallOf(CORRECT_RULE)])
    expect(gradeRetrieved(s2, CORRECT_RULE).ok).toBe(true)
    // plur_recall appends annotations after the statement; still the whole statement
    expect(gradeRetrieved(run('', [recallOf(`${CORRECT_RULE} (used 2x)`)]), CORRECT_RULE).ok).toBe(true)
    expect(gradeRetrieved(run('', [sessionStartOf(CORRECT_RULE)]), CORRECT_RULE).ok).toBe(true)
    for (const body of ['smtp_host=localhost\n', 'smtp_host = localhost', '# Larkspur mailer\nsmtp_host = localhost\n']) {
      const v = gradeRequestedFile({ 'CLAUDE.md': '# x', 'mailer.cfg': body }, 'mailer.cfg', 'smtp_host', 'localhost', /\.conf$/)
      expect(v.ok, `${JSON.stringify(body)} → ${v.why}`).toBe(true)
    }
  })
})

describe('a failed record nested in a lookup reply is never a returned memory (fourth audit A4-04)', () => {
  it('a nested success:false record carrying the statement does not count', () => {
    const STORED = 'Larkspur keeps its log files for 11 days.'
    const payload = JSON.stringify({ count: 0, results: [{ success: false, error: 'store unreachable', id: 'ENG-X', statement: STORED }] })
    const v = gradeRetrieved(run('', [recallHit(payload)]), STORED)
    expect(v.ok, v.why).toBe(false)
    const good = JSON.stringify({ count: 1, results: [{ id: 'ENG-X', statement: STORED }] })
    expect(gradeRetrieved(run('', [recallHit(good)]), STORED).ok).toBe(true)
  })
})

describe('BEH-3 explicit-save graders', () => {
  const RULE = 'Larkspur keeps its log files for 11 days.'

  it('rejects a statement with the opposite or another number, or about another project', () => {
    expect(saysElevenDays('Larkspur logs are not kept for 11 days.').ok).toBe(false)
    expect(saysElevenDays('Larkspur keeps logs for 7 days, not 11 days.').ok).toBe(false)
    expect(saysElevenDays('Larkspur retention is 11 days.').ok).toBe(false) // no mention of logs
    expect(saysElevenDays('A different project keeps logs for 11 days.').ok).toBe(false)
    expect(saysElevenDays('Keeping Larkspur logs for 11 days is wrong.').ok).toBe(false)
    // Fourth audit A4-04: the target's logs get another (spelled-out) count, eleven goes to another project.
    expect(saysElevenDays('Larkspur keeps logs for thirty days, and Bramble keeps logs for eleven days.').ok).toBe(false)
    expect(saysElevenDays('Larkspur logs: thirty days. Bramble logs: 11 days.').ok).toBe(false)
    expect(saysElevenDays('Bramble keeps its logs for 11 days. Larkspur has logs too.').ok).toBe(false)
  })

  it('accepts the fact in other words', () => {
    expect(saysElevenDays(RULE).ok).toBe(true)
    expect(saysElevenDays('Log retention for the Larkspur project: eleven days.').ok).toBe(true)
    expect(saysElevenDays('Larkspur log files are retained for 11 days.').ok).toBe(true)
  })

  it('rejects an acknowledged save that is not on disk, and passes one that is', () => {
    expect(gradeSaved([run('Saved!', [learnOk(RULE)])], [], saysElevenDays, 'logs are kept 11 days').ok).toBe(false)
    expect(gradeSaved([run('Saved!', [learnOk(RULE)])], [RULE], saysElevenDays, 'logs are kept 11 days').ok).toBe(true)
  })

  it('a long statement truncated before its number is not a retrieval', () => {
    const saved = 'Larkspur log retention policy for every production application and every staging application: 11 days.'
    expect(gradeRetrieved(run('', [recallOf(`${saved.slice(0, 60)} [truncated]`)]), saved).ok).toBe(false)
    expect(gradeRetrieved(run('', [recallHit(JSON.stringify({ success: false, error: 'lookup failed', query: saved }))]), saved).ok).toBe(false)
    expect(gradeRetrieved(run('', [recallOf(saved)]), saved).ok).toBe(true)
  })

  it('the output file must hold exactly the number 11', () => {
    expect(gradeRetentionFile({ 'retention.txt': '7\n' }).ok).toBe(false)
    expect(gradeRetentionFile({ 'retention.txt': '11 (or 14)\n' }).ok).toBe(false)
    expect(gradeRetentionFile({ 'retention.txt': 'Not 11. Unknown.' }).ok).toBe(false)
    expect(gradeRetentionFile({ 'retention.txt': '11 days\n' }).ok).toBe(false)
    expect(gradeRetentionFile({ 'retention.txt': '110\n' }).ok).toBe(false)
    expect(gradeRetentionFile({ 'notes.txt': '11\n' }).ok).toBe(false)
    expect(gradeRetentionFile({ 'retention.txt': '11\n' }).ok).toBe(true)
    expect(gradeRetentionFile({ 'retention.txt': ' 11 ' }).ok).toBe(true)
  })
})
