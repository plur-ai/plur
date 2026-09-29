import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))
const SIGNAL = 'CORRECTION SIGNAL DETECTED'

/**
 * #1312: `hook-correction-detect` was never registered by any installer, so
 * the reminder it produces never fired. It is folded into the UserPromptSubmit
 * output of `hook-inject` — one process, one hookSpecificOutput — rather than
 * registered as a second per-prompt process.
 */
describe('hook-inject folds in correction detection (#1312)', () => {
  let dir: string
  let sessions: string
  let env: NodeJS.ProcessEnv

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-inject-correction-'))
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }))
    mkdirSync(join(dir, 'tmp'), { recursive: true })
    sessions = join(dir, 'tmp', 'plur-sessions')
    env = {
      ...process.env,
      HOME: dir, USERPROFILE: dir, TMPDIR: join(dir, 'tmp'), PLUR_PATH: join(dir, '.plur'),
      PLUR_DISABLE_EMBEDDINGS: '1',
    }
    delete env.CLAUDE_SESSION_ID
  })

  afterAll(() => { rmSync(dir, { recursive: true, force: true }) })
  beforeEach(() => { rmSync(sessions, { recursive: true, force: true }) })

  function hook(payload: Record<string, unknown>, args: string[] = []): string {
    const r = runCli('node', [CLI, 'hook-inject', ...args], {
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', ...payload }),
      encoding: 'utf-8', timeout: 30_000, env, cwd: dir,
    })
    expect(r.status).toBe(0)
    return r.stdout ?? ''
  }

  function context(stdout: string): string {
    const parsed = JSON.parse(stdout) as any
    expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit')
    return parsed.hookSpecificOutput.additionalContext as string
  }

  it('first prompt: the reminder is appended to the injection, in the same output', () => {
    const ctx = context(hook({ session_id: 'c-1', prompt: 'No, from now on always run the tests first.' }))
    expect(ctx).toContain('session started')
    expect(ctx).toContain(SIGNAL)
    expect(ctx).toContain('"from now on"')
  }, 60_000)

  it('first prompt without a correction: the injection only', () => {
    const ctx = context(hook({ session_id: 'c-2', prompt: 'show me the diff' }))
    expect(ctx).toContain('session started')
    expect(ctx).not.toContain(SIGNAL)
  }, 60_000)

  it('later prompt with a correction: the reminder alone', () => {
    hook({ session_id: 'c-3', prompt: 'start' })
    const ctx = context(hook({ session_id: 'c-3', prompt: 'you got that wrong, I prefer tabs' }))
    expect(ctx).toContain(SIGNAL)
    expect(ctx).not.toContain('session started')
    expect(ctx).not.toContain('Memory Reminder')
  }, 60_000)

  it('later prompt without a correction: nothing at all', () => {
    hook({ session_id: 'c-4', prompt: 'start' })
    expect(hook({ session_id: 'c-4', prompt: 'run the tests' })).toBe('')
  }, 60_000)

  for (const text of ['no problem, take your time', 'actually that works for me', 'wait a sec']) {
    it(`known false positive adds nothing: "${text}"`, () => {
      hook({ session_id: `c-fp-${text.length}`, prompt: 'start' })
      expect(hook({ session_id: `c-fp-${text.length}`, prompt: text })).toBe('')
    }, 60_000)
  }

  it('the 10-minute reminder and a correction share one output', () => {
    hook({ session_id: 'c-5', prompt: 'start' })
    const t = (Date.now() - 11 * 60 * 1000) / 1000
    utimesSync(join(sessions, 'c-5.reminded'), t, t)
    const out = hook({ session_id: 'c-5', prompt: 'never edit files without reading them first' })
    const ctx = context(out)
    expect(ctx).toContain('Memory Reminder')
    expect(ctx).toContain(SIGNAL)
  }, 60_000)

  it('the rehydrate after compaction carries no correction reminder', () => {
    hook({ session_id: 'c-6', prompt: 'No, from now on use pnpm' })
    const out = hook({ hook_event_name: 'SessionStart', source: 'compact', session_id: 'c-6' }, ['--rehydrate'])
    const parsed = JSON.parse(out) as any
    expect(parsed.hookSpecificOutput.additionalContext).not.toContain(SIGNAL)
  }, 60_000)

  it('the standalone hook-correction-detect command keeps working', () => {
    const r = runCli('node', [CLI, 'hook-correction-detect'], {
      input: JSON.stringify({ prompt: 'No, that is wrong' }), encoding: 'utf-8', timeout: 30_000, env, cwd: dir,
    })
    expect(r.status).toBe(0)
    expect(context(r.stdout ?? '')).toContain(SIGNAL)
    const quiet = runCli('node', [CLI, 'hook-correction-detect'], {
      input: JSON.stringify({ prompt: 'thanks' }), encoding: 'utf-8', timeout: 30_000, env, cwd: dir,
    })
    expect(quiet.stdout).toBe('')
  }, 60_000)
})
