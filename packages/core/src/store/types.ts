/**
 * Abstract storage interface for engram persistence.
 * Search/retrieval stays in fts.ts, embeddings.ts, hybrid-search.ts.
 * The store is about persistence only.
 */
import type { Engram } from '../schemas/engram.js'

export interface EngramStore {
  /** Load all engrams from the store. */
  load(): Promise<Engram[]>
  /** Replace all engrams in the store (full save). */
  save(engrams: Engram[]): Promise<void>
  /** Append a single engram. For YAML, this does load+append+save. */
  append(engram: Engram): Promise<void>
  /** Get a single engram by ID. Returns null if not found. */
  getById(id: string): Promise<Engram | null>
  /** Remove an engram by ID. Returns true if found and removed. */
  remove(id: string): Promise<boolean>
  /** Count engrams, optionally filtered by status. */
  count(filter?: { status?: string }): Promise<number>
  /** Close any open resources (e.g., database connections). */
  close(): Promise<void>
}

/** Backend type identifier. */
export type StorageBackend = 'yaml' | 'sqlite'
