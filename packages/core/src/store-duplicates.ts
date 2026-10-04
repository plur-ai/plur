import { readFileSync } from 'fs'
import { isDeepStrictEqual } from 'util'
import yaml from 'js-yaml'
import { canonicalize } from './project-config.js'
import { atomicWrite, CONFIG_FILE_MODE, withLock } from './sync.js'
import type { StoreEntry } from './schemas/config.js'

/**
 * Duplicate local store entries in config.yaml (#1319, #1356).
 *
 * A local store entry is ignored at load when it would load engrams that are
 * already loaded: its file is the primary store, or its file AND scope repeat
 * an earlier entry. One file under two different scopes is NOT a duplicate —
 * each scope admits different engrams — and is only reported in `sharedFile`.
 */
export interface IgnoredStoreEntry {
  entry: StoreEntry
  /** 'the primary store', or `store "<scope>"` for a repeated file + scope. */
  duplicateOf: string
  /** True when the entry names the primary store file. */
  primary: boolean
}

export interface StoreDuplicateReport {
  kept: StoreEntry[]
  ignored: IgnoredStoreEntry[]
  /** Kept entries whose file is already loaded under an earlier, different scope. */
  sharedFile: Array<{ entry: StoreEntry; firstScope: string }>
}

/** Classify config.yaml store entries against the primary engrams file. Pure: no I/O beyond realpath. */
export function classifyStoreDuplicates(stores: StoreEntry[], primaryEngramsPath: string): StoreDuplicateReport {
  const primary = canonicalize(primaryEngramsPath)
  const scopesByFile = new Map<string, string[]>()
  const kept: StoreEntry[] = []
  const ignored: IgnoredStoreEntry[] = []
  const sharedFile: Array<{ entry: StoreEntry; firstScope: string }> = []
  for (const s of stores) {
    if (s.url || s.path === undefined) { kept.push(s); continue }
    const key = canonicalize(s.path)
    if (key === primary) {
      ignored.push({ entry: s, duplicateOf: 'the primary store', primary: true })
      continue
    }
    const scopes = scopesByFile.get(key) ?? []
    if (scopes.includes(s.scope)) {
      ignored.push({ entry: s, duplicateOf: `store "${s.scope}"`, primary: false })
      continue
    }
    if (scopes.length) sharedFile.push({ entry: s, firstScope: scopes[0] })
    scopesByFile.set(key, [...scopes, s.scope])
    kept.push(s)
  }
  return { kept, ignored, sharedFile }
}

/**
 * Remove every local store entry in config.yaml whose file is the primary
 * engrams file (`plur stores prune`, #1356). Returns the removed entries; an
 * empty list means nothing matched and the file was not touched.
 *
 * Only those entries are removed, and every other byte of config.yaml is kept:
 * the file is edited as text (a re-dump would drop comments and reformat), and
 * the result is re-parsed and must equal the original with exactly those
 * entries gone. If the `stores:` list is not in a shape this can edit safely
 * (flow style, anchors, …) it throws and changes nothing. The write is atomic
 * (tmp + fsync + rename) under the config lock.
 */
export function removePrimaryStoreEntries(configPath: string, primaryEngramsPath: string): StoreEntry[] {
  return withLock(configPath, () => {
    let text: string
    try {
      text = readFileSync(configPath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return []
      throw err
    }
    const before = (yaml.load(text) as Record<string, unknown> | null | undefined) ?? {}
    const stores = Array.isArray(before.stores) ? (before.stores as unknown[]) : []
    const primary = canonicalize(primaryEngramsPath)
    const remove = new Set<number>()
    stores.forEach((s, i) => {
      const e = s as { path?: unknown; url?: unknown } | null
      if (e && typeof e === 'object' && typeof e.path === 'string' && e.url === undefined && canonicalize(e.path) === primary) {
        remove.add(i)
      }
    })
    if (remove.size === 0) return []

    // A leading UTF-8 byte-order mark is not part of the YAML (loadConfig and
    // js-yaml skip it), but it would hide a `stores:` on the first line from
    // the text scan. Edit without it and put it back on write.
    const bom = text.startsWith('\uFEFF') ? '\uFEFF' : ''
    const body = removeSequenceItems(text.slice(bom.length), stores.length, remove)
    const edited = body === null ? null : bom + body
    const expected = { ...before, stores: stores.filter((_, i) => !remove.has(i)) }
    let after: unknown
    try { after = edited === null ? undefined : yaml.load(edited) } catch { after = undefined }
    if (edited === null || !isDeepStrictEqual(after, expected)) {
      throw new Error(
        `cannot remove the entry safely: the stores list in ${configPath} is not in plain block style. ` +
        `Nothing was changed; remove the entries that name ${primaryEngramsPath} by hand.`,
      )
    }
    atomicWrite(configPath, edited, { mode: CONFIG_FILE_MODE })
    return [...remove].map(i => stores[i] as StoreEntry)
  })
}

/**
 * Cut items out of the top-level block sequence `stores:`, as text. An item is
 * its `- ` line plus the following lines indented deeper than the dash; blank
 * lines and comments at or left of the dash stay. Returns null when the list
 * is not a block sequence with exactly `count` items.
 */
export function removeSequenceItems(text: string, count: number, remove: Set<number>): string | null {
  const lines = text.split('\n')
  const indentOf = (l: string) => /^ */.exec(l)![0].length
  const blankOrComment = (l: string) => /^\s*(#.*)?\r?$/.test(l)
  const keyIdx = lines.findIndex(l => /^stores:[ \t]*(#.*)?\r?$/.test(l))
  if (keyIdx === -1) return null
  let first = keyIdx + 1
  while (first < lines.length && blankOrComment(lines[first])) first++
  const dash = first < lines.length ? /^( *)-(?:[ \t]|\r?$)/.exec(lines[first]) : null
  if (!dash) return null
  const d = dash[1].length
  const isItemStart = (l: string) => indentOf(l) === d && /^ *-(?:[ \t]|\r?$)/.test(l)

  const items: Array<{ start: number; end: number }> = []
  for (let j = first; j < lines.length; j++) {
    const l = lines[j]
    if (isItemStart(l)) { items.push({ start: j, end: j + 1 }); continue }
    if (/^\s*\r?$/.test(l)) continue
    if (indentOf(l) > d) { items[items.length - 1].end = j + 1; continue }
    if (blankOrComment(l)) continue
    break
  }
  if (items.length !== count) return null

  const drop = new Set<number>()
  items.forEach((it, i) => { if (remove.has(i)) for (let j = it.start; j < it.end; j++) drop.add(j) })
  const out = lines.filter((_, j) => !drop.has(j))
  if (remove.size === count) {
    // An empty block sequence is `stores:` with nothing under it, which YAML
    // reads as null. Write an explicit empty list instead.
    const key = lines[keyIdx]
    out[keyIdx] = key.replace(/^stores:/, 'stores: []')
  }
  return out.join('\n')
}
