import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { cursorHookFolder } from '../src/lib/folder-gate.js'

let root: string, folders: string[]
const scopes = ['project:example/team/app', 'project:other/team/app']
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'plur-cursor-git-agreement-')))
  folders = [join(root, 'a'), join(root, 'b')]
  for (const [i, folder] of folders.entries()) {
    mkdirSync(folder)
    execFileSync('git', ['init', '-q', folder])
    execFileSync('git', ['-C', folder, 'remote', 'add', 'origin', `https://git${i}.example.test/team/app.git`])
  }
  writeFileSync(join(root, 'config.yaml'), JSON.stringify({ stores: scopes.map((scope, i) => ({
    url: `https://memory${i}.example.test`, token: 'fixture-key', scope, scopes: [scope], enterprise: {},
    discovery: { status: 'ok', discovered_at: new Date().toISOString(), gitlab_host: `git${i}.example.test`, project_paths: { [scope]: 'team/app' } },
  })) }))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
it('a conflicting Cursor window never binds the first root as its Git destination', () => {
  const result = cursorHookFolder({ workspace_roots: folders }, { path: root })
  expect(result.policy.mode).toBe('on')
  expect(result.policy.scope).toBeUndefined()
  expect(result.policy.git).toEqual({ kind: 'unknown', reason: 'ambiguous-mapping' })
})
it('a single mapped root retains its Git destination', () => {
  const result = cursorHookFolder({ workspace_roots: [folders[0]] }, { path: root })
  expect(result.policy.scope).toBe(scopes[0])
  expect(result.policy.git).toMatchObject({ kind: 'scope', scope: scopes[0] })
})
