/**
 * W2+4 (overhaul): an event-path injection runs the same pipeline as the
 * session-start path. On the generated 3,000-engram store in unified mode, a
 * plan-mode event with the same query delivers the same target engram the
 * first prompt does, and leaves the pins out of the context that has them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'
import { buildLargeFixture, writeFixtureStore, LARGE_QUERY, TARGET_ID } from '../../core/test/helpers/injection-fixture.js'

const CLI = builtCliPath(join(__dirname, '..'))

describe('event path = session-start path (W2+4)', () => {
  let dir: string
  let env: NodeJS.ProcessEnv
  let pinIds: string[]

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-event-pipeline-'))
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }))
    mkdirSync(join(dir, 'tmp'), { recursive: true })
    const fixture = buildLargeFixture(3000)
    pinIds = fixture.pins.map(p => p.id)
    writeFixtureStore(join(dir, '.plur'), fixture.engrams, 'injection:\n  mode: unified\n')
    env = {
      ...process.env,
      HOME: dir, USERPROFILE: dir, TMPDIR: join(dir, 'tmp'),
      PLUR_PATH: join(dir, '.plur'),
      PLUR_DISABLE_EMBEDDINGS: '1',
    }
  }, 60_000)
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  function run(args: string[], input: object): string {
    const r = runCli('node', [CLI, 'hook-inject', ...args], {
      input: JSON.stringify({ cwd: dir, ...input }), encoding: 'utf-8', timeout: 60_000, env, cwd: dir,
    })
    expect(r.status).toBe(0)
    const out = (r.stdout ?? '').trim()
    return out ? (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext : ''
  }

  it('the plan-mode event delivers the session-start target, without the pins', () => {
    const first = run([], { session_id: 'E1', hook_event_name: 'UserPromptSubmit', prompt: LARGE_QUERY })
    expect(first).toContain(TARGET_ID)
    expect(pinIds.some(id => first.includes(id))).toBe(true)
    const ev = run(['--event', 'plan_mode'], { session_id: 'E1', hook_event_name: 'PreToolUse', prompt: LARGE_QUERY })
    expect(ev).toContain(TARGET_ID)
    expect(pinIds.some(id => ev.includes(id))).toBe(false)
  }, 120_000)
})
