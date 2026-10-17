// Proof that the agent-behaviour graders reject what they must (audit B-02).
// Not a promise eval: synthetic transcripts, no model, no money. Run with
//   pnpm exec vitest run --config evals/vitest.diagnostics.config.ts evals/helpers/agent-behaviour-graders.unit.test.ts
//
// Each of the audit's three false positives is reproduced here and must now be
// REJECTED; a correct transcript for the same step must PASS.
import { describe, expect, it } from 'vitest'
import type { AgentRun, ToolCall } from './agent-behaviour-harness.js'
import {
  gradeAnswerFromMemory, gradeRequestedFile, gradeRetentionFile, gradeRetrieved, gradeSaved, saysCfgNotConf, saysElevenDays, stance,
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
  call('plur_learn', { statement, scope: 'global' }, JSON.stringify({ id: STORED_ID, statement, scope: 'global', decision: 'ADD' }))
const recallHit = (result: string) => call('plur_recall', { query: 'Larkspur' }, result)

describe('negation-aware meaning', () => {
  it('counts a negated mention as negated, and an affirmed one as affirmed', () => {
    expect(stance('Never Tuesday; deploy Friday', /tuesday/i)).toEqual({ affirmed: 0, negated: 1 })
    expect(stance('Deploy on Tuesday, never on Friday', /friday/i)).toEqual({ affirmed: 0, negated: 1 })
    expect(stance('Use .cfg instead of .conf', /\.conf\b/i)).toEqual({ affirmed: 0, negated: 1 })
    expect(stance('Not sure, but Tuesday', /tuesday/i)).toEqual({ affirmed: 1, negated: 0 })
    expect(stance('Deploy on Tuesday. Not on Friday, Saturday, or Sunday.', /saturday|sunday/i)).toEqual({ affirmed: 0, negated: 2 })
    expect(stance('Not on Friday. Tuesday works.', /tuesday/i)).toEqual({ affirmed: 1, negated: 0 })
    expect(stance('Not Friday, deploy on Tuesday', /tuesday/i)).toEqual({ affirmed: 1, negated: 0 })
  })
})

describe('BEH-1 recall grader', () => {
  const lookup = recallHit(JSON.stringify({ results: [{ id: STORED_ID, statement: FACT }] }))

  it('audit false positive 1: "Never Tuesday; deploy Friday" after a tool result mentioning Tuesday is rejected', () => {
    const v = gradeAnswerFromMemory(run('Never Tuesday; deploy Friday', [lookup]), 'tuesday', /larkspur/i)
    expect(v.ok, v.why).toBe(false)
  })

  it('an answer naming Tuesday AND another day as allowed is rejected', () => {
    const v = gradeAnswerFromMemory(run('You can deploy on Tuesday or Wednesday.', [lookup]), 'tuesday', /larkspur/i)
    expect(v.ok, v.why).toBe(false)
  })

  it('a right answer with no successful lookup is rejected (the fact must come from memory)', () => {
    const failed = call('plur_recall', { query: 'Larkspur' }, `failed: ${FACT}`, true)
    expect(gradeAnswerFromMemory(run('Tuesday.', [failed]), 'tuesday', /larkspur/i).ok).toBe(false)
    expect(gradeAnswerFromMemory(run('Tuesday.', []), 'tuesday', /larkspur/i).ok).toBe(false)
  })

  it('a correct transcript passes: recalled the fact, answered Tuesday, Friday only negated', () => {
    const v = gradeAnswerFromMemory(run('Larkspur deploys only on Tuesdays — never on Fridays.', [lookup]), 'tuesday', /larkspur/i)
    expect(v.ok, v.why).toBe(true)
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
    const v = gradeRequestedFile({ 'unrelated.cfg': 'x = 1\n' }, 'mailer.cfg', 'smtp_host = localhost', /\.conf$/)
    expect(v.ok, v.why).toBe(false)
  })

  it('the requested file with the wrong content, or a .conf beside it, is rejected', () => {
    expect(gradeRequestedFile({ 'mailer.cfg': 'smtp_host = example.org\n' }, 'mailer.cfg', 'smtp_host = localhost', /\.conf$/).ok).toBe(false)
    expect(gradeRequestedFile({ 'mailer.cfg': 'smtp_host = localhost\n', 'mailer.conf': 'smtp_host = localhost\n' }, 'mailer.cfg', 'smtp_host = localhost', /\.conf$/).ok).toBe(false)
  })

  it('the next session must retrieve the saved memory, not merely create the file', () => {
    expect(gradeRetrieved(run('Done.', []), CORRECT_RULE).ok).toBe(false)
    expect(gradeRetrieved(run('Done.', [recallHit(JSON.stringify({ results: [] }))]), CORRECT_RULE).ok).toBe(false)
  })

  it('a correct session 2 passes: retrieved the rule and wrote mailer.cfg with the line', () => {
    const s2 = run('Created mailer.cfg.', [recallHit(JSON.stringify({ results: [{ id: STORED_ID, statement: CORRECT_RULE }] }))])
    expect(gradeRetrieved(s2, CORRECT_RULE).ok).toBe(true)
    const v = gradeRequestedFile({ 'CLAUDE.md': '# x', 'mailer.cfg': 'smtp_host=localhost\n' }, 'mailer.cfg', 'smtp_host = localhost', /\.conf$/)
    expect(v.ok, v.why).toBe(true)
  })
})

describe('BEH-3 explicit-save graders', () => {
  const RULE = 'Larkspur keeps its log files for 11 days.'

  it('rejects a statement with the opposite or another number', () => {
    expect(saysElevenDays('Larkspur logs are not kept for 11 days.').ok).toBe(false)
    expect(saysElevenDays('Larkspur keeps logs for 7 days, not 11 days.').ok).toBe(false)
    expect(saysElevenDays('Larkspur retention is 11 days.').ok).toBe(false) // no mention of logs
  })

  it('accepts the fact in other words', () => {
    expect(saysElevenDays(RULE).ok).toBe(true)
    expect(saysElevenDays('Log retention for the Larkspur project: eleven days.').ok).toBe(true)
  })

  it('rejects an acknowledged save that is not on disk, and passes one that is', () => {
    expect(gradeSaved([run('Saved!', [learnOk(RULE)])], [], saysElevenDays, 'logs are kept 11 days').ok).toBe(false)
    expect(gradeSaved([run('Saved!', [learnOk(RULE)])], [RULE], saysElevenDays, 'logs are kept 11 days').ok).toBe(true)
  })

  it('the output file must hold 11 and nothing else numeric', () => {
    expect(gradeRetentionFile({ 'retention.txt': '7\n' }).ok).toBe(false)
    expect(gradeRetentionFile({ 'retention.txt': '11 (or 14)\n' }).ok).toBe(false)
    expect(gradeRetentionFile({ 'notes.txt': '11\n' }).ok).toBe(false)
    expect(gradeRetentionFile({ 'retention.txt': '11\n' }).ok).toBe(true)
  })
})
