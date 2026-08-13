/**
 * Async filesystem utilities for the store layer.
 * Async equivalent of atomicWrite() from sync.ts.
 */
import { existsSync } from 'fs'
import { open, rename, mkdir, unlink } from 'fs/promises'
import { dirname } from 'path'

/** Options for {@link asyncAtomicWrite}. */
export interface AsyncAtomicWriteOptions {
  /**
   * fsync the file and its parent directory before resolving. Default `true`.
   *
   * Pass `false` ONLY for derived, rebuildable state. Never for a store file.
   */
  durable?: boolean
}

/** Counter making each tmp name unique within a process (pid makes it unique across them). */
let tmpCounter = 0

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
  const tmp = `${filePath}.${process.pid}.${tmpCounter++}.tmp`
  try {
    const handle = await open(tmp, 'w')
    try {
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
    try { await unlink(tmp) } catch { /* already gone, or never created */ }
    throw err
  }
}

/**
 * fsync a directory so a rename into it is durable.
 *
 * Best-effort: directory handles cannot be synced on Windows and some
 * filesystems reject it. A failure means the rename may not survive power loss;
 * it does not mean the write failed, so it must not throw.
 */
async function fsyncDir(dir: string): Promise<void> {
  let handle
  try {
    handle = await open(dir, 'r')
    await handle.sync()
  } catch {
    /* platform does not support it — the file's own fsync still happened */
  } finally {
    if (handle) {
      try { await handle.close() } catch { /* ignore */ }
    }
  }
}
