import { lstatSync, readFileSync, unlinkSync } from 'fs'
import { basename, dirname, join } from 'path'
import { spawnSync } from 'child_process'
import { isDeepStrictEqual } from 'util'
import yaml from 'js-yaml'
import { atomicWrite, currentWindowsAccount, findProjectConfigPath, ServerStoreEntrySchema } from '@plur-ai/core'
import { backupWriter } from '../enterprise/backup.js'

type Outcome = 'none' | 'deleted' | 'stripped' | 'tracked-token' | 'symlink-skipped' | 'unknown-tracking'
const fields = ['remote_url', 'remote_token', 'remote_scopes']
const generatedComment = '# remote_token is sensitive — keep .plur.yaml in .gitignore.'

/** Remove only old installer fields, with a private backup before any edit. */
export function cleanupLegacyPlurYaml(dir: string, deps: {
  isTracked: (path: string) => boolean | null; now: () => Date; backupRoot: string
}): { path: string | null; outcome: Outcome } {
  const path = findProjectConfigPath(dir)
  if (!path) return { path, outcome: 'none' }
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) return { path, outcome: 'symlink-skipped' }
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('Legacy project configuration is not a private regular file')
  const snapshot = readFileSync(path)
  const parsed = yaml.load(snapshot.toString('utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { path, outcome: 'none' }
  const record = parsed as Record<string, unknown>
  if (!fields.some(key => Object.hasOwn(record, key))) return { path, outcome: 'none' }
  const tracked = deps.isTracked(path)
  if (tracked === null) return { path, outcome: 'unknown-tracking' }
  if (tracked) return { path, outcome: Object.hasOwn(record, 'remote_token') ? 'tracked-token' : 'none' }
  // Old installers wrote plain top-level keys. Preserve all other bytes;
  // verify the parsed result before touching unfamiliar YAML layouts.
  let dropping = false
  const kept = snapshot.toString('utf8').split(/(?<=\n)/).filter(line => {
    if (line.trimEnd() === generatedComment) return false
    if (/^(remote_url|remote_token|remote_scopes):(?:\s|$)/.test(line)) { dropping = true; return false }
    if (dropping && (/^[ \t]/.test(line) || /^-\s/.test(line))) return false
    if (line.trim()) dropping = false
    return true
  }).join('')
  const expected = { ...record }; for (const key of fields) delete expected[key]
  const remaining = yaml.load(kept) ?? {}
  if (!isDeepStrictEqual(remaining, expected)) throw new Error('Legacy project configuration has an unsupported layout; left unchanged')
  const backup = backupWriter(join(deps.backupRoot, deps.now().toISOString().replace(/[:.]/g, '-')), {
    platform: process.platform, account: currentWindowsAccount(process.env),
  })
  backup(path, snapshot)
  // Recheck the index before the final snapshot comparison: Git can take
  // time, during which an editor may change this file.
  if (deps.isTracked(path) !== false) return { path, outcome: 'unknown-tracking' }
  const current = lstatSync(path)
  if (current.isSymbolicLink() || current.ino !== stat.ino || current.dev !== stat.dev || current.nlink !== 1 || !readFileSync(path).equals(snapshot)) {
    throw new Error('Legacy project configuration changed during cleanup; left unchanged')
  }
  if (!kept.trim()) { unlinkSync(path); return { path, outcome: 'deleted' } }
  atomicWrite(path, kept, { secret: true })
  return { path, outcome: 'stripped' }
}

function gitTracked(path: string): boolean | null {
  // Git index/worktree/config overrides belong to the launching process,
  // not necessarily the project whose file is being inspected.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')))
  const options = { cwd: dirname(path), env, encoding: 'utf8' as const, timeout: 2000, windowsHide: true }
  const repo = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], options)
  if (repo.status !== 0 || repo.stdout.trim() !== 'true') return null
  const result = spawnSync('git', ['ls-files', '--error-unmatch', '--', basename(path)], options)
  return result.status === 0 ? true : result.status === 1 ? false : null
}

/** Advisory only. Never print file contents or an exception carrying a token. */
export function cleanupLegacyProjectAtSessionStart(dir: string, storageRoot: string): string[] {
  try {
    // Normalization supplies default enterprise blocks and expands scopes;
    // only the explicit persisted registration is evidence of installation.
    const config = yaml.load(readFileSync(join(storageRoot, 'config.yaml'), 'utf8')) as { stores?: unknown } | null
    if (!Array.isArray(config?.stores) || !config.stores.some(store => store && typeof store === 'object' &&
      typeof store.url === 'string' && store.url.length > 0 && Object.hasOwn(store, 'enterprise') &&
      store.enterprise && typeof store.enterprise === 'object' && !Array.isArray(store.enterprise) &&
      ServerStoreEntrySchema.safeParse(store).success)) return []
    const result = cleanupLegacyPlurYaml(dir, { isTracked: gitTracked, now: () => new Date(), backupRoot: join(storageRoot, 'backups') })
    if (result.outcome !== 'tracked-token') return []
    const warning = 'A tracked .plur.yaml in this repo contains a server token — ask your PLUR admin to revoke it.'
    // Emit before injection as well: a later injection failure must not hide
    // this actionable warning. Successful hooks also include it in context.
    process.stderr.write(`[plur] ${warning}\n`)
    return [warning]
  } catch {
    process.stderr.write('[plur] Old project configuration could not be cleaned up; it was left for manual review.\n')
    return []
  }
}
