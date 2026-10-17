/**
 * B14: Record which editors send MCP workspace roots.
 *
 * Five fixture files capture the clientInfo and capabilities each editor is
 * documented to send. Every fixture is marked "unverified": the real
 * recording is a human step described in docs/runbooks/mcp-roots-by-editor.md.
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

// --- PLUR_LOG_CLIENT_INFO stderr line (requires built dist) ---

describe.skipIf(!existsSync(DIST_ENTRY))('PLUR_LOG_CLIENT_INFO', () => {
  const tmpDirs: string[] = []
  const clients: Client[] = []

  afterAll(async () => {
    for (const c of clients) await c.close().catch(() => {})
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
  })

  it('PLUR_LOG_CLIENT_INFO=1 logs one client line on initialize', async () => {
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
        PLUR_LOG_CLIENT_INFO: '1',
      },
    })
    let stderrData = ''
    transport.stderr?.on('data', (d: Buffer) => { stderrData += d.toString() })
    const client = new Client(
      { name: 'test-editor', version: '9.9.9' },
      { capabilities: { roots: { listChanged: true } } },
    )
    clients.push(client)
    await client.connect(transport)
    // Give the server a moment to write the stderr line after initialized notification
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(stderrData).toMatch(/^\[plur\] client \S+ \S+ roots=(yes|no) listChanged=(yes|no)$/m)
  }, 15_000)
})
