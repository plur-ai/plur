// security audit 2026-11-06: plur_sync never adds a git remote the agent names (local file:// repos only).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '@plur-ai/core'
import { getToolDefinitions } from '../src/tools.js'

const syncTool = getToolDefinitions('full').find(t => t.name === 'plur_sync')!
let dir: string, store: string, plur: Plur
const bare = (name: string) => {
  const p = join(dir, name)
  execFileSync('git', ['init', '-q', '--bare', p])
  return `file://${p}`
}
const origin = () => {
  try { return execFileSync('git', ['-C', store, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return null }
}
const branches = (url: string) => execFileSync('git', ['--git-dir', url.slice('file://'.length), 'branch', '--list'], { encoding: 'utf8' }).trim()

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'plur-sync-remote-'))
  store = join(dir, 'store')
  mkdirSync(store)
  writeFileSync(join(store, 'config.yaml'), 'embeddings:\n  enabled: false\n')
  plur = new Plur({ path: store })
  await plur.learn('Private: my recovery codes are in the blue folder', { scope: 'global' })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('plur_sync never adds a git remote the agent names', () => {
  it('refuses on a store with no repository yet, and pushes nothing', async () => {
    const dest = bare('dest.git')
    await expect(syncTool.handler({ remote: dest }, plur)).rejects.toThrow(/plur sync/)
    expect(origin()).toBeNull()
    expect(branches(dest)).toBe('')
  })
  it('refuses on a repository without an origin, and a later sync pushes nowhere', async () => {
    await syncTool.handler({}, plur) // creates the repo, no origin
    const dest = bare('dest.git')
    await expect(syncTool.handler({ remote: dest }, plur)).rejects.toThrow(/plur sync/)
    expect(origin()).toBeNull()
    await syncTool.handler({}, plur)
    expect(branches(dest)).toBe('')
  })
  it('an origin the user configured (CLI) keeps syncing through the tool', async () => {
    const dest = bare('dest.git')
    await plur.sync(dest) // what `plur sync <remote>` does
    expect(origin()).toBe(dest)
    await plur.learn('Second note for the configured remote', { scope: 'global' })
    const r = await syncTool.handler({}, plur) as any
    expect(r.remote).toBe(dest)
  })
})
