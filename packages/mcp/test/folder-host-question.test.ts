/**
 * One set of folder-question nonces per folder in opencode (#1562, low L6 of
 * the 0.21.1 pre-release check).
 *
 * In opencode the plugin asks the folder question in the system prompt, and
 * the PLUR MCP server (a child of the same opencode process) asked it again
 * with its own nonces, so the agent saw two sets. The server now shows the
 * question its host process already issued for the folder, with the same
 * nonces, and issues its own only when there is none.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur, folderAsk, endFolderNonceSession } from '@plur-ai/core'
import { createFolderGate } from '../src/folder-gate.js'

const dirs: string[] = []
function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  dirs.push(d)
  return d
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function setup(): { plur: Plur; ws: string } {
  const home = tmp('plur-host-q-home-')
  writeFileSync(join(home, 'config.yaml'), 'embeddings:\n  enabled: false\n')
  return { plur: new Plur({ path: home }), ws: tmp('plur-host-q-ws-') }
}

const HOST = 4242

describe('the MCP server reuses its host\'s folder question (#1562)', () => {
  it('a question the host (the opencode plugin) issued for this folder comes back with the same nonces', () => {
    const { plur, ws } = setup()
    const policy = plur.resolveFolderPolicy(ws)
    const fromPlugin = folderAsk({ dir: ws, policy, sessionId: 'ses_oc', root: plur.storageRoot, claim: () => true, bindSession: true, hostPid: HOST })!
    const gate = createFolderGate(plur, { hostPids: () => [HOST] })
    const r = gate.check({ roots: [], cwd: ws }) as any
    expect(r.plur).toBe('ask')
    const nonces = (r.answers as Array<{ command: string }>).map(a => / --nonce ([0-9a-f]+)/.exec(a.command)![1])
    expect(nonces.sort()).toEqual([...fromPlugin.nonces].sort())
    // Asked again: still the same set.
    const again = gate.check({ roots: [], cwd: ws }) as any
    expect(again.answers).toEqual(r.answers)
    gate.end()
  })

  it('without a host question, the server issues its own; once the host\'s session ends, its own too', () => {
    const { plur, ws } = setup()
    const policy = plur.resolveFolderPolicy(ws)
    const gate = createFolderGate(plur, { hostPids: () => [HOST] })
    const own = gate.check({ roots: [], cwd: ws }) as any
    expect(own.plur).toBe('ask')
    expect(own.answers.some((a: any) => a.label === 'Not now')).toBe(true)
    const fromPlugin = folderAsk({ dir: ws, policy, sessionId: 'ses_oc2', root: plur.storageRoot, claim: () => true, bindSession: true, hostPid: 999 })!
    // Another host's question is not this server's.
    const still = gate.check({ roots: [], cwd: ws }) as any
    expect(still.answers).toEqual(own.answers)
    expect(fromPlugin.nonces.some(n => JSON.stringify(still.answers).includes(n))).toBe(false)
    endFolderNonceSession(plur.storageRoot, 'ses_oc2')
    gate.end()
  })
})
