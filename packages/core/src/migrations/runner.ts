import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'js-yaml'
import { join } from 'path'
import { loadEngrams, saveEngrams } from '../engrams.js'
import { atomicWrite, withLock } from '../sync.js'
import { logger } from '../logger.js'
import type { Migration } from './types.js'

// Import all migrations in order
import { migration as m001 } from './20260406-001-add-commitment.js'
import { migration as m002 } from './20260406-002-add-content-hash.js'
import { migration as m003 } from './20260406-003-populate-memory-class.js'
import { migration as m004 } from './20260406-004-populate-cognitive-level.js'
import { migration as m005 } from './20260406-005-add-version-field.js'

/** All registered migrations, ordered by ID. */
export const ALL_MIGRATIONS: Migration[] = [m001, m002, m003, m004, m005]

/** Current schema version after all migrations have run. */
export const CURRENT_SCHEMA_VERSION = ALL_MIGRATIONS.length

export interface MigrationResult {
  applied: string[]
  schema_version: number
  backup_path: string | null
}

/** Read schema_version from config.yaml. Defaults to 0 if not present. */
export function getSchemaVersion(configPath: string): number {
  if (!fs.existsSync(configPath)) return 0
  try {
    const raw = yaml.load(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown> | null
    if (!raw || typeof raw.schema_version !== 'number') return 0
    return raw.schema_version
  } catch {
    return 0
  }
}

/**
 * Write schema_version to config.yaml, preserving other fields.
 *
 * Under the SAME `withLock(configPath)` every other config writer takes (#805,
 * audit F12). This was the one config write that skipped it, and skipping it is
 * not a style point: probe p09b measured `setSchemaVersion wrote while the
 * config lock was held: true`, after which the lock holder's own read-modify-
 * write — begun before this one landed — wrote back its stale copy and erased
 * `schema_version`. A store that HAS been migrated then reads as version 0, so
 * the next run re-applies every migration to already-migrated data.
 *
 * The read is no longer `catch {}`. Swallowing every error meant an EACCES or a
 * momentary failure on an EXISTING config started the merge from `{}`, writing
 * a schema-version-only file and dropping stores, auto_learn, embeddings and
 * every other top-level key. Only ENOENT is safe to treat as "start empty" —
 * matching `persistStores`, which rethrows for exactly this reason.
 */
export function setSchemaVersion(configPath: string, version: number): void {
  withLock(configPath, () => {
    let configData: Record<string, unknown> = {}
    try {
      const raw = fs.readFileSync(configPath, 'utf8')
      if (raw) configData = (yaml.load(raw) as Record<string, unknown>) ?? {}
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
    }
    configData.schema_version = version
    // Atomic + fsynced for the same reason persistStores is: loadConfig turns a
    // parse failure into DEFAULT config, so a crash mid-write does not fail
    // loudly — it silently reverts settings.
    atomicWrite(configPath, yaml.dump(configData, { lineWidth: 120, noRefs: true }))
  })
}

/** Create a backup of engrams.yaml before migration. Returns backup path. */
function createBackup(engramsPath: string, version: number): string | null {
  if (!fs.existsSync(engramsPath)) return null
  const backupPath = `${engramsPath}.bak.${version}`
  // Do not clobber an existing backup for this version (#813, audit finding
  // 18). The name is fixed, and it was overwritten BEFORE the live store was
  // validated — so a second migration attempt against a store that had since
  // become corrupt replaced a known-good backup with the corrupt copy, and the
  // rollback target was gone. An existing backup is by definition from an
  // earlier, better state; keep it.
  if (fs.existsSync(backupPath)) return backupPath
  fs.copyFileSync(engramsPath, backupPath)
  // A backup that is not on disk is not a backup. copyFileSync leaves the copy
  // in the page cache, so a power cut during a migration could take the corpus
  // AND the rollback target with it (audit #794, F4).
  flushFile(backupPath)
  // The rename/create is directory metadata: without flushing the directory a
  // crash can lose the backup's PATHNAME even when its blocks reached disk.
  flushDir(path.dirname(backupPath))
  return backupPath
}

/** fsync a directory so a file created in it survives a crash. Best-effort. */
function flushDir(dir: string): void {
  let fd: number | undefined
  try {
    fd = fs.openSync(dir, 'r')
    fs.fsyncSync(fd)
  } catch {
    /* not supported on this platform/filesystem — the file's own fsync stands */
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch { /* ignore */ }
    }
  }
}

/** fsync a path that was just written by a non-atomic helper. Best-effort — see atomicWrite. */
function flushFile(filePath: string): void {
  let fd: number | undefined
  try {
    fd = fs.openSync(filePath, 'r+')
    fs.fsyncSync(fd)
  } catch {
    /* nothing actionable — the copy itself succeeded */
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch { /* ignore */ }
    }
  }
}

/** Restore engrams.yaml from backup. */
function restoreBackup(engramsPath: string, backupPath: string): void {
  fs.copyFileSync(backupPath, engramsPath)
}

/**
 * Run pending migrations on engrams.yaml.
 * - Checks schema_version in config
 * - Creates backup before running
 * - Applies each pending migration in order
 * - Rolls back to backup if any migration fails
 * - Updates schema_version after success
 */
export function runMigrations(
  engramsPath: string,
  configPath: string,
  options?: { dryRun?: boolean },
): MigrationResult {
  const currentVersion = getSchemaVersion(configPath)
  const pending = ALL_MIGRATIONS.slice(currentVersion)

  if (pending.length === 0) {
    return { applied: [], schema_version: currentVersion, backup_path: null }
  }

  const applied: string[] = []

  /**
   * Backup, load, migrate and save under the store lock (#805, audit F12).
   *
   * This is a read-modify-write over the WHOLE corpus that ran with no lock at
   * all, so a `learn()` landing between the load and the save was overwritten
   * by the migrated copy of the pre-learn corpus — the plainest form of lost
   * update, on the one code path whose entire job is rewriting every engram.
   *
   * The backup is taken inside the lock too. Outside it, a write could land
   * between `createBackup` and `loadEngrams`, so the file we restore on failure
   * would not be the file we migrated — a rollback to a state that never
   * existed. `withLock` is NOT reentrant, and `saveEngrams`/`loadEngrams` do
   * not lock internally (their callers do), so this is the only holder.
   */
  let backupPath: string | null = null
  withLock(engramsPath, () => {
    backupPath = options?.dryRun ? null : createBackup(engramsPath, currentVersion)

    // Load engrams as raw objects (passthrough mode — we use the passthrough schema)
    let engrams = loadEngrams(engramsPath)

    for (const migration of pending) {
      logger.info(`Running migration: ${migration.id} — ${migration.description}`)
      try {
        engrams = migration.up(engrams)
        applied.push(migration.id)
      } catch (err) {
        logger.error(`Migration ${migration.id} failed: ${err}`)
        // Restore from backup
        if (backupPath) {
          restoreBackup(engramsPath, backupPath)
          logger.info(`Restored engrams.yaml from backup: ${backupPath}`)
        }
        throw new Error(`Migration ${migration.id} failed: ${err}. Engrams restored from backup.`)
      }
    }

    // Migrations rewrite the entire corpus by design, and a migration that
    // legitimately drops records would otherwise trip the save-side shrink
    // guard (#801). Declaring it here keeps the guard armed everywhere else.
    if (!options?.dryRun) saveEngrams(engramsPath, engrams, { allowShrink: true })
  })

  if (!options?.dryRun) {
    // Outside the engrams lock: this takes the CONFIG lock, a different file.
    // Kept sequential rather than nested so the two lock scopes stay disjoint.
    setSchemaVersion(configPath, currentVersion + applied.length)
  }

  return {
    applied,
    schema_version: currentVersion + applied.length,
    backup_path: backupPath,
  }
}

/**
 * Roll back migrations to a target version.
 * Applies down() for each migration in reverse from current to target.
 */
export function rollbackMigrations(
  engramsPath: string,
  configPath: string,
  targetVersion: number,
): MigrationResult {
  const currentVersion = getSchemaVersion(configPath)

  if (targetVersion >= currentVersion) {
    return { applied: [], schema_version: currentVersion, backup_path: null }
  }

  if (targetVersion < 0) {
    throw new Error('Target version cannot be negative')
  }

  const rolledBack: string[] = []
  // Apply down() in reverse order
  const toRollback = ALL_MIGRATIONS.slice(targetVersion, currentVersion).reverse()

  // Same store lock as runMigrations, for the same reason (#805, F12): this is
  // a whole-corpus read-modify-write, and rolling back is if anything the worse
  // moment to lose a concurrent write — the operator is already recovering from
  // something. Backup taken inside the lock so the rollback target matches the
  // state actually rolled back.
  let backupPath: string | null = null
  withLock(engramsPath, () => {
    backupPath = createBackup(engramsPath, currentVersion)
    let engrams = loadEngrams(engramsPath)

    for (const migration of toRollback) {
      logger.info(`Rolling back migration: ${migration.id}`)
      try {
        engrams = migration.down(engrams)
        rolledBack.push(migration.id)
      } catch (err) {
        logger.error(`Rollback of ${migration.id} failed: ${err}`)
        if (backupPath) {
          restoreBackup(engramsPath, backupPath)
          logger.info(`Restored engrams.yaml from backup: ${backupPath}`)
        }
        throw new Error(`Rollback of ${migration.id} failed: ${err}. Engrams restored from backup.`)
      }
    }

    // A down() migration legitimately removes fields and can remove records;
    // the shrink guard must not veto a deliberate rollback.
    saveEngrams(engramsPath, engrams, { allowShrink: true })
  })

  setSchemaVersion(configPath, targetVersion)

  return {
    applied: rolledBack,
    schema_version: targetVersion,
    backup_path: backupPath,
  }
}
