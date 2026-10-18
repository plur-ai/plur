/**
 * B14: Record which editors send MCP workspace roots.
 *
 * One fixture file per editor captures the clientInfo and capabilities it
 * sends at initialize. A fixture with "source": "manual check" was recorded
 * from a real run (B14v); "unverified" ones still await the run described in
 * docs/runbooks/mcp-roots-by-editor.md.
 *
 * Tests:
 *  - For each fixture, createWorkspaceDirs behaves correctly based on whether
 *    the editor declares the roots capability.
 *  - Every editor named in the runbook has a matching fixture file.
 *  - PLUR_LOG_CLIENT_INFO=1 causes the server to write a client-info line to
 *    stderr on initialize.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { readdirSync, readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join, dirname, basename } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { createWorkspaceDirs, type RootsServer } from '../src/folder-gate.js'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST_ENTRY = join(PKG_ROOT, 'dist', 'index.js')
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'client-capabilities')
const RUNBOOK = join(PKG_ROOT, '..', '..', 'docs', 'runbooks', 'mcp-roots-by-editor.md')

/** Minimal RootsServer backed by static data, for unit-testing createWorkspaceDirs. */
function fakeRootsServer(
  capabilities: Record<string, unknown>,
  roots: string[],
): RootsServer {
  const fileRoots = roots.map(r => ({ uri: `file://${r}` }))
  return {
    getClientCapabilities: () => capabilities as { roots?: unknown },
    listRoots: async () => ({ roots: fileRoots }),
    setNotificationHandler: () => {},
  }
}

// --- Per-fixture behavioural tests ---

for (const f of readdirSync(FIXTURES).filter(f => f.endsWith('.json'))) {
  const fx = JSON.parse(readFileSync(join(FIXTURES, f), 'utf8'))
  it(`${f}: a client that declares roots gets its roots; one that does not gets the start folder`, async () => {
    const ws = createWorkspaceDirs(fakeRootsServer(fx.capabilities, ['/w/a', '/w/b']), { cwd: () => '/w/start' })
    const dirs = await ws.dirs()
    expect(dirs).toEqual(fx.capabilities.roots ? ['/w/a', '/w/b', '/w/start'] : ['/w/start'])
  })
}

// --- Runbook completeness check ---

it('every editor named in the runbook has a fixture', () => {
  const runbook = readFileSync(RUNBOOK, 'utf8')
  // Parse the first column of Markdown table data rows (lines starting with '| <lowercase-letter>')
  const editorNames = runbook
    .split('\n')
    .filter(l => /^\| [a-z]/.test(l))
    .map(l => l.split('|')[1].trim())
    .sort()
  const fixtureBasenames = readdirSync(FIXTURES)
    .filter(f => f.endsWith('.json'))
    .map(f => basename(f, '.json'))
    .sort()
  expect(editorNames).toEqual(fixtureBasenames)
})

// --- Runbook status table agrees with each fixture (B14v) ---

it('the runbook status row for each editor states what its fixture records', () => {
  const runbook = readFileSync(RUNBOOK, 'utf8')
  const rows = new Map(
    runbook
      .split('\n')
      .filter(l => /^\| [a-z]/.test(l))
      .map(l => l.split('|').slice(1, -1).map(c => c.trim()))
      .map(cells => [cells[0], cells] as const),
  )
  for (const f of readdirSync(FIXTURES).filter(f => f.endsWith('.json'))) {
    const name = basename(f, '.json')
    const fx = JSON.parse(readFileSync(join(FIXTURES, f), 'utf8'))
    const row = rows.get(name)
    expect(row, `${name} has a status row`).toBeDefined()
    const [, sendsRoots, listChanged, recorded] = row!
    if (fx.source === 'manual check') {
      expect(fx.recorded, `${name}: a manual check carries its date`).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(recorded, `${name}: runbook date`).toBe(fx.recorded)
      expect(sendsRoots, `${name}: runbook roots`).toBe(fx.capabilities.roots ? 'yes' : 'no')
      expect(listChanged, `${name}: runbook listChanged`).toBe(fx.capabilities.roots?.listChanged === true ? 'yes' : 'no')
    } else {
      expect(fx.source, `${name}: source`).toBe('unverified')
      expect(fx.recorded, `${name}: an unverified fixture has no date`).toBeNull()
      expect([sendsRoots, listChanged, recorded], `${name}: runbook row`).toEqual(['unverified', 'unverified', '—'])
    }
  }
})

// --- PLUR_LOG_CLIENT_INFO stderr line (requires built dist) ---

describe.skipIf(!existsSync(DIST_ENTRY))('PLUR_LOG_CLIENT_INFO', () => {
  const tmpDirs: string[] = []
  const clients: Client[] = []

  afterAll(async () => {
    for (const c of clients) await c.close().catch(() => {})
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
  })

  /** Start the built server over stdio as `clientInfo`/`capabilities`; return its stderr after initialize. */
  async function stderrAfterInitialize(
    clientInfo: { name: string; version: string },
    capabilities: Record<string, unknown>,
    logClientInfo: boolean,
  ): Promise<string> {
    const plurPath = mkdtempSync(join(tmpdir(), 'plur-b14-'))
    tmpDirs.push(plurPath)
    writeFileSync(join(plurPath, 'config.yaml'), 'embeddings:\n  enabled: false\n')
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST_ENTRY],
      stderr: 'pipe',
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
        PLUR_PATH: plurPath,
        ...(logClientInfo ? { PLUR_LOG_CLIENT_INFO: '1' } : {}),
      },
    })
    let stderrData = ''
    transport.stderr?.on('data', (d: Buffer) => { stderrData += d.toString() })
    const client = new Client(clientInfo, { capabilities })
    clients.push(client)
    await client.connect(transport)
    // The line is written on the initialized notification, which connect()
    // sends without waiting for; a round trip after it guarantees the server
    // has processed it (stdio messages are handled in order).
    await client.listTools()
    await new Promise(resolve => setTimeout(resolve, 100))
    return stderrData
  }

  const clientLines = (stderr: string) => stderr.split('\n').filter(l => l.startsWith('[plur] client '))

  it('PLUR_LOG_CLIENT_INFO=1 logs one client line on initialize', async () => {
    const stderr = await stderrAfterInitialize({ name: 'test-editor', version: '9.9.9' }, { roots: { listChanged: true } }, true)
    expect(stderr).toMatch(/^\[plur\] client \S+ \S+ roots=(yes|no) listChanged=(yes|no)$/m)
    // Exactly one line, and it reports what this client actually declared.
    expect(clientLines(stderr)).toEqual(['[plur] client test-editor 9.9.9 roots=yes listChanged=yes'])
  }, 15_000)

  it('a client without the roots capability is logged as roots=no listChanged=no', async () => {
    const stderr = await stderrAfterInitialize({ name: 'plain editor', version: '1.2.3' }, {}, true)
    expect(clientLines(stderr)).toEqual(['[plur] client plain-editor 1.2.3 roots=no listChanged=no'])
  }, 15_000)

  it('without PLUR_LOG_CLIENT_INFO=1 no client line is written', async () => {
    const stderr = await stderrAfterInitialize({ name: 'test-editor', version: '9.9.9' }, { roots: {} }, false)
    expect(clientLines(stderr)).toEqual([])
  }, 15_000)
})
