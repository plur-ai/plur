import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir, hostname } from 'os'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))
const N = 400

/**
 * #1313 audit: the embedding cache is saved only when a hybrid search runs to
 * completion. A first prompt whose hybrid search misses the deadline exits
 * before that, so a store whose cache is cold stays cold: every session's
 * first prompt misses the deadline, falls back to BM25, and never improves.
 *
 * After a fallback the hook starts one detached background build of the
 * cache, so the NEXT session's hybrid search meets its deadline.
 *
 * Temp HOME / PLUR_PATH / TMPDIR only — never ~/.plur.
 */
describe('a first prompt that fell back warms the embedding cache for the next session', () => {
  let dir: string
  let store: string
  let env: NodeJS.ProcessEnv

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-inject-warm-'))
    store = join(dir, '.plur')
    mkdirSync(store, { recursive: true })
    mkdirSync(join(dir, 'tmp'), { recursive: true })
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }))
    // Synthetic store, large enough that embedding it from cold takes longer
    // than the hook will wait for the abandoned search.
    const nouns = ['widget', 'parser', 'queue', 'cache', 'router', 'schema', 'ledger', 'socket', 'buffer', 'kernel']
    const verbs = ['validate', 'rebuild', 'flush', 'retry', 'serialize', 'shard', 'compress', 'rotate']
    let yaml = 'engrams:\n'
    for (let i = 0; i < N; i++) {
      const s = i === 0
        ? 'The project codeword is basalt-heron.'
        : `When you ${verbs[i % verbs.length]} a ${nouns[(i * 7) % nouns.length]}, check the ${nouns[(i * 3) % nouns.length]} first; synthetic rule ${i}.`
      yaml += `  - id: ENG-2026-01-01-${String(i).padStart(5, '0')}
    version: 2
    status: active
    type: behavioral
    scope: global
    visibility: private
    statement: ${JSON.stringify(s)}
    activation: { retrieval_strength: 0.7, storage_strength: 1, frequency: 0, last_accessed: "2026-01-01" }
    feedback_signals: { positive: 0, negative: 0, neutral: 0 }
    knowledge_anchors: []
    associations: []
    tags: []
    created_at: "2026-01-01T00:00:00.000Z"
    updated_at: "2026-01-01T00:00:00.000Z"
`
    }
    writeFileSync(join(store, 'engrams.yaml'), yaml)
    // Normal priority for the build: at the default (lowest) it can be starved
    // for minutes on a busy CI machine, which is right in use and slow in a test.
    env = { ...process.env, HOME: dir, USERPROFILE: dir, TMPDIR: join(dir, 'tmp'), PLUR_PATH: store, PLUR_WARM_NICE: '0' }
    delete env.PLUR_DISABLE_EMBEDDINGS
    delete env.PLUR_HOOK_HYBRID
    delete env.CLAUDE_SESSION_ID
  })

  afterAll(() => {
    // A build still running (a failed run) must not outlive the test and
    // write into a deleted temp dir.
    try {
      const pid = Number(readFileSync(join(store, '.embeddings-warming'), 'utf8').split(':')[1])
      if (pid && pid !== process.pid) process.kill(pid)
    } catch { /* no build running */ }
    rmSync(dir, { recursive: true, force: true })
  })

  function cachedEntries(): number {
    try {
      const raw = JSON.parse(readFileSync(join(store, '.embeddings-cache.json'), 'utf8'))
      return Object.keys(raw.entries ?? {}).length
    } catch {
      return 0
    }
  }

  it('the second session takes the hybrid path within budget', async () => {
    // Session 1: the hybrid search cannot meet a 1ms deadline, and the exit's
    // wait is capped by a 3s watchdog, far too short to embed the whole store.
    const first = runCli('node', [CLI, 'hook-inject'], {
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'warm-1', prompt: 'what is the project codeword' }),
      encoding: 'utf-8', timeout: 30_000, cwd: dir,
      env: { ...env, PLUR_HOOK_HYBRID_DEADLINE_MS: '1', PLUR_HOOK_CEILING_MS: '3000' },
    })
    expect(first.status).toBe(0)
    // Under heavy load the 3s watchdog can end the run before BM25 answers;
    // either exit must start the build, so only a clean exit is asserted.

    // The background build finishes on its own; wait for it (bounded).
    const until = Date.now() + 540_000
    while (Date.now() < until && (cachedEntries() < N || existsSync(join(store, '.embeddings-warming')))) {
      await new Promise(r => setTimeout(r, 500))
    }
    expect(cachedEntries()).toBeGreaterThanOrEqual(N)
    expect(existsSync(join(store, '.embeddings-warming'))).toBe(false)

    // Session 2: the shipped deadline and watchdog, and no fallback.
    const t = Date.now()
    const second = runCli('node', [CLI, 'hook-inject'], {
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'warm-2', prompt: 'what is the project codeword' }),
      encoding: 'utf-8', timeout: 30_000, cwd: dir, env,
    })
    const ms = Date.now() - t
    expect(second.status).toBe(0)
    expect(second.stderr).not.toContain('hybrid injection exceeded')
    expect(JSON.parse(second.stdout).hookSpecificOutput.additionalContext).toContain('session started')
    expect(ms).toBeLessThan(20_000)
  }, 600_000)

  it('a hybrid search still running when the watchdog fires also starts the build', async () => {
    rmSync(join(store, '.embeddings-cache.json'), { force: true })
    // A deadline the search cannot reach before a 3s watchdog: the hook
    // exits from the watchdog, not from the fallback path.
    const r = runCli('node', [CLI, 'hook-inject'], {
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'warm-3', prompt: 'what is the project codeword' }),
      encoding: 'utf-8', timeout: 30_000, cwd: dir,
      env: { ...env, PLUR_HOOK_HYBRID_DEADLINE_MS: '60000', PLUR_HOOK_CEILING_MS: '3000' },
    })
    expect(r.status).toBe(0)
    const until = Date.now() + 540_000
    while (Date.now() < until && (cachedEntries() < N || existsSync(join(store, '.embeddings-warming')))) {
      await new Promise(res => setTimeout(res, 500))
    }
    expect(cachedEntries()).toBeGreaterThanOrEqual(N)
  }, 600_000)

  it('a second fallback while a build is running starts no second build', () => {
    // Single flight: a live marker means a build is under way.
    writeFileSync(join(store, '.embeddings-warming'), `${hostname()}:${process.pid}:${Date.now()}`)
    try {
      const r = runCli('node', [CLI, 'hook-inject', '--warm-embeddings'], {
        input: '', encoding: 'utf-8', timeout: 30_000, cwd: dir, env,
      })
      expect(r.status).toBe(0)
      // The marker is still ours: the second build backed off without touching it.
      expect(readFileSync(join(store, '.embeddings-warming'), 'utf8')).toContain(`:${process.pid}:`)
    } finally {
      rmSync(join(store, '.embeddings-warming'), { force: true })
    }
  }, 60_000)
})
