/**
 * `plur remote` (#1413, folder-map design r3).
 *
 * One way to connect a folder to a team store: the URL and token go into the
 * user's own config.yaml (verified against /me first, via addRemoteStore from
 * #1272), and the current folder is mapped in folders.yaml. Nothing is written
 * to the repo's .plur.yaml, so no token lands in a repo folder. Bare
 * `plur remote` reports the folder policy and checks the stores serving this
 * folder. `plur init-remote` is a hidden alias; `plur trust` / `untrust` are
 * hidden from --help but keep working.
 *
 * Real spawned CLI against the in-process StubServer, with HOME, USERPROFILE
 * and PLUR_PATH pointed at a temp dir in every spawn: the real ~/.plur is
 * never touched. The spawn is async so the stub (in this process) can answer.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import yaml from 'js-yaml'
import { StubServer } from '../../core/test/helpers/stub-server.js'
import { builtCliPath } from './helpers/built-cli.js'
// Warm the module graph at collection time (see login.test.ts).
import '../src/commands/remote.js'

const CLI = builtCliPath(join(__dirname, '..'))
const TOKEN = 'plur-remote-SECRET-token-7a2f'
const BAD_TOKEN = 'plur-remote-wrong-SECRET-91'
const SCOPE = 'group:example/eng'
const SCOPE2 = 'group:example/ops'
const SPAWN_KILL_MS = 60_000
const TEST_TIMEOUT_MS = 120_000

interface Run { status: number; stdout: string; stderr: string }

let server: StubServer
let baseUrl: string
/** Every byte any run in this file printed — grepped for the tokens at the end. */
const allOutput: string[] = []

describe('plur remote (#1413)', () => {
  let root: string
  let plurDir: string
  let home: string
  let work: string

  beforeAll(async () => {
    server = new StubServer(TOKEN)
    baseUrl = (await server.start()).url
  })
  afterAll(async () => {
    await server.stop()
    const all = allOutput.join('\n')
    expect(all).not.toContain(TOKEN)
    expect(all).not.toContain(BAD_TOKEN)
  })

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plur-remote-'))
    plurDir = join(root, 'plur')
    home = join(root, 'home')
    work = join(root, 'work')
    mkdirSync(plurDir, { recursive: true })
    mkdirSync(home, { recursive: true })
    mkdirSync(join(work, '.git'), { recursive: true })
    writeFileSync(join(plurDir, 'config.yaml'), 'embeddings:\n  enabled: false\n')
    server.reset()
    server.setMe({ username: 'installer', org_id: 'example', role: 'developer', scopes: [SCOPE, SCOPE2] })
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  const configText = () => readFileSync(join(plurDir, 'config.yaml'), 'utf8')
  const foldersPath = () => join(plurDir, 'folders.yaml')
  const foldersText = () => existsSync(foldersPath()) ? readFileSync(foldersPath(), 'utf8') : null
  const folders = () => ((yaml.load(foldersText() ?? '') ?? { folders: [] }) as { folders: Array<Record<string, unknown>> }).folders ?? []

  function cli(args: string[], opts: { cwd?: string } = {}): Promise<Run> {
    return new Promise((resolve, reject) => {
      const child = spawn('node', [CLI, ...args, '--path', plurDir], {
        env: { ...process.env, HOME: home, USERPROFILE: home, PLUR_PATH: plurDir },
        cwd: opts.cwd ?? work,
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill('SIGKILL')
        reject(new Error(`plur ${args.join(' ')} timed out; stdout=${stdout.slice(0, 400)} stderr=${stderr.slice(0, 400)}`))
      }, SPAWN_KILL_MS)
      child.stdout.on('data', d => { stdout += String(d) })
      child.stderr.on('data', d => { stderr += String(d) })
      child.on('error', err => { if (!settled) { settled = true; clearTimeout(timer); reject(err) } })
      child.on('close', code => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        allOutput.push(stdout, stderr)
        resolve({ status: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() })
      })
      child.stdin.end()
    })
  }

  /** Run `plur remote` in THIS process in text mode (a spawned child is never a TTY). */
  async function inProcess(args: string[], cwd: string): Promise<{ out: string; code: number | undefined }> {
    const { run } = await import('../src/commands/remote.js')
    let out = ''
    let code: number | undefined
    const prevCwd = process.cwd()
    const prevHome = process.env.HOME
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => { out += String(c); return true })
    const spyErr = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => { out += String(c); return true })
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { code = c; throw new Error(`exit:${c}`) }) as never)
    process.chdir(cwd)
    process.env.HOME = home
    try {
      await run(args, { path: plurDir, json: false })
    } catch (err) {
      if (!String((err as Error).message).startsWith('exit:')) throw err
    } finally {
      process.chdir(prevCwd)
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
      spy.mockRestore(); spyErr.mockRestore(); exitSpy.mockRestore()
    }
    allOutput.push(out)
    return { out, code }
  }

  it('connects: url store in config.yaml, folder mapped in folders.yaml, nothing in .plur.yaml', async () => {
    const r = await cli(['remote', '--url', baseUrl, '--token', TOKEN, '--scope', SCOPE, '--json'])
    expect(r.status, r.stderr).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out).toMatchObject({ success: true, url: baseUrl, folder: realpathSync(work), scope: SCOPE })
    expect(out.stores).toEqual([expect.objectContaining({ scope: SCOPE, status: 'added' })])

    const config = yaml.load(configText()) as { stores: Array<Record<string, unknown>> }
    expect(config.stores).toEqual([expect.objectContaining({ url: baseUrl, scope: SCOPE, token: TOKEN })])
    expect(folders()).toEqual([{ path: realpathSync(work), scope: SCOPE }])
    expect(existsSync(join(work, '.plur.yaml'))).toBe(false)
    expect(existsSync(join(work, '.gitignore'))).toBe(false)
  }, TEST_TIMEOUT_MS)

  it('--scopes registers each scope and maps the folder to the first', async () => {
    const r = await cli(['remote', '--url', baseUrl, '--token', TOKEN, '--scopes', `${SCOPE},${SCOPE2}`, '--json'])
    expect(r.status, r.stderr).toBe(0)
    const config = yaml.load(configText()) as { stores: Array<Record<string, unknown>> }
    expect(config.stores.map(s => s.scope)).toEqual([SCOPE, SCOPE2])
    expect(folders()).toEqual([{ path: realpathSync(work), scope: SCOPE }])
  }, TEST_TIMEOUT_MS)

  it('a rejected token writes nothing', async () => {
    const before = configText()
    const r = await cli(['remote', '--url', baseUrl, '--token', BAD_TOKEN, '--scope', SCOPE])
    expect(r.status).not.toBe(0)
    expect(r.stdout + r.stderr).toMatch(/rejected/i)
    expect(configText()).toBe(before)
    expect(foldersText()).toBeNull()
    expect(existsSync(join(work, '.plur.yaml'))).toBe(false)
  }, TEST_TIMEOUT_MS)

  it('an unauthorised scope writes nothing, even when an earlier --scopes entry is fine', async () => {
    const before = configText()
    const r = await cli(['remote', '--url', baseUrl, '--token', TOKEN, '--scopes', `${SCOPE},group:example/finance`])
    expect(r.status).not.toBe(0)
    expect(r.stdout + r.stderr).toContain('group:example/finance')
    expect(configText()).toBe(before)
    expect(foldersText()).toBeNull()
  }, TEST_TIMEOUT_MS)

  it('is idempotent: a second identical run exits 0 and changes no file', async () => {
    const first = await cli(['remote', '--url', baseUrl, '--token', TOKEN, '--scope', SCOPE, '--json'])
    expect(first.status, first.stderr).toBe(0)
    const config1 = configText()
    const folders1 = foldersText()
    const second = await cli(['remote', '--url', baseUrl, '--token', TOKEN, '--scope', SCOPE, '--json'])
    expect(second.status, second.stderr).toBe(0)
    expect(JSON.parse(second.stdout).stores).toEqual([expect.objectContaining({ status: 'already_registered' })])
    expect(configText()).toBe(config1)
    expect(foldersText()).toBe(folders1)
  }, TEST_TIMEOUT_MS)

  it('the token is never printed, in text mode either', async () => {
    const { out, code } = await inProcess(['--url', baseUrl, '--token', TOKEN, '--scope', SCOPE], work)
    expect(code).toBeUndefined()
    expect(out).toContain(SCOPE)
    expect(out).not.toContain(TOKEN)
  }, TEST_TIMEOUT_MS)

  it('bare `plur remote` reports the folder policy and a reachable store', async () => {
    const connect = await cli(['remote', '--url', baseUrl, '--token', TOKEN, '--scope', SCOPE, '--json'])
    expect(connect.status, connect.stderr).toBe(0)
    const r = await cli(['remote', '--json'])
    expect(r.status, r.stderr).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.policy).toMatchObject({ mode: 'on', scope: SCOPE, source: 'map' })
    expect(out.stores).toEqual([expect.objectContaining({ url: baseUrl, scope: SCOPE, ok: true })])

    const text = await inProcess([], work)
    expect(text.code).toBeUndefined()
    expect(text.out).toMatch(/on/)
    expect(text.out).toContain(SCOPE)
    expect(text.out).toMatch(/reachable/i)
  }, TEST_TIMEOUT_MS)

  it('bare `plur remote` exits non-zero when a store serving this folder is unreachable', async () => {
    writeFileSync(join(plurDir, 'config.yaml'),
      `embeddings:\n  enabled: false\nstores:\n  - url: http://127.0.0.1:1\n    token: ${TOKEN}\n    scope: ${SCOPE}\n`)
    writeFileSync(foldersPath(), `version: 1\nfolders:\n  - path: ${realpathSync(work)}\n    scope: ${SCOPE}\n`)
    const r = await cli(['remote', '--json'])
    expect(r.status).not.toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.stores).toEqual([expect.objectContaining({ scope: SCOPE, ok: false })])
    const text = await inProcess([], work)
    expect(text.code).not.toBe(0)
    expect(text.out).toMatch(/unreachable/i)
  }, TEST_TIMEOUT_MS)

  it('bare `plur remote` in a folder no store serves says so and exits non-zero', async () => {
    const r = await cli(['remote', '--json'])
    expect(r.status).not.toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.policy).toMatchObject({ mode: 'ask', source: 'default' })
    expect(out.stores).toEqual([])
  }, TEST_TIMEOUT_MS)

  it('init-remote is an alias: the same flags give the same result, and --verify is bare remote', async () => {
    const r = await cli(['init-remote', '--url', baseUrl, '--token', TOKEN, '--scopes', SCOPE, '--json'])
    expect(r.status, r.stderr).toBe(0)
    const config = yaml.load(configText()) as { stores: Array<Record<string, unknown>> }
    expect(config.stores).toEqual([expect.objectContaining({ url: baseUrl, scope: SCOPE })])
    expect(folders()).toEqual([{ path: realpathSync(work), scope: SCOPE }])
    expect(existsSync(join(work, '.plur.yaml'))).toBe(false)

    const v = await cli(['init-remote', '--verify', '--json'])
    expect(v.status, v.stderr).toBe(0)
    expect(JSON.parse(v.stdout).stores).toEqual([expect.objectContaining({ scope: SCOPE, ok: true })])
  }, TEST_TIMEOUT_MS)

  describe('a legacy .plur.yaml that carries remote_url / remote_token', () => {
    const legacy = () => `domain: example\nremote_url: ${baseUrl}\nremote_token: ${TOKEN}\nremote_scopes:\n  - ${SCOPE}\n`

    it('connecting prints one line that the token can be removed, and never edits the file', async () => {
      writeFileSync(join(work, '.plur.yaml'), legacy())
      const { out, code } = await inProcess(['--url', baseUrl, '--token', TOKEN, '--scope', SCOPE], work)
      expect(code).toBeUndefined()
      const hint = out.split('\n').filter(l => l.includes('.plur.yaml') && /remove/i.test(l))
      expect(hint).toHaveLength(1)
      expect(hint[0]).toMatch(/user config|config\.yaml/i)
      expect(readFileSync(join(work, '.plur.yaml'), 'utf8')).toBe(legacy())
      const r = await cli(['remote', '--url', baseUrl, '--token', TOKEN, '--scope', SCOPE, '--json'])
      expect(r.status, r.stderr).toBe(0)
      expect(JSON.parse(r.stdout).legacy_plur_yaml).toMatchObject({ path: join(realpathSync(work), '.plur.yaml') })
      expect(readFileSync(join(work, '.plur.yaml'), 'utf8')).toBe(legacy())
    }, TEST_TIMEOUT_MS)

    it('golden: untrusted, its remote is refused and the folder asks', async () => {
      writeFileSync(join(work, '.plur.yaml'), legacy())
      const r = await cli(['remote', '--json'])
      expect(r.status).not.toBe(0)
      const out = JSON.parse(r.stdout)
      expect(out.policy).toEqual({
        mode: 'ask', remoteAllowed: false, source: 'plur-yaml', reason: 'untrusted-plur-yaml',
        requested: { domain: 'example', remote_url: baseUrl },
      })
      expect(out.stores).toEqual([])
      expect(readFileSync(join(work, '.plur.yaml'), 'utf8')).toBe(legacy())
    }, TEST_TIMEOUT_MS)

    it('golden: trusted, it still connects', async () => {
      writeFileSync(join(work, '.plur.yaml'), legacy())
      const t = await cli(['trust', work, '--json'])
      expect(t.status, t.stderr).toBe(0)
      const r = await cli(['remote', '--json'])
      expect(r.status, r.stderr).toBe(0)
      const out = JSON.parse(r.stdout)
      expect(out.policy).toEqual({ mode: 'on', remoteAllowed: true, source: 'plur-yaml' })
      expect(out.stores).toEqual([expect.objectContaining({ url: baseUrl, source: 'plur-yaml', ok: true })])
      expect(readFileSync(join(work, '.plur.yaml'), 'utf8')).toBe(legacy())
    }, TEST_TIMEOUT_MS)
  })

  it('plur --help lists remote, and no longer lists trust, untrust or init-remote', async () => {
    const r = await cli(['--help'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/^\s+remote\b/m)
    expect(r.stdout).not.toMatch(/^\s+trust\b/m)
    expect(r.stdout).not.toMatch(/^\s+untrust\b/m)
    expect(r.stdout).not.toMatch(/^\s+init-remote\b/m)
  }, TEST_TIMEOUT_MS)

  it('plur trust and plur untrust still work', async () => {
    const t = await cli(['trust', work, '--json'])
    expect(t.status, t.stderr).toBe(0)
    expect(JSON.parse(t.stdout)).toMatchObject({ success: true, trusted: realpathSync(work) })
    const u = await cli(['untrust', work, '--json'])
    expect(u.status, u.stderr).toBe(0)
    expect(JSON.parse(u.stdout)).toMatchObject({ success: true, removed: true })
  }, TEST_TIMEOUT_MS)
})
