/**
 * #1356 — removing config.yaml store entries that name the primary engrams
 * file (`plur stores prune`).
 *
 * Such an entry is ignored at load (#1319) but warns on every run until it is
 * gone. Removal must touch only those entries, keep every other byte of
 * config.yaml (comments, key order, quoting), be atomic, and refuse — changing
 * nothing — when the file is not in a shape it can edit safely.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync, realpathSync, statSync, chmodSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import { removePrimaryStoreEntries, classifyStoreDuplicates, removeSequenceItems } from '../src/store-duplicates.js'

describe('#1356 removePrimaryStoreEntries', () => {
  let base: string
  let root: string
  let link: string
  let config: string
  let primary: string

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'plur-prune-')))
    root = join(base, 'plur')
    link = join(base, 'plur-link')
    mkdirSync(root, { recursive: true })
    symlinkSync(root, link, 'dir')
    primary = join(root, 'engrams.yaml')
    writeFileSync(primary, 'engrams: []\n')
    writeFileSync(join(base, 'other.yaml'), 'engrams: []\n')
    config = join(root, 'config.yaml')
  })

  afterEach(() => { rmSync(base, { recursive: true, force: true }) })

  const other = () => join(base, 'other.yaml')

  it('removes only the entries that name the primary file, under any spelling, and keeps every other byte', () => {
    const head = [
      '# my plur config',
      'auto_learn: true   # keep',
      'stores:',
      '  # the team store',
      `  - path: ${other()}`,
      '    scope: "project:other"   # quoted on purpose',
      '    shared: false',
      '',
    ]
    const dupA = [
      `  - path: ${join(link, 'engrams.yaml')}`,
      '    scope: project:home',
      '    # stray comment inside the entry',
      '    readonly: false',
    ]
    const middle = [
      '  - url: https://example.invalid/sse',
      '    token: t0k',
      '    scope: group:x/y',
    ]
    const dupB = [
      `  - {path: '${join(root, '.', 'engrams.yaml')}', scope: project:again}`,
    ]
    const tail = [
      '# trailing comment at column 0',
      'packs:',
      '  - a',
      '',
    ]
    writeFileSync(config, [...head, ...dupA, ...middle, ...dupB, ...tail].join('\n'))

    const removed = removePrimaryStoreEntries(config, join(link, 'engrams.yaml'))

    expect(removed.map(s => s.scope)).toEqual(['project:home', 'project:again'])
    expect(readFileSync(config, 'utf8')).toBe([...head, ...middle, ...tail].join('\n'))
  })

  it('leaves a same-file same-scope duplicate of ANOTHER store alone', () => {
    const body = `stores:\n  - path: ${other()}\n    scope: project:o\n  - path: ${other()}\n    scope: project:o\n`
    writeFileSync(config, body)
    expect(removePrimaryStoreEntries(config, primary)).toEqual([])
    expect(readFileSync(config, 'utf8')).toBe(body)
  })

  it('does not touch the file when nothing matches', () => {
    const body = `stores:\n  - path: ${other()}\n    scope: project:o\n`
    writeFileSync(config, body)
    const before = statSync(config).mtimeMs
    expect(removePrimaryStoreEntries(config, primary)).toEqual([])
    expect(readFileSync(config, 'utf8')).toBe(body)
    expect(statSync(config).mtimeMs).toBe(before)
  })

  it('writes an explicit empty list when every entry goes, and keeps CRLF line endings', () => {
    writeFileSync(config, `a: 1\r\nstores:\r\n  - path: ${primary}\r\n    scope: project:home\r\nb: 2\r\n`)
    expect(removePrimaryStoreEntries(config, primary)).toHaveLength(1)
    expect(readFileSync(config, 'utf8')).toBe('a: 1\r\nstores: []\r\nb: 2\r\n')
  })

  it('handles a sequence written at the same indent as its key', () => {
    writeFileSync(config, `stores:\n- path: ${other()}\n  scope: project:o\n- path: ${primary}\n  scope: project:home\nx: 1\n`)
    expect(removePrimaryStoreEntries(config, primary)).toHaveLength(1)
    expect(readFileSync(config, 'utf8')).toBe(`stores:\n- path: ${other()}\n  scope: project:o\nx: 1\n`)
  })

  it('refuses a flow-style list and changes nothing', () => {
    const body = `stores: [{path: ${primary}, scope: project:home}]\n`
    writeFileSync(config, body)
    expect(() => removePrimaryStoreEntries(config, primary)).toThrow(/not in plain block style/)
    expect(readFileSync(config, 'utf8')).toBe(body)
  })

  it('refuses, changing nothing, when the removed entry is an anchor aliased elsewhere', () => {
    // Cutting the anchored item would leave `*p` dangling (or change what
    // `backup` means): the re-parse must not equal the original minus the entry.
    const body = `stores:\n  - &p\n    path: ${primary}\n    scope: project:home\n  - path: ${other()}\n    scope: project:o\nbackup: *p\n`
    writeFileSync(config, body)
    expect(() => removePrimaryStoreEntries(config, primary)).toThrow(/not in plain block style/)
    expect(readFileSync(config, 'utf8')).toBe(body)
  })

  it('the text edit refuses when the `stores:` it finds does not hold the parsed number of items', () => {
    // A multi-line quoted scalar can hold a `stores:` line with dash lines at
    // column 0. The first `stores:` line the text scan finds is inside it, and
    // holds 2 "items" while the real list holds 1.
    const text = `note: "x\nstores:\n- a\n- b"\nstores:\n  - path: ${primary}\n    scope: project:home\n`
    expect(removeSequenceItems(text, 1, new Set([0]))).toBeNull()
    writeFileSync(config, text)
    expect(() => removePrimaryStoreEntries(config, primary)).toThrow(/not in plain block style/)
    expect(readFileSync(config, 'utf8')).toBe(text)
  })

  it('edits a config.yaml that starts with a UTF-8 byte-order mark and keeps the mark', () => {
    writeFileSync(config, `\uFEFFstores:\n  - path: ${primary}\n    scope: project:home\n  - path: ${other()}\n    scope: project:o\n`)
    expect(removePrimaryStoreEntries(config, primary).map(s => s.scope)).toEqual(['project:home'])
    expect(readFileSync(config, 'utf8')).toBe(`\uFEFFstores:\n  - path: ${other()}\n    scope: project:o\n`)
  })

  it('keeps the file mode and leaves no temp file behind', () => {
    writeFileSync(config, `stores:\n  - path: ${primary}\n    scope: project:home\n`)
    chmodSync(config, 0o600)
    removePrimaryStoreEntries(config, primary)
    expect(statSync(config).mode & 0o777).toBe(0o600)
    expect(readdirSync(root).filter(f => f.endsWith('.tmp') || f.endsWith('.lock'))).toEqual([])
  })

  it('classifyStoreDuplicates marks which ignored entries are the primary', () => {
    const r = classifyStoreDuplicates([
      { path: join(link, 'engrams.yaml'), scope: 'project:home', shared: false, readonly: false },
      { path: other(), scope: 'project:o', shared: false, readonly: false },
      { path: other(), scope: 'project:o', shared: false, readonly: false },
      { path: other(), scope: 'project:p', shared: false, readonly: false },
    ], primary)
    expect(r.ignored.map(d => [d.entry.scope, d.primary])).toEqual([['project:home', true], ['project:o', false]])
    expect(r.sharedFile.map(d => [d.entry.scope, d.firstScope])).toEqual([['project:p', 'project:o']])
    expect(r.kept.map(s => s.scope)).toEqual(['project:o', 'project:p'])
  })

  it('Plur.removeDuplicatePrimaryStores removes the entry and clears ignoredDuplicateStores', () => {
    writeFileSync(config, `stores:\n  - path: ${join(link, 'engrams.yaml')}\n    scope: project:home\n  - path: ${other()}\n    scope: project:o\n`)
    const plur = new Plur({ path: root, autoDiscover: false })
    expect(plur.ignoredDuplicateStores().map(s => s.scope)).toEqual(['project:home'])
    expect(plur.removeDuplicatePrimaryStores().map(s => s.scope)).toEqual(['project:home'])
    expect(plur.ignoredDuplicateStores()).toEqual([])
    expect(readFileSync(config, 'utf8')).toBe(`stores:\n  - path: ${other()}\n    scope: project:o\n`)
    // A fresh instance finds nothing left to ignore.
    expect(new Plur({ path: root, autoDiscover: false }).ignoredDuplicateStores()).toEqual([])
  })
})
