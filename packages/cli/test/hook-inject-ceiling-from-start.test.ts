import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))
const SLOW_LOCK = join(__dirname, 'helpers', 'slow-store-lock.mjs')
const SLOW_START = join(__dirname, 'fixtures', 'slow-start.mjs')

/**
 * Claude Code kills the first-prompt hook 20s after it STARTS the process
 * (lib/claude-inject-budget.ts). The hook's own watchdog must therefore count
 * from process start, not from the moment the hook's code begins to run:
 * module loading on a busy machine took the hook past 20s in the promise eval
 * for a hung store (HK-3), although the watchdog itself was set to 15s.
 *
 * A slow start (2s, before the CLI loads) and a store whose lock never frees
 * keep the hook running until its watchdog. With the ceiling at 4s, the hook
 * must be gone within ceiling + the bounded lock wait + start-up slack,
 * measured from spawn — not ceiling + lock wait AFTER a slow start.
 *
 * Every test runs against a temp HOME / PLUR_PATH / TMPDIR — never ~/.plur.
 */
let dir: string
let store: string

function env(extra: Record<string, string>): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, HOME: dir, USERPROFILE: dir, TMPDIR: join(dir, 'tmp'), PLUR_PATH: store }
  delete e.PLUR_HOOK_NO_EXIT
  return { ...e, ...extra }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plur-ceiling-from-start-'))
  store = join(dir, '.plur')
  mkdirSync(join(dir, 'tmp'), { recursive: true })
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }))
  const seeded = runCli('node', [CLI, 'learn', 'codeword basalt-heron: the ceiling counts from process start', '--json'], {
    encoding: 'utf-8', timeout: 20_000, env: { ...env({}), PLUR_DISABLE_EMBEDDINGS: '1' }, cwd: dir,
  })
  expect(seeded.status).toBe(0)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('the hook-inject watchdog counts from process start', () => {
  it('a slow start does not add to the ceiling', async () => {
    const { WATCHDOG_LOCK_WAIT_MS } = await import('../src/commands/hook-inject.js')
    const CEILING_MS = 4_000
    const SLOW_START_MS = 2_000
    const started = Date.now()
    const r = runCli('node', ['--import', SLOW_START, '--import', SLOW_LOCK, CLI, 'hook-inject'], {
      input: JSON.stringify({ session_id: 'ceiling-from-start', hook_event_name: 'UserPromptSubmit', prompt: 'basalt-heron codeword' }),
      encoding: 'utf-8', timeout: 40_000, cwd: dir,
      env: env({
        PLUR_HOOK_HYBRID: '0', PLUR_HOOK_CEILING_MS: String(CEILING_MS),
        PLUR_TEST_SLOW_START_MS: String(SLOW_START_MS), PLUR_TEST_LOCK_ACQUIRE_DELAYS_MS: '30000',
      }),
    })
    const elapsed = Date.now() - started
    expect(r.status, r.stderr).toBe(0)
    // Counted from process start the hook is gone by ceiling + lock wait (+ 1.5s for node itself);
    // counted from when its code ran, it would also spend the slow start.
    expect(elapsed, `the hook ran ${elapsed} ms from spawn; ceiling ${CEILING_MS} ms + lock wait ${WATCHDOG_LOCK_WAIT_MS} ms`)
      .toBeLessThan(CEILING_MS + WATCHDOG_LOCK_WAIT_MS + 1_500)
  }, 60_000)
})
