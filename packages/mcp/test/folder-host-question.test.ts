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
import { createFolderGate, ancestorHosts, parseEtime } from '../src/folder-gate.js'

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

const HOST = { pid: 4242, startedAt: 1_790_000_000_000 }

describe('the MCP server reuses its host\'s folder question (#1562)', () => {
  it('a question the host (the opencode plugin) issued for this folder comes back with the same nonces', () => {
    const { plur, ws } = setup()
    const policy = plur.resolveFolderPolicy(ws)
    const fromPlugin = folderAsk({ dir: ws, policy, sessionId: 'ses_oc', root: plur.storageRoot, claim: () => true, bindSession: true, host: HOST })!
    const gate = createFolderGate(plur, { hosts: () => [HOST] })
    const r = gate.check({ roots: [], cwd: ws }) as any
    expect(r.plur).toBe('ask')
    const nonces = (r.answers as Array<{ label: string; command: string }>).filter(a => a.label !== 'Not now').map(a => / --nonce ([0-9a-f]+)/.exec(a.command)![1])
    expect(nonces.sort()).toEqual([...fromPlugin.nonces].sort())
    // Asked again: still the same set.
    const again = gate.check({ roots: [], cwd: ws }) as any
    expect(again.answers).toEqual(r.answers)
    gate.end()
  })

  it('without a host question, the server issues its own; once the host\'s session ends, its own too', () => {
    const { plur, ws } = setup()
    const policy = plur.resolveFolderPolicy(ws)
    const gate = createFolderGate(plur, { hosts: () => [HOST] })
    const own = gate.check({ roots: [], cwd: ws }) as any
    expect(own.plur).toBe('ask')
    expect(own.answers.some((a: any) => a.label === 'Not now')).toBe(true)
    const fromPlugin = folderAsk({ dir: ws, policy, sessionId: 'ses_oc2', root: plur.storageRoot, claim: () => true, bindSession: true, host: { pid: 999, startedAt: 1 } })!
    // Another host's question is not this server's.
    const still = gate.check({ roots: [], cwd: ws }) as any
    expect(still.answers).toEqual(own.answers)
    expect(fromPlugin.nonces.some(n => JSON.stringify(still.answers).includes(n))).toBe(false)
    endFolderNonceSession(plur.storageRoot, 'ses_oc2')
    gate.end()
  })

  // #1563 review, L2: the reused question offers "not now"; once answered,
  // the server stops asking for the rest of the session.
  it('the reused question offers "not now", and after it memory is off without the question', () => {
    const { plur, ws } = setup()
    const policy = plur.resolveFolderPolicy(ws)
    const fromPlugin = folderAsk({ dir: ws, policy, sessionId: 'ses_oc3', root: plur.storageRoot, claim: () => true, bindSession: true, host: HOST })!
    const gate = createFolderGate(plur, { hosts: () => [HOST] })
    const r = gate.check({ roots: [], cwd: ws }) as any
    const nn = (r.answers as Array<{ label: string; command: string }>).find(a => a.label === 'Not now')!
    expect(nn, JSON.stringify(r.answers)).toBeDefined()
    expect(fromPlugin.nonces.every(n => JSON.stringify(r.answers).includes(n))).toBe(true)
    // The same not-now nonce on the next call: not a fresh one every time.
    expect((gate.check({ roots: [], cwd: ws }) as any).answers).toEqual(r.answers)
    const m = / --not-now --nonce ([0-9a-f]+) --session (\S+)$/.exec(nn.command)!
    ;(plur as any).notNowFolder(ws, { nonce: m[1], session: m[2] })
    const after = gate.check({ roots: [], cwd: ws }) as any
    expect(after.plur).toBe('off')
    expect(after.reason).toBe('not-now')
    gate.end()
  })
})

describe('the parent-process lookup (#1563 review, L3)', () => {
  it('parses ps etime', () => {
    expect(parseEtime('00:07')).toBe(7)
    expect(parseEtime(' 12:34')).toBe(754)
    expect(parseEtime('01:02:03')).toBe(3723)
    expect(parseEtime('2-01:02:03')).toBe(2 * 86400 + 3723)
    expect(parseEtime('garbage')).toBeNull()
  })

  it.skipIf(process.platform === 'win32')('finds this process\'s parent, with a start time in the past', () => {
    const hosts = ancestorHosts()
    expect(hosts[0]?.pid).toBe(process.ppid)
    expect(hosts[0].startedAt).toBeLessThanOrEqual(Date.now())
  })
})
