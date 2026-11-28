import { lstatSync, chmodSync } from 'fs'
import { atomicWrite } from '@plur-ai/core'

/**
 * S6: write a file that quotes memory text (a plan, a pin-audit proposal):
 * atomically through core's `atomicWrite` (exclusive 0600 temp file, renamed
 * over the path), owner-only even over an existing wider file, and never
 * through a symlink — a link planted at the path is refused rather than
 * replaced or followed. Throws on refusal or I/O failure.
 */
export function writePrivateFile(path: string, content: string): void {
  let st: ReturnType<typeof lstatSync> | null = null
  try { st = lstatSync(path) } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
  }
  if (st?.isSymbolicLink()) throw new Error(`refusing to write ${path}: it is a symbolic link`)
  if (st && !st.isFile()) throw new Error(`refusing to write ${path}: it is not a regular file`)
  // atomicWrite keeps an existing file's mode; tighten it first so the
  // renamed-in file is 0600 too.
  if (st && process.platform !== 'win32' && (st.mode & 0o077) !== 0) chmodSync(path, 0o600)
  atomicWrite(path, content, { mode: 0o600 })
}
