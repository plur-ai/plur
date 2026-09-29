import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, utimesSync } from 'fs'
import { join } from 'path'
import { tmpdir, hostname } from 'os'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'
import { injectForHook, waitForOwnStoreLock, HOOK_CEILING_DEFAULT_MS } from '../src/commands/hook-inject.js'
import { CLAUDE_INJECT_TIMEOUT_S } from '../src/lib/claude-inject-budget.js'

const CLI = builtCliPath(join(__dirname, '..'))

/**
 * #1313: the UserPromptSubmit and SessionStart(compact) injections are
 * registered synchronously so the first reply (and every one-shot
 * `claude -p`) has memory. A sync hook has a hard budget, so the hook must
 * bound its own work below it: hybrid on a soft deadline, then BM25, and a
 * watchdog below the registered timeout.
 */
describe('hook-inject bounds its sync first-prompt injection (#1313)', () => {
  it('falls back to BM25 when hybrid misses the deadline, instead of waiting on it', async () => {
    const bm25 = { count: 1, directives: 'bm25 result' }
    const plur = {
      injectHybrid: () => new Promise<typeof bm25>(() => { /* never settles: a hung embedder */ }),
      inject: async () => bm25,
    }
    const started = Date.now()
    const { result, mode } = await injectForHook(plur, 'task', {}, 100)
    expect(result).toBe(bm25)
    expect(mode).toBe('bm25')
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('uses the hybrid result when it arrives inside the deadline', async () => {
    const hybrid = { count: 2, directives: 'hybrid result' }
    const plur = { injectHybrid: async () => hybrid, inject: async () => ({ count: 0 }) }
    const { result, mode } = await injectForHook(plur, 'task', {}, 1_000)
    expect(result).toBe(hybrid)
    expect(mode).toBe('hybrid')
  })

  it('the first-prompt hook itself takes the bounded path: a missed deadline is served by BM25', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plur-inject-sync-'))
    try {
      writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }))
      mkdirSync(join(dir, 'tmp'), { recursive: true })
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: dir, USERPROFILE: dir, TMPDIR: join(dir, 'tmp'), PLUR_PATH: join(dir, '.plur'),
        // Embeddings stay ON so the hybrid leg is real; a 1ms deadline cannot be met.
        PLUR_HOOK_HYBRID_DEADLINE_MS: '1',
      }
      delete env.PLUR_DISABLE_EMBEDDINGS
      delete env.PLUR_HOOK_HYBRID
      const seeded = runCli('node', [CLI, 'learn', 'codeword basalt-heron for the bounded hook test', '--json'], {
        encoding: 'utf-8', timeout: 20_000, env: { ...env, PLUR_DISABLE_EMBEDDINGS: '1' }, cwd: dir,
      })
      expect(seeded.status).toBe(0)
      // Two first prompts in a row. The abandoned hybrid search records
      // its injection under engrams.yaml.lock; exiting mid-acquire left an
      // empty lock that stalled every later writer for 60s (seen on 10 of 12
      // runs against a 10k-engram store before the exit waited for it).
      for (let i = 0; i < 2; i++) {
        const r = runCli('node', [CLI, 'hook-inject'], {
          input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: `sync-${i}`, prompt: 'basalt-heron codeword' }),
          encoding: 'utf-8', timeout: 20_000, env, cwd: dir,
        })
        expect(r.status).toBe(0)
        expect(r.stderr).toContain('hybrid injection exceeded 1ms')
        const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string
        expect(ctx).toContain('session started')
        expect(ctx).toContain('basalt-heron')
        expect(existsSync(join(dir, '.plur', 'engrams.yaml.lock'))).toBe(false)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 90_000)

  describe('the exit past an abandoned hybrid waits for its own store lock', () => {
    const lockDir = () => mkdtempSync(join(tmpdir(), 'plur-inject-lock-'))

    it('waits while the lock names this process, and returns once it is released', async () => {
      const d = lockDir()
      const lock = join(d, 'engrams.yaml.lock')
      writeFileSync(lock, `${hostname()}:${process.pid}:${Date.now()}:0`)
      setTimeout(() => rmSync(lock, { force: true }), 300)
      const t = Date.now()
      await waitForOwnStoreLock(lock, 3_000)
      expect(Date.now() - t).toBeGreaterThanOrEqual(250)
      rmSync(d, { recursive: true, force: true })
    })

    it('waits on a fresh empty lock (an O_EXCL open whose token write has not landed)', async () => {
      const d = lockDir()
      const lock = join(d, 'engrams.yaml.lock')
      writeFileSync(lock, '')
      setTimeout(() => rmSync(lock, { force: true }), 300)
      const t = Date.now()
      await waitForOwnStoreLock(lock, 3_000)
      expect(Date.now() - t).toBeGreaterThanOrEqual(250)
      rmSync(d, { recursive: true, force: true })
    })

    it('does not wait on another process lock, an old empty lock, or no lock', async () => {
      const d = lockDir()
      const lock = join(d, 'engrams.yaml.lock')
      const t = Date.now()
      await waitForOwnStoreLock(lock, 3_000)
      writeFileSync(lock, `${hostname()}:${process.pid + 1}:${Date.now()}:0`)
      await waitForOwnStoreLock(lock, 3_000)
      writeFileSync(lock, '')
      const old = (Date.now() - 10_000) / 1000
      utimesSync(lock, old, old)
      await waitForOwnStoreLock(lock, 3_000)
      expect(Date.now() - t).toBeLessThan(500)
      rmSync(d, { recursive: true, force: true })
    })

    it('gives up at its bound', async () => {
      const d = lockDir()
      const lock = join(d, 'engrams.yaml.lock')
      writeFileSync(lock, `${hostname()}:${process.pid}:${Date.now()}:0`)
      const t = Date.now()
      await waitForOwnStoreLock(lock, 200)
      expect(Date.now() - t).toBeLessThan(1_000)
      rmSync(d, { recursive: true, force: true })
    })
  })

  it('the watchdog ceiling leaves headroom below the registered Claude Code timeout', () => {
    // Exiting on our own watchdog prints nothing but exits 0; being killed at
    // the harness timeout shows the user a hook error. The ceiling must fire
    // first, and must still fit hybrid deadline (8s) + a BM25 pass.
    expect(HOOK_CEILING_DEFAULT_MS).toBeLessThanOrEqual(CLAUDE_INJECT_TIMEOUT_S * 1000 - 3_000)
    expect(HOOK_CEILING_DEFAULT_MS).toBeGreaterThanOrEqual(12_000)
  })
})
