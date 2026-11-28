/**
 * H2: an event injection (skill, agent, plan mode, subagent) is keyword-first
 * (H1), so on the generated 3,000-engram store in unified mode it delivers the
 * target inside the old 10 s event timeout with the watchdog's margin — on a
 * fresh HOME, embeddings ENABLED (no model on disk, cold cache), which is the
 * path every event of a new install takes. The 15,000-engram variant runs with
 * PLUR_LATENCY_LARGE=1.
 *
 * Temp HOME / PLUR_PATH / TMPDIR only — never ~/.plur.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'
import { buildLargeFixture, writeFixtureStore, LARGE_QUERY, TARGET_ID } from '../../core/test/helpers/injection-fixture.js'

const CLI = builtCliPath(join(__dirname, '..'))
const large = process.env.PLUR_LATENCY_LARGE === '1'

for (const size of [3000, 15000]) {
  describe.skipIf(size > 3000 && !large)(`event path latency, ${size} engrams (H2)`, () => {
    let dir: string
    let env: NodeJS.ProcessEnv

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'plur-event-latency-'))
      writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }))
      mkdirSync(join(dir, 'tmp'), { recursive: true })
      writeFixtureStore(join(dir, '.plur'), buildLargeFixture(size).engrams, 'injection:\n  mode: unified\n')
      env = { ...process.env, HOME: dir, USERPROFILE: dir, TMPDIR: join(dir, 'tmp'), PLUR_PATH: join(dir, '.plur') }
      delete env.PLUR_DISABLE_EMBEDDINGS
      delete env.PLUR_HOOK_HYBRID
      delete env.CLAUDE_SESSION_ID
    }, 120_000)
    afterAll(() => rmSync(dir, { recursive: true, force: true }))

    it('a plan-mode event delivers the target well inside the 9.5 s event budget', () => {
      const t = Date.now()
      const r = runCli('node', [CLI, 'hook-inject', '--event', 'plan_mode'], {
        input: JSON.stringify({ cwd: dir, session_id: 'LAT', hook_event_name: 'PreToolUse', prompt: LARGE_QUERY }),
        encoding: 'utf-8', timeout: 60_000, env, cwd: dir,
      })
      const ms = Date.now() - t
      expect(r.status).toBe(0)
      expect(r.stderr).not.toContain('hybrid injection exceeded')
      const ctx = (JSON.parse(r.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext
      expect(ctx).toContain(TARGET_ID)
      expect(ms).toBeLessThan(9_500)
    }, 120_000)
  })
}
