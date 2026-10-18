/**
 * Since #1347 the plugin asks the folder map what to do before it recalls or
 * learns: an undecided folder asks a question instead. Suites about
 * something else (recall/render, learning, compaction, scope and remote
 * propagation) give their fake Plur a folder decision through this helper:
 * a throwaway PLUR home holding exactly `folders`, read by core's real
 * resolver — never the user's own ~/.plur.
 */
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterAll } from 'vitest'
import { canonicalize, resolveFolderPolicy, saveFolderMap, type FolderEntry, type FolderPolicy } from '@plur-ai/core'

const homes: string[] = []
afterAll(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }) })

/** `fake` plus a `resolveFolderPolicy` answering from a folder map of `folders` (paths canonicalised). */
export function withFolderMap<T extends object>(fake: T, folders: FolderEntry[]): T & {
  resolveFolderPolicy(dir: string): FolderPolicy
} {
  const root = mkdtempSync(join(tmpdir(), 'oc-folder-fixture-'))
  homes.push(root)
  saveFolderMap(root, { version: 1, folders: folders.map(f => ({ ...f, path: canonicalize(f.path) })) })
  return Object.assign(fake, {
    resolveFolderPolicy: (dir: string) => resolveFolderPolicy(dir, { root }),
  })
}

/** The folder `dir` is switched on in the map — the decision every pre-#1347 suite assumed. */
export function folderOn<T extends object>(fake: T, dir: string) {
  return withFolderMap(fake, [{ path: dir, plur: 'on' }])
}
