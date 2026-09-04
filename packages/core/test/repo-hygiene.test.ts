import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

/**
 * Structural guards on what the repository TRACKS — the sibling of the
 * `index.ts contains no direct loadEngrams calls` guard in
 * plur-source-of-truth.test.ts, aimed at the working tree instead of a module.
 *
 * `plur init` writes two files into the current directory that every
 * contributor generates for their own machine: `.claude/settings.json` (hook
 * and MCP commands as ABSOLUTE paths under the installer's home directory) and
 * `AGENTS.md`. Both were swept into a review commit of #1017 by `git add -A`,
 * which put seven hook events and an MCP server entry pointing at one
 * developer's `~/.plur/bin` into every checkout — an execution policy for
 * paths that exist on no other machine. Fourth instance of the class
 * (`pgprobe.mjs`, the `*.tmp.mjs` gate probes, `mig-seed.mjs`); the release
 * gate added for the previous one matches `*.tmp.*` only.
 *
 * Git is the oracle, deliberately: the files legitimately EXIST in every
 * developer's working tree (gitignored), so a filesystem check would be either
 * vacuous or always red. What must never be true is that they are tracked.
 */
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')

function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
  return out.split('\0').filter(Boolean)
}

/** Every string value anywhere in a parsed JSON document, with its path. */
function stringLeaves(value: unknown, path = '$'): Array<{ path: string; value: string }> {
  if (typeof value === 'string') return [{ path, value }]
  if (Array.isArray(value)) return value.flatMap((v, i) => stringLeaves(v, `${path}[${i}]`))
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .flatMap(([k, v]) => stringLeaves(v, `${path}.${k}`))
  }
  return []
}

// A path under someone's home directory. `plur init` writes
// `/Users/<name>/.plur/bin/plur-hook` (macOS), `/home/<name>/...` (Linux) or
// `C:\Users\<name>\...` (Windows) — none of which resolve anywhere else.
const HOME_PATH = /(^|[^A-Za-z0-9])(\/Users\/|\/home\/|[A-Za-z]:\\Users\\)/

/**
 * Tracked root-level AGENTS.md files that are permitted, with the reason. The
 * generated one from `plur init` is not — it is machine-local installer
 * output, and the same content already ships to agents through the MCP
 * server's `plur://guide` resource. Add an entry here (and say why in the PR)
 * before tracking one.
 */
const ALLOWED_ROOT_AGENTS_MD: ReadonlyMap<string, string> = new Map<string, string>([
  // e.g. ['AGENTS.md', 'hand-written contributor guide, reviewed in #NNNN']
])

describe('repository does not track installer output (#1017 review, #1110)', () => {
  const tracked = trackedFiles()

  it('is running against a git checkout (the guard is not vacuous)', () => {
    // If `git ls-files` returned nothing the assertions below would pass for
    // the wrong reason. package.json at the root is always tracked.
    expect(tracked).toContain('package.json')
  })

  it('no tracked settings.json points a hook or MCP command at a home directory', () => {
    const offenders: string[] = []
    for (const file of tracked) {
      const base = basename(file)
      if (base !== 'settings.json' && base !== 'settings.local.json') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(readFileSync(join(repoRoot, file), 'utf8'))
      } catch {
        continue // not JSON — nothing Claude Code would execute from it
      }
      for (const leaf of stringLeaves(parsed)) {
        if (HOME_PATH.test(leaf.value)) offenders.push(`${file} ${leaf.path} = ${leaf.value}`)
      }
    }
    expect(offenders, 'execution policy pointing outside the repo').toEqual([])
  })

  it('no tracked .claude/settings.json at the repository root at all', () => {
    // Stricter than the path check above: the file is `plur init` output by
    // construction (see the header), so even one with relative commands is a
    // contributor's local install swept in by `git add -A`.
    expect(tracked).not.toContain('.claude/settings.json')
    expect(tracked).not.toContain('.claude/settings.local.json')
  })

  it('a root AGENTS.md is tracked only with an allow-list entry', () => {
    const rootAgents = tracked.filter(f => f === 'AGENTS.md')
    const unlisted = rootAgents.filter(f => !ALLOWED_ROOT_AGENTS_MD.has(f))
    expect(unlisted, 'generated AGENTS.md tracked without an allow-list entry').toEqual([])
  })

  it('.gitignore keeps the installer output out of `git add -A`', () => {
    // The two lines are the first line of defence; the ls-files checks above
    // are the second. Both must hold — the review commit that motivated this
    // guard landed before the ignore lines existed.
    const lines = readFileSync(join(repoRoot, '.gitignore'), 'utf8')
      .split('\n').map(l => l.trim())
    expect(lines).toContain('.claude/settings.json')
    expect(lines).toContain('AGENTS.md')
  })
})
