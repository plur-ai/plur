import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'
import { printText } from '../src/commands/doctor.js'

let home: string, root: string, server: Server, writeStatus: number
const scope = 'project:example/team/app'
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'plur-doctor-server-')); root = join(home, '.plur'); mkdirSync(root)
  writeStatus = 200
  server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/v1/me') { res.end(JSON.stringify({ username: 'fixture', org_id: 'example', scopes: [scope], scopes_status: 'ok' })); return }
    if (req.url === '/api/v1/write-check') {
      let raw = ''; for await (const c of req) raw += c
      res.writeHead(writeStatus); res.end(JSON.stringify({ results: JSON.parse(raw).scopes.map((scope: string) => ({ scope, writable: true, review_held: false })) })); return
    }
    res.writeHead(404); res.end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  writeFileSync(join(root, 'config.yaml'), JSON.stringify({ index: false, embeddings: { enabled: false }, stores: [{
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: 'fixture-key', scopes: [scope], enterprise: {},
    discovery: { status: 'ok', discovered_at: new Date().toISOString() },
  }] }))
  chmodSync(join(root, 'config.yaml'), 0o600)
})
afterEach(async () => { vi.restoreAllMocks(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(home, { recursive: true, force: true }) })
async function cli(args: string[], cwd = home) {
  const child = spawn(process.execPath, [builtCliPath(join(__dirname, '..')), ...args], {
    cwd, env: { ...isolatedHomeEnv(home), PLUR_DISABLE_EMBEDDINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''; child.stdout.on('data', c => { stdout += c }); child.stderr.on('data', c => { stderr += c })
  const timer = setTimeout(() => child.kill(), 25000)
  const status = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }).finally(() => clearTimeout(timer))
  expect(status, stderr).not.toBeNull()
  return { stdout, stderr, status }
}
it('exposes six checks in JSON and fails without a healthy text conclusion when permission evidence is missing', async () => {
  writeStatus = 404
  const r = await cli(['doctor', '--no-handshake', '--json']), report = JSON.parse(r.stdout)
  expect(r.status).toBe(1); expect(report.overall).toBe('fail')
  expect(report.serverStores).toHaveLength(1)
  expect(report.serverStores[0].checks).toHaveLength(6)
  expect(report.serverStores[0].checks.find((c: any) => c.name === 'write-path').result).toBe('could-not-check')
  let text = ''; vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { text += s; return true }) as any)
  printText(report)
  expect(text).toContain('could not check'); expect(text).not.toContain('Healthy')
}, 30000)
it.each(['claude', 'codex', 'cursor'])('init records %s installation and doctor requires a later real hook run', async tool => {
  const initialized = await cli(['init', '--no-prompt', ...(tool === 'claude' ? [] : [`--${tool}`])])
  expect(initialized.status, initialized.stderr).toBe(0)
  const installed = JSON.parse(readFileSync(join(root, 'hook-installs.json'), 'utf8'))[tool]
  expect(Number.isFinite(Date.parse(installed))).toBe(true)
  let report = JSON.parse((await cli(['doctor', '--no-handshake', '--json'])).stdout)
  const row = () => report.hookTrust.find((r: any) => r.tool === tool)
  expect(row()).toMatchObject({ ok: false }); expect(row().detail).toContain('hooks have not run yet')
  expect(row().fix).toContain(tool === 'codex' ? '/hooks' : 'start a new session')
  writeFileSync(join(root, 'hook-runs.json'), JSON.stringify({ [tool]: installed }))
  report = JSON.parse((await cli(['doctor', '--no-handshake', '--json'])).stdout)
  expect(row().ok).toBe(false)
  writeFileSync(join(root, 'hook-runs.json'), JSON.stringify({ [tool]: '2000-01-01T00:00:00Z' }))
  report = JSON.parse((await cli(['doctor', '--no-handshake', '--json'])).stdout)
  expect(row().ok).toBe(false)
  // Existing session-start integration tests prove the hook writes this file.
  writeFileSync(join(root, 'hook-runs.json'), JSON.stringify({ [tool]: new Date().toISOString() }))
  report = JSON.parse((await cli(['doctor', '--no-handshake', '--json'])).stdout)
  expect(row().ok).toBe(true); expect(row().detail).toContain('hooks ran')
}, 60000)
it('a changed global hook invalidates a split project installation while an unchanged init preserves it', async () => {
  const project = join(home, 'project'); mkdirSync(project)
  expect((await cli(['init', '--project', '--no-prompt'], project)).status).toBe(0)
  const path = join(root, 'hook-installs.json')
  const first = JSON.parse(readFileSync(path, 'utf8')).claude
  expect((await cli(['init', '--project', '--no-prompt'], project)).status).toBe(0)
  expect(JSON.parse(readFileSync(path, 'utf8')).claude).toBe(first)
  const global = join(home, '.claude', 'settings.json')
  const settings = JSON.parse(readFileSync(global, 'utf8'))
  settings.hooks = {}
  writeFileSync(global, JSON.stringify(settings))
  expect((await cli(['init', '--project', '--no-prompt'], project)).status).toBe(0)
  expect(Date.parse(JSON.parse(readFileSync(path, 'utf8')).claude)).toBeGreaterThan(Date.parse(first))
}, 60000)
