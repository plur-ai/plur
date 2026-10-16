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
// fictional fact no model can know. Asked about it, every run (pass^3) must
// (a) call PLUR recall / session start and get the fact back from memory, and
// (b) answer "Tuesday".
// The control arm: the same prompt with no PLUR at all. No run may answer
// "Tuesday" — that is what proves the answer came from memory, not a guess.
// The promise is green only when BOTH hold.
import { describe, expect, it } from 'vitest'
import {
  RUNS, authEnv, copyScaffold, folderOn, freshDir, installClaudeMd, logReport, plurCalls, recallFrom, report, requireEnabled,
  requireMcpBuilt, runSession, seededStore, writeMcpConfig, type AgentRun, type Graded,
} from '../helpers/agent-behaviour-harness.js'

const FACT = 'The Larkspur project deploys only on Tuesdays, never on Fridays.'
const SEEDS = [
  'Use pnpm, not npm, in every repository of this workspace.',
  'Release notes are written in plain English and never mention internal ticket numbers.',
  FACT,
  'The staging database is reset every night at 02:00 UTC.',
  'Code review needs one approval from someone outside the author\'s team.',
  'Log timestamps are always written in UTC with an explicit Z suffix.',
]
const PROMPT = 'Which day can I deploy Larkspur?'
const RECALL_TOOLS = new Set(['plur_recall', 'plur_recall_hybrid', 'plur_session_start', 'plur_inject', 'plur_inject_hybrid', 'plur_similarity_search'])
const TIMEOUT = 20 * 60_000

function gradeMemory(run: AgentRun): { ok: boolean; why: string } {
  if (run.timedOut) return { ok: false, why: 'the session timed out' }
  const lookups = plurCalls(run).filter(c => RECALL_TOOLS.has(c.name))
  if (lookups.length === 0) {
    return { ok: false, why: `expected a PLUR recall or session_start call before answering; saw tools: ${run.toolCalls.map(c => c.name).join(', ') || 'none'}` }
  }
  const fromMemory = lookups.some(c => /tuesday/i.test(c.result))
  if (!fromMemory) return { ok: false, why: `PLUR was asked (${lookups.map(c => c.name).join(', ')}) but no answer it returned contained the Larkspur fact` }
  if (!/tuesday/i.test(run.text)) return { ok: false, why: `expected the final answer to say Tuesday; it said: ${JSON.stringify(run.text.slice(0, 200))}` }
  return { ok: true, why: `recalled via ${lookups.map(c => c.name).join(', ')} and answered Tuesday` }
}

function gradeControl(run: AgentRun): { ok: boolean; why: string } {
  if (run.timedOut || (run.isError && !run.text)) return { ok: false, why: 'the control session did not produce an answer, so it proves nothing' }
  if (/tuesday/i.test(run.text)) return { ok: false, why: `without PLUR the agent still answered Tuesday — the fact is guessable, so the memory arm proves nothing: ${JSON.stringify(run.text.slice(0, 200))}` }
  return { ok: true, why: 'without PLUR the agent could not say Tuesday' }
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
  }, TIMEOUT)
})
