import * as fs from 'fs'
import { createHash, randomUUID } from 'node:crypto'
import * as yaml from 'js-yaml'
import { join } from 'path'
import { loadEngrams, saveEngrams, engramStoreEntries } from '../engrams.js'
import { recordLastWritten } from '../backup.js'
import { atomicWrite, withLock, fsyncDir, CONFIG_FILE_MODE } from '../sync.js'
import { logger } from '../logger.js'
import type { Migration } from './types.js'

// Import all migrations in order
import { migration as m001 } from './20260406-001-add-commitment.js'
import { migration as m002 } from './20260406-002-add-content-hash.js'
import { migration as m003 } from './20260406-003-populate-memory-class.js'
import { migration as m004 } from './20260406-004-populate-cognitive-level.js'
import { migration as m005 } from './20260406-005-add-version-field.js'
import { migration as m006 } from './20260813-006-recompute-content-hashes.js'

/** All registered migrations, ordered by ID. */
export const ALL_MIGRATIONS: Migration[] = [m001, m002, m003, m004, m005, m006]

/** Current schema version after all migrations have run. */
export const CURRENT_SCHEMA_VERSION = ALL_MIGRATIONS.length

export interface MigrationResult {
  applied: string[]
  schema_version: number
  backup_path: string | null
}

/** Read schema_version from config.yaml. Defaults to 0 if not present. */
export function getSchemaVersion(configPath: string): number {
  let raw: unknown
  try {
    raw = yaml.load(fs.readFileSync(configPath, 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw new Error('Cannot read or parse migration configuration')
  }
  // An empty or comment-only file loads as null/undefined: that is an empty
  // mapping, as loadConfig treats it. A scalar or a list is not.
  const config: unknown = raw ?? {}
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new Error('Cannot read migration schema version: config must be a mapping')
  }
  const version = Object.hasOwn(config, 'schema_version') ? (config as Record<string, unknown>).schema_version : 0
  assertVersion(version)
  return version
}

function assertVersion(version: unknown): asserts version is number {
  if (typeof version === 'number' && Number.isInteger(version) && version > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Schema version ${version} was written by a newer PLUR than this one, which supports up to ${CURRENT_SCHEMA_VERSION}. `
      + 'Upgrade PLUR before migrating or rolling back this store.',
    )
  }
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    throw new Error(`Invalid schema version: expected a non-negative integer from 0 to ${CURRENT_SCHEMA_VERSION}`)
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
  assertVersion(version)
  withLock(configPath, () => {
    let configData: Record<string, unknown> = {}
    try {
      const raw = fs.readFileSync(configPath, 'utf8')
      const parsed: unknown = yaml.load(raw) ?? {}
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Migration config must be a mapping')
      configData = parsed as Record<string, unknown>
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw new Error('Cannot read or parse migration configuration')
    }
    configData.schema_version = version
    // Atomic + fsynced for the same reason persistStores is: loadConfig turns a
    // parse failure into DEFAULT config, so a crash mid-write does not fail
    // loudly — it silently reverts settings.
    atomicWrite(configPath, yaml.dump(configData, { lineWidth: 120, noRefs: true }), { mode: CONFIG_FILE_MODE })
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
  // Same mode as the corpus (copyFileSync kept it): a backup is the corpus.
  atomicWrite(backupPath, fs.readFileSync(engramsPath), { mode: fs.statSync(engramsPath).mode & 0o777 })
  return backupPath
}

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
function corpusHash(file: string): string | null {
  try { return digest(fs.readFileSync(file)) } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** Resolve an interrupted two-file commit without replaying transformations
 * or restoring stale bytes. Unrelated intervening edits require reconciliation.
 * Caller holds the corpus lock. */
function recoverMigration(engramsPath: string, configPath: string): void {
  const journalPath = `${engramsPath}.migration.json`
  let text: string
  try { text = fs.readFileSync(journalPath, 'utf8') } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  const journal = JSON.parse(text)
  if (!journal || journal.config !== configPath || typeof journal.after !== 'string' ||
      !(journal.before === null || typeof journal.before === 'string')) throw new Error('Invalid migration recovery journal')
  assertVersion(journal.version)
  const current = corpusHash(engramsPath)
  if (current === journal.after) setSchemaVersion(configPath, journal.version)
  else if (current !== journal.before) {
    throw new Error(
      `An interrupted migration to schema version ${journal.version} was followed by other writes, so it cannot be completed automatically. `
      + `The corpus has been left as it is. To reconcile: check whether ${engramsPath} is already in the version ${journal.version} shape. `
      + `If it is, set schema_version: ${journal.version} in ${configPath}; if it is not, leave schema_version as it is. `
      + `Then delete the journal ${journalPath} and run the migration again.`,
    )
  }
  fs.unlinkSync(journalPath)
  fsyncDir(join(engramsPath, '..'))
}

/** Stage/validate exact bytes, persist intent, replace corpus, stamp config.
 *
 * Two guarantees, one mechanism (#1178 F01 and formal round 2, r2-persist §4):
 * - A stamp that FAILS (config lock held, EACCES, full disk) puts the corpus
 *   back and removes the journal, so the run leaves both files as they were.
 * - A CRASH between the corpus write and the stamp — or a failed put-back —
 *   leaves the journal, and the next run finishes the stamp without replaying
 *   migrations, or refuses if other writes intervened. */
function commitMigration(engramsPath: string, configPath: string, engrams: ReturnType<typeof loadEngrams>, fromVersion: number, version: number): void {
  const staged = `${engramsPath}.${randomUUID()}.migration-stage`
  let bytes: Buffer
  try {
    if (fs.existsSync(engramsPath)) {
      atomicWrite(staged, fs.readFileSync(engramsPath), { mode: fs.statSync(engramsPath).mode & 0o777 })
      loadEngrams(staged) // retain quarantined rows through the serializer
    }
    saveEngrams(staged, engrams, { allowShrink: true })
    bytes = fs.readFileSync(staged)
  } finally {
    try { fs.unlinkSync(staged) } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err }
  }
  const journalPath = `${engramsPath}.migration.json`
  const before = fs.existsSync(engramsPath) ? fs.readFileSync(engramsPath) : null
  atomicWrite(journalPath, JSON.stringify({ config: configPath, before: before === null ? null : digest(before), after: digest(bytes), version }))
  atomicWrite(engramsPath, bytes)
  // saveEngrams recorded the STAGED file's count; record the live store's.
  recordLastWritten(engramsPath, countEntries(engramsPath, bytes))
  try {
    setSchemaVersion(configPath, version)
  } catch (stampErr) {
    try {
      if (before === null) fs.rmSync(engramsPath, { force: true })
      else {
        atomicWrite(engramsPath, before)
        // The put-back is a PLUR write too: keep the backup gate's baseline in step.
        recordLastWritten(engramsPath, countEntries(engramsPath, before))
      }
      fs.unlinkSync(journalPath)
      fsyncDir(join(engramsPath, '..'))
    } catch (restoreErr) {
      throw new Error(
        `Recording schema_version ${version} in ${configPath} failed (${stampErr}), and restoring ` +
        `engrams.yaml afterwards failed too (${restoreErr}). The recovery journal ${journalPath} was kept: ` +
        `the next migration run finishes the stamp. To do it by hand, set schema_version: ${version} in ${configPath} ` +
        `and delete ${journalPath}.`,
      )
    }
    throw new Error(
      `Recording schema_version ${version} in ${configPath} failed: ${stampErr}. ` +
      `engrams.yaml was restored to its previous contents; nothing changed (still schema ${fromVersion}).`,
    )
  }
  fs.unlinkSync(journalPath)
  fsyncDir(join(engramsPath, '..'))
}

function countEntries(engramsPath: string, bytes: Buffer): number {
  try {
    return engramStoreEntries(engramsPath, bytes.toString('utf8'), bytes.length).length
  } catch {
    return 0
  }
}

/**
 * Run pending migrations on engrams.yaml.
 * - Checks schema_version in config
 * - Creates backup before running
 * - Applies each pending migration in order
 * - If any migration fails, writes nothing (the live file is left as it was)
 * - Updates schema_version after success
 */
export function runMigrations(
  engramsPath: string,
  configPath: string,
  options?: { dryRun?: boolean },
): MigrationResult {
  const applied: string[] = []
  let currentVersion = 0
  let backupPath: string | null = null

  /**
   * EVERYTHING under the corpus lock — reading the version, planning, backing
   * up, migrating, saving, and stamping the new version (#805 F12; audit
   * 2026-08-03 finding 2).
   *
   * The first fix wrapped only the corpus read-modify-write, leaving the
   * version read before it and the version stamp after it. That gap is enough:
   * a concurrent `run` and `rollback` both read version 2, rollback strips the
   * v1/v2 fields, and run — planned from 2 — applies only v3-v5. The store then
   * reports schema 5 while lacking `commitment` and `content_hash`, or reports
   * 0 over a partially upgraded corpus, depending on which stamp lands last.
   * Nothing detects either state; the next run just migrates from a lie.
   *
   * LOCK ORDER is corpus -> config. `setSchemaVersion` takes the config lock
   * itself, so this nests. That direction is safe because nothing acquires them
   * the other way round: `addStore` materializes its store file (store lock)
   * and only THEN calls `persistStores` (config lock), sequentially rather than
   * nested. Anything added later must keep that order or reintroduce a deadlock.
   *
   * `withLock` is NOT reentrant, and `loadEngrams`/`saveEngrams` do not lock
   * internally — their callers do — so this is the only holder of the corpus
   * lock for the duration.
   */
  withLock(engramsPath, () => {
    if (options?.dryRun && fs.existsSync(`${engramsPath}.migration.json`)) throw new Error('Interrupted migration needs recovery before a dry run')
    if (!options?.dryRun) recoverMigration(engramsPath, configPath)
    currentVersion = getSchemaVersion(configPath)
    const pending = ALL_MIGRATIONS.slice(currentVersion)
    if (pending.length === 0) return

    // Load engrams as raw objects (passthrough mode — we use the passthrough schema)
    let engrams = loadEngrams(engramsPath)
    backupPath = options?.dryRun ? null : createBackup(engramsPath, currentVersion)

    for (const migration of pending) {
      logger.info(`Running migration: ${migration.id} — ${migration.description}`)
      try {
        engrams = migration.up(engrams)
        applied.push(migration.id)
      } catch (err) {
        logger.error(`Migration ${migration.id} failed: ${err}`)
        // Nothing has been written yet: the live file is untouched. Do NOT copy
        // the (possibly older) backup over it — see the note above createBackup.
        throw new Error(`Migration ${migration.id} failed: ${err}. engrams.yaml was not modified.`)
      }
    }

    if (!options?.dryRun) {
      // Migrations rewrite the entire corpus by design, and a migration that
      // legitimately drops records would otherwise trip the save-side shrink
      // guard (#801). Declaring it here keeps the guard armed everywhere else.
      commitMigration(engramsPath, configPath, engrams, currentVersion, currentVersion + applied.length)
    }
  })

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
  if (targetVersion < 0) {
    throw new Error('Target version cannot be negative')
  }
  assertVersion(targetVersion)

  const rolledBack: string[] = []
  let currentVersion = 0
  let noop = false

  // Same corpus lock as runMigrations, held across the version read, the
  // rewrite and the version stamp, in the same order (corpus -> config) and for
  // the same reasons — see the comment there (#805 F12; audit 2026-08-03
  // finding 2). Rolling back is if anything the worse moment to lose a
  // concurrent write, since the operator is already recovering from something.
  let backupPath: string | null = null
  withLock(engramsPath, () => {
    recoverMigration(engramsPath, configPath)
    currentVersion = getSchemaVersion(configPath)
    if (targetVersion >= currentVersion) { noop = true; return }

    // Apply down() in reverse order
    const toRollback = ALL_MIGRATIONS.slice(targetVersion, currentVersion).reverse()

    let engrams = loadEngrams(engramsPath)
    backupPath = createBackup(engramsPath, currentVersion)

    for (const migration of toRollback) {
      logger.info(`Rolling back migration: ${migration.id}`)
      try {
        engrams = migration.down(engrams)
        rolledBack.push(migration.id)
      } catch (err) {
        logger.error(`Rollback of ${migration.id} failed: ${err}`)
        throw new Error(`Rollback of ${migration.id} failed: ${err}. engrams.yaml was not modified.`)
      }
    }

    // A down() migration legitimately removes fields and can remove records;
    // the shrink guard must not veto a deliberate rollback.
    commitMigration(engramsPath, configPath, engrams, currentVersion, targetVersion)
  })

  if (noop) {
    return { applied: [], schema_version: currentVersion, backup_path: null }
  }

  return {
    applied: rolledBack,
    schema_version: targetVersion,
    backup_path: backupPath,
  }
}
