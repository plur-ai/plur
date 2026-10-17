import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import { helloStatement, runHello, type ToolId, type McpLaunch as HelloMcpLaunch } from '../src/enterprise/hello.js'

const FAKE_SERVER = join(__dirname, 'helpers', 'fake-mcp-server.mjs')

function fakeLaunch(
  tool: ToolId,
  logPath: string,
  mode?: string,
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
    // Must be under tmpdir
    expect(cwd.startsWith(tmpdir())).toBe(true)
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
      statement: 'PLUR connected: alice',
      timeoutMs: 800,
    })
    expect(result.saved.ok).toBe(false)
    if (!result.saved.ok) {
      expect(result.saved.reason).toContain('did not start within')
    }
  })
})
