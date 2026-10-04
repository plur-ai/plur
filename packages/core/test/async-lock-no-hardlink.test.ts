/**
 * #1354: on a filesystem without hard links, `link()` fails with EPERM/ENOTSUP
 * and the store lock falls back to create-then-write. That fallback must still
 * lock, release, exclude, and leave no private publish files behind.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync, linkSync } from 'fs'
import { readFile, writeFile, link } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('fs/promises', async (orig) => {
  const real = await orig<typeof import('fs/promises')>()
  const link = vi.fn(async () => {
    throw Object.assign(new Error('EPERM: operation not permitted, link'), { code: 'EPERM' })
  })
  return { ...real, link, default: { ...real, link } }
})
vi.mock('fs', async (orig) => {
  const real = await orig<typeof import('fs')>()
  const linkSync = vi.fn(() => {
    throw Object.assign(new Error('ENOTSUP: operation not supported, link'), { code: 'ENOTSUP' })
  })
  return { ...real, linkSync, default: { ...real, linkSync } }
})

const { withAsyncLock } = await import('../src/store/async-lock.js')
const { withLock } = await import('../src/sync.js')

let dir: string
let filePath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plur-no-hardlink-'))
  filePath = join(dir, 'engrams.yaml')
  writeFileSync(filePath, '0')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('store lock without hard links (#1354 fallback)', () => {
  it('async: holds the lock with the token written, then releases it', async () => {
    const seen = await withAsyncLock(filePath, async () => readFile(filePath + '.lock', 'utf8'))
    expect(seen).not.toBe('')
    expect(existsSync(filePath + '.lock')).toBe(false)
    expect(readdirSync(dir)).toEqual(['engrams.yaml'])
    expect(link).toHaveBeenCalled() // the fallback really ran
  })

  it('async: still serializes concurrent callers', async () => {
    await Promise.all(Array.from({ length: 10 }, () => withAsyncLock(filePath, async () => {
      const n = Number(await readFile(filePath, 'utf8'))
      await new Promise(r => setImmediate(r))
      await writeFile(filePath, String(n + 1))
    })))
    expect(await readFile(filePath, 'utf8')).toBe('10')
    expect(readdirSync(dir)).toEqual(['engrams.yaml'])
  })

  it('sync: holds and releases, leaving nothing behind', () => {
    expect(withLock(filePath, () => 'ok')).toBe('ok')
    expect(linkSync).toHaveBeenCalled()
    expect(readdirSync(dir)).toEqual(['engrams.yaml'])
  })
})
