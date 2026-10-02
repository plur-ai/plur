/**
 * The folder question's nonces die with a real stdio MCP session (audit F1 of
 * #1529).
 *
 * Every real client connects over stdio, and the SDK's stdio transport never
 * reports that stdin ended, so cleanup bound to `onclose` alone never ran: the
 * session's nonce file stayed on disk and its printed commands still worked
 * after the client was gone. The server now closes itself when stdin ends
 * and on SIGTERM / SIGINT, deleting the session's nonces; a server killed
 * outright (SIGKILL) leaves its file, which the next server sweeps once the
 * nonce lifetime has passed.
 *
 * Drives the built server (`node dist/index.js`) as a child process.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { Plur, FOLDER_NONCE_TTL_MS } from '@plur-ai/core'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST_ENTRY = join(PKG_ROOT, 'dist', 'index.js')

const dirs: string[] = []
const live: Array<{ client: Client; transport: StdioClientTransport }> = []

function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  dirs.push(d)
  return d
}

afterEach(async () => {
  for (const { client } of live.splice(0)) await client.close().catch(() => {})
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

interface Env { home: string; fakeHome: string; workspace: string }

function env(): Env {
  const home = tmp('plur-stdio-ask-store-')
  writeFileSync(join(home, 'config.yaml'), 'embeddings:\n  enabled: false\n')
  return { home, fakeHome: tmp('plur-stdio-ask-home-'), workspace: tmp('plur-stdio-ask-ws-') }
}

async function start(e: Env, cwd?: string): Promise<{ client: Client; transport: StdioClientTransport }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST_ENTRY],
    cwd: cwd ?? e.workspace,
    stderr: 'ignore',
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      HOME: e.fakeHome,
      PLUR_PATH: e.home,
      PLUR_TOOL_PROFILE: 'full',
    },
  })
  const client = new Client({ name: 'folder-ask-stdio', version: '1.0.0' })
  await client.connect(transport)
  const s = { client, transport }
  live.push(s)
  return s
}

async function ask(client: Client): Promise<any> {
  const raw = await client.callTool({ name: 'plur_learn', arguments: { statement: 'zebra stdio fact' } })
  return JSON.parse((raw.content as any)[0].text)
}

const nonceFiles = (e: Env) => (existsSync(join(e.home, 'folder-nonces')) ? readdirSync(join(e.home, 'folder-nonces')) : [])

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await new Promise(r => setTimeout(r, 50))
  }
  return cond()
}

function yesCommand(q: any): { folder: string; nonce: string; session: string } {
  const cmd = (q.answers as Array<{ label: string; command: string }>).find(a => /^Yes/.test(a.label))!.command
  const m = /folders set (\S+) --on --nonce ([0-9a-f]+) --session (\S+)$/.exec(cmd)!
  return { folder: m[1], nonce: m[2], session: m[3] }
}

describe.skipIf(!existsSync(DIST_ENTRY))('folder-question nonces over a real stdio session', () => {
  it('stdin end closes the session: its nonce file is deleted and its command no longer works', async () => {
    const e = env()
    const s = await start(e)
    const q = await ask(s.client)
    expect(q.plur).toBe('ask')
    expect(nonceFiles(e)).toHaveLength(1)
    const proc = (s.transport as any)._process
    proc.stdin.end()
    // Before the client's own SIGTERM (2 s after stdin ends).
    expect(await until(() => nonceFiles(e).length === 0, 1500)).toBe(true)
    const yes = yesCommand(q)
    const plur = new Plur({ path: e.home })
    expect(() => plur.setFolder(yes.folder, { mode: 'on' }, { nonce: yes.nonce, session: yes.session })).toThrow(/Unknown or already-used/)
  }, 30_000)

  // SIGTERM from another process cannot be caught on Windows (it is a
  // TerminateProcess); there a killed server's file is left for the sweep.
  it.skipIf(process.platform === 'win32')('SIGTERM closes the session: its nonce file is deleted', async () => {
    const e = env()
    const s = await start(e)
    expect((await ask(s.client)).plur).toBe('ask')
    expect(nonceFiles(e)).toHaveLength(1)
    process.kill(s.transport.pid!, 'SIGTERM')
    expect(await until(() => nonceFiles(e).length === 0, 3000)).toBe(true)
  }, 30_000)

  it('after SIGKILL the file stays, and the next server sweeps it once the nonce lifetime has passed', async () => {
    const e = env()
    const s = await start(e)
    expect((await ask(s.client)).plur).toBe('ask')
    process.kill(s.transport.pid!, 'SIGKILL')
    await new Promise(r => setTimeout(r, 300))
    const [file] = nonceFiles(e)
    expect(file).toBeDefined()
    // Still within the lifetime: a new server leaves it alone.
    const second = await start(e)
    await second.client.listTools()
    expect(nonceFiles(e)).toContain(file)
    // Age it past the lifetime: the next server start removes it.
    const path = join(e.home, 'folder-nonces', file)
    const old = Date.now() - FOLDER_NONCE_TTL_MS - 60_000
    writeFileSync(path, readFileSync(path, 'utf8').replace(/issued_at: \d+/g, `issued_at: ${old}`))
    const third = await start(e)
    await third.client.listTools()
    expect(nonceFiles(e)).not.toContain(file)
  }, 30_000)

  it('a request in flight when stdin ends still gets its response (audit R1 of #1529)', async () => {
    const e = env()
    const project = tmp('plur-stdio-on-')
    writeFileSync(join(project, '.plur.yaml'), '# on\n')
    const s = await start(e, project)
    const pending = s.client.callTool({ name: 'plur_learn', arguments: { statement: 'zebra in-flight learning', scope: 'global' } })
    ;(s.transport as any)._process.stdin.end()
    const raw = await Promise.race([pending, new Promise(r => setTimeout(() => r('no response'), 8000))])
    expect(raw).not.toBe('no response')
    const json = JSON.parse(((raw as any).content as any)[0].text)
    expect(json.plur).toBeUndefined()
    expect(readFileSync(join(e.home, 'engrams.yaml'), 'utf8')).toContain('zebra in-flight learning')
  }, 30_000)

  it.skipIf(process.platform === 'win32')('a request in flight on SIGTERM still gets its response (audit R1 of #1529)', async () => {
    const e = env()
    const project = tmp('plur-stdio-on-')
    writeFileSync(join(project, '.plur.yaml'), '# on\n')
    const s = await start(e, project)
    const pending = s.client.callTool({ name: 'plur_learn', arguments: { statement: 'zebra sigterm learning', scope: 'global' } })
    await new Promise(r => setTimeout(r, 5))
    process.kill(s.transport.pid!, 'SIGTERM')
    const raw = await Promise.race([pending, new Promise(r => setTimeout(() => r('no response'), 8000))])
    expect(raw).not.toBe('no response')
  }, 30_000)
})
