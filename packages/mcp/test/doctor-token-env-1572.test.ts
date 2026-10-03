/**
 * #1572 review M2: the CLI `plur doctor` and MCP `plur_doctor` agree on a
 * team store whose `token_env` variable is unset — both say not ok, with the
 * same detail and the same fix (which says to restart, review L1).
 */
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { Plur } from '@plur-ai/core'
import { createServer } from '../src/server.js'

const VAR = 'PLUR_TEST_1572_PARITY'
const CLI = join(__dirname, '..', '..', 'cli', 'dist', 'index.js')
const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

describe('plur doctor (CLI) and plur_doctor (MCP) agree on an unset token_env variable', () => {
  it('both not ok, same detail, same fix', async () => {
    delete process.env[VAR]
    const store = mkdtempSync(join(tmpdir(), 'plur-1572-parity-'))
    const home = mkdtempSync(join(tmpdir(), 'plur-1572-parity-home-'))
    dirs.push(store, home)
    writeFileSync(join(store, 'config.yaml'), `embeddings:\n  enabled: false\nstores:\n  - url: http://127.0.0.1:9\n    scope: group:acme/eng\n    token_env: ${VAR}\n`)

    const server = await createServer(new Plur({ path: store }), { profile: 'full' })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    const client = new Client({ name: 'parity', version: '1.0.0' })
    await client.connect(ct)
    const mcp = JSON.parse(((await client.callTool({ name: 'plur_doctor', arguments: {} })).content as any)[0].text)
    await client.close()
    const check = mcp.checks.find((c: any) => String(c.check).startsWith('remote store:'))
    expect(mcp.ok).toBe(false)
    expect(check?.ok).toBe(false)

    const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home, PLUR_PATH: store, PLUR_DISABLE_EMBEDDINGS: '1' }
    delete env[VAR]
    let out = ''
    try { out = execFileSync('node', [CLI, 'doctor', '--no-handshake', '--json'], { encoding: 'utf-8', env, cwd: home, stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 }) }
    catch (err: any) { out = err.stdout?.toString() ?? '' }
    const cli = JSON.parse(out)
    expect(cli.overall).toBe('fail')
    expect(cli.tokenEnvUnset).toHaveLength(1)
    const t = cli.tokenEnvUnset[0]
    expect(`remote store: ${t.url}`).toBe(check.check)
    expect(t.detail).toBe(check.detail)
    expect(mcp.remediation).toContain(t.fix)
    expect(t.fix).toMatch(/restart/i)
  }, 60000)
})
