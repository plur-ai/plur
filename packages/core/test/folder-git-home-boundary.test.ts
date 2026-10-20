import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { resolveFolderPolicy, saveFolderMap } from '../src/folders.js'
import type { GitScopeSource, OriginRead } from '../src/git-origin.js'

let root: string, home: string, store: string
const scope = 'project:example/team/backend'
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'plur-git-home-boundary-')))
  home = join(root, 'home'); store = join(root, 'store')
  mkdirSync(home); mkdirSync(store)
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })
function options() {
  const source: GitScopeSource = {
    server: 'https://memory.example.test', gitlab_host: 'git.example.test',
    status: 'ok', scopes: [scope], project_paths: { [scope]: 'team/backend' },
    discovered_at: new Date().toISOString(),
  }
  return { root: store, home, gitScopes: [source],
    readOrigin: vi.fn((): OriginRead => ({ kind: 'url', url: 'https://git.example.test/team/backend.git' })),
  }
}
it('keeps home, its ancestors and filesystem root behind their folder decision', () => {
  for (const dir of [home, root, parse(home).root]) {
    const opts = options()
    expect(resolveFolderPolicy(dir, opts)).toMatchObject({ mode: 'ask', source: 'default' })
    expect(opts.readOrigin).not.toHaveBeenCalled()
  }
})
it('still honors an explicit home decision and a normal project default', () => {
  saveFolderMap(store, { version: 1, folders: [{ path: home, plur: 'on' }] })
  expect(resolveFolderPolicy(home, options())).toMatchObject({ mode: 'on', scope })
  const repo = join(home, 'repo'); mkdirSync(repo)
  saveFolderMap(store, { version: 1, folders: [] })
  expect(resolveFolderPolicy(repo, options())).toMatchObject({ mode: 'on', scope })
})
