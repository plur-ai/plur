// BEH-3: When I tell my agent to remember something, it is saved, and in the next session it uses it.
//
// kind: agent — REAL headless Claude Code sessions (sonnet, ≤ $0.50 and ≤ 8
// turns per invocation), graded deterministically from the stream-json
// transcripts, the store reopened after session 1, and the files session 2
// leaves behind. Opt-in: runs only with PLUR_AGENT_EVALS=1; otherwise it FAILS
// with "agent eval not run (set PLUR_AGENT_EVALS=1)". Auth:
// CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY. Harness and isolation rules:
// ../helpers/agent-behaviour-harness.ts; graders (proven on synthetic
// transcripts in agent-behaviour-graders.unit.test.ts):
// ../helpers/agent-behaviour-graders.ts.
//
// This is the explicit-save scenario: the user SAYS "remember". (BEH-2 is the
// unprompted one: a correction with no instruction to save it.)
//
// Route under test: the MCP server alone (packages/mcp/dist), plus the CLAUDE.md
// section `plur-mcp init` writes. NO hooks. The working folders are switched on
// in the folder map first (`plur folders set --on`) — the user's consent, given
// before the agent runs.
//
// Each run (pass^3):
//  Session 1: "Remember this: Larkspur keeps its log files for 11 days."
//    Grade: a plur_learn call that SUCCEEDED, whose statement says Larkspur
//    logs are kept 11 days (Larkspur named, no other day count, not negated
//    before or after), AND that memory is in the store when it is reopened.
//  Session 2: new HOME, new working folder, SAME store. "Write the number of
//    days Larkspur keeps its log files into retention.txt." Grade: a PLUR
//    lookup in this session whose JSON payload succeeded RETURNED a memory
//    holding the complete saved statement (not an echoed query or a truncated
//    prefix), and retention.txt is exactly `11` ("Not 11. Unknown." fails).
// Control (graded, one run): session 2 with no PLUR at all must NOT write 11 —
// otherwise the number is guessable and the memory arm proves nothing.
// A run with PLUR_AGENT_EVAL_RUNS below 3 is diagnostic and fails as
// non-certifying.
import { describe, expect, it } from 'vitest'
import {
  RUNS, authEnv, copyScaffold, folderOn, freshDir, installClaudeMd, logReport, persistedStatements, plurCalls, readFiles, report,
  requireCertifying, requireEnabled, requireMcpBuilt, runSession, seededStore, writeMcpConfig, type Graded,
} from '../helpers/agent-behaviour-harness.js'
import { gradeRetentionFile, gradeRetrieved, gradeSaved, saysElevenDays } from '../helpers/agent-behaviour-graders.js'

const SESSION1 = 'Remember this: Larkspur keeps its log files for 11 days.'
const SESSION2 = 'Write the number of days Larkspur keeps its log files into a file named retention.txt in this folder — just the number.'
const TIMEOUT = 25 * 60_000

describe('BEH-3 what I tell my agent to remember is saved and used in the next session', () => {
  it(`every run (pass^${RUNS}) saves the fact when asked and uses it in a fresh session; without PLUR the number is not guessed`, async () => {
    requireEnabled()
    const auth = authEnv()
    requireMcpBuilt()

    const template = freshDir('beh3-template')
    installClaudeMd(template, auth)

    const control = (async () => {
      const cwd = freshDir('beh3-ctl')
      const run = await runSession({ prompt: SESSION2, cwd, home: freshDir('beh3-ctl-home'), auth })
      const files = readFiles(cwd)
      const guessed = /\b11\b/.test(files['retention.txt'] ?? '')
      return { run, files, ok: !guessed && !(run.timedOut || (run.isError && !run.text)) }
    })()

    const runs = await Promise.all(Array.from({ length: RUNS }, async (_, i) => {
      const n = i + 1
      const store = await seededStore([])
      const mcpConfig = writeMcpConfig(freshDir(`beh3-r${n}-cfg`), store.dir)

      const cwd1 = copyScaffold(template, `beh3-r${n}-s1`)
      const home1 = freshDir(`beh3-r${n}-s1-home`)
      await folderOn(store.dir, cwd1, home1)
      const s1run = await runSession({ prompt: SESSION1, cwd: cwd1, home: home1, auth, mcpConfig })
      const persisted = await persistedStatements(store.dir)
      const s1 = gradeSaved([s1run], persisted, saysElevenDays, 'Larkspur logs are kept 11 days')

      const cwd2 = copyScaffold(template, `beh3-r${n}-s2`)
      const home2 = freshDir(`beh3-r${n}-s2-home`)
      await folderOn(store.dir, cwd2, home2)
      const s2run = await runSession({ prompt: SESSION2, cwd: cwd2, home: home2, auth, mcpConfig })
      const file = s2run.timedOut ? { ok: false, why: 'session 2 timed out' } : gradeRetentionFile(readFiles(cwd2))
      const used = s1.stored ? gradeRetrieved(s2run, s1.stored) : { ok: false, why: 'nothing correct was saved, so nothing could be retrieved' }

      const graded: Graded = {
        ok: s1.ok && file.ok && used.ok,
        why: `session 1: ${s1.ok ? 'ok' : 'FAIL'} (${s1.why}); session 2 file: ${file.ok ? 'ok' : 'FAIL'} (${file.why}); ` +
          `session 2 used the memory: ${used.ok ? 'ok' : 'FAIL'} (${used.why}); ` +
          `session-2 PLUR calls: ${plurCalls(s2run).map(c => c.name).join(', ') || 'none'}; ` +
          `cost s1=$${s1run.costUsd.toFixed(3)} s2=$${s2run.costUsd.toFixed(3)}`,
        run: s2run,
      }
      return graded
    }))

    const ctl = await control
    const ctlNote = `control (no PLUR, graded): ${ctl.ok ? 'ok' : 'FAIL'}; retention.txt=${JSON.stringify((ctl.files['retention.txt'] ?? '(none)').slice(0, 40))}; ` +
      `cost=$${ctl.run.costUsd.toFixed(3)}; text: ${JSON.stringify(ctl.run.text.slice(0, 160))}`
    const text = `${report('BEH-3', runs)}\n${ctlNote}`
    logReport(text)
    expect(runs.every(g => g.ok),
      `expected every run to save "logs are kept 11 days" when told to remember it (successfully, and on disk), and in session 2 to retrieve it and write 11 into retention.txt.\n${text}`).toBe(true)
    expect(ctl.ok, `without PLUR the agent wrote 11 (or produced nothing), so the memory arm would prove nothing.\n${ctlNote}`).toBe(true)
    requireCertifying()
  }, TIMEOUT)
})
