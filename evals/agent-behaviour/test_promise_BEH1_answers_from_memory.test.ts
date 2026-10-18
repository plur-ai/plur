// BEH-1: An agent asked something that is in memory answers from memory, where the same agent without PLUR cannot.
//
// kind: agent — a REAL headless Claude Code session (sonnet, ≤ $0.50 and ≤ 8
// turns per session), graded deterministically from its stream-json transcript.
// Opt-in: runs only with PLUR_AGENT_EVALS=1; otherwise it FAILS with
// "agent eval not run (set PLUR_AGENT_EVALS=1)". Auth: CLAUDE_CODE_OAUTH_TOKEN
// or ANTHROPIC_API_KEY. Harness and isolation rules: ../helpers/agent-behaviour-harness.ts.
//
// Route under test: the MCP server alone (packages/mcp/dist), plus the CLAUDE.md
// section `plur-mcp init` writes. NO hooks — nothing is injected for the agent;
// it has to decide to look in memory itself. The working folder is turned on in
// the folder map (as `plur folders set <dir> --on` does): a user who has
// memories for a project has said yes to its folder.
//
// The memory arm: six memories seeded through Plur.learn, one of them a
// fictional fact no model can know. The folder is switched on for memory
// FIRST — folder consent is a prerequisite the user gives, not something the
// agent gets past (the harness checks the folder map says "on" before the run).
// The prompt ends with an ANSWER CONTRACT (audit R-01, 2026-10-18): the reply
// must close with one line `ANSWER: <weekday>` or `ANSWER: UNKNOWN`, and only
// that line is graded, exactly. Prose heuristics could not tell "Tuesday is
// forbidden" from "deploy on Tuesday", nor "Today is Sunday" (calendar
// context) from a second deploy day; a fixed final line can be read exactly.
// A missing, repeated, non-final or compound line ("Tuesday or Wednesday") is
// not an answer.
// Asked about the fact, every run (pass^3) must
// (a) call PLUR recall / session start, and a reply that SUCCEEDED (JSON
//     payload, no error / success:false) must RETURN a memory holding the
//     complete seeded fact — an echoed query or a truncated statement does not
//     count, and
// (b) end with `ANSWER: Tuesday`.
// The control arm: the same prompt with no PLUR at all. No run may answer
// Tuesday on its contract line — that is what proves the answer came from
// memory, not a guess. Refusals and uncertainty pass even when they name a
// weekday as context; with no valid contract line, any mention of Tuesday
// fails (a guess and a hedge cannot be told apart, and failing is the safe
// direction).
// Graders: ../helpers/agent-behaviour-graders.ts, proven on synthetic
// transcripts (including the real 2026-10-18 answers) in
// agent-behaviour-graders.unit.test.ts.
// The promise is green only when BOTH hold, over three runs each; a run with
// PLUR_AGENT_EVAL_RUNS below 3 is diagnostic and fails as non-certifying.
import { describe, expect, it } from 'vitest'
import {
  RUNS, authEnv, copyScaffold, folderOn, freshDir, installClaudeMd, logReport, recallFrom, report, requireCertifying, requireEnabled,
  requireMcpBuilt, runSession, seededStore, writeMcpConfig, type AgentRun, type Graded,
} from '../helpers/agent-behaviour-harness.js'
import { ANSWER_CONTRACT, gradeAnswerFromMemory, gradeControlAnswer } from '../helpers/agent-behaviour-graders.js'

const FACT = 'The Larkspur project deploys only on Tuesdays, never on Fridays.'
const SEEDS = [
  'Use pnpm, not npm, in every repository of this workspace.',
  'Release notes are written in plain English and never mention internal ticket numbers.',
  FACT,
  'The staging database is reset every night at 02:00 UTC.',
  'Code review needs one approval from someone outside the author\'s team.',
  'Log timestamps are always written in UTC with an explicit Z suffix.',
]
const PROMPT = `Which day can I deploy Larkspur? ${ANSWER_CONTRACT}`
const TIMEOUT = 20 * 60_000

function gradeMemory(run: AgentRun): { ok: boolean; why: string } {
  return gradeAnswerFromMemory(run, 'tuesday', FACT)
}

function gradeControl(run: AgentRun): { ok: boolean; why: string } {
  if (run.isError && !run.text) return { ok: false, why: 'the control session did not produce an answer, so it proves nothing' }
  return gradeControlAnswer(run, 'tuesday')
}

describe('BEH-1 an agent answers from memory where the same agent without PLUR cannot', () => {
  it(`with PLUR attached, every run (pass^${RUNS}) recalls the Larkspur fact and answers Tuesday`, async () => {
    requireEnabled()
    const auth = authEnv()
    requireMcpBuilt()

    const template = freshDir('beh1-template')
    installClaudeMd(template, auth)

    const runs = await Promise.all(Array.from({ length: RUNS }, async (_, i) => {
      const store = await seededStore(SEEDS)
      const onDisk = await recallFrom(store.dir, 'Larkspur deploy')
      expect(onDisk, `precondition: the seeded store (run ${i + 1}) must hold the Larkspur fact before the agent runs`).toContain(FACT)
      expect(store.ids, 'precondition: all six memories were written').toHaveLength(6)
      const cwd = copyScaffold(template, `beh1-mem${i + 1}`)
      const home = freshDir(`beh1-mem${i + 1}-home`)
      await folderOn(store.dir, cwd, home)
      const run = await runSession({
        prompt: PROMPT, cwd, home, auth,
        mcpConfig: writeMcpConfig(freshDir(`beh1-mem${i + 1}-cfg`), store.dir),
      })
      return { ...gradeMemory(run), run } as Graded
    }))

    const text = report('BEH-1 memory arm', runs)
    logReport(text)
    expect(runs.every(g => g.ok), `expected every run with PLUR to look in memory and answer Tuesday.\n${text}`).toBe(true)
    requireCertifying()
  }, TIMEOUT)

  it(`without PLUR, no run (0/${RUNS}) answers Tuesday — the control arm`, async () => {
    requireEnabled()
    const auth = authEnv()

    const runs = await Promise.all(Array.from({ length: RUNS }, async (_, i) => {
      // An empty working dir and no CLAUDE.md: a user without PLUR.
      const cwd = freshDir(`beh1-ctl${i + 1}`)
      const run = await runSession({ prompt: PROMPT, cwd, home: freshDir(`beh1-ctl${i + 1}-home`), auth })
      return { ...gradeControl(run), run } as Graded
    }))

    const text = report('BEH-1 control arm (no PLUR)', runs)
    logReport(text)
    expect(runs.every(g => g.ok), `expected no run without PLUR to answer Tuesday.\n${text}`).toBe(true)
    requireCertifying()
  }, TIMEOUT)
})
