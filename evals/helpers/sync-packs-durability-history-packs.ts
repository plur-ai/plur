// Pack fixtures for the pack evals: an author's store that exports a real pack
// through the public surface, written to a folder of the caller's choosing.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tempStore } from './store.js'

/** A scratch directory that is removed by the returned cleanup. */
export function scratch(prefix: string): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/**
 * Another person's store exports a pack of public memories to `outDir`.
 * Returns the pack directory (outDir itself).
 *
 * Ids are minted per store by date and sequence, so a pack made today starts
 * at the same ids as my own store. `fillers` first saves that many unrelated,
 * unexported memories in the author's store so the pack's ids differ from mine.
 */
export async function authorPack(outDir: string, name: string, statements: string[], fillers = 0): Promise<string> {
  const author = await tempStore({ embedder: 'off' })
  try {
    for (let i = 0; i < fillers; i++) await author.plur.learn(`Author filler note ${i} about unrelated topic number ${i}`, { scope: 'global' })
    const learned = []
    for (const st of statements) learned.push(await author.plur.learn(st, { scope: 'global', visibility: 'public' }))
    author.plur.exportPack(learned, outDir, { name, version: '1.0.0', description: `${name} pack`, license: 'cc0-1.0' })
    return outDir
  } finally {
    author.cleanup()
  }
}
