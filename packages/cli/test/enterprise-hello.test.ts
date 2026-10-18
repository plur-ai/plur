import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, realpathSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import { helloStatement, runHello, type ToolId, type McpLaunch as HelloMcpLaunch } from '../src/enterprise/hello.js'

const FAKE_SERVER = join(__dirname, 'helpers', 'fake-mcp-server.mjs')
const SERVER = 'https://plur.example.com'

function fakeLaunch(
  tool: ToolId,
  logPath: string,
  mode?: string,
  extraEnv: Record<string, string> = {},
): { tool: ToolId; launch: HelloMcpLaunch } {
  return {
    tool,
    launch: {
      command: process.execPath,
      args: [FAKE_SERVER],
      env: {
        ...process.env,
        FAKE_LOG: logPath,
        ...(mode ? { FAKE_MODE: mode } : {}),
        ...extraEnv,
      },
    },
  }
}

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'plur-hello-test-'))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('helloStatement', () => {
  it('formats the statement correctly', () => {
    expect(
      helloStatement({
        username: 'alice',
        deviceName: 'ws-0142 (Windows)',
        tools: ['Codex', 'OpenCode'],
        version: '0.22.0',
        date: '2026-10-16',
      }),
    ).toBe('PLUR connected: alice on ws-0142 (Windows), Codex, OpenCode, PLUR 0.22.0, 2026-10-16')
  })
})

describe('runHello', () => {
  it('save args include supersedes when previousId is set', async () => {
    const logPath = join(tempDir, 'log.ndjson')
    const stmt = 'PLUR connected: alice on ws-0142 (Windows), Codex, PLUR 0.22.0, 2026-10-16'
    const result = await runHello({
      launches: [fakeLaunch('codex', logPath)],
      personalScope: 'user:acme:alice',
      serverUrl: SERVER,
      statement: stmt,
      previousId: 'ENG-OLD',
    })
    expect(result.saved).toMatchObject({ ok: true })
    const entries = readFileSync(logPath, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    const learnCall = entries.find((e) => e.tool === 'plur_learn')
    expect(learnCall).toBeDefined()
    expect(learnCall.args.statement).toBe(stmt)
    expect(learnCall.args.scope).toBe('user:acme:alice')
    expect(learnCall.args.domain).toBe('plur.connect')
    expect(learnCall.args.tags).toEqual(['plur-connect'])
    expect(learnCall.args.supersedes).toEqual(['ENG-OLD'])
  })

  it('save args have no supersedes key when previousId is absent', async () => {
    const logPath = join(tempDir, 'log.ndjson')
    await runHello({
      launches: [fakeLaunch('codex', logPath)],
      personalScope: 'user:acme:alice',
      serverUrl: SERVER,
      statement: 'PLUR connected: alice on ws-0142 (Windows), Codex, PLUR 0.22.0, 2026-10-16',
    })
    const entries = readFileSync(logPath, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    const learnCall = entries.find((e) => e.tool === 'plur_learn')
    expect(learnCall).toBeDefined()
    expect(Object.keys(learnCall.args)).not.toContain('supersedes')
  })

  it('FAKE_MODE=queued returns saved.ok false with reason', async () => {
    const logPath = join(tempDir, 'log.ndjson')
    const result = await runHello({
      launches: [fakeLaunch('codex', logPath, 'queued')],
      personalScope: 'user:acme:alice',
      serverUrl: SERVER,
      statement: 'PLUR connected: alice',
    })
    expect(result.saved).toEqual({
      ok: false,
      reason: 'queued on this device, not delivered to the server',
    })
    expect(result.perTool).toEqual([])
  })

  it('FAKE_MODE=off returns saved.ok false with reason containing "turned off"', async () => {
    const logPath = join(tempDir, 'log.ndjson')
    const result = await runHello({
      launches: [fakeLaunch('codex', logPath, 'off')],
      personalScope: 'user:acme:alice',
      serverUrl: SERVER,
      statement: 'PLUR connected: alice',
    })
    expect(result.saved.ok).toBe(false)
    if (!result.saved.ok) {
      expect(result.saved.reason).toContain('turned off')
    }
    expect(result.perTool).toEqual([])
  })

  it('hello runs from a neutral cwd under os.tmpdir()', async () => {
    const logPath = join(tempDir, 'log.ndjson')
    await runHello({
      launches: [fakeLaunch('codex', logPath)],
      personalScope: 'user:acme:alice',
      serverUrl: SERVER,
      statement: 'PLUR connected: alice',
    })
    const entries = readFileSync(logPath, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    // Find any logged entry with a cwd
    const cwdEntry = entries.find((e) => e.cwd)
    expect(cwdEntry).toBeDefined()
    const cwd: string = cwdEntry.cwd
    // Must be under tmpdir (the child reports the resolved path: on macOS
    // tmpdir() is under /var, a symlink to /private/var)
    expect(cwd.startsWith(realpathSync(tmpdir()))).toBe(true)
    // Must not be process.cwd()
    expect(cwd).not.toBe(process.cwd())
    // Must not be HOME
    expect(cwd).not.toBe(homedir())
  })

  it('two launches: second recall miss produces recalled:false', async () => {
    const log1 = join(tempDir, 'log1.ndjson')
    const log2 = join(tempDir, 'log2.ndjson')
    const result = await runHello({
      launches: [
        fakeLaunch('codex', log1),
        fakeLaunch('opencode', log2, 'recall-miss'),
      ],
      personalScope: 'user:acme:alice',
      serverUrl: SERVER,
      statement: 'PLUR connected: alice on ws-0142 (Windows), Codex, OpenCode, PLUR 0.22.0, 2026-10-16',
    })
    expect(result.saved).toMatchObject({ ok: true })
    expect(result.perTool).toHaveLength(2)
    expect(result.perTool[0]).toEqual({ tool: 'codex', recalled: true })
    expect(result.perTool[1]).toEqual({
      tool: 'opencode',
      recalled: false,
      reason: "saved, but OpenCode's environment could not recall it",
    })
  })

  it('server that never answers initialize → saved.ok false with timeout reason', async () => {
    const logPath = join(tempDir, 'log.ndjson')
    const result = await runHello({
      launches: [fakeLaunch('codex', logPath, 'no-start')],
      personalScope: 'user:acme:alice',
      serverUrl: SERVER,
      statement: 'PLUR connected: alice',
      timeoutMs: 800,
    })
    expect(result.saved.ok).toBe(false)
    if (!result.saved.ok) {
      expect(result.saved.reason).toContain('did not start within')
    }
  })

  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  async function waitDead(pid: number, ms = 3000): Promise<boolean> {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (!isAlive(pid)) return true
      await new Promise((r) => setTimeout(r, 50))
    }
    return !isAlive(pid)
  }

  it('recalls through plur_recall (exposed by the default tool profile) in the personal scope', async () => {
    const logPath = join(tempDir, 'log.ndjson')
    const result = await runHello({
      launches: [fakeLaunch('codex', logPath)],
      personalScope: 'user:acme:alice',
      serverUrl: SERVER,
      statement: 'PLUR connected: alice',
    })
    expect(result.perTool).toEqual([{ tool: 'codex', recalled: true }])
    const entries = readFileSync(logPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    const recall = entries.find((e) => e.tool === 'plur_recall')
    expect(recall?.args).toMatchObject({ query: 'PLUR connected: alice', scope: 'user:acme:alice' })
  })

  it('kills the child when initialize times out', async () => {
    const pidPath = join(tempDir, 'pid')
    const result = await runHello({
      launches: [fakeLaunch('codex', join(tempDir, 'log'), 'no-start', { FAKE_PID: pidPath })],
      personalScope: 'user:acme:alice',
      serverUrl: SERVER,
      statement: 'PLUR connected: alice',
      timeoutMs: 800,
    })
    expect(result.saved.ok).toBe(false)
    expect(existsSync(pidPath)).toBe(true)
    expect(await waitDead(Number(readFileSync(pidPath, 'utf-8')))).toBe(true)
  })

  it('a tool call that never answers times out, and the child is killed', async () => {
    const pidPath = join(tempDir, 'pid')
    const started = Date.now()
    const result = await runHello({
      launches: [fakeLaunch('codex', join(tempDir, 'log'), 'hang-call', { FAKE_PID: pidPath })],
      personalScope: 'user:acme:alice',
      serverUrl: SERVER,
      statement: 'PLUR connected: alice',
      timeoutMs: 800,
    })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(result.saved.ok).toBe(false)
    if (!result.saved.ok) expect(result.saved.reason).toContain('did not answer within')
    expect(await waitDead(Number(readFileSync(pidPath, 'utf-8')))).toBe(true)
  }, 10_000)

  it('a launch command that does not exist is a failed save, not a crash', async () => {
    const result = await runHello({
      launches: [
        {
          tool: 'codex',
          launch: { command: join(tempDir, 'no-such-plur-mcp'), args: [], env: { ...process.env } },
        },
      ],
      personalScope: 'user:acme:alice',
      serverUrl: SERVER,
      statement: 'PLUR connected: alice',
      timeoutMs: 2000,
    })
    expect(result.saved.ok).toBe(false)
    if (!result.saved.ok) expect(result.saved.reason).toMatch(/could not start/)
  })

  it('a tool error result is reported with its text', async () => {
    const result = await runHello({
      launches: [fakeLaunch('codex', join(tempDir, 'log'), 'tool-error')],
      personalScope: 'user:acme:alice',
      serverUrl: SERVER,
      statement: 'PLUR connected: alice',
    })
    expect(result.saved).toEqual({ ok: false, reason: 'scope user:acme:alice is not writable' })
  })

  it('a remote save without an id is not a confirmed save', async () => {
    const result = await runHello({
      launches: [fakeLaunch('codex', join(tempDir, 'log'), 'no-id')],
      personalScope: 'user:acme:alice',
      serverUrl: SERVER,
      statement: 'PLUR connected: alice',
    })
    expect(result.saved.ok).toBe(false)
  })

  it('a server that writes a lot to stderr does not block, and stderr is not in the result', async () => {
    const result = await runHello({
      launches: [fakeLaunch('codex', join(tempDir, 'log'), 'noisy-stderr')],
      personalScope: 'user:acme:alice',
      serverUrl: SERVER,
      statement: 'PLUR connected: alice',
      timeoutMs: 10_000,
    })
    expect(result.saved).toEqual({ ok: true, id: 'ENG-HELLO-1' })
    expect(JSON.stringify(result)).not.toContain('xxxx')
  }, 20_000)

  describe('recalled means a live answer from the intended server', () => {
    const readLog = (p: string) => readFileSync(p, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))

    it('a single launch recalls from a fresh process, not the one that saved', async () => {
      const logPath = join(tempDir, 'log.ndjson')
      const result = await runHello({
        launches: [fakeLaunch('codex', logPath)],
        personalScope: 'user:acme:alice',
        serverUrl: SERVER,
        statement: 'PLUR connected: alice',
      })
      expect(result.perTool).toEqual([{ tool: 'codex', recalled: true }])
      const entries = readLog(logPath)
      const learn = entries.find((e) => e.tool === 'plur_learn')
      const recall = entries.find((e) => e.tool === 'plur_recall')
      expect(learn.pid).toBeTypeOf('number')
      expect(recall.pid).not.toBe(learn.pid)
    })

    it('the id came back but the server leg failed (a cached row): not proven', async () => {
      const result = await runHello({
        launches: [fakeLaunch('codex', join(tempDir, 'log'), 'recall-degraded')],
        personalScope: 'user:acme:alice',
        serverUrl: SERVER,
        statement: 'PLUR connected: alice',
      })
      expect(result.saved).toMatchObject({ ok: true })
      expect(result.perTool).toHaveLength(1)
      expect(result.perTool[0]).toMatchObject({ tool: 'codex', recalled: false })
      expect(result.perTool[0].reason).toContain('server')
    })

    it('a recall answer without the server report is not proven', async () => {
      const result = await runHello({
        launches: [fakeLaunch('codex', join(tempDir, 'log'), 'recall-no-report')],
        personalScope: 'user:acme:alice',
        serverUrl: SERVER,
        statement: 'PLUR connected: alice',
      })
      expect(result.perTool[0]).toMatchObject({ tool: 'codex', recalled: false })
    })

    it('the server leg answered with nothing: not proven', async () => {
      const result = await runHello({
        launches: [fakeLaunch('codex', join(tempDir, 'log'), 'recall-miss')],
        personalScope: 'user:acme:alice',
        serverUrl: SERVER,
        statement: 'PLUR connected: alice',
      })
      expect(result.perTool[0]).toMatchObject({ tool: 'codex', recalled: false })
    })

    it('a live answer from a different server is not proven', async () => {
      const result = await runHello({
        launches: [fakeLaunch('codex', join(tempDir, 'log'), undefined, { FAKE_HOST: 'https://other.example.com' })],
        personalScope: 'user:acme:alice',
        serverUrl: SERVER,
        statement: 'PLUR connected: alice',
      })
      expect(result.perTool[0]).toMatchObject({ tool: 'codex', recalled: false })
    })

    it('the intended server is matched by its endpoint identity, and its userinfo never reaches a reason', async () => {
      const ok = await runHello({
        launches: [fakeLaunch('codex', join(tempDir, 'log1'))],
        personalScope: 'user:acme:alice',
        serverUrl: 'https://alice:FAKE_PASSWORD@PLUR.example.com:443/',
        statement: 'PLUR connected: alice',
      })
      expect(ok.perTool).toEqual([{ tool: 'codex', recalled: true }])
      const bad = await runHello({
        launches: [fakeLaunch('codex', join(tempDir, 'log2'), 'recall-degraded')],
        personalScope: 'user:acme:alice',
        serverUrl: 'https://alice:FAKE_PASSWORD@plur.example.com',
        statement: 'PLUR connected: alice',
      })
      expect(bad.perTool[0].recalled).toBe(false)
      expect(JSON.stringify(bad)).not.toContain('FAKE_PASSWORD')
      expect(JSON.stringify(bad)).not.toContain('alice:')
    })
  })

  // Codex round 5. Finding 2: the proof must bind the saved id to the intended
  // server — the save delivered there, and that server's own answer carrying
  // the id. Finding 1: local semantic-search readiness must not decide it.
  describe('the intended server stored and returned the saved id', () => {
    const readLog = (p: string) => readFileSync(p, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    const hello = (mode: string | undefined, extra: Record<string, string> = {}, log = join(tempDir, 'log')) =>
      runHello({
        launches: [fakeLaunch('codex', log, mode, extra)],
        personalScope: 'user:acme:alice',
        serverUrl: SERVER,
        statement: 'PLUR connected: alice',
      })

    it('the save was delivered to another server: not saved there, nothing recalled', async () => {
      const result = await hello(undefined, { FAKE_SAVE_HOST: 'https://other.example.com' })
      expect(result.saved.ok).toBe(false)
      if (!result.saved.ok) expect(result.saved.reason).toContain('other.example.com')
      expect(result.perTool).toEqual([])
    })

    it('a save that does not say which server received it is not confirmed', async () => {
      const result = await hello(undefined, { FAKE_SAVE_HOST: 'none' })
      expect(result.saved.ok).toBe(false)
      expect(result.perTool).toEqual([])
    })

    it('the id came back from another server, the intended one answered with other rows: not proven', async () => {
      const result = await hello('recall-other-holds')
      expect(result.saved).toMatchObject({ ok: true })
      expect(result.perTool).toHaveLength(1)
      expect(result.perTool[0]).toMatchObject({ tool: 'codex', recalled: false })
    })

    it('local semantic search degraded (no embedding model), the server returned the id: proven', async () => {
      const result = await hello('recall-local-degraded')
      expect(result.perTool).toEqual([{ tool: 'codex', recalled: true }])
    })

    it('another dialed server failed, the intended server returned the id: proven', async () => {
      const result = await hello('recall-other-failed')
      expect(result.perTool).toEqual([{ tool: 'codex', recalled: true }])
    })

    it('recalls in keyword mode, which does not use local embeddings', async () => {
      const log = join(tempDir, 'log.ndjson')
      await hello(undefined, {}, log)
      const recall = readLog(log).find((e) => e.tool === 'plur_recall')
      expect(recall?.args).toMatchObject({ mode: 'keyword', scope: 'user:acme:alice' })
    })

    it('a reason naming the other server carries no userinfo', async () => {
      const result = await hello(undefined, { FAKE_SAVE_HOST: 'https://bob:FAKE_PASSWORD@other.example.com' })
      expect(result.saved.ok).toBe(false)
      expect(JSON.stringify(result)).not.toContain('FAKE_PASSWORD')
      expect(JSON.stringify(result)).not.toContain('bob:')
    })
  })
})
