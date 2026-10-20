import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Plur } from '@plur-ai/core'
import { StubServer } from '../../core/test/helpers/stub-server.js'
import { PlurPlugin } from '../src/index.js'
import { setupV2 } from '../src/v2.js'
import { folderPolicy } from '../src/scope.js'

const scope = 'project:example/team/backend'
let root: string, repo: string, store: string, stub: StubServer
let serverUrl: string, serverToken: string
const closers: Array<() => void | Promise<void>> = []
let warnings: string[]
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'plur-opencode-git-boundary-'))
  repo = join(root, 'repo'); store = join(root, 'store')
  const home = join(root, 'home')
  for (const dir of [repo, store, home]) mkdirSync(dir)
  vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home)
  vi.stubEnv('PLUR_PATH', store)
  execFileSync('git', ['init', '-q', repo])
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://git.example.test/team/backend.git'])
  stub = new StubServer('fixture-token')
  const server = await stub.start()
  serverUrl = server.url; serverToken = server.token
  warnings = []
  vi.spyOn(console, 'error').mockImplementation(value => { warnings.push(String(value)) })
})
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  await stub.stop()
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})
async function configure(kind: 'mapped' | 'unmatched' | 'unknown') {
  writeFileSync(join(store, 'config.yaml'), JSON.stringify({
    index: false, auto_learn: false, embeddings: { enabled: false },
    stores: [{ url: serverUrl, token: serverToken, scope: 'user:example:fixture-user', scopes: [scope],
      dial: 'always', enterprise: {}, discovery: {
        status: 'ok', org_id: 'example', gitlab_host: 'git.example.test',
        scopes: [scope], project_paths: { [scope]: kind === 'unmatched' ? 'team/other' : 'team/backend' },
        discovered_at: kind === 'unknown' ? '2000-01-01T00:00:00Z' : new Date().toISOString(),
      },
    }],
  }))
}
async function turn(version: 'v1' | 'v2') {
  if (version === 'v1') {
    const plur = new Plur({ path: store, cwd: repo, autoDiscover: false })
    closers.push(() => plur.close())
    const hooks = await PlurPlugin({ directory: repo, worktree: repo, _plur: plur } as any)
    await hooks['chat.message']!({ sessionID: 'fixture-session' } as any,
      { message: { id: 'fixture-message' }, parts: [{ type: 'text', text: 'How are canary releases verified?' }] } as any)
    return
  }
  const hooks = new Map<string, (request: any) => Promise<void>>()
  const close = await setupV2({
    session: {
      hook: async (name: string, callback: any) => { hooks.set(name, callback); return { dispose: async () => hooks.delete(name) } },
      get: async () => ({ id: 'fixture-session', location: { directory: repo } }),
      context: async () => [{ id: 'fixture-message', type: 'user', text: 'How are canary releases verified?' }],
    },
    storage: { get: async () => undefined, set: async () => {}, remove: async () => {} },
    event: { async *subscribe({ signal }: { signal: AbortSignal }) {
      await new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }) })
    } },
  } as any)
  if (typeof close !== 'function') throw Error('V2 setup did not return its cleanup')
  closers.push(close)
  await hooks.get('context')!({ sessionID: 'fixture-session', system: [], messages: [], tools: {} })
}
for (const version of ['v1', 'v2'] as const) {
  it.each(['mapped', 'unmatched', 'unknown'] as const)(`${version} admits %s Git routing before real remote recall`, async kind => {
    await configure(kind)
    await turn(version)
    expect(stub.recallCalls).toBe(kind === 'mapped' ? 1 : 0)
    expect(stub.appendCalls).toBe(0)
    if (kind === 'unknown') expect(warnings.join('\n')).toMatch(/could not tell.*scope list is out of date/)
  })
}

it('refuses memory if an adapter core cannot bind the decision', () => {
  const decision = folderPolicy({
    resolveFolderPolicy: () => ({ mode: 'on', source: 'git', remoteAllowed: false,
      git: { kind: 'local', reason: 'no-remote' } }),
  } as any, repo, text => warnings.push(text))
  expect(decision).toMatchObject({ mode: 'ask', reason: 'resolver-error' })
  expect(warnings.join('\n')).toContain('memory is off here')
})

it('blocks the old core binding when resolving a later decision fails', async () => {
  await configure('mapped')
  const plur = new Plur({ path: store, cwd: repo, autoDiscover: false })
  closers.push(() => plur.close())
  expect(folderPolicy(plur, repo, () => {}).mode).toBe('on')
  await plur.recallHybrid('canary releases')
  expect(stub.recallCalls).toBe(1)
  vi.spyOn(plur, 'resolveFolderPolicy').mockImplementation(() => { throw Error('fixture resolver failure') })
  expect(folderPolicy(plur, repo, () => {})).toMatchObject({ mode: 'ask', reason: 'resolver-error' })
  await expect(plur.recallHybrid('canary releases')).resolves.toEqual([])
  expect(stub.recallCalls).toBe(1)
})
