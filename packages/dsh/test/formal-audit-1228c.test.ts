/**
 * Audit of #1228, non-core packages (1228-c), dsh:
 *
 *  #1 the untrusted-workspace warning names a trust command that writes to the
 *     store this plugin checks — `plur --path <root> trust <dir>` when the
 *     plugin's store is not ~/.plur;
 *  unconfirmed item, replayed: with an older @plur-ai/core that has no
 *     `isDirectoryTrusted`, the gate (correctly) fails closed, but the warning
 *     told the user to run `plur trust`, which that engine never reads. The
 *     warning now says what would actually help.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Plur } from '@plur-ai/core'
import { createEngine } from '../src/engine.js'
import { trustedWorkspaceScope, trustRemedy } from '../src/workspace-scope.js'
import { cfg } from './helpers/config.js'

describe('dsh trust notice names a command that can help (1228-c)', () => {
  let root: string
  let repo: string
  let store: string
  let warnings: string[]

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'plur-1228c-dsh-')))
    repo = join(root, 'cloned-repo')
    store = join(root, 'store')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(store)
    writeFileSync(join(store, 'config.yaml'), 'embeddings:\n  enabled: false\n')
    writeFileSync(join(repo, '.plur.yaml'), 'scope: group:acme/eng\n')
    warnings = []
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('a configured store path is named with --path, and that grant is the one the engine reads', async () => {
    const engine = createEngine(cfg({ path: store }), () => import('@plur-ai/core'), () => {})
    const read = trustedWorkspaceScope(d => engine.trusts(d), m => warnings.push(m),
      async d => trustRemedy(d, await engine.trustSupport(), store))
    expect(await read(repo)).toBeUndefined()
    expect(warnings.join('\n')).toContain(`run: plur --path ${store} trust ${repo}`)
    new Plur({ path: store }).trustDirectory(repo)
    expect(await read(repo)).toBe('group:acme/eng')
  })

  it('an engine without isDirectoryTrusted: the warning does not promise that `plur trust` fixes it', async () => {
    class OldPlur { constructor(_o: unknown) {} }
    const engine = createEngine(cfg({ path: store }), async () => ({ Plur: OldPlur }), () => {})
    expect(await engine.trustSupport()).toBe('no-trust')
    const read = trustedWorkspaceScope(d => engine.trusts(d), m => warnings.push(m),
      async d => trustRemedy(d, await engine.trustSupport(), store))
    expect(await read(repo)).toBeUndefined()
    const w = warnings.join('\n')
    expect(w).toMatch(/cannot check directory trust/)
    expect(w).toMatch(/upgrade @plur-ai\/core, then run: plur --path/)
    expect(w).not.toMatch(/If this project is yours, run: plur trust/)
  })

  it('an engine that did not load: no trust command is offered at all', async () => {
    const engine = createEngine(cfg({ path: store }), () => Promise.reject(new Error('ERR_MODULE_NOT_FOUND')), () => {})
    expect(await engine.trustSupport()).toBe('no-engine')
    expect(trustRemedy(repo, 'no-engine', store)).not.toMatch(/plur trust|plur --path/)
  })
})
