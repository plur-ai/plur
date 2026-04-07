import * as fs from 'fs'
import * as yaml from 'js-yaml'
import { join } from 'path'
import { loadEngrams, saveEngrams } from '../engrams.js'
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

/** Write schema_version to config.yaml, preserving other fields. */
export function setSchemaVersion(configPath: string, version: number): void {
  let configData: Record<string, unknown> = {}
  try {
    const raw = fs.readFileSync(configPath, 'utf8')
    if (raw) configData = (yaml.load(raw) as Record<string, unknown>) ?? {}
  } catch { /* file may not exist */ }
  configData.schema_version = version
  fs.writeFileSync(configPath, yaml.dump(configData, { lineWidth: 120, noRefs: true }))
}

/** Create a backup of engrams.yaml before migration. Returns backup path. */
function createBackup(engramsPath: string, version: number): string | null {
  if (!fs.existsSync(engramsPath)) return null
  const backupPath = `${engramsPath}.bak.${version}`
  fs.copyFileSync(engramsPath, backupPath)
  return backupPath
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

  // Create backup before any changes
  const backupPath = options?.dryRun ? null : createBackup(engramsPath, currentVersion)

  // Load engrams as raw objects (passthrough mode — we use the passthrough schema)
  let engrams = loadEngrams(engramsPath)

  const applied: string[] = []

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

  if (!options?.dryRun) {
    // Save migrated engrams
    saveEngrams(engramsPath, engrams)
    // Update schema version
    const newVersion = currentVersion + applied.length
    setSchemaVersion(configPath, newVersion)
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

  const backupPath = createBackup(engramsPath, currentVersion)
  let engrams = loadEngrams(engramsPath)

  const rolledBack: string[] = []
  // Apply down() in reverse order
  const toRollback = ALL_MIGRATIONS.slice(targetVersion, currentVersion).reverse()

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

  saveEngrams(engramsPath, engrams)
  setSchemaVersion(configPath, targetVersion)

  return {
    applied: rolledBack,
    schema_version: targetVersion,
    backup_path: backupPath,
  }
}
