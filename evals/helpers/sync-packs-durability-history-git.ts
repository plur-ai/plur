// Git fixtures for the sync evals: a bare "remote" repository in a temp dir,
// and a way to see exactly what was pushed to it (by cloning it).
//
// Every git this file or sync.ts spawns is isolated from the developer's own
// git config: a global gitignore listing engrams.yaml would otherwise empty
// the commit, and setup.ts has moved HOME so there is no user identity.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createRequire } from 'node:module'

// js-yaml is a dependency of core, not of the repo root; resolve it from there.
export const yaml = createRequire(new URL('../../packages/core/package.json', import.meta.url))('js-yaml') as typeof import('js-yaml')

let isolated = false
/** Point git at a scratch global config with an identity; ignore the system config. */
export function isolateGit(): void {
  if (isolated) return
  const dir = mkdtempSync(join(tmpdir(), 'plur-eval-gitcfg-'))
  const cfg = join(dir, 'gitconfig')
  writeFileSync(cfg, '[user]\n  name = PLUR Eval\n  email = eval@example.invalid\n[init]\n  defaultBranch = main\n[core]\n  excludesFile = /dev/null\n')
  process.env.GIT_CONFIG_GLOBAL = cfg
  process.env.GIT_CONFIG_SYSTEM = '/dev/null'
  isolated = true
}

export function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** A fresh, empty bare repository to push to. */
export function bareRemote(): { path: string; cleanup(): void } {
  isolateGit()
  const dir = mkdtempSync(join(tmpdir(), 'plur-eval-remote-'))
  const path = join(dir, 'remote.git')
  git(['init', '--bare', '--quiet', '-b', 'main', path], dir)
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Clone the remote and return what a teammate pulling it would see. */
export function cloneRemote(remote: string): { dir: string; files: string[]; engrams: Array<Record<string, unknown>>; text: string; cleanup(): void } {
  const parent = mkdtempSync(join(tmpdir(), 'plur-eval-clone-'))
  const dir = join(parent, 'clone')
  git(['clone', '--quiet', remote, dir], parent)
  const files: string[] = []
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === '.git') continue
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else files.push(relative(dir, p))
    }
  }
  walk(dir)
  const enPath = join(dir, 'engrams.yaml')
  const enText = existsSync(enPath) ? readFileSync(enPath, 'utf8') : ''
  const parsed = enText ? (yaml.load(enText) as { engrams?: Array<Record<string, unknown>> } | null) : null
  const text = files.map(f => readFileSync(join(dir, f), 'utf8')).join('\n')
  return { dir, files, engrams: parsed?.engrams ?? [], text, cleanup: () => rmSync(parent, { recursive: true, force: true }) }
}
