/**
 * 0.23 release audit, findings 15 and 17.
 * 15: an unparseable keys.yaml is never overwritten (the other identities in it
 *     would be lost); registering refuses with a clear error instead.
 * 17: key file names are a reversible encoding of the identity: no ':' (an
 *     NTFS alternate data stream), and distinct ids never share a file.
 *     (Receipt file names: packages/gateway/test/gateway.test.ts.)
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join, basename } from 'path'
import { tmpdir } from 'os'
import { privateKeyPath, registerPublicKey, safeFileName } from '../src/actor-keys.js'

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

})
