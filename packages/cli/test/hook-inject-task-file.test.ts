import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, lstatSync, symlinkSync, existsSync, readdirSync, chmodSync,
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))
const SID = '0f0e0d0c-aaaa-bbbb-cccc-123456789abc'
const posix = process.platform !== 'win32'

/**
 * hook-inject keeps the latest prompt per Claude Code session in
 * `$TMPDIR/plur-sessions/<session>.task` so rehydration after compaction has a
 * query. On Linux `$TMPDIR` is usually the shared /tmp, so that file is a copy
 * of the user's prompt in a shared directory. It must not be readable by other
 * users, and a planted symlink must not redirect the write.
 */
describe.skipIf(!posix)('hook-inject session task file', () => {
  let dir: string
  let env: NodeJS.ProcessEnv
  let sessions: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-task-file-'))
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }))
    mkdirSync(join(dir, 'tmp'), { recursive: true })
    sessions = join(dir, 'tmp', 'plur-sessions')
    env = {
      ...process.env,
      HOME: dir,
      USERPROFILE: dir,
      TMPDIR: join(dir, 'tmp'),
      PLUR_PATH: join(dir, '.plur'),
      PLUR_DISABLE_EMBEDDINGS: '1',
    }
  })

  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function prompt(text: string, args: string[] = []): { stdout: string; status: number } {
    const r = runCli('node', [CLI, 'hook-inject', ...args], {
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: SID, prompt: text }),
      encoding: 'utf-8', timeout: 20_000, env, cwd: dir,
    })
    return { stdout: r.stdout ?? '', status: r.status ?? 1 }
  }

  const mode = (p: string) => lstatSync(p).mode & 0o777

  it('creates the session dir 0700 and the task file 0600', () => {
    expect(prompt('first prompt').status).toBe(0)
    expect(mode(sessions)).toBe(0o700)
    const task = join(sessions, `${SID}.task`)
    expect(lstatSync(task).isFile()).toBe(true)
    expect(mode(task)).toBe(0o600)
    expect(readFileSync(task, 'utf8')).toBe('first prompt')
  }, 30_000)

  it('tightens an existing 0755 session dir it owns', () => {
    mkdirSync(sessions, { mode: 0o755 })
    chmodSync(sessions, 0o755)
    prompt('first prompt')
    expect(mode(sessions)).toBe(0o700)
  }, 30_000)

  it('does not write through a symlink planted at the task path', () => {
    mkdirSync(sessions, { mode: 0o700 })
    const victim = join(dir, 'victim.txt')
    writeFileSync(victim, 'original')
    symlinkSync(victim, join(sessions, `${SID}.task`))

    expect(prompt('the prod DB password is hunter2').status).toBe(0)

    expect(readFileSync(victim, 'utf8')).toBe('original')
    const task = join(sessions, `${SID}.task`)
    expect(lstatSync(task).isSymbolicLink()).toBe(false)
    expect(mode(task)).toBe(0o600)
  }, 30_000)

  it('refuses a session dir that is a symlink, and writes nothing through it', () => {
    const elsewhere = join(dir, 'elsewhere')
    mkdirSync(elsewhere, { mode: 0o700 })
    symlinkSync(elsewhere, sessions)

    const r = prompt('secret prompt text')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('hookSpecificOutput') // the prompt still gets memory
    expect(readdirSync(elsewhere)).toEqual([])
  }, 30_000)

  it('stores a length-capped query, not the whole prompt', () => {
    prompt('x'.repeat(20_000))
    const stored = readFileSync(join(sessions, `${SID}.task`), 'utf8')
    expect(stored.length).toBeLessThanOrEqual(1000)
    expect(stored.length).toBeGreaterThan(0)
  }, 30_000)

  it('the per-prompt rewrite keeps 0600 and leaves no temp files', () => {
    prompt('first prompt')
    prompt('second prompt')
    const task = join(sessions, `${SID}.task`)
    expect(readFileSync(task, 'utf8')).toBe('second prompt')
    expect(mode(task)).toBe(0o600)
    expect(readdirSync(sessions).filter((f) => f.endsWith('.tmp'))).toEqual([])
  }, 30_000)

  it('hook-session-end removes the task file', () => {
    prompt('first prompt')
    const task = join(sessions, `${SID}.task`)
    expect(existsSync(task)).toBe(true)
    const r = runCli('node', [CLI, 'hook-session-end'], {
      input: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: SID, reason: 'exit' }),
      encoding: 'utf-8', timeout: 20_000, env, cwd: dir,
    })
    expect(r.status).toBe(0)
    expect(existsSync(task)).toBe(false)
  }, 30_000)
})
