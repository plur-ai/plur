/**
 * #1228 × #1353 merge: hook-inject keeps main's lock structure (watchdog
 * release, the 2-attempt cap, release in a finally) but takes the lock with
 * #1228's O_EXCL `takeInjectLock`. With a stat-then-write lock, hooks that
 * fire together all see "no lock", all write one and all run the full
 * injection. With O_EXCL exactly one wins; the rest bail before counting an
 * attempt, so the cap is charged once. The barrier preload
 * (helpers/inject-lock-barrier.mjs) lines the runs up at the lock; on main's
 * stat-then-write lock this test fails with every run injecting.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import { pathToFileURL } from 'url'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = process.env.PLUR_R2_CLI ?? builtCliPath(join(__dirname, '..'))
const BARRIER = pathToFileURL(join(__dirname, 'helpers', 'inject-lock-barrier.mjs')).href

describe('concurrent hook-inject runs on one session key', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plur-inject-race-'))
    mkdirSync(join(home, 'tmp'), { recursive: true })
    writeFileSync(join(home, '.mcp.json'), JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }))
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  const N = 6
  let barrierDir: string
  function injectAsync(): Promise<string> {
    return new Promise(resolve => {
      // The barrier preload makes every run reach the lock at the same moment.
      const child = spawn('node', ['--import', BARRIER, CLI, 'hook-inject'], {
        cwd: home,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          TMPDIR: join(home, 'tmp'),
          PLUR_PATH: join(home, '.plur'),
          PLUR_DISABLE_EMBEDDINGS: '1',
          PLUR_TEST_BARRIER_DIR: barrierDir,
          PLUR_TEST_BARRIER_N: String(N),
        },
      })
      let out = ''
      child.stdout.on('data', d => { out += d })
      child.on('close', () => resolve(out))
      child.stdin.end(JSON.stringify({ prompt: 'race', session_id: 'race-key' }))
    })
  }

  it('exactly one run injects; the others bail without charging the attempt cap', async () => {
    barrierDir = mkdtempSync(join(home, 'barrier-'))
    const outs = await Promise.all(Array.from({ length: N }, () => injectAsync()))
    const started = outs.filter(o => o.includes('session started'))
    const dir = join(home, 'tmp', 'plur-sessions')
    const seen = JSON.stringify({ outs: outs.map(o => o.slice(0, 80)), barrier: readdirSync(barrierDir), state: existsSync(dir) ? readdirSync(dir) : [] })
    expect(started, seen).toHaveLength(1)
    expect(outs.filter(o => o !== ''), seen).toHaveLength(1) // the others print nothing
    // One attempt counted (cap is 2), and no lock left behind.
    expect(readFileSync(join(dir, 'race-key.attempts'), 'utf8')).toBe('1')
    expect(existsSync(dir) ? readdirSync(dir).filter(f => f.includes('.injecting')) : []).toEqual([])
  }, 120_000)
})
