import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
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
