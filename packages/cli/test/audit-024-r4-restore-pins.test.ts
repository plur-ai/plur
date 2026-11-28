/**
 * 0.24 review, round 4: `plur restore --yes` puts a snapshot's rows back in
 * force, pins included. Under `pinning.agents: request` or `deny` a restore
 * that would pin engrams again needs the confirmation typed at an
 * interactive terminal, as an undo that puts pins back does (H12). Without a
 * terminal it is refused and the store is unchanged. A restore that brings
 * no pin back, and any restore under `allow`, run as before.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import { Plur } from '@plur-ai/core'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'

const CLI = builtCliPath(join(__dirname, '..'))
const STAMP = '2026-01-01'
let home: string, root: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'plur-r4-restore-'))
  root = join(home, '.plur')
  mkdirSync(join(root, 'backups'), { recursive: true })
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const store = () => join(root, 'engrams.yaml')
const config = (agents: 'allow' | 'request' | 'deny') =>
  writeFileSync(join(root, 'config.yaml'), `embeddings:\n  enabled: false\nindex: false\npinning:\n  agents: ${agents}\n`)

/** A snapshot whose one engram is pinned, and a current store where it is not. */
async function snapshotWithPin(pinned = true): Promise<string> {
  const owner = new Plur({ path: root, autoDiscover: false, actor: 'owner' })
  const e = await owner.learn('Always mention the zebracrossing rule', { scope: 'global', pinned })
  copyFileSync(store(), join(root, 'backups', `engrams-${STAMP}.yaml`))
  if (pinned) await owner.setPinned(e.id, false, { actor: 'owner' })
  return e.id
}

function restore(env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ out: string; status: number | null }>(resolve => {
    const child = spawn(process.execPath, [CLI, 'restore', '--yes', '--force', '--date', STAMP], {
      cwd: home, env: { ...isolatedHomeEnv(home), PLUR_DISABLE_EMBEDDINGS: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', c => { out += c }); child.stderr.on('data', c => { out += c })
    const t = setTimeout(() => child.kill('SIGKILL'), 40_000)
    child.on('close', status => { clearTimeout(t); resolve({ out, status }) })
  })
}

describe('round 4: plur restore and pins under pinning.agents', () => {
  for (const agents of ['request', 'deny'] as const) {
    it(`${agents}: a restore that pins an engram again is refused without a terminal`, async () => {
      config('allow')
      await snapshotWithPin()
      config(agents)
      const before = readFileSync(store(), 'utf8')
      for (const env of [{}, { PLUR_ACTOR: 'owner' }]) {
        const r = await restore(env)
        expect(r.status, r.out).toBe(1)
        expect(r.out).toMatch(/pinning\.agents is "(request|deny)".*interactive terminal/)
        expect(readFileSync(store(), 'utf8')).toBe(before)
      }
    }, 90_000)

    it(`${agents}: a restore that brings no pin back runs as before`, async () => {
      config('allow')
      await snapshotWithPin(false)
      config(agents)
      const r = await restore()
      expect(r.status, r.out).toBe(0)
      expect(r.out).toMatch(/"restored":true|Restored/)
    }, 60_000)
  }

  it('allow (default): a restore that pins an engram again runs as before', async () => {
    config('allow')
    await snapshotWithPin()
    const r = await restore()
    expect(r.status, r.out).toBe(0)
    expect(readFileSync(store(), 'utf8')).toMatch(/pinned: true/)
  }, 60_000)
})
