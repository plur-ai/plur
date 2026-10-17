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
//    turn 2  the user corrects: ".cfg, never .conf." — and says NOTHING about
//            remembering it. The promise is about corrections being saved
//            without being told to; "Remember that." would turn this into the
//            explicit-save promise (BEH-3) and let the server's "save when asked"
//            rule pass it (the earlier planted bug survived for that reason).
//  Two turns, not one prompt holding both, because the promise is about a
//  correction that arrives AFTER the agent acted.
//  Grade session 1: a plur_learn call that SUCCEEDED and whose statement says
//  config files use .cfg (and .conf only negated — "never use .cfg; use .conf"
//  fails), AND that memory is in the store when it is reopened afterwards.
//  Session 2: new HOME, new working folder (switched on), SAME store. The user
//  asks for the mailer config file by base name and content, not extension.
//  Grade: the agent retrieved the saved correction through PLUR in this session
//  (a successful lookup whose reply carries the saved text), and it wrote
//  exactly mailer.cfg holding `smtp_host = localhost`, with no .conf file.
// Control (informative, one run, not graded): session 2 with no PLUR at all —
// what does the agent write on its own? Printed beside the verdict.
// Graders: ../helpers/agent-behaviour-graders.ts, proven on synthetic
// transcripts in agent-behaviour-graders.unit.test.ts. A run with
// PLUR_AGENT_EVAL_RUNS below 3 is diagnostic and fails as non-certifying.
//
// The MCP server runs from dist: a planted bug under packages/mcp/src reaches
// the agent only after `pnpm --filter @plur-ai/mcp build` (bite.py does not
// rebuild — see evals/mutants/manual/BEH-2-2.patch, which acknowledges a save
// without persisting it).
import { describe, expect, it } from 'vitest'
import {
  RUNS, authEnv, copyScaffold, folderOn, freshDir, installClaudeMd, listFiles, logReport, persistedStatements, plurCalls, readFiles, report,
  requireCertifying, requireEnabled, requireMcpBuilt, runSession, seededStore, writeMcpConfig, type Graded,
} from '../helpers/agent-behaviour-harness.js'
import { gradeRequestedFile, gradeRetrieved, gradeSaved, saysCfgNotConf } from '../helpers/agent-behaviour-graders.js'

const TURN1 = 'Create the config file for the Larkspur mailer: a file named mailer.conf in this folder containing the single line `smtp_host = localhost`.'
const CORRECTION = 'No — in Larkspur we name config files with .cfg, never .conf.'
const SESSION2 = 'Create the config file for the Larkspur mailer in this folder: base name `mailer`, containing the single line `smtp_host = localhost`.'
const EXPECTED_FILE = 'mailer.cfg'
const EXPECTED_LINE = 'smtp_host = localhost'
const TIMEOUT = 25 * 60_000

describe('BEH-2 a correction is saved and not repeated in the next session', () => {
  it(`every run (pass^${RUNS}) saves the .cfg correction unprompted and uses it in a fresh session`, async () => {
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
      const madeMistake = filesAfterTurn1.some(f => f.endsWith('.conf'))
      // What is REALLY in the store after session 1: a fresh instance reopens it.
      const persisted = await persistedStatements(store.dir)
      const s1 = madeMistake
        ? gradeSaved([t1, t2], persisted, saysCfgNotConf, 'config files use .cfg, not .conf')
        : { ok: false, why: `precondition: turn 1 should have written mailer.conf (the mistake to correct); files were: ${filesAfterTurn1.join(', ') || 'none'}` }

      // Session 2: a new conversation, new HOME, new folder, the same store.
      const cwd2 = copyScaffold(template, `beh2-r${n}-s2`)
      const home2 = freshDir(`beh2-r${n}-s2-home`)
      await folderOn(store.dir, cwd2, home2)
      const s2run = await runSession({ prompt: SESSION2, cwd: cwd2, home: home2, auth, mcpConfig })
      const file = s2run.timedOut ? { ok: false, why: 'session 2 timed out' } : gradeRequestedFile(readFiles(cwd2), EXPECTED_FILE, EXPECTED_LINE, /\.conf$/)
      const used = 'stored' in s1 && s1.stored ? gradeRetrieved(s2run, s1.stored) : { ok: false, why: 'nothing correct was saved, so nothing could be retrieved' }

      const graded: Graded = {
        ok: s1.ok && file.ok && used.ok,
        why: `session 1: ${s1.ok ? 'ok' : 'FAIL'} (${s1.why}); ` +
          `session 2 file: ${file.ok ? 'ok' : 'FAIL'} (${file.why}); session 2 used the memory: ${used.ok ? 'ok' : 'FAIL'} (${used.why}); ` +
          `session-2 PLUR calls: ${plurCalls(s2run).map(c => c.name).join(', ') || 'none'}; ` +
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
      `expected every run to save the .cfg correction in session 1 (successfully, and on disk), and in session 2 to retrieve it and write ${EXPECTED_FILE} (never .conf).\n${text}`).toBe(true)
    requireCertifying()
  }, TIMEOUT)
})
