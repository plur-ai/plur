/**
 * Security audit 2026-11-06: a repository's committed .claude/settings.json
 * with a PLUR-looking hook (the `npx @plur-ai/cli hook-*` fallback, or a
 * plur-hook shim outside this home) is not this machine's init having set the
 * repo up. `plur init` there must not record the folder as `on` — that exact
 * entry counts as the user's decision (#1588) and adopts the repository's
 * .plur/engrams.yaml as a shared, writable store read in every folder.
 *
 * Real spawned CLI; HOME, USERPROFILE, TMPDIR and PLUR_PATH inside a temp dir.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'fs'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))

let base: string, home: string, plurRoot: string, env: NodeJS.ProcessEnv

function cli(args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const r = runCli('node', [CLI, ...args], { encoding: 'utf-8', env: { ...env, ...extraEnv }, cwd, input: '' })
  expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0)
  return r.stdout ?? ''
}

const text = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '')

function repoWithHook(name: string, command: string): string {
  const repo = join(home, 'code', name)
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(join(repo, '.claude'), { recursive: true })
  writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify({
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command }] }] },
  }, null, 2) + '\n')
  // The repository ships its own store with one dummy memory.
  cli(['learn', `Dummy marker ${name.toUpperCase()}MARK from the repo store`, '--json'], base, { PLUR_PATH: join(repo, '.plur') })
  expect(existsSync(join(repo, '.plur', 'engrams.yaml'))).toBe(true)
  return repo
}

const init = (cwd: string) =>
  cli(['init', '--no-desktop', '--no-prompt', '--no-codex', '--no-cursor', '--no-antigravity', '--no-opencode'], cwd)

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'plur-repo-hook-')))
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

describe('plur init does not turn a repo-shipped PLUR hook into a folder decision', () => {
  for (const [name, command] of [
    ['npxrepo', 'npx @plur-ai/cli hook-inject'],
    ['shimrepo', '/opt/elsewhere/plur-hook hook-inject'],
  ] as const) {
    it(`${name}: no folder-map entry and no adopted store`, () => {
      const repo = repoWithHook(name, command)
      const out = init(repo)
      expect(text(join(plurRoot, 'folders.yaml'))).not.toContain(repo)
      expect(text(join(plurRoot, 'config.yaml'))).not.toContain(join(repo, '.plur'))
      expect(out).toContain('not recorded in the folder map')
      // The hooks still moved out of the repo file.
      expect(text(join(repo, '.claude', 'settings.json'))).not.toContain('hook-inject')
    }, 60_000)
  }

  it("a committed settings file naming this home's own shim is not a decision (the path can be guessed)", () => {
    const repo = repoWithHook('guessrepo', `${join(home, '.plur', 'bin', 'plur-hook')} hook-inject`)
    rmSync(join(repo, '.git'), { recursive: true, force: true })
    const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { stdio: 'ignore' })
    git('init', '-q'); git('add', '.claude/settings.json'); git('commit', '-q', '-m', 'ship hooks')
    const out = init(repo)
    expect(text(join(plurRoot, 'folders.yaml'))).not.toContain(repo)
    expect(out).toContain('not recorded in the folder map')
    expect(text(join(repo, '.claude', 'settings.json'))).not.toContain('hook-inject')
  }, 60_000)

  it("this machine's own shim (what an older local init wrote) is still recorded as on", () => {
    const repo = repoWithHook('ownrepo', `${join(home, '.plur', 'bin', 'plur-hook')} hook-inject`)
    init(repo)
    expect(text(join(plurRoot, 'folders.yaml'))).toContain(repo)
  }, 60_000)
})
