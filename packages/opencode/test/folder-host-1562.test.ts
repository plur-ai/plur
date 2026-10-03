/**
 * The plugin's folder question is the one set of nonces for its folder
 * (#1562, low L6 of the 0.21.1 pre-release check): it records the opencode
 * process as the question's host, so the PLUR MCP server opencode started
 * shows this same question instead of issuing a second set.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'fs'
import { join, delimiter } from 'path'
import { tmpdir } from 'os'
import { Plur, hostFolderAsk } from '@plur-ai/core'
import { PlurPlugin } from '../src/index.js'

describe('the plugin\'s folder question can be reused by its MCP server (#1562)', () => {
  let root: string
  let repo: string
  let fakeBin: string
  let plur: Plur
  const savedPath = process.env.PATH

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'oc-host-home-')))
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'oc-host-repo-')))
    plur = new Plur({ path: root, autoDiscover: false })
    ;(plur as any).injectHybrid = vi.fn()
    ;(plur as any).learnRouted = vi.fn()
    fakeBin = realpathSync(mkdtempSync(join(tmpdir(), 'oc-host-bin-')))
    writeFileSync(join(fakeBin, 'plur'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    process.env.PATH = `${fakeBin}${delimiter}${savedPath ?? ''}`
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    process.env.PATH = savedPath
    vi.restoreAllMocks()
    for (const d of [root, repo, fakeBin]) rmSync(d, { recursive: true, force: true })
  })

  it('the question the plugin shows is found for this process, with the same nonces', async () => {
    const hooks: any = await PlurPlugin({ directory: repo, worktree: repo, _plur: plur } as any)
    await hooks['chat.message']!({ sessionID: 'ses_host' } as any, { message: { id: 'm1' }, parts: [{ type: 'text', text: 'hello' }] } as any)
    const out = { system: ['base'] }
    await hooks['experimental.chat.system.transform']!({ sessionID: 'ses_host', model: {} } as any, out as any)
    const shown = out.system.slice(1).join('\n')
    const pluginNonces = [...shown.matchAll(/--nonce ([0-9a-f]+)/g)].map(m => m[1])
    expect(pluginNonces.length).toBeGreaterThan(0)
    const reused = hostFolderAsk({ dir: repo, policy: plur.resolveFolderPolicy(repo), root: plur.storageRoot, hostPids: [process.pid] })
    expect(reused, 'the plugin did not record its process as the host').not.toBeNull()
    expect([...reused!.nonces].sort()).toEqual([...new Set(pluginNonces)].sort())
  })
})
