import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'
import { workspaceScopeDecision, workspaceFolderScope, type FolderPolicy } from '../src/folders.js'

let root: string, a: string, b: string
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'plur-multi-root-'))); a = join(root, 'a'); b = join(root, 'b'); mkdirSync(a); mkdirSync(b) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })
const policy = (scope?: string, mode: FolderPolicy['mode'] = 'on'): FolderPolicy => ({ mode, scope, remoteAllowed: true, source: 'map' })
it('reports disagreeing scopes in root order', () => {
  expect(workspaceScopeDecision([a, b], dir => policy(dir === a ? 'project:example/a' : 'project:other/b'))).toEqual({
    kind: 'disagree', roots: [{ root: a, scope: 'project:example/a' }, { root: b, scope: 'project:other/b' }],
  })
})
it('reports one local and one scoped root as a disagreement', () => {
  expect(workspaceScopeDecision([a, b], dir => policy(dir === a ? undefined : 'project:example/b'))).toEqual({
    kind: 'disagree', roots: [{ root: a, scope: null }, { root: b, scope: 'project:example/b' }],
  })
})
it.each(['off', 'ask', 'remote-only'] as const)('preserves the existing closed decision for a %s root', mode => {
  expect(workspaceScopeDecision([a, b], dir => policy('project:example/a', dir === a ? mode : 'on'))).toEqual({ kind: 'none' })
})
it('preserves legacy results for agreed, absent, mixed, missing and home roots', () => {
  for (const [inputs, p, expected] of [
    [[a, b], () => policy('project:example/a'), 'project:example/a'],
    [[a, b], () => policy(), null],
    [[a, b], (d: string) => policy(d === a ? 'project:example/a' : undefined), null],
    [[], () => policy('project:example/a'), null],
    [[join(root, 'missing')], () => policy('project:example/a'), null],
    [[homedir(), a], () => policy('project:example/a'), null],
  ] as const) {
    expect(workspaceFolderScope([...inputs], p)).toBe(expected)
    const decision = workspaceScopeDecision([...inputs], p)
    expect(decision.kind === 'agreed' ? decision.scope : null).toBe(expected)
  }
})
