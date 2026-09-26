/**
 * Formal-verification apply phase, decision E3 ("opencode rule everywhere"),
 * 2026-09-26.
 *
 * dsh adopts a workspace `.plur.yaml` scope only from a directory the user
 * trusted (`plur trust <dir>`, core's `Plur.isDirectoryTrusted`), warning with
 * the file and the trust command otherwise — @plur-ai/opencode's rule. And the
 * documented rule "the ambient global store is never a fallback" holds for the
 * workspace file too: `scope: global` is not adopted.
 * spec/formal/findings/adapters.md §9, PlurSpec/Adapters.lean §9.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Plur } from '@plur-ai/core'
import { createScopeResolver } from '../src/scope.js'
import { cfg } from './helpers/config.js'

// Lazy, so the suite runs (and fails on its assertions) before the export exists.
const reader = async () => (await import('../src/workspace-scope.js') as any).trustedWorkspaceScope as
  (trusts: (dir: string) => Promise<boolean> | boolean, warn: (msg: string) => void) =>
    (cwd: string) => Promise<string | undefined>

describe('dsh workspace scope needs directory trust (E3)', () => {
  let root: string
  let repo: string
  let store: string
  let plur: Plur
  let warnings: string[]

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'plur-e3-dsh-')))
    repo = join(root, 'cloned-repo')
    store = join(root, 'store')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(store)
    plur = new Plur({ path: store })
    warnings = []
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const resolve = async (yaml: string) => {
    writeFileSync(join(repo, '.plur.yaml'), yaml)
    const read = (await reader())(dir => plur.isDirectoryTrusted(dir), m => warnings.push(m))
    return createScopeResolver(cfg({ path: store }), read).resolve('agent-1', repo)
  }

  it('untrusted: the declared scope is ignored and the warning names the file and `plur trust`', async () => {
    const scope = await resolve('scope: group:acme/eng\n')
    expect(scope).not.toBe('group:acme/eng')
    expect(scope).toMatch(/^project:cloned-repo-/)
    expect(warnings.join('\n')).toContain(join(repo, '.plur.yaml'))
    expect(warnings.join('\n')).toContain(`plur trust ${repo}`)
  })

  it('trusted: the declared scope is adopted as before', async () => {
    plur.trustDirectory(repo)
    expect(await resolve('scope: group:acme/eng\n')).toBe('group:acme/eng')
    expect(warnings).toEqual([])
  })

  it('never the ambient global store: `scope: global` in a trusted workspace is not adopted', async () => {
    plur.trustDirectory(repo)
    const scope = await resolve('scope: global\n')
    expect(scope).not.toBe('global')
    expect(warnings.join('\n')).toMatch(/global/)
  })

  it('a throwing trust check fails closed', async () => {
    writeFileSync(join(repo, '.plur.yaml'), 'scope: group:acme/eng\n')
    const read = (await reader())(() => { throw new Error('boom') }, m => warnings.push(m))
    expect(await read(repo)).toBeUndefined()
  })
})
