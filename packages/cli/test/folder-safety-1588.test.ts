/**
 * #1588 — folder safety, end to end through the built CLI's prompt hook.
 *
 *  - A PLUR marker in a folder above a cloned repository does not decide for
 *    it: the repository gets the "no decision for this folder yet" question
 *    and its shipped `.plur` store is not registered.
 *  - A repository that ships a `.plur` store, inside a folder that is on only
 *    through a parent folder-map entry, registers no store and injects none of
 *    its memories. After `plur folders set <repo> --on` the existing
 *    behaviour applies: the store is registered and its memories are used.
 *
 * Everything lives under the system temp folder. HOME, USERPROFILE, TMPDIR and
 * PLUR_PATH point inside it in every spawn, so the real ~/.plur is never
 * touched. PLUR_TEST_DISCOVER_IN_TMP=1 (a test-only switch) turns off core's
 * skip of discovery for a PLUR root under the temp folder, so the cases are
 * not vacuous (the explicit-decision case proves discovery runs).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))
const posix = process.platform !== 'win32'
const hasPythonPty = posix && spawnSync('python3', ['-c', 'import pty'], { encoding: 'utf-8' }).status === 0
const MCP = JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } })
const PROMPT = 'codeword fixture deploys orchid lantern staging lane'

let base: string
let home: string
let plurRoot: string
let env: NodeJS.ProcessEnv

function cli(args: string[], input: unknown, cwd: string, extraEnv: NodeJS.ProcessEnv = {}): { stdout: string; stderr: string; status: number } {
  const r = runCli('node', [CLI, ...args], {
    encoding: 'utf-8', env: { ...env, ...extraEnv }, cwd,
    input: typeof input === 'string' ? input : JSON.stringify(input),
  })
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? 1 }
}

function context(stdout: string): string {
  if (!stdout) return ''
  const j = JSON.parse(stdout)
  return j.hookSpecificOutput?.additionalContext ?? ''
}

function inject(folder: string, sid: string): string {
  return context(cli(['hook-inject'], { session_id: sid, cwd: folder, hook_event_name: 'UserPromptSubmit', prompt: PROMPT }, folder).stdout)
}

function configText(): string {
  const p = join(plurRoot, 'config.yaml')
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}

/** The CLI in an interactive terminal: no nonce needed, and text output, not JSON. */
function ptySet(args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}): { status: number | null; out: string } {
  const r = spawnSync('python3', [
    '-c', 'import os,pty,sys; sys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))',
    'node', CLI, ...args,
  ], { env: { ...env, COLUMNS: '400', ...extraEnv }, cwd, encoding: 'utf-8', timeout: 60_000, input: '' })
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
}

let code: string
let proj: string
let onProj: string

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'plur-1588-cli-')))
  home = join(base, 'home')
  plurRoot = join(home, '.plur')
  mkdirSync(plurRoot, { recursive: true })
  mkdirSync(join(base, 'tmp'), { recursive: true })
  env = {
    ...process.env,
    HOME: home, USERPROFILE: home, TMPDIR: join(base, 'tmp'),
    PLUR_PATH: plurRoot, PLUR_HOOK_HYBRID: 'off', PLUR_TEST_DISCOVER_IN_TMP: '1',
  }
  delete env.CLAUDE_SESSION_ID
  delete env.PLUR_AUTO_DISCOVER
  code = join(home, 'code')
  proj = join(code, 'proj')
  onProj = join(home, 'elsewhere', 'on-proj')
  mkdirSync(join(proj, '.git'), { recursive: true })
  mkdirSync(join(onProj, '.git'), { recursive: true })
  // The cloned repository ships its own store with one memory.
  const seeded = cli(['learn', 'Codeword ORCHIDLANTERN: fixture deploys leaked from the repo store', '--json'], '', base, { PLUR_PATH: join(proj, '.plur') })
  expect(seeded.status, seeded.stderr).toBe(0)
  expect(existsSync(join(proj, '.plur', 'engrams.yaml'))).toBe(true)
  // The user's own memory, in the main store.
  const own = cli(['learn', 'Codeword ZEPHYRQUILL: fixture deploys go through the blue staging lane', '--json'], '', base)
  expect(own.status, own.stderr).toBe(0)
}, 60_000)

afterEach(() => { rmSync(base, { recursive: true, force: true }) })

describe.skipIf(!posix)('#1588 a marker above a repository does not decide for it', () => {
  it('a parent .mcp.json naming plur: the repository is asked, no store is registered', () => {
    writeFileSync(join(code, '.mcp.json'), MCP)
    const before = configText()
    const text = inject(proj, 'cc-parent-marker')
    expect(text).toContain('no decision for this folder yet')
    expect(text).not.toContain('ORCHIDLANTERN')
    expect(text).not.toContain('project:proj')
    expect(configText()).toBe(before)
    expect(configText()).not.toContain(join(proj, '.plur'))
  }, 60_000)
})

describe.skipIf(!posix)('#1588 a repository store in a folder that is on only by inheritance', () => {
  beforeEach(() => {
    writeFileSync(join(plurRoot, 'folders.yaml'),
      `version: 1\nfolders:\n  - path: ${JSON.stringify(code)}\n    plur: on\n  - path: ${JSON.stringify(onProj)}\n    plur: on\n`)
  })

  it('registers no store and injects none of its memories, here or in another folder', () => {
    const before = configText()
    const text = inject(proj, 'cc-inherit')
    expect(text).not.toContain('no decision for this folder yet')
    expect(text).toContain('ZEPHYRQUILL')
    expect(text).not.toContain('ORCHIDLANTERN')
    expect(configText()).toBe(before)
    const other = inject(onProj, 'cc-other')
    expect(other).toContain('ZEPHYRQUILL')
    expect(other).not.toContain('ORCHIDLANTERN')
  }, 60_000)

  it.skipIf(!hasPythonPty)('after `plur folders set <repo> --on` the existing behaviour applies', () => {
    expect(inject(proj, 'cc-before')).not.toContain('ORCHIDLANTERN')
    const set = ptySet(['folders', 'set', proj, '--on'], base)
    expect(set.status, set.out).toBe(0)
    const text = inject(proj, 'cc-after')
    expect(text).toContain('ORCHIDLANTERN')
    expect(configText()).toContain(join(proj, '.plur', 'engrams.yaml'))
  }, 90_000)
})

describe.skipIf(!posix)('#1589 audit L2: one workspace entry keeps new worktrees on, with no question', () => {
  it('a new worktree path inside a repository under a workspace entry gets memories, not the question', () => {
    writeFileSync(join(plurRoot, 'folders.yaml'), `version: 1\nfolders:\n  - path: ${JSON.stringify(code)}\n    plur: on\n`)
    for (const name of ['feat-a', 'feat-b']) {
      const wt = join(proj, '.claude', 'worktrees', name)
      mkdirSync(wt, { recursive: true })
      writeFileSync(join(wt, '.git'), 'gitdir: elsewhere\n')
      const text = inject(wt, `cc-wt-${name}`)
      expect(text, name).not.toContain('no decision for this folder yet')
      expect(text, name).toContain('ZEPHYRQUILL')
    }
  }, 90_000)
})

describe.skipIf(!posix)('#1589 audit L3: a store skipped for lack of its own decision is listed with the command that adds it', () => {
  beforeEach(() => {
    writeFileSync(join(plurRoot, 'folders.yaml'), `version: 1\nfolders:\n  - path: ${JSON.stringify(code)}\n    plur: on\n`)
  })

  it.skipIf(!hasPythonPty)('plur stores list', () => {
    const out = ptySet(['stores', 'list'], proj)
    expect(out.status, out.out).toBe(0)
    expect(out.out.replace(/\r?\n/g, '')).toContain(join(proj, '.plur', 'engrams.yaml'))
    expect(out.out).toContain(`plur folders set ${proj} --on`)
    const json = JSON.parse(cli(['stores', 'list', '--json'], '', proj).stdout)
    expect(json.skipped.map((s: { folder: string }) => s.folder)).toEqual([proj])
    expect(configText()).not.toContain(join(proj, '.plur'))
  }, 60_000)

  it.skipIf(!hasPythonPty)('plur doctor', () => {
    const out = ptySet(['doctor', '--no-handshake'], proj, { PLUR_DISABLE_EMBEDDINGS: '1' })
    expect(out.out).toContain(join(proj, '.plur', 'engrams.yaml'))
    expect(out.out).toContain(`plur folders set ${proj} --on`)
    const json = JSON.parse(cli(['doctor', '--no-handshake', '--json'], '', proj, { PLUR_DISABLE_EMBEDDINGS: '1' }).stdout)
    expect(json.skippedProjectStores.map((s: { folder: string }) => s.folder)).toEqual([proj])
  }, 90_000)
})
