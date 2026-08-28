/**
 * #1070: the server must survive background faults, and plur_doctor over MCP
 * must return AND leave the server answering.
 *
 * The production signature was "plur_doctor failed after 0s: Connection
 * closed" — which reads as doctor killing the server, but 0s means the
 * server was ALREADY dead: Node's default response to any unhandled
 * rejection (an un-awaited background retry, a timer's fetch) is process
 * death, and Claude Code never restarts an MCP server mid-session, so one
 * background hiccup silently ended memory for the whole session. runStdio
 * now installs survive-and-log handlers; these tests drive the REAL bundled
 * process over real stdio pipes (same harness as dist-validation, #102) and
 * prove both halves.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST_ENTRY = join(PKG_ROOT, 'dist', 'index.js')

function makeTransport(plurPath: string, extraEnv: Record<string, string>): StdioClientTransport {
  return new StdioClientTransport({
    command: process.execPath,
    args: [DIST_ENTRY],
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
      PLUR_PATH: plurPath,
      PLUR_TOOL_PROFILE: 'full',
      ...extraEnv,
    },
  })
}

function callResult(raw: any): any {
  return JSON.parse(raw.content[0].text)
}

describe.skipIf(!existsSync(DIST_ENTRY))('server survival (#1070)', () => {
  let dir: string
  let client: Client

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-1070-'))
    writeFileSync(join(dir, 'config.yaml'), 'embeddings:\n  enabled: false\n')
    const transport = makeTransport(dir, {
      // Fire an unhandled rejection in the background 100ms after startup —
      // through the real test seam in runStdio, so the handlers under test
      // are the ones production runs.
      PLUR_TEST_INDUCE_UNHANDLED_REJECTION_MS: '100',
    })
    client = new Client({ name: 'survival-1070', version: '1.0.0' })
    await client.connect(transport)
  }, 30_000)

  afterAll(async () => {
    await client?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('survives a background unhandled rejection and still answers', async () => {
    // Let the induced rejection fire first. Pre-fix, the process is dead by
    // now and the next call throws a transport error.
    await new Promise(resolve => setTimeout(resolve, 500))
    const status = callResult(await client.callTool({ name: 'plur_status', arguments: {} }))
    expect(status.engram_count).toBeGreaterThanOrEqual(0)
  }, 20_000)

  it('an uncaught EXCEPTION exits code 1 — a wedged-but-alive lock holder is worse than a visible death', async () => {
    // The other half of the fault policy (0.19.1 data-loss audit, finding 3):
    // surviving an uncaughtException leaves a live pid that the cross-process
    // stale-lock recovery will rightly never steal from, so a wedged server
    // blocks every writer indefinitely. Exit restores that recovery path and
    // lets the harness surface the failure. Raw spawn, not the SDK client —
    // the assertion IS the exit code.
    const { spawn } = await import('child_process')
    const dir2 = mkdtempSync(join(tmpdir(), 'plur-1070-exc-'))
    writeFileSync(join(dir2, 'config.yaml'), 'embeddings:\n  enabled: false\n')
    try {
      const child = spawn(process.execPath, [DIST_ENTRY], {
        env: {
          ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
          ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
          PLUR_PATH: dir2,
          PLUR_TOOL_PROFILE: 'full',
          PLUR_TEST_INDUCE_UNCAUGHT_EXCEPTION_MS: '150',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stderr = ''
      child.stderr.on('data', d => { stderr += d.toString() })
      const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        child.on('exit', (code, signal) => resolve({ code, signal }))
        setTimeout(() => { child.kill(); resolve({ code: null, signal: 'TEST-TIMEOUT' }) }, 10_000)
      })
      expect(exit.signal).not.toBe('TEST-TIMEOUT') // it must die on its own, not linger
      expect(exit.code).toBe(1)
      expect(stderr).toContain('UNCAUGHT EXCEPTION')
      expect(stderr).toContain('induced test exception')
    } finally {
      rmSync(dir2, { recursive: true, force: true })
    }
  }, 20_000)

  it('plur_doctor over MCP returns a result AND the server answers the next call', async () => {
    const doctor = callResult(await client.callTool({ name: 'plur_doctor', arguments: {} }))
    expect(Array.isArray(doctor.checks)).toBe(true)
    expect(doctor.checks.length).toBeGreaterThan(0)
    // The half that killed sessions: the server must still be alive after.
    const status = callResult(await client.callTool({ name: 'plur_status', arguments: {} }))
    expect(status.version).toBeDefined()
  }, 30_000)
})
