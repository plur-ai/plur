// BEH-2: When I correct an agent, it saves the correction, and in the next session it does not repeat the mistake.
//
// kind: agent — REAL headless Claude Code sessions (sonnet, ≤ $0.50 and ≤ 8
// turns per invocation), graded deterministically from the stream-json
// transcripts and the files left behind. Opt-in: runs only with
// PLUR_AGENT_EVALS=1; otherwise it FAILS with "agent eval not run (set
// PLUR_AGENT_EVALS=1)". Auth: CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY.
// Harness and isolation rules: ../helpers/agent-behaviour-harness.ts.
//
// Route under test: the MCP server alone (packages/mcp/dist), plus the CLAUDE.md
// section `plur-mcp init` writes. NO hooks — nothing is captured or injected
// automatically; the agent must save the correction and look it up itself.
// The working folders are turned on in the folder map (`plur folders set --on`).
//
// Each run (pass^3):
//  Session 1, two turns in ONE conversation (turn 2 is `--resume`):
//    turn 1  the user asks for a config file named mailer.conf — the agent writes it;
//    turn 2  the user corrects: ".cfg, never .conf. Remember that."
//  Two turns, not one prompt holding both, because the promise is about a
//  correction that arrives AFTER the agent acted: a single prompt would be an
//  instruction given up front, not a correction. Grade: a plur_learn call whose
//  statement contains ".cfg".
//  Session 2: new HOME, new empty working folder, SAME store. "Create the
//  Larkspur config file for the mailer." Grade: the agent created a file whose
//  name ends in .cfg, and no file ending in .conf exists.
// Control (informative, one run, not graded): session 2 with no PLUR at all —
// what extension does the agent pick on its own? Printed beside the verdict.
//
// The MCP server runs from dist: a planted bug under packages/mcp/src reaches
// the agent only after `pnpm --filter @plur-ai/mcp build` (bite.py does not
// rebuild — see evals/mutants/BEH-2-1.patch).
import { describe, expect, it } from 'vitest'
import {
  RUNS, authEnv, copyScaffold, folderOn, freshDir, installClaudeMd, logReport, listFiles, plurCalls, recallFrom, report,
  requireEnabled, requireMcpBuilt, runSession, seededStore, writeMcpConfig, type AgentRun, type Graded,
} from '../helpers/agent-behaviour-harness.js'

const TURN1 = 'Create the config file for the Larkspur mailer: a file named mailer.conf in this folder containing the single line `smtp_host = localhost`.'
const CORRECTION = 'No — in Larkspur we name config files with .cfg, never .conf. Remember that.'
const SESSION2 = 'Create the Larkspur config file for the mailer.'
const TIMEOUT = 25 * 60_000

const LEARN_TOOLS = new Set(['plur_learn', 'plur_learn_batch'])

/** Every statement text the agent passed to a learn call. */
function learnedStatements(runs: AgentRun[]): string[] {
  const out: string[] = []
  for (const r of runs) {
    for (const c of plurCalls(r).filter(c => LEARN_TOOLS.has(c.name))) {
      if (typeof c.input.statement === 'string') out.push(c.input.statement)
      const items = (c.input.items ?? c.input.engrams ?? c.input.learnings) as unknown
      if (Array.isArray(items)) for (const it of items) if (it && typeof it === 'object' && typeof (it as { statement?: unknown }).statement === 'string') out.push((it as { statement: string }).statement)
    }
  }
  return out
}

function gradeSession1(turn1: AgentRun, turn2: AgentRun, filesAfterTurn1: string[]): { ok: boolean; why: string } {
  if (turn1.timedOut || turn2.timedOut) return { ok: false, why: 'session 1 timed out' }
  if (!filesAfterTurn1.some(f => f.endsWith('.conf'))) {
    return { ok: false, why: `precondition: turn 1 should have written mailer.conf (the mistake to correct); files were: ${filesAfterTurn1.join(', ') || 'none'}` }
  }
  const statements = learnedStatements([turn1, turn2])
  const saved = statements.filter(s => s.includes('.cfg'))
  if (saved.length === 0) {
    return { ok: false, why: `expected a plur_learn call whose statement contains ".cfg" after the correction; learn statements seen: ${JSON.stringify(statements)}; tools in turn 2: ${turn2.toolCalls.map(c => c.name).join(', ') || 'none'}` }
  }
  return { ok: true, why: `saved: ${JSON.stringify(saved[0].slice(0, 120))}` }
}

function gradeSession2(run: AgentRun, files: string[]): { ok: boolean; why: string } {
  if (run.timedOut) return { ok: false, why: 'session 2 timed out' }
  const created = files.filter(f => f !== 'CLAUDE.md')
  const conf = created.filter(f => f.endsWith('.conf'))
  const cfg = created.filter(f => f.endsWith('.cfg'))
  if (conf.length > 0) return { ok: false, why: `the mistake came back: session 2 created ${conf.join(', ')}` }
  if (cfg.length === 0) return { ok: false, why: `expected session 2 to create a .cfg file; it created: ${created.join(', ') || 'nothing'}` }
  return { ok: true, why: `created ${cfg.join(', ')}` }
}

describe('BEH-2 a correction is saved and not repeated in the next session', () => {
  it(`every run (pass^${RUNS}) saves the .cfg correction and uses .cfg in a fresh session`, async () => {
    requireEnabled()
    const auth = authEnv()
    requireMcpBuilt()

    const template = freshDir('beh2-template')
    installClaudeMd(template, auth)

    const control = (async () => {
      // A user without PLUR: empty folder, no CLAUDE.md, no server.
      const cwd = freshDir('beh2-ctl')
      const run = await runSession({ prompt: SESSION2, cwd, home: freshDir('beh2-ctl-home'), auth })
      return { run, files: listFiles(cwd) }
    })()

    const runs = await Promise.all(Array.from({ length: RUNS }, async (_, i) => {
      const n = i + 1
      const store = await seededStore([])
      const mcpConfig = writeMcpConfig(freshDir(`beh2-r${n}-cfg`), store.dir)

      // Session 1: the mistake, then the correction, in one conversation.
      const cwd1 = copyScaffold(template, `beh2-r${n}-s1`)
      const home1 = freshDir(`beh2-r${n}-s1-home`)
      await folderOn(store.dir, cwd1, home1)
      const t1 = await runSession({ prompt: TURN1, cwd: cwd1, home: home1, auth, mcpConfig, persist: true })
      const filesAfterTurn1 = listFiles(cwd1)
      const t2 = t1.sessionId
        ? await runSession({ prompt: CORRECTION, cwd: cwd1, home: home1, auth, mcpConfig, resume: t1.sessionId })
        : { ...t1, toolCalls: [], text: '(turn 1 returned no session id, so the correction could not be sent)' }
      const s1 = gradeSession1(t1, t2, filesAfterTurn1)

      // What is really in the store after session 1 (diagnostic for the report).
      const stored = (await recallFrom(store.dir, 'Larkspur config cfg conf')).filter(s => s.includes('.cfg'))

      // Session 2: a new conversation, new HOME, new folder, the same store.
      const cwd2 = copyScaffold(template, `beh2-r${n}-s2`)
      const home2 = freshDir(`beh2-r${n}-s2-home`)
      await folderOn(store.dir, cwd2, home2)
      const s2run = await runSession({ prompt: SESSION2, cwd: cwd2, home: home2, auth, mcpConfig })
      const s2 = gradeSession2(s2run, listFiles(cwd2))

      const graded: Graded = {
        ok: s1.ok && s2.ok,
        why: `session 1: ${s1.ok ? 'ok' : 'FAIL'} (${s1.why}); store holds a .cfg memory: ${stored.length > 0}; ` +
          `session 2: ${s2.ok ? 'ok' : 'FAIL'} (${s2.why}); session-2 PLUR calls: ${plurCalls(s2run).map(c => c.name).join(', ') || 'none'}; ` +
          `cost s1=$${(t1.costUsd + t2.costUsd).toFixed(3)} s2=$${s2run.costUsd.toFixed(3)}`,
        run: s2run,
      }
      return graded
    }))

    const ctl = await control
    const ctlNote = `control (no PLUR, informative): created ${ctl.files.join(', ') || 'nothing'}; cost=$${ctl.run.costUsd.toFixed(3)}; text: ${JSON.stringify(ctl.run.text.slice(0, 160))}`
    const text = `${report('BEH-2', runs)}\n${ctlNote}`
    logReport(text)
    expect(runs.every(g => g.ok),
      `expected every run to save the .cfg correction in session 1 and create a .cfg (never .conf) file in session 2.\n${text}`).toBe(true)
  }, TIMEOUT)
})
