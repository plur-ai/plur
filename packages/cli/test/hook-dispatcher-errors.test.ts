import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))

/**
 * Owner decision H1 (formal field report, cluster 5, "a stopped run prints
 * nothing"): hook commands never print errors to stdout.
 *
 * An editor parses a hook's stdout as its result, and treats a non-zero exit
 * as a hook error. The CLI dispatcher's catch printed `{"error": …}` on stdout
 * and exited 1 for EVERY command — so a hook-inject whose injection threw
 * (including a run the watchdog had already stopped, while its exit waited for
 * the store) handed the editor an error document and a failed hook.
 *
 * Now: for `hook-*` commands the error goes to stderr and the exit is 0.
 * Every other command is unchanged. Temp HOME / PLUR_PATH / TMPDIR only.
 */
describe('hook commands never print errors to stdout (decision H1)', () => {
  let dir: string
  let env: NodeJS.ProcessEnv
  let broken: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-hook-dispatch-'))
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }))
    mkdirSync(join(dir, 'tmp'), { recursive: true })
    broken = join(dir, 'broken-store')
    mkdirSync(broken, { recursive: true })
    // Invalid YAML: the store refuses to load, so the command throws.
    writeFileSync(join(broken, 'engrams.yaml'), 'engrams: [\n  - {bad')
    env = {
      ...process.env,
      HOME: dir, USERPROFILE: dir, TMPDIR: join(dir, 'tmp'), PLUR_PATH: broken,
      PLUR_DISABLE_EMBEDDINGS: '1',
    }
    delete env.CLAUDE_SESSION_ID
  })

  afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

  it('a hook-inject whose injection throws: nothing on stdout, the error on stderr, exit 0', () => {
    const r = runCli('node', [CLI, 'hook-inject'], {
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'dispatch-1', prompt: 'first' }),
      encoding: 'utf-8', timeout: 30_000, env, cwd: dir,
    })
    expect(r.stdout).toBe('')
    expect(r.stderr).toMatch(/\[plur\] hook-inject failed: .+/)
    expect(r.status).toBe(0)
  }, 60_000)

  it('the same holds with --json forced: a hook prints no error document', () => {
    const r = runCli('node', [CLI, 'hook-inject', '--json'], {
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'dispatch-2', prompt: 'first' }),
      encoding: 'utf-8', timeout: 30_000, env, cwd: dir,
    })
    expect(r.stdout).toBe('')
    expect(r.status).toBe(0)
  }, 60_000)

  it('a non-hook command is unchanged: {"error"} on stdout and exit 1', () => {
    const r = runCli('node', [CLI, 'recall', 'anything', '--json'], {
      encoding: 'utf-8', timeout: 30_000, env, cwd: dir,
    })
    expect(r.stdout).toContain('"error"')
    expect(r.status).toBe(1)
  }, 60_000)
})

/**
 * #1422, carry-over from #1349: the dispatcher's hook-error exit must not land
 * inside a store write of its own process.
 *
 * A hook-inject that misses its hybrid deadline leaves that search running, and
 * it records its injection under `engrams.yaml.lock`. If the BM25 fallback that
 * serves the turn then throws, the dispatcher's catch is where the process
 * ends. A bare `process.exit(0)` there drops the write mid-way: the lock, or
 * its private publish file (#1354), stays behind for every later writer.
 *
 * helpers/bm25-throws-while-writing.mjs makes the fallback throw once a store
 * lock operation is in flight; helpers/slow-store-lock.mjs holds that write
 * open long enough for an early exit to be caught every time. The real hybrid
 * leg runs (it is the write in flight). Temp HOME / PLUR_PATH / TMPDIR only.
 */
describe('a hook that throws while a store write is in flight (#1422, #1349)', () => {
  const SLOW_LOCK = join(__dirname, 'helpers', 'slow-store-lock.mjs')
  const BM25_THROWS = join(__dirname, 'helpers', 'bm25-throws-while-writing.mjs')
  let dir: string
  let store: string

  function env(extra: Record<string, string>): NodeJS.ProcessEnv {
    const e: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: dir, USERPROFILE: dir, TMPDIR: join(dir, 'tmp'), PLUR_PATH: store,
    }
    delete e.PLUR_DISABLE_EMBEDDINGS
    delete e.PLUR_HOOK_HYBRID
    delete e.PLUR_HOOK_NO_EXIT
    delete e.CLAUDE_SESSION_ID
    return { ...e, ...extra }
  }

  // The lock and anything the lock protocol leaves beside it.
  const locksLeft = () => readdirSync(store).filter(f => f.startsWith('engrams.yaml.lock'))

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-hook-dispatch-lock-'))
    store = join(dir, '.plur')
    mkdirSync(join(dir, 'tmp'), { recursive: true })
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }))
    const seeded = runCli('node', [CLI, 'learn', 'codeword basalt-heron: a hook error exit waits for the store', '--json'], {
      encoding: 'utf-8', timeout: 20_000, env: { ...env({}), PLUR_DISABLE_EMBEDDINGS: '1' }, cwd: dir,
    })
    expect(seeded.status).toBe(0)
  })

  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function runThrowingHook(sessionId: string, extra: Record<string, string>) {
    return runCli('node', ['--import', SLOW_LOCK, '--import', BM25_THROWS, CLI, 'hook-inject', '--json'], {
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: 'basalt-heron codeword' }),
      encoding: 'utf-8', timeout: 40_000, cwd: dir,
      env: env({ PLUR_HOOK_HYBRID_DEADLINE_MS: '1', PLUR_TEST_BM25_THROWS_WHILE_WRITING: '1', ...extra }),
    })
  }

  it('thrown while the lock is being published: exits after the write, nothing on stdout, no lock or publish file left', () => {
    const r = runThrowingHook('dispatch-lock-1', { PLUR_TEST_LOCK_PRE_OPEN_DELAYS_MS: '1500' })
    // The race really happened: the throw came with a store write in flight.
    expect(r.stderr).toContain('[plur] hook-inject failed: test fault: BM25 fallback failed while a store write was in flight')
    expect(r.stdout).toBe('')
    expect(r.status).toBe(0)
    expect(locksLeft()).toEqual([])
  }, 60_000)

  it('thrown while the lock is held: exits after the write, nothing on stdout, no lock or publish file left', () => {
    const r = runThrowingHook('dispatch-lock-2', {
      PLUR_TEST_LOCK_ACQUIRE_DELAYS_MS: '2000', PLUR_TEST_BM25_THROW_AFTER_MS: '300',
    })
    expect(r.stderr).toContain('[plur] hook-inject failed: test fault: BM25 fallback failed while a store write was in flight')
    expect(r.stdout).toBe('')
    expect(r.status).toBe(0)
    expect(locksLeft()).toEqual([])
  }, 60_000)
})
