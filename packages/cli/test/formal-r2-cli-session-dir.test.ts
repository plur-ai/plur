import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, symlinkSync, existsSync, chmodSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'

/**
 * Formal round 2, cli#8 — session-directory vetting on the READ side and on
 * every writer (spec/formal/PlurSpec/R2CLI.lean §1, findings/r2-cli.md item 1).
 *
 * #1060 vetted the directory before WRITING for the Codex and Antigravity
 * families. Three holes remained, each replayed against the built binary:
 *   - readers trusted whatever sat in the directory, so a planted Antigravity
 *     turn cache reached the model as "recalled memory";
 *   - the Cursor family computed the verdict and then wrote into the refused
 *     directory anyway (through the planted symlink);
 *   - the Claude Code family used a bare mkdirSync and wrote its sentinel with
 *     a plain writeFileSync that follows a planted symlink and truncates it.
 */

const CLI = process.env.PLUR_R2_CLI ?? builtCliPath(join(__dirname, '..'))
const posixOnly = process.platform === 'win32' ? it.skip : it

describe('cli#8 session-dir vetting (formal r2)', () => {
  let root: string
  let tmp: string
  let attacker: string
  let proj: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plur-r2-sessdir-'))
    tmp = join(root, 'tmp')
    attacker = join(root, 'attacker')
    proj = join(root, 'proj')
    for (const d of [tmp, attacker, proj, join(root, 'home')]) mkdirSync(d, { recursive: true })
    writeFileSync(join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  function hook(name: string, input: object, cwd = proj) {
    return runCli('node', [CLI, name], {
      input: JSON.stringify(input),
      encoding: 'utf-8',
      cwd,
      env: {
        ...process.env,
        HOME: join(root, 'home'),
        USERPROFILE: join(root, 'home'),
        TMPDIR: tmp,
        PLUR_PATH: join(root, 'home', '.plur'),
        PLUR_HOOK_NO_EXIT: '1',
        PLUR_DISABLE_EMBEDDINGS: '1',
        PLUR_HOOK_HYBRID: '0',
      },
    })
  }

  posixOnly('antigravity: a planted turn cache behind a symlinked dir never reaches the model', () => {
    symlinkSync(attacker, join(tmp, 'plur-agy-sessions'))
    writeFileSync(join(attacker, 'c1.turncache'), JSON.stringify({
      conversationId: 'c1', step: 5, textHash: 'x', message: 'PLANTED-BY-ATTACKER',
    }))
    const r = hook('hook-agy-pre-invocation', { conversationId: 'c1', invocationNum: 1 })
    expect(r.status).toBe(0)
    expect(r.stdout).not.toContain('PLANTED-BY-ATTACKER')
  }, 60_000)

  posixOnly('antigravity: a group/other-writable dir is not trusted either', () => {
    const dir = join(tmp, 'plur-agy-sessions')
    mkdirSync(dir)
    chmodSync(dir, 0o777)
    writeFileSync(join(dir, 'c1.turncache'), JSON.stringify({
      conversationId: 'c1', step: 5, textHash: 'x', message: 'PLANTED-IN-SHARED-DIR',
    }))
    const r = hook('hook-agy-pre-invocation', { conversationId: 'c1', invocationNum: 1 })
    expect(r.status).toBe(0)
    expect(r.stdout).not.toContain('PLANTED-IN-SHARED-DIR')
  }, 60_000)

  posixOnly('cursor: the guard writes nothing into a refused (symlinked) directory', () => {
    symlinkSync(attacker, join(tmp, 'plur-cursor-sessions'))
    const r = hook('hook-cursor-guard', { conversation_id: 'c2', tool_name: 'Shell' })
    expect(r.status).toBe(0)
    expect(readdirSync(attacker)).toEqual([])
  }, 60_000)

  posixOnly('cursor: a sentinel planted behind a symlink does not count as "session started"', () => {
    symlinkSync(attacker, join(tmp, 'plur-cursor-sessions'))
    writeFileSync(join(attacker, 'c3.marker'), 'x')
    // post-tool reminds only for a started session; a planted sentinel must not
    // make it write reminder state through the symlink either.
    const r = hook('hook-cursor-post-tool', { conversation_id: 'c3', tool_name: 'Shell' })
    expect(r.status).toBe(0)
    expect(readdirSync(attacker)).toEqual(['c3.marker'])
  }, 60_000)

  posixOnly('claude: hook-session-mark does not follow a planted symlink (victim not truncated)', () => {
    const victim = join(root, 'victim.txt')
    writeFileSync(victim, 'precious')
    symlinkSync(victim, join(tmp, 'plur-session-s3'))
    const r = hook('hook-session-mark', { session_id: 's3' })
    expect(r.status).toBe(0)
    expect(readFileSync(victim, 'utf8')).toBe('precious')
  }, 60_000)

  posixOnly('claude: the guard state dir is vetted — no counter written through a symlink', () => {
    symlinkSync(attacker, join(tmp, 'plur-sessions'))
    const r = hook('hook-session-guard', { session_id: 's5', tool_name: 'Bash' })
    expect(r.status).toBe(0)
    expect(readdirSync(attacker)).toEqual([])
  }, 60_000)

  it('claude: a namespaced plur_session_start is exempt, like every other harness', () => {
    const r = hook('hook-session-guard', { session_id: 's4', tool_name: 'mcp__plugin_plur_plur__plur_session_start' })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  }, 60_000)

  it('claude: an ordinary tool is still nudged once (guard not disabled by the fix)', () => {
    const r = hook('hook-session-guard', { session_id: 's6', tool_name: 'Bash' })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('"permissionDecision":"deny"')
    const r2 = hook('hook-session-guard', { session_id: 's6', tool_name: 'Bash' })
    expect(r2.stdout).toBe('')
  }, 60_000)

  it('claude: mark then guard — a marked session is not nudged', () => {
    hook('hook-session-mark', { session_id: 's7' })
    expect(existsSync(join(tmp, 'plur-session-s7'))).toBe(true)
    const r = hook('hook-session-guard', { session_id: 's7', tool_name: 'Bash' })
    expect(r.stdout).toBe('')
  }, 60_000)
})
