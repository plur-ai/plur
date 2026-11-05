/**
 * A private key file is written through a temp file and a rename: a write or
 * rename that fails part way never leaves a partial key under the key's name,
 * and the next init writes a whole, usable key.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as realFs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const fault = vi.hoisted(() => ({ write: false, rename: false }))

vi.mock('node:fs', async (importOriginal) => {
  const a = await importOriginal<typeof import('node:fs')>()
  const writeFileSync = ((p: realFs.PathOrFileDescriptor, data: unknown, opts?: unknown) => {
    if (fault.write && typeof p === 'string' && Buffer.isBuffer(data)) {
      a.writeFileSync(p, data.subarray(0, Math.floor(data.length / 2)), opts as realFs.WriteFileOptions)
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    }
    return a.writeFileSync(p, data as string, opts as realFs.WriteFileOptions)
  }) as typeof a.writeFileSync
  const renameSync = ((from: realFs.PathLike, to: realFs.PathLike) => {
    if (fault.rename) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' })
    return a.renameSync(from, to)
  }) as typeof a.renameSync
  return { ...a, default: { ...a, writeFileSync, renameSync }, writeFileSync, renameSync }
})

import { initActorKey, privateKeyPath, loadPrivateKeyBuffer } from '../src/actor-keys.js'

let dir: string
beforeEach(() => { dir = realFs.mkdtempSync(join(tmpdir(), 'plur-keywrite-')) })
afterEach(() => {
  fault.write = false
  fault.rename = false
  realFs.rmSync(dir, { recursive: true, force: true })
})

const leftovers = () => realFs.readdirSync(dir).filter(f => f.endsWith('.tmp'))

describe('private key write', () => {
  it('a write that fails part way leaves no key file and no temp file', () => {
    fault.write = true
    expect(() => initActorKey('agent:a', dir)).toThrow(/ENOSPC/)
    expect(realFs.existsSync(privateKeyPath('agent:a', dir))).toBe(false)
    expect(leftovers()).toEqual([])
  })

  it('a rename that fails leaves no key file and no temp file', () => {
    fault.rename = true
    expect(() => initActorKey('agent:a', dir)).toThrow(/EIO/)
    expect(realFs.existsSync(privateKeyPath('agent:a', dir))).toBe(false)
    expect(leftovers()).toEqual([])
  })

  it('after a failed write, the next init writes a whole key that loads', () => {
    fault.write = true
    expect(() => initActorKey('agent:a', dir)).toThrow()
    fault.write = false
    const pub = initActorKey('agent:a', dir)
    expect(pub.length).toBeGreaterThan(0)
    const der = loadPrivateKeyBuffer('agent:a', dir)
    expect(der).not.toBeNull()
    expect(initActorKey('agent:a', dir)).toBe(pub)
  })
})
