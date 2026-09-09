/**
 * Async filesystem utilities for the store layer.
 * Async equivalent of atomicWrite() from sync.ts.
 */
import { existsSync } from 'fs'
import { open, rename, mkdir, unlink, stat } from 'fs/promises'
import { dirname } from 'path'
import { randomUUID } from 'crypto'
import { directoryAncestry } from './durability.js'

/** Options for {@link asyncAtomicWrite}. */
export interface AsyncAtomicWriteOptions {
  /** Mode for a new file; can tighten existing permissions, never loosen them. */
  mode?: number
  /**
   * fsync the file and its parent directory before resolving. Default `true`.
   *
   * Pass `false` ONLY for derived, rebuildable state. Never for a store file.
   */
  durable?: boolean
}

/**
 * Atomic write: write to a temp file, flush it, then rename over the target.
 *
 * Mirrors `atomicWrite` in sync.ts — see the durability and unique-tmp
 * rationale there (audit #794, F4). Kept as a separate implementation rather
 * than a wrapper because this one must not block the event loop: the store
 * layer calls it from async write paths that a long-lived MCP server is
 * servicing concurrently.
 */
export async function asyncAtomicWrite(
  filePath: string,
  content: string,
  opts: AsyncAtomicWriteOptions = {},
): Promise<void> {
  const durable = opts.durable !== false
  const dir = dirname(filePath)
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  const tmp = `${filePath}.${randomUUID()}.tmp`
  let mode = opts.mode ?? 0o600
  try {
    mode = ((await stat(filePath)).mode & 0o777) & (opts.mode ?? 0o777)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  let created = false
  try {
    const handle = await open(tmp, 'wx', 0o600)
    created = true
    try {
      await handle.chmod(mode)
      await handle.writeFile(content)
      if (durable) await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, filePath)
    if (durable) await fsyncDir(dir)
  } catch (err) {
    // Never leave the tmp behind on a failed write — with a unique name
    // nothing else would ever clean it up.
    if (created) try { await unlink(tmp) } catch { /* already gone */ }
    throw err
  }
}

/**
 * fsync a directory so a rename into it is durable.
 *
 * Unsupported directory sync is tolerated on those platforms. Actual I/O
 * failures propagate: replacement may already be visible, but durability was
 * not acknowledged. Callers must resolve an ambiguous write before retrying.
 */
async function fsyncDir(dir: string): Promise<void> {
  for (const directory of directoryAncestry(dir)) await fsyncDirectoryEntry(directory)
}

async function fsyncDirectoryEntry(dir: string): Promise<void> {
  let handle
  try {
    handle = await open(dir, 'r')
    await handle.sync()
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(code ?? '') &&
        !(process.platform === 'win32' && ['EPERM', 'EACCES', 'EISDIR'].includes(code ?? ''))) throw err
  } finally {
    if (handle) {
      try { await handle.close() } catch { /* ignore */ }
    }
  }
}
