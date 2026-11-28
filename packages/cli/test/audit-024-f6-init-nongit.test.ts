/**
 * Security audit 2026-11 (finding 6 of run 2): nothing a repository ships
 * counts as the user's folder decision (#1588). `plur init` records a folder
 * as `on` from its .claude/settings.json only when git positively reports that
 * file untracked in a real work tree (what an older local init left behind).
 * A folder that is not a git checkout (an archive, a copied tree), one whose
 * `.git` is not a valid repository, or a machine where git cannot answer,
 * gives no such evidence: the hooks still move to user settings, but the
 * folder map is left alone and the folder's .plur/engrams.yaml is not adopted
 * as a store.
 *
 * Real spawned CLI; HOME, USERPROFILE, TMPDIR and PLUR_PATH inside a temp dir.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, realpathSync, symlinkSync } from 'fs'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))

let base: string, home: string, plurRoot: string, env: NodeJS.ProcessEnv

function cli(args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const r = runCli(process.execPath, [CLI, ...args], { encoding: 'utf-8', env: { ...env, ...extraEnv }, cwd, input: '' })
  expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0)
  return r.stdout ?? ''
}

const text = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '')

/** A folder shipping settings.json whose PLUR hook names this home's own shim, plus its own store. */
function shippedFolder(dir: string): string {
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${join(home, '.plur', 'bin', 'plur-hook')} hook-inject` }] }] },
  }, null, 2) + '\n')
  cli(['learn', 'Dummy marker SHIPPEDMARK from the folder store', '--json'], base, { PLUR_PATH: join(dir, '.plur') })
  expect(existsSync(join(dir, '.plur', 'engrams.yaml'))).toBe(true)
  return dir
}

const init = (cwd: string, extraEnv: NodeJS.ProcessEnv = {}) =>
  cli(['init', '--no-desktop', '--no-prompt', '--no-codex', '--no-cursor', '--no-antigravity', '--no-opencode'], cwd, extraEnv)

function expectNoDecision(dir: string, out: string) {
  expect(text(join(plurRoot, 'folders.yaml'))).not.toContain(dir)
  expect(text(join(plurRoot, 'config.yaml'))).not.toContain(join(dir, '.plur'))
  expect(out).toContain('not recorded in the folder map')
  // The hooks still moved out of the folder's file.
  expect(text(join(dir, '.claude', 'settings.json'))).not.toContain('hook-inject')
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'plur-audit024-f6-')))
  home = join(base, 'home'); plurRoot = join(home, '.plur')
  mkdirSync(plurRoot, { recursive: true }); mkdirSync(join(base, 'tmp'))
  env = {
    ...process.env, HOME: home, USERPROFILE: home, TMPDIR: join(base, 'tmp'),
    PLUR_PATH: plurRoot, PLUR_HOOK_HYBRID: 'off', PLUR_TEST_DISCOVER_IN_TMP: '1',
  }
  delete env.CLAUDE_SESSION_ID
  delete env.PLUR_AUTO_DISCOVER
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

describe('plur init: a folder that is not a git checkout cannot record its own folder decision', () => {
  it('not a git checkout: no folder-map entry and no adopted store', () => {
    const dir = shippedFolder(join(base, 'code', 'archive'))
    expectNoDecision(dir, init(dir))
  }, 60_000)

  it('not a git checkout, inside the home folder: no folder-map entry and no adopted store', () => {
    const dir = shippedFolder(join(home, 'Downloads', 'archive'))
    expectNoDecision(dir, init(dir))
  }, 60_000)

  it('a .git that is not a valid repository gives no evidence either', () => {
    const dir = shippedFolder(join(base, 'code', 'fakegit'))
    mkdirSync(join(dir, '.git'))
    expectNoDecision(dir, init(dir))
  }, 60_000)

  it('git not available: no folder-map entry', () => {
    if (process.platform === 'win32') return
    const dir = shippedFolder(join(base, 'code', 'nogit'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    const bin = join(base, 'bin-node-only')
    mkdirSync(bin)
    symlinkSync(process.execPath, join(bin, 'node'))
    expectNoDecision(dir, init(dir, { PATH: bin }))
  }, 60_000)

  // 0.24 review round 2: a folder inside an unrelated repository, under a
  // directory that repository ignores, is not that work tree's own project.
  it('nested in another repository under an ignored directory: no folder-map entry and no adopted store', () => {
    const parent = join(base, 'code', 'parent')
    mkdirSync(join(parent, 'projects'), { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: parent })
    writeFileSync(join(parent, '.gitignore'), 'projects/\n')
    const dir = shippedFolder(join(parent, 'projects', 'archive'))
    expectNoDecision(dir, init(dir))
  }, 60_000)

  // 0.24 review round 4: .claude committed as a symlink to a shipped
  // directory; the settings file behind it is repository content.
  it('a settings file behind a committed .claude symlink: no folder-map entry and no adopted store', () => {
    if (process.platform === 'win32') return
    const dir = join(base, 'code', 'symlinked')
    const shipped = shippedFolder(join(dir, 'shipped'))
    // The hooks file lives in shipped/.claude; the project's .claude points at it.
    symlinkSync(join('shipped', '.claude'), join(dir, '.claude'))
    cli(['learn', 'Dummy marker SHIPPEDMARK from the folder store', '--json'], base, { PLUR_PATH: join(dir, '.plur') })
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['add', '.claude'], { cwd: dir })
    expect(shipped).toBe(join(dir, 'shipped'))
    expectNoDecision(dir, init(dir))
  }, 60_000)

  it('control: an untracked settings file in a real git work tree is still recorded as on', () => {
    const dir = shippedFolder(join(base, 'code', 'gituntracked'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    const out = init(dir)
    expect(text(join(plurRoot, 'folders.yaml'))).toContain(dir)
    expect(out).toContain('recorded as on')
  }, 60_000)
})
