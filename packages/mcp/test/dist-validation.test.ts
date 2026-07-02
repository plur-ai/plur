/**
 * MCP dist validation (#102): spawn the bundled server as a real process.
 *
 * The in-process E2E tests (e2e.test.ts, #82) wire InMemoryTransport directly
 * against createServer() — they catch tool-handler divergence from core (the
 * 0.9.6 bug class) but never touch the artifact users actually run. These
 * tests spawn `node dist/index.js` as a child process and drive it over a
 * real stdio pipe, validating what #82 cannot:
 *
 *   - the bundled `dist/index.js` artifact (tsup output, not source)
 *   - stdio transport serialization (real pipes, real framing)
 *   - the CLI entrypoint and PLUR_PATH env var handling
 *   - process startup and shutdown
 *
 * Requires a built dist — `pnpm --filter @plur-ai/mcp build` (CI runs
 * `pnpm build` before `pnpm test`, so this always runs there). Locally the
 * suite is skipped with a hint when dist/index.js is missing rather than
 * failing an unbuilt checkout.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST_ENTRY = join(PKG_ROOT, 'dist', 'index.js')
const PKG_VERSION = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf-8')).version as string

/** Spawn `node dist/index.js` with PLUR_PATH pointed at `plurPath`. */
function makeTransport(plurPath: string): StdioClientTransport {
  return new StdioClientTransport({
    command: process.execPath,
    args: [DIST_ENTRY],
    // When `env` is provided the child gets ONLY these vars — deliberate, so
    // the test can't accidentally inherit a developer's real ~/.plur via a
    // stray PLUR_PATH. PATH/HOME are passed through for node + os.homedir().
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
      PLUR_PATH: plurPath,
    },
  })
}

async function connectClient(plurPath: string): Promise<{ client: Client; transport: StdioClientTransport }> {
  const transport = makeTransport(plurPath)
  const client = new Client({ name: 'dist-validation', version: '1.0.0' })
  await client.connect(transport)
  return { client, transport }
}

function callResult(raw: Awaited<ReturnType<Client['callTool']>>): any {
  return JSON.parse((raw.content as any)[0].text)
}

describe.skipIf(!existsSync(DIST_ENTRY))('MCP dist validation (#102)', () => {
  let dir: string
  let client: Client

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-dist-'))
    // Disable embeddings: keeps the smoke deterministic and avoids a model
    // download in CI. plur_recall (BM25) works without them.
    writeFileSync(join(dir, 'config.yaml'), 'embeddings:\n  enabled: false\n')
    ;({ client } = await connectClient(dir))
  }, 30_000)

  afterAll(async () => {
    await client?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('bundled server starts and lists tools over stdio', async () => {
    const { tools } = await client.listTools()
    const names = tools.map(t => t.name)
    expect(names).toContain('plur_learn')
    expect(names).toContain('plur_recall')
    expect(names).toContain('plur_status')
  })

  it('learn → recall → status smoke through the real process', async () => {
    // learn
    const learned = callResult(await client.callTool({
      name: 'plur_learn',
      arguments: { statement: 'Dist validation smoke: deploys go out on Tuesdays', type: 'procedural' },
    }))
    expect(learned.id).toMatch(/^ENG-/)

    // recall (BM25 — embeddings disabled above)
    const recalled = callResult(await client.callTool({
      name: 'plur_recall',
      arguments: { query: 'dist validation smoke deploys' },
    }))
    expect(recalled.count).toBeGreaterThanOrEqual(1)
    expect(recalled.results.map((r: any) => r.id)).toContain(learned.id)

    // status
    const status = callResult(await client.callTool({ name: 'plur_status', arguments: {} }))
    expect(status.engram_count).toBeGreaterThanOrEqual(1)
    // The bundle must report the version it was built from — catches a stale
    // dist or a package.json / src/version.ts drift.
    expect(status.version).toBe(PKG_VERSION)
  })

  it('honors PLUR_PATH — storage lands in the temp dir, not ~/.plur', async () => {
    const status = callResult(await client.callTool({ name: 'plur_status', arguments: {} }))
    expect(status.storage_root).toBe(dir)
    // The learn above must have materialized on disk under PLUR_PATH.
    expect(existsSync(join(dir, 'engrams.yaml'))).toBe(true)
    expect(readFileSync(join(dir, 'engrams.yaml'), 'utf-8')).toContain('Dist validation smoke')
  })

  it('shuts down cleanly: child process exits after client.close()', async () => {
    const ownDir = mkdtempSync(join(tmpdir(), 'plur-dist-shutdown-'))
    try {
      const { client: c2, transport: t2 } = await connectClient(ownDir)
      const pid = t2.pid
      expect(pid).not.toBeNull()

      await c2.close()

      // Poll until the process is gone (signal 0 = existence check).
      const deadline = Date.now() + 10_000
      let alive = true
      while (alive) {
        try {
          process.kill(pid!, 0)
          if (Date.now() > deadline) throw new Error(`child ${pid} still alive 10s after close()`)
          await new Promise(r => setTimeout(r, 50))
        } catch (err: any) {
          if (err.code === 'ESRCH') { alive = false } else { throw err }
        }
      }
      expect(alive).toBe(false)
    } finally {
      rmSync(ownDir, { recursive: true, force: true })
    }
  }, 30_000)
})
