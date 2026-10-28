/**
 * 0.23 release audit, findings 15 and 17.
 * 15: an unparseable keys.yaml is never overwritten (the other identities in it
 *     would be lost); registering refuses with a clear error instead.
 * 17: key and receipt file names are a reversible encoding of the identity /
 *     session id: no ':' (an NTFS alternate data stream), and distinct ids
 *     never share a file.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'fs'
import { join, basename } from 'path'
import { tmpdir } from 'os'
import { privateKeyPath, registerPublicKey, safeFileName } from '../src/actor-keys.js'
import { anchorManifest } from '../src/anchor.js'
import type { SessionManifest, WormStore } from '../src/session-manifest.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
function fresh(): string {
  const d = mkdtempSync(join(tmpdir(), 'plur-keys-audit-'))
  dirs.push(d)
  return d
}

describe('key registry and file names (audit findings 15, 17)', () => {
  it('refuses to overwrite an unparseable keys.yaml', () => {
    const root = fresh()
    const garbage = 'keys: [ {identity: agent:a, public_key: AAA\n  this is : not : yaml ]]]\n'
    writeFileSync(join(root, 'keys.yaml'), garbage)
    expect(() => registerPublicKey(root, 'agent:b', 'BBBB')).toThrow(/keys\.yaml/)
    expect(readFileSync(join(root, 'keys.yaml'), 'utf8')).toBe(garbage)
  })

  it('key file names carry no colon and distinct identities never collide', () => {
    const dir = '/k'
    const a = basename(privateKeyPath('agent:miles', dir))
    expect(a).not.toContain(':')
    expect(basename(privateKeyPath('agent/x', dir))).not.toBe(basename(privateKeyPath('agent_x', dir)))
    expect(safeFileName('agent:miles')).toBe('agent%3Amiles')
    expect(decodeURIComponent(safeFileName('user:x/y z'))).toBe('user:x/y z')
  })

  it('receipt file names do not collide for a.b and a_b', async () => {
    const root = fresh()
    const store: WormStore = { name: 'stub', put: async () => ({ reference: 'ef'.repeat(32) }), get: async () => ({ bytes: Buffer.alloc(0) }) }
    const m = (s: string) => ({ schema: 'plur/session-manifest/v1', session_id: s, actor: 'unidentified', window: { from: null, to: null }, engrams: [], created_at: 'x' }) as unknown as SessionManifest
    await anchorManifest(root, m('a.b'), {}, store)
    await anchorManifest(root, m('a_b'), {}, store)
    await anchorManifest(root, m('a:b'), {}, store)
    const files = readdirSync(join(root, 'receipts'))
    expect(files).toHaveLength(3)
    expect(files.some(f => f.includes(':'))).toBe(false)
  })
})
