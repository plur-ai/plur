/**
 * Event injections (plan mode, skill, agent, subagent) run the unified
 * pipeline, but safely (audit H1, H3, H5):
 *
 *  - H1: they take the KEYWORD leg unless the embedding model is on disk, the
 *    embeddings cache is warm, and no other hybrid run of this session is live.
 *    A per-session single-flight lock means N concurrent event hooks start at
 *    most one hybrid run. An event never loads (or downloads) the model on a
 *    cold store and never starts the detached cache warm-up.
 *  - H3: an event never dials a team server, except in a remote-only folder
 *    (where there is no local store to read).
 *  - H5: the event watchdog plus its store-idle wait stays inside the old 10 s
 *    hook timeout.
 *
 * Temp HOME / PLUR_PATH / TMPDIR only — never ~/.plur.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir, hostname } from 'os'
import { spawn, execFileSync } from 'child_process'
import { pathToFileURL } from 'url'
import yaml from 'js-yaml'
import { registerHooks } from 'node:module'
import { Plur } from '@plur-ai/core'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'
import { StubServer } from '../../core/test/helpers/stub-server.js'
import {
  planEventRetrieval, eventInjectOptions, eventWatchdogBudgetMs, releaseInjectLock,
} from '../src/commands/hook-inject.js'

const CLI = builtCliPath(join(__dirname, '..'))

let scratch: string[] = []
afterEach(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); scratch = [] })
function tmp(prefix: string): string { const d = mkdtempSync(join(tmpdir(), prefix)); scratch.push(d); return d }

describe('planEventRetrieval (H1)', () => {
  function warmStore(): string {
    const root = tmp('plur-evplan-')
    writeFileSync(join(root, '.embeddings-cache.json'), JSON.stringify({ meta: {}, entries: { a: { hash: 'x', embedding: [0] } } }))
    return root
  }

  it('cold cache → keyword, and the model is not even checked', async () => {
    const root = tmp('plur-evplan-cold-')
    let checked = 0
    const plan = await planEventRetrieval({
      lockPath: join(root, 'S.event-hybrid'), firstPromptLockPath: null, storeRoot: root,
      modelReady: async () => { checked++; return true },
    })
    expect(plan.mode).toBe('keyword')
    expect(plan.reason).toBe('cache-cold')
    expect(checked).toBe(0)
  })

  it('warm cache + model on disk + lock free → hybrid; the lock is held until released', async () => {
    const root = warmStore()
    const lockPath = join(root, 'S.event-hybrid')
    const plan = await planEventRetrieval({ lockPath, firstPromptLockPath: null, storeRoot: root, modelReady: async () => true })
    expect(plan.mode).toBe('hybrid')
    expect(existsSync(lockPath)).toBe(true)
    const second = await planEventRetrieval({ lockPath, firstPromptLockPath: null, storeRoot: root, modelReady: async () => true })
    expect(second.mode).toBe('keyword')
    expect(second.reason).toBe('hybrid-busy')
    releaseInjectLock(plan.hold)
    expect(existsSync(lockPath)).toBe(false)
  })

  it('N concurrent planners: at most one hybrid run', async () => {
    const root = warmStore()
    const lockPath = join(root, 'S.event-hybrid')
    const plans = await Promise.all(Array.from({ length: 8 }, () => planEventRetrieval({
      lockPath, firstPromptLockPath: null, storeRoot: root,
      modelReady: () => new Promise(r => setTimeout(() => r(true), 50)),
    })))
    expect(plans.filter(p => p.mode === 'hybrid')).toHaveLength(1)
    for (const p of plans) releaseInjectLock(p.hold)
  })

  it('model not on disk → keyword, lock released (never a download)', async () => {
    const root = warmStore()
    const lockPath = join(root, 'S.event-hybrid')
    const plan = await planEventRetrieval({ lockPath, firstPromptLockPath: null, storeRoot: root, modelReady: async () => false })
    expect(plan.mode).toBe('keyword')
    expect(plan.reason).toBe('model-missing')
    expect(existsSync(lockPath)).toBe(false)
  })

  it('a model check that hangs → keyword within the bound', async () => {
    const root = warmStore()
    const t = Date.now()
    const plan = await planEventRetrieval({
      lockPath: join(root, 'S.event-hybrid'), firstPromptLockPath: null, storeRoot: root,
      modelReady: () => new Promise(() => {}), modelCheckMs: 100,
    })
    expect(plan.mode).toBe('keyword')
    expect(Date.now() - t).toBeLessThan(2_000)
  })

  it('the first-prompt injection of the session is running → keyword', async () => {
    const root = warmStore()
    const first = join(root, 'S.injecting')
    writeFileSync(first, 'live')
    const plan = await planEventRetrieval({ lockPath: join(root, 'S.event-hybrid'), firstPromptLockPath: first, storeRoot: root, modelReady: async () => true })
    expect(plan.mode).toBe('keyword')
    expect(plan.reason).toBe('hybrid-busy')
  })

  it('a cache warm-up in progress → keyword', async () => {
    const root = warmStore()
    writeFileSync(join(root, '.embeddings-warming'), `${hostname()}:${process.pid}:${Date.now()}`)
    const plan = await planEventRetrieval({ lockPath: join(root, 'S.event-hybrid'), firstPromptLockPath: null, storeRoot: root, modelReady: async () => true })
    expect(plan.mode).toBe('keyword')
    expect(plan.reason).toBe('cache-warming')
  })

  it('no usable state dir (no lock possible) → keyword', async () => {
    const root = warmStore()
    const plan = await planEventRetrieval({ lockPath: null, firstPromptLockPath: null, storeRoot: root, modelReady: async () => true })
    expect(plan.mode).toBe('keyword')
  })

  it('hybrid switched off → keyword', async () => {
    const root = warmStore()
    const plan = await planEventRetrieval({ lockPath: join(root, 'S.event-hybrid'), firstPromptLockPath: null, storeRoot: root, modelReady: async () => true, hybridEnabled: false })
    expect(plan.mode).toBe('keyword')
  })
})

describe('event inject options (H3)', () => {
  it('an event never dials a team server outside a remote-only folder', () => {
    expect((eventInjectOptions({ remoteOnly: false }) as { remote?: boolean }).remote).toBe(false)
    expect(eventInjectOptions({ remoteOnly: false, remoteProject: { url: 'https://x', token: 't' } as never })).not.toHaveProperty('remote_project')
  })
  it('a remote-only folder keeps its team-server read (no local store)', () => {
    const o = eventInjectOptions({ remoteOnly: true })
    expect((o as { remote?: boolean }).remote).toBeUndefined()
  })
})

describe('event watchdog budget (H5)', () => {
  it('ceiling plus store-idle wait stays ≤ 9.5 s', () => {
    expect(eventWatchdogBudgetMs()).toBeLessThanOrEqual(9_500)
  })
})

// ── Spawned hooks ──────────────────────────────────────────────────────────

/** Preload: every import of @huggingface/transformers is recorded (pid) and never settles. */
function writeRecorder(dir: string): string {
  const path = join(dir, 'record-tjs.mjs')
  writeFileSync(path, [
    `import * as m from 'node:module'`,
    `import { appendFileSync } from 'node:fs'`,
    `const rec = process.env.PLUR_TEST_TJS_RECORD`,
    `const target = 'data:text/javascript,await new Promise(() => {})'`,
    `m.registerHooks({ resolve(s, c, n) {`,
    `  if (s === '@huggingface/transformers') { try { appendFileSync(rec, process.pid + '\\n') } catch {} ; return { url: target, shortCircuit: true } }`,
    `  return n(s, c)`,
    `} })`,
  ].join('\n'))
  return path
}

function runHook(args: string[], input: object, env: NodeJS.ProcessEnv, cwd: string, timeoutMs = 30_000): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
  return new Promise((resolve, reject) => {
    const t = Date.now()
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', b => { stdout += b }); child.stderr.on('data', b => { stderr += b })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('error', reject)
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, ms: Date.now() - t }) })
    child.stdin.end(JSON.stringify(input))
  })
}

describe.skipIf(typeof registerHooks !== 'function')('spawned event hooks never load the model on a cold store (H1)', () => {
  let dir: string
  let store: string
  let env: NodeJS.ProcessEnv
  let recorder: string
  let record: string

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-event-safety-'))
    store = join(dir, '.plur')
    mkdirSync(join(dir, 'tmp'), { recursive: true })
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }))
    const plur = new Plur({ path: store })
    await plur.learn('codeword zephyr-quartz applies to planning skills agents and subagents', { scope: 'global', type: 'behavioral' })
    plur.close?.()
    recorder = writeRecorder(dir)
    record = join(dir, 'tjs-imports.txt')
    env = { ...process.env, HOME: dir, USERPROFILE: dir, TMPDIR: join(dir, 'tmp'), PLUR_PATH: store, PLUR_TEST_TJS_RECORD: record }
    delete env.PLUR_DISABLE_EMBEDDINGS
    delete env.PLUR_HOOK_HYBRID
    delete env.CLAUDE_SESSION_ID
  }, 30_000)

  afterAll(() => {
    try {
      const pid = Number(readFileSync(join(store, '.embeddings-warming'), 'utf8').split(':')[1])
      if (pid && pid !== process.pid) process.kill(pid)
    } catch { /* no build running */ }
    rmSync(dir, { recursive: true, force: true })
  })

  it('cold cache: keyword path, no model import, no warm-up', async () => {
    const r = await runHook(['--import', pathToFileURL(recorder).href, CLI, 'hook-inject', '--event', 'skill'],
      { cwd: dir, session_id: 'cold-1', hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'zephyr-quartz' } }, env, dir)
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('zephyr-quartz')
    expect(existsSync(record)).toBe(false)
    await new Promise(res => setTimeout(res, 1_500))
    expect(existsSync(join(store, '.embeddings-warming'))).toBe(false)
    expect(existsSync(join(store, '.embeddings-cache.json'))).toBe(false)
  }, 60_000)

  it('N concurrent event hooks on a warm-looking cache: at most one tries the model, all finish inside 10 s', async () => {
    writeFileSync(join(store, '.embeddings-cache.json'), JSON.stringify({ meta: {}, entries: {} }))
    rmSync(record, { force: true })
    const runs = await Promise.all(Array.from({ length: 4 }, () => runHook(
      ['--import', pathToFileURL(recorder).href, CLI, 'hook-inject', '--event', 'skill'],
      { cwd: dir, session_id: 'conc-1', hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'zephyr-quartz' } }, env, dir)))
    for (const r of runs) {
      expect(r.code).toBe(0)
      expect(r.ms).toBeLessThan(10_000)
    }
    const pids = existsSync(record) ? new Set(readFileSync(record, 'utf8').split('\n').filter(Boolean)) : new Set()
    expect(pids.size).toBeLessThanOrEqual(1)
    await new Promise(res => setTimeout(res, 1_500))
    expect(existsSync(join(store, '.embeddings-warming'))).toBe(false)
  }, 60_000)
})

describe('a spawned event hook does not dial the team server (H3)', () => {
  const SCOPE = 'project:fixture/team/backend'
  let home: string, repo: string, root: string, stub: StubServer
  beforeAll(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'plur-event-remote-')))
    root = join(home, '.plur'); repo = join(home, 'repo')
    mkdirSync(root); mkdirSync(repo); mkdirSync(join(home, 'tmp'))
    execFileSync('git', ['init', '-q', repo])
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://gitlab.example.com/team/backend.git'])
    stub = new StubServer('fixture-key')
    const { url, token } = await stub.start()
    writeFileSync(join(root, 'config.yaml'), yaml.dump({
      stores: [{ url, token, scope: 'user:fixture:alice', scopes: ['user:fixture:alice', SCOPE], enterprise: {},
        scope_settings: { [SCOPE]: { covers: ['fixture.build'] }, 'user:fixture:alice': { dial: 'always' } },
        discovery: { status: 'ok', scopes_status: 'ok', discovered_at: new Date().toISOString(),
          gitlab_host: 'gitlab.example.com', project_paths: { [SCOPE]: 'team/backend' } } }],
    }))
  })
  afterAll(async () => { await stub.stop(); rmSync(home, { recursive: true, force: true }) })

  it('the first prompt dials (control); a skill event afterwards does not', async () => {
    const env = { ...isolatedHomeEnv(home), TMPDIR: join(home, 'tmp'), PLUR_HOOK_HYBRID: 'on' }
    const first = await runHook([CLI, 'hook-inject'], { cwd: repo, session_id: 'remote-1', hook_event_name: 'UserPromptSubmit', prompt: 'fixture release procedure' }, env, repo)
    expect(first.code).toBe(0)
    expect(stub.recallCalls).toBeGreaterThan(0)
    const before = stub.recallCalls
    const ev = await runHook([CLI, 'hook-inject', '--event', 'skill'], { cwd: repo, session_id: 'remote-1', hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'fixture release procedure' } }, env, repo)
    expect(ev.code).toBe(0)
    expect(stub.recallCalls).toBe(before)
  }, 60_000)
})
