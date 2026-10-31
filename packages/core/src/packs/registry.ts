import * as fs from 'fs'
import yaml from 'js-yaml'
import * as path from 'path'
import { isTransientPackDir, loadPack } from '../engrams.js'
import { atomicWrite, withLock } from '../sync.js'


// --- Registry ---

export interface RegistryEntry {
  /** The pack's manifest name. NOT unique: two install directories may share it. */
  name: string
  /**
   * The install directory under the packs directory: what identifies the row.
   * Absent on legacy rows; those are matched by `name` (`findRegistryRow`).
   */
  dir?: string
  installed_at: string
  source: string
  integrity: string
  version?: string
  creator?: string
  /**
   * Set when `integrity` is a v2 value that `migratePackIntegrity` carried
   * forward from a v1 row WITHOUT re-verifying the pack against its source
   * (§5.5). v1 cannot see bytes moved across the SKILL.md / engrams.yaml
   * boundary or an added `manifest.yaml`, so a carried value inherits v1's
   * trust and nothing more: it detects changes made AFTER the migration, not
   * changes made before it. A reinstall writes a fresh row without it.
   */
  integrity_carried_from?: 'v1'
  /**
  /**
   * Set on a legacy row (no `dir`) when a pack that could have owned it was
   * uninstalled while another installed directory with the same manifest name
   * could also own it. The row stays, because nothing records whose baseline it
   * is, but verifying the remaining directory against it would compare it with
   * what may be the uninstalled pack's hash and report a false `modified`.
   * A row carrying it is reported as ambiguous. A reinstall writes a fresh row
   * without it.
   */
  ambiguous?: true
}


/**
 * Is `p` a directory right now? `false` when it is not, or when it vanished
 * between the `readdir` that named it and this check: an install that
 * finished mid-walk renames its staging directory away, and that must not
 * abort a listing or a migration.
 */
export function isDirNow(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}


export function registryPath(packsDir: string): string {
  return path.join(packsDir, 'registry.yaml')
}


/**
 * The pack registry exists but cannot be read as a registry.
 *
 * Mirrors `EngramStoreUnreadableError`, and for the same reason: the writer is
 * a whole-file replace, so treating an unreadable file as "no packs recorded"
 * means the next install rewrites it with a single entry and every other pack's
 * integrity baseline is gone. The packs stay on disk, but the ability to tell
 * whether they have been tampered with would be lost silently.
 */
export class PackRegistryUnreadableError extends Error {
  constructor(readonly filePath: string, readonly detail: string) {
    super(
      `[plur] refusing to read ${filePath}: ${detail}\n` +
      `The file exists but is not a valid pack registry, so PLUR cannot tell which packs were installed ` +
      `or what they hashed to at install time. It is NOT being treated as empty: the write path replaces ` +
      `the whole file, so an install against an "empty" registry would erase the integrity baseline for ` +
      `every other installed pack — after which a tampered pack reports its integrity as UNKNOWN rather ` +
      `than MODIFIED.\n` +
      `Fix the file (or delete it and re-run 'plur packs install' for each pack to rebuild the baseline) ` +
      `and retry.`,
    )
    this.name = 'PackRegistryUnreadableError'
  }
}


/**
 * Read the registry, refusing rather than guessing.
 *
 * Returning `[]` for an unreadable or malformed file would let the next install
 * rewrite the registry with only its own entry, after which every other pack's
 * integrity check degrades from `modified` to "unknown" without anything
 * saying so.
 */
export function loadRegistry(packsDir: string): RegistryEntry[] {
  const p = registryPath(packsDir)
  if (!fs.existsSync(p)) return [] // never installed anything: genuinely empty
  const raw = fs.readFileSync(p, 'utf8')
  if (raw.trim().length === 0) throw new PackRegistryUnreadableError(p, 'the file is empty')
  let parsed: unknown
  try {
    parsed = yaml.load(raw)
  } catch (err) {
    throw new PackRegistryUnreadableError(p, `YAML parse failed: ${(err as Error).message}`)
  }
  if (parsed === null || parsed === undefined) {
    throw new PackRegistryUnreadableError(p, 'the file parsed to nothing')
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PackRegistryUnreadableError(p, `expected a mapping with a "packs" key, got ${Array.isArray(parsed) ? 'a list' : typeof parsed}`)
  }
  const packs = (parsed as { packs?: unknown }).packs
  if (packs === undefined || packs === null) {
    throw new PackRegistryUnreadableError(p, 'no "packs" key')
  }
  if (!Array.isArray(packs)) {
    throw new PackRegistryUnreadableError(p, `"packs" is ${typeof packs}, expected a list`)
  }
  return packs as RegistryEntry[]
}


export function saveRegistry(packsDir: string, entries: RegistryEntry[]): void {
  const content = yaml.dump({ packs: entries }, { lineWidth: 120, noRefs: true, quotingType: '"' })
  // Atomic + fsynced: a plain writeFileSync truncates in place, so a crash or a
  // full disk mid-write would leave a half-written registry. `atomicWrite`
  // writes to a unique temp file, fsyncs it, renames, then fsyncs the
  // directory, so the registry is either the old one or the new one.
  atomicWrite(registryPath(packsDir), content)
}


/**
 * Serialize a registry read-modify-write.
 *
 * Atomic saves prevent torn files but not lost updates: two processes
 * installing different packs each read the same registry, each add their own
 * entry, and each rename a COMPLETE but different snapshot. The last rename
 * wins and the other pack's integrity baseline is gone, after which a tampered
 * copy of it can no longer be detected.
 *
 * Two MCP servers, or an MCP server and a CLI, is the ordinary case, so
 * atomicity alone is not enough.
 */
export function withRegistryLock<T>(packsDir: string, fn: () => T): T {
  // The lock file must live next to the registry, and the directory may not
  // exist yet on a first install.
  if (!fs.existsSync(packsDir)) fs.mkdirSync(packsDir, { recursive: true })
  return withLock(registryPath(packsDir), fn)
}


/*
 * Which registry row belongs to which installed pack.
 *
 * Rows are keyed by install directory (`dir`). Keying by manifest name would
 * let two directories whose manifests share a name share ONE row: the second
 * install would overwrite the first's baseline, and uninstalling either would
 * remove the other's baseline.
 *
 * Legacy rows carry only `name`. They still resolve, by manifest name, and only
 * rows WITHOUT `dir` are matched that way: a row that names its directory never
 * answers for another one.
 */

/** Index of the row for the pack installed at `dir` (manifest `name`), or -1. */
export function findRegistryRowIndex(entries: RegistryEntry[], dir: string, name: string | undefined): number {
  const own = entries.findIndex(e => e.dir === dir)
  if (own >= 0) return own
  if (name === undefined) return -1
  return entries.findIndex(e => e.dir === undefined && e.name === name)
}


/**
 * Other install directories whose manifest carries `name` and that could own a
 * legacy row (no `dir`) with that name. A legacy row is claimed or removed on
 * behalf of `dir` only when this is empty.
 *
 * Two kinds of directory are NOT candidates:
 *   - one that already owns a `dir` row: its baseline is that row, so a legacy
 *     row cannot be its. Counting it would make a legacy row next to a newer
 *     same-name install "ambiguous", so the legacy pack could never be
 *     reinstalled in place, migrated, or uninstalled cleanly.
 *   - a transient staging (`*.installing-*`) or displaced (`*.replacing-*`)
 *     directory, which is not a pack at all.
 */
export function otherDirsNamed(packsDir: string, dir: string, name: string, entries: RegistryEntry[]): string[] {
  if (!fs.existsSync(packsDir)) return []
  const owned = new Set(entries.map(e => e.dir).filter((d): d is string => d !== undefined))
  return fs.readdirSync(packsDir).filter(e => {
    if (e === dir || owned.has(e) || isTransientPackDir(e)) return false
    const d = path.join(packsDir, e)
    try {
      if (!fs.statSync(d).isDirectory()) return false
      return loadPack(d).manifest.name === name
    } catch { return false }
  })
}


/**
 * Is `row`, found for the pack at `dir`, a legacy row that cannot be told to be
 * that pack's baseline? Either another installed directory could equally own
 * it, or it was marked `ambiguous` when such a directory was uninstalled
 * it, or it was marked `ambiguous` when such a directory was uninstalled.
 * Used where a row is VERIFIED against; claiming or removing a row
 * goes by `ownedRegistryRowIndex`, which ignores the mark, so the last
 * candidate can still reinstall over the row or remove it.
 */
export function isAmbiguousLegacyRow(packsDir: string, dir: string, name: string, row: RegistryEntry | undefined, entries: RegistryEntry[]): boolean {
  if (row === undefined || row.dir !== undefined) return false
  return row.ambiguous === true || otherDirsNamed(packsDir, dir, name, entries).length > 0
}


/** Index of the row `dir` may claim or remove: its own, or a legacy row only it can own. */
export function ownedRegistryRowIndex(packsDir: string, entries: RegistryEntry[], dir: string, name: string | undefined): number {
  const idx = findRegistryRowIndex(entries, dir, name)
  if (idx < 0 || entries[idx].dir === dir) return idx
  // A legacy row matched by name: only if no other installed directory could own it.
  return otherDirsNamed(packsDir, dir, name!, entries).length === 0 ? idx : -1
}


/**
 * The name `name` has in the packs directory's own listing. On a
 * case-insensitive filesystem `PACK-ONE` opens `pack-one` (and on APFS a
 * composed `café` opens a decomposed one), but a row keyed by `dir` must carry
 * the name the directory actually has, or the row and the directory part ways:
 * uninstall would remove the directory and keep its row, and a reinstall from a
 * case-variant source would add a second row. Returns `name` unchanged when
 * nothing on disk answers to it.
 */
export function onDiskEntryName(packsDir: string, name: string): string {
  if (!fs.existsSync(packsDir)) return name
  const listing = fs.readdirSync(packsDir)
  if (listing.includes(name)) return name
  let target: fs.Stats
  try { target = fs.statSync(path.join(packsDir, name)) } catch { return name }
  // Case and Unicode normalization: APFS ignores both, so `café` spelled
  // composed (NFC) opens the directory listed decomposed (NFD). The inode
  // comparison below is what decides; this only narrows the candidates.
  const fold = (s: string) => s.normalize('NFC').toLowerCase()
  for (const e of listing) {
    if (fold(e) !== fold(name)) continue
    try {
      const st = fs.statSync(path.join(packsDir, e))
      if (st.ino === target.ino && st.dev === target.dev) return e
    } catch { /* vanished */ }
  }
  return name
}


export function addToRegistry(packsDir: string, entry: RegistryEntry & { dir: string }): void {
  withRegistryLock(packsDir, () => {
    const entries = loadRegistry(packsDir)
    const idx = ownedRegistryRowIndex(packsDir, entries, entry.dir, entry.name)
    if (idx >= 0) entries[idx] = entry
    else entries.push(entry)
    saveRegistry(packsDir, entries)
  })
}


/**
 * Remove the row for the pack installed at `dir`, never another pack's row.
 * `name` is its manifest name when it could be read; a legacy row is removed
 * by it only when no other installed directory carries the same name.
 */
export function removeFromRegistry(packsDir: string, dir: string, name: string | undefined): void {
  withRegistryLock(packsDir, () => {
    const entries = loadRegistry(packsDir)
    const idx = ownedRegistryRowIndex(packsDir, entries, dir, name)
    if (idx >= 0) {
      entries.splice(idx, 1)
      saveRegistry(packsDir, entries)
      return
    }
    // A legacy row this pack might own but cannot claim, because another
    // installed directory could too. It stays, but once this pack is gone the
    // other directory would look like its only owner and be verified against
    // what may be this pack's hash. Mark it so it keeps being reported
    // as ambiguous.
    const legacy = findRegistryRowIndex(entries, dir, name)
    if (legacy >= 0 && entries[legacy].dir === undefined && entries[legacy].ambiguous !== true) {
      entries[legacy].ambiguous = true
      saveRegistry(packsDir, entries)
    }
  })
}


/** Rewrite one entry's `source` under the same lock (the URL-install path). */
export function setRegistrySource(packsDir: string, dir: string, source: string): void {
  withRegistryLock(packsDir, () => {
    const entries = loadRegistry(packsDir)
    const idx = entries.findIndex(e => e.dir === dir)
    if (idx >= 0) { entries[idx].source = source; saveRegistry(packsDir, entries) }
  })
}
