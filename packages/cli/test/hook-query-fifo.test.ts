/**
 * H11: the W5 query-context readers (git HEAD, the transcript tail) open with
 * O_NONBLOCK and read only regular files. A FIFO planted as `.git/HEAD` or
 * passed as `transcript_path` used to block the hook's synchronous open
 * forever — the watchdog timer cannot fire while the main thread is blocked,
 * so the editor killed the hook at its timeout.
 *
 * Spawned (an in-process open would hang the test worker). Temp dirs only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFileSync, spawnSync } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))

describe.skipIf(process.platform === 'win32')('hook query readers never block on a FIFO (H11)', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-fifo-'))
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }))
    mkdirSync(join(dir, 'tmp'))
    mkdirSync(join(dir, '.git'))
    execFileSync('mkfifo', [join(dir, '.git', 'HEAD')])
    execFileSync('mkfifo', [join(dir, 'transcript.jsonl')])
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('a skill event with a FIFO HEAD and FIFO transcript finishes', () => {
    const r = spawnSync(process.execPath, [CLI, 'hook-inject', '--event', 'skill'], {
      input: JSON.stringify({ cwd: dir, session_id: 'FIFO', hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'review' }, transcript_path: join(dir, 'transcript.jsonl') }),
      encoding: 'utf-8', timeout: 20_000, cwd: dir,
      env: { ...process.env, HOME: dir, USERPROFILE: dir, TMPDIR: join(dir, 'tmp'), PLUR_PATH: join(dir, '.plur'), PLUR_DISABLE_EMBEDDINGS: '1' },
    })
    // A blocked open never exits: spawnSync's timeout kills it (error ETIMEDOUT, status null).
    expect(r.error).toBeUndefined()
    expect(r.status).toBe(0)
  }, 30_000)
})
