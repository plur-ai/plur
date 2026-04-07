/**
 * Async filesystem utilities for the store layer.
 * Async equivalent of atomicWrite() from sync.ts.
 */
import { existsSync } from 'fs'
import { writeFile, rename, mkdir } from 'fs/promises'
import { dirname } from 'path'

/** Atomic write: write to temp file then rename (prevents corruption on crash). */
export async function asyncAtomicWrite(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath)
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  const tmp = filePath + '.tmp'
  await writeFile(tmp, content)
  await rename(tmp, filePath)
}
