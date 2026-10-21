/**
 * Repository defaults in opencode (#1690 review): an undecided Git folder
 * resolves to `on` with a Git outcome, and core keeps an unmatched or unknown
 * origin local only for an instance bound to that decision. The plugin must
 * therefore bind before it recalls, or a `dial: always` store is contacted
 * for a repository no mapping covers.
 *
 * A real `Plur` on a throwaway PLUR home with an enterprise server entry that
 * maps one GitLab project, a real Git repository, and an in-process stub
 * server as that store (personal scope set to `dial: always`).
 */
import { afterEach, beforeEach, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '@plur-ai/core'
import { StubServer } from '../../core/test/helpers/stub-server.js'
import { PlurPlugin } from '../src/index.js'

const SCOPE = 'project:acme/team/backend'
let base: string, root: string, repo: string, stub: StubServer, plur: Plur

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'oc-git-origin-')))
  root = join(base, 'plur'); repo = join(base, 'repo')
  mkdirSync(root); execFileSync('git', ['init', '-q', repo])
  stub = new StubServer('fixture-key')
  const { url, token } = await stub.start()
  writeFileSync(join(root, 'config.yaml'), JSON.stringify({ index: false, embeddings: { enabled: false },
    stores: [{ url, token, scope: 'user:acme:alice', scopes: ['user:acme:alice', SCOPE], enterprise: {},
      scope_settings: { 'user:acme:alice': { dial: 'always' } },
      discovery: { status: 'ok', scopes_status: 'ok', discovered_at: new Date().toISOString(),
        gitlab_host: 'gitlab.example.com', project_paths: { [SCOPE]: 'team/backend' } } }] }))
  plur = new Plur({ path: root, autoDiscover: false })
})
afterEach(async () => {
  plur.close(); await stub.stop()
  rmSync(base, { recursive: true, force: true })
})

const origin = (path: string) =>
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', `https://gitlab.example.com/${path}.git`])

async function turn(sessionID: string): Promise<void> {
  const hooks: any = await PlurPlugin({ directory: repo, worktree: repo, _plur: plur } as any)
  await hooks['chat.message']!({ sessionID } as any,
    { message: { id: `msg-${sessionID}` }, parts: [{ type: 'text', text: 'how do we deploy canaries' }] } as any)
  await hooks['experimental.chat.system.transform']!({ sessionID, model: {} } as any, { system: ['base'] } as any)
}

it('an unmatched Git repository never dials an always-dial store from opencode', async () => {
  origin('someone/unmapped')
  expect(plur.resolveFolderPolicy(repo)).toMatchObject({ mode: 'on', source: 'git', git: { kind: 'local' } })
  await turn('ses-unmatched')
  expect(stub.recallCalls).toBe(0)
})

it('control: a mapped origin makes the same turn dial the server', async () => {
  origin('team/backend')
  expect(plur.resolveFolderPolicy(repo)).toMatchObject({ mode: 'on', source: 'git', scope: SCOPE })
  await turn('ses-mapped')
  expect(stub.recallCalls).toBeGreaterThan(0)
})
