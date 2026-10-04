/**
 * Audit of #1228, non-core packages (1228-c #1), opencode: the untrusted-scope
 * and remote-refusal warnings name a trust command that writes to the store
 * this plugin checks — `plur --path <root> trust <dir>` when opencode's
 * `PLUR_PATH` is not ~/.plur, since a bare `plur trust` in the user's shell
 * records the grant in ~/.plur, which the plugin never reads.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { Plur } from '@plur-ai/core'
import { resolveTrustedScope, projectRemoteRefusalNotice } from '../src/scope.js'

describe('opencode trust notices name the plugin\'s store (1228-c #1)', () => {
  it('a real engine on a custom store: the warning carries --path, and that grant is what the plugin reads', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'plur-1228c-oc-')))
    try {
      const store = join(root, 'store')
      const repo = join(root, 'repo')
      const plur = new Plur({ path: store })
      const messages: string[] = []
      expect(resolveTrustedScope(plur, { scope: 'group:acme/eng' }, join(repo, '.plur.yaml'), m => messages.push(m))).toEqual({})
      expect(messages[0]).toContain(`run: plur --path ${store} trust ${repo}`)
      plur.trustDirectory(repo)
      expect(resolveTrustedScope(plur, { scope: 'group:acme/eng' }, join(repo, '.plur.yaml'), () => {}))
        .toEqual({ scope: 'group:acme/eng', domain: undefined })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('the default store keeps the bare command', () => {
    const messages: string[] = []
    resolveTrustedScope({ isDirectoryTrusted: () => false, storageRoot: join(homedir(), '.plur') },
      { scope: 'group:acme/eng' }, '/repo/.plur.yaml', m => messages.push(m))
    expect(messages[0]).toContain('run: plur trust /repo')
  })

  it('the remote refusal keeps core\'s wording and names the same command', () => {
    expect(projectRemoteRefusalNotice('/repo')).toMatch(/run: plur trust \/repo$/)
    expect(projectRemoteRefusalNotice('/repo', '/srv/plur')).toMatch(/Ignored remote memory settings.*run: plur --path \/srv\/plur trust \/repo$/)
  })
})
