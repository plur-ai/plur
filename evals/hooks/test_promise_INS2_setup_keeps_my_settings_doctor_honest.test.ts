// INS-2: Setting up PLUR keeps my other client settings, and the doctor
// reports a memory connection it could not verify as a failure.
//
// Setup: each installer (`plur init` and `plur-mcp init`, run from source into
// a throwaway HOME) meets a Claude Code that is already customised: other MCP
// servers and unrelated keys in ~/.claude.json, other hooks, permissions, env
// and unrelated keys in ~/.claude/settings.json. Everything that was there must
// still be there, unchanged, next to PLUR's own entries.
//
// Doctor: the MCP plur_doctor with a team store that cannot be reached must
// say not ok and name that store (control: the same store reachable is not a
// failing check). `plur doctor --no-handshake` does not start the memory
// server, so it has not verified the connection: it must not say "ok".
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { hookHome, runSource, type HookHome } from '../helpers/agent-tools-hooks-cli.js'
import {
  resetTeamStub, startTeamStub, teamStore, type TeamStore, type TeamStub,
} from '../helpers/privacy-folders-team-stub.js'
import { callTool, connectMcp, offlineFetch } from '../helpers/privacy-folders-team-mcp.js'

const CLI_INIT = ['init', '--global', '--no-prompt', '--no-desktop', '--no-cursor', '--no-codex', '--no-opencode', '--no-antigravity']
const MCP_INIT = ['init']
type Installer = 'plur init' | 'plur-mcp init'

const MY_CLAUDE_JSON = {
  numStartups: 41,
  theme: 'dark',
  mcpServers: {
    github: { type: 'stdio', command: 'github-mcp', args: ['--readonly'], env: { GH_HOST: 'github.example.com' } },
    notes: { type: 'stdio', command: 'notes-mcp', args: [] },
  },
  projects: { '/work/app': { allowedTools: ['Bash(git status:*)'], mcpServers: { local: { command: 'local-mcp' } } } },
}
const MY_HOOK_PROMPT = { hooks: [{ type: 'command', command: '/opt/tools/prompt-audit --log' }] }
const MY_HOOK_BASH = { matcher: 'Bash', hooks: [{ type: 'command', command: '/opt/tools/bash-guard' }] }
const MY_SETTINGS = {
  model: 'opus',
  permissions: { allow: ['Bash(ls:*)', 'Read(~/notes/**)'], deny: ['Bash(rm -rf:*)'] },
  env: { MY_FLAG: 'kept' },
  statusLine: { type: 'command', command: '/opt/tools/status' },
  hooks: { UserPromptSubmit: [MY_HOOK_PROMPT], PreToolUse: [MY_HOOK_BASH], Notification: [{ hooks: [{ type: 'command', command: '/opt/tools/notify' }] }] },
}

function customise(h: HookHome): void {
  writeFileSync(join(h.home, '.claude.json'), JSON.stringify(MY_CLAUDE_JSON, null, 2))
  mkdirSync(join(h.home, '.claude'), { recursive: true })
  writeFileSync(join(h.home, '.claude', 'settings.json'), JSON.stringify(MY_SETTINGS, null, 2))
}

function install(h: HookHome, which: Installer): void {
  const r = which === 'plur init'
    ? runSource('cli', CLI_INIT, { env: h.env, cwd: h.home, timeoutMs: 90_000 })
    : runSource('mcp', MCP_INIT, { env: h.env, cwd: h.home, timeoutMs: 90_000 })
  if (r.status !== 0) throw new Error(`${which} failed (exit ${r.status}): ${r.stderr.slice(0, 500)}`)
}

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'))
const hasPlurHook = (settings: any) => JSON.stringify(settings.hooks ?? {}).includes('hook-')

describe('INS-2 setup keeps my other client settings; the doctor calls an unverified memory connection a failure', () => {
  const homes: HookHome[] = []
  afterEach(() => { while (homes.length) homes.pop()!.cleanup() })
  const fresh = () => { const h = hookHome(); homes.push(h); return h }

  for (const which of ['plur init', 'plur-mcp init'] as const) {
    it(`${which} keeps my other MCP servers, hooks and settings`, () => {
      const h = fresh()
      customise(h)
      install(h, which)

      const claudeJson = readJson(join(h.home, '.claude.json'))
      expect(claudeJson.mcpServers?.plur, `precondition: ${which} registered the PLUR server in ~/.claude.json`).toBeTruthy()
      for (const [name, server] of Object.entries(MY_CLAUDE_JSON.mcpServers)) {
        expect(claudeJson.mcpServers?.[name], `${which} changed or removed my "${name}" MCP server`).toEqual(server)
      }
      for (const key of ['numStartups', 'theme', 'projects'] as const) {
        expect(claudeJson[key], `${which} changed or removed "${key}" in ~/.claude.json`).toEqual(MY_CLAUDE_JSON[key])
      }

      const settings = readJson(join(h.home, '.claude', 'settings.json'))
      expect(hasPlurHook(settings), `precondition: ${which} installed PLUR's hooks`).toBe(true)
      for (const key of ['model', 'permissions', 'env', 'statusLine'] as const) {
        expect(settings[key], `${which} changed or removed "${key}" in ~/.claude/settings.json`).toEqual(MY_SETTINGS[key])
      }
      expect(settings.hooks?.UserPromptSubmit ?? [], `${which} removed my own prompt hook`).toContainEqual(MY_HOOK_PROMPT)
      expect(settings.hooks?.PreToolUse ?? [], `${which} removed my own Bash guard hook`).toContainEqual(MY_HOOK_BASH)
      expect(settings.hooks?.Notification, `${which} changed my Notification hook`).toEqual(MY_SETTINGS.hooks.Notification)
    }, 180_000)
  }

  it('plur doctor without the server handshake does not call the connection ok', () => {
    const h = fresh()
    install(h, 'plur init')
    const r = runSource('cli', ['doctor', '--no-handshake', '--json'], { env: h.env, cwd: h.home, timeoutMs: 90_000 })
    let report: any
    try { report = JSON.parse(r.stdout) } catch { throw new Error(`plur doctor did not print JSON (exit ${r.status}): ${r.stdout.slice(0, 300)} ${r.stderr.slice(0, 300)}`) }
    expect(report.hooksInstalled, `precondition: after plur init the doctor sees the hooks; report: ${r.stdout.slice(0, 400)}`).toBe(true)
    expect(report.handshake?.ok, 'precondition: the doctor did not start the memory server').toBe(false)
    expect(report.overall, `expected the doctor not to say "ok" for a memory connection it did not verify; it said ${report.overall} (handshake: ${JSON.stringify(report.handshake)})`).not.toBe('ok')
    expect(r.status, 'expected the doctor to exit with a failure when the connection is unverified').not.toBe(0)
  }, 180_000)
})

describe('INS-2 plur_doctor reports a team store it cannot reach as a failure', () => {
  let t: TeamStub
  let s: TeamStore | undefined
  let net: ReturnType<typeof offlineFetch> | undefined
  const closers: Array<() => Promise<void>> = []
  beforeAll(async () => { t = await startTeamStub() })
  afterAll(async () => { await t.stop() })
  beforeEach(() => resetTeamStub(t))
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const c of closers.splice(0)) await c()
    net?.restore(); net = undefined
    s?.cleanup(); s = undefined
  })

  async function doctor(url: string): Promise<{ ok: boolean; remote: any[]; text: string }> {
    s?.cleanup()
    s = await teamStore(url)
    await s.plur.learn('the doctor eval keeps one memory in the store', { scope: 'global' })
    net?.restore()
    net = offlineFetch()
    vi.spyOn(process, 'cwd').mockReturnValue(s.dir)
    const conn = await connectMcp(s.plur)
    closers.push(conn.close)
    const r = await callTool(conn.client, 'plur_doctor', {})
    expect(r.raw.isError, `plur_doctor failed: ${r.text.slice(0, 300)}`).not.toBe(true)
    const checks = (r.json?.checks ?? []) as Array<{ check: string; ok: boolean }>
    return { ok: r.json?.ok, remote: checks.filter(c => String(c.check).includes(url)), text: r.text }
  }

  it('reachable: the team store check passes; unreachable: it fails and the doctor is not ok', async () => {
    const up = await doctor(t.url)
    expect(up.remote.length, `precondition: the doctor checks the team store; checks: ${up.text.slice(0, 600)}`).toBeGreaterThan(0)
    expect(up.remote.every(c => c.ok), `precondition: a reachable team store passes; got ${JSON.stringify(up.remote)}`).toBe(true)

    const gone = await startTeamStub()
    const url = gone.url
    await gone.stop()
    const down = await doctor(url)
    expect(down.remote.length, `expected the doctor to report the team store it could not reach (${url}); report: ${down.text.slice(0, 800)}`).toBeGreaterThan(0)
    expect(down.remote.some(c => c.ok === false), `expected the unreachable team store to be a failing check; got ${JSON.stringify(down.remote)}`).toBe(true)
    expect(down.ok, 'expected the doctor not to say ok with a team store it could not reach').toBe(false)
  })
})
