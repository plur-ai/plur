/** Invariant: private replacement bytes are never exposed at broader modes,
 * and a colliding temporary pathname cannot redirect or truncate a write. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as real from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { atomicWrite } from '../src/sync.js'
import { asyncAtomicWrite } from '../src/store/async-fs.js'

const probes = vi.hoisted(() => ({ modes: [] as number[], victim: '', collide: false, fsyncError: '', fsyncPath: '', synced: [] as string[], descriptors: new Map<number, string>() }))
vi.mock('fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs,
    fsyncSync: (fd: number) => {
      const path = probes.descriptors.get(fd)!
      if (fs.fstatSync(fd).isDirectory()) probes.synced.push(path)
      if (probes.fsyncError && fs.fstatSync(fd).isDirectory() && (!probes.fsyncPath || path === probes.fsyncPath)) throw Object.assign(new Error('directory sync failed'), { code: probes.fsyncError })
      return fs.fsyncSync(fd)
    },
    openSync: (p: string, flags: string | number, mode?: number) => {
      if (probes.collide && String(p).endsWith('.tmp')) fs.symlinkSync(probes.victim, p)
      const fd = fs.openSync(p, flags, mode)
      probes.descriptors.set(fd, String(p))
      return fd
    },
    writeFileSync: (p: string | number, data: string, ...args: any[]) => {
      if (typeof p === 'number') probes.modes.push(fs.fstatSync(p).mode & 0o777)
      return (fs.writeFileSync as any)(p, data, ...args)
    },
  }
})
vi.mock('fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, open: async (p: string, flags: string | number, mode?: number) => {
    if (probes.collide && String(p).endsWith('.tmp')) await fs.symlink(probes.victim, p)
    const handle = await fs.open(p, flags, mode)
    const sync = handle.sync.bind(handle)
    handle.sync = async () => {
      if ((await handle.stat()).isDirectory()) probes.synced.push(String(p))
      if (probes.fsyncError && (await handle.stat()).isDirectory() && (!probes.fsyncPath || String(p) === probes.fsyncPath)) throw Object.assign(new Error('directory sync failed'), { code: probes.fsyncError })
      return sync()
    }
    const write = handle.writeFile.bind(handle)
    handle.writeFile = async (...args: Parameters<typeof write>) => {
      probes.modes.push((await handle.stat()).mode & 0o777)
      return write(...args)
    }
    return handle
  } }
})

let root: string
beforeEach(() => {
  root = real.mkdtempSync(join(tmpdir(), 'plur-atomic-audit-'))
  probes.modes = []; probes.collide = false; probes.fsyncError = ''
  probes.fsyncPath = ''; probes.synced = []; probes.descriptors.clear()
  probes.victim = join(root, 'unrelated')
  real.writeFileSync(probes.victim, 'must survive')
})
afterEach(() => { real.rmSync(root, { recursive: true, force: true }) })

describe.each([
  ['sync', async (p: string, mode?: number) => atomicWrite(p, 'private bytes', { mode })],
  ['async', async (p: string, mode?: number) => asyncAtomicWrite(p, 'private bytes', { mode })],
] as const)('%s atomic replacement', (_name, write) => {
  it('checks new directory ancestry and repeats that check after an interrupted first write', async () => {
    const dir = join(root, 'new', 'nested')
    const dest = join(dir, 'private.yaml')
    probes.fsyncError = 'EIO'; probes.fsyncPath = root
    await expect(write(dest)).rejects.toThrow('directory sync failed')
    await expect(write(dest)).rejects.toThrow('directory sync failed')
    expect(real.readFileSync(dest, 'utf8')).toBe('private bytes')
    probes.fsyncError = ''; probes.synced = []
    await write(dest)
    const canonical = (path: string) => real.realpathSync(path)
    expect(probes.synced.map(canonical).slice(0, 3)).toEqual([dir, join(root, 'new'), root].map(canonical))
  })
  it('tightens a previously public credential file without broadening stricter permissions', async () => {
    const dest = join(root, 'config.yaml')
    real.writeFileSync(dest, 'old', { mode: 0o644 })
    await write(dest, 0o600)
    expect(real.statSync(dest).mode & 0o777).toBe(0o600)
    real.chmodSync(dest, 0o400)
    await write(dest, 0o600)
    expect(real.statSync(dest).mode & 0o777).toBe(0o400)
  })
  it('reports directory I/O failure after rename instead of acknowledging durability', async () => {
    const dest = join(root, 'private.yaml')
    probes.fsyncError = 'EIO'
    await expect(write(dest)).rejects.toThrow('directory sync failed')
    expect(real.readFileSync(dest, 'utf8')).toBe('private bytes')
  })
  it('tolerates only an unsupported directory sync operation', async () => {
    probes.fsyncError = 'EINVAL'
    await expect(write(join(root, 'private.yaml'))).resolves.toBeUndefined()
  })
  it('preserves private permissions before writing bytes and after rename', async () => {
    const dest = join(root, 'private.yaml')
    real.writeFileSync(dest, 'old', { mode: 0o600 })
    await write(dest)
    expect(probes.modes).toEqual([0o600])
    expect(real.statSync(dest).mode & 0o777).toBe(0o600)
    expect(real.readFileSync(dest, 'utf8')).toBe('private bytes')
  })

  it('refuses a preexisting symlink without touching either file', async () => {
    const dest = join(root, 'private.yaml')
    real.writeFileSync(dest, 'old', { mode: 0o600 })
    probes.collide = true
    await expect(write(dest)).rejects.toThrow()
    expect(real.readFileSync(probes.victim, 'utf8')).toBe('must survive')
    expect(real.readFileSync(dest, 'utf8')).toBe('old')
  })
})
