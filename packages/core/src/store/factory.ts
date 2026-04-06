/**
 * Storage factory — creates EngramStore instances based on config.
 * YAML is default. SQLite is available for scale.
 */
import { join } from 'path'
import { YamlStore } from './yaml-store.js'
import { SqliteStore } from './sqlite-store.js'
import type { EngramStore, StorageBackend } from './types.js'

export interface StorageConfig {
  backend: StorageBackend
  path: string
}

/**
 * Create an EngramStore based on the storage configuration.
 * Default: YamlStore at {path}/engrams.yaml
 */
export function createStore(config: StorageConfig): EngramStore {
  switch (config.backend) {
    case 'sqlite':
      return new SqliteStore(join(config.path, 'engrams.db'))
    case 'yaml':
    default:
      return new YamlStore(join(config.path, 'engrams.yaml'))
  }
}

/**
 * Migrate data from one backend to another.
 * Loads all engrams from source, saves to target.
 */
export async function migrateStore(from: EngramStore, to: EngramStore): Promise<number> {
  const engrams = await from.load()
  await to.save(engrams)
  return engrams.length
}
