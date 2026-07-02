import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createRequire } from 'module'
import { Plur } from '../src/index.js'
import {
  parseGenericContent,
  parseMem0Content,
  parseGpEngramDb,
  getImportSource,
  listImportSources,
  runImport,
  importFrom,
  normalizeImportType,
  type ImportRecord,
} from '../src/importers/index.js'

const FIXTURES = join(__dirname, 'fixtures', 'import')

// ─── Issue #441: migration importers ────────────────────────────────────────
//
// Three implemented sources (generic JSON/JSONL/CSV, gp-engram SQLite, mem0
// JSON export) + stubbed adapters for zep/letta. All imports route through
// plur.learn() so the content-hash dedup gate and secret guard apply — never
// raw-append. Reports N imported / M skipped (dedup) / K conflicts.

// ─── Type normalization ──────────────────────────────────────────────────────

describe('normalizeImportType', () => {
  it('passes through native PLUR types', () => {
    expect(normalizeImportType('behavioral')).toBe('behavioral')
    expect(normalizeImportType('procedural')).toBe('procedural')
    expect(normalizeImportType('terminological')).toBe('terminological')
    expect(normalizeImportType('architectural')).toBe('architectural')
  })

  it('maps common competitor type names onto the 4 PLUR types', () => {
    expect(normalizeImportType('decision')).toBe('architectural')
    expect(normalizeImportType('adr')).toBe('architectural')
    expect(normalizeImportType('config')).toBe('procedural')
    expect(normalizeImportType('how-to')).toBe('procedural')
    expect(normalizeImportType('definition')).toBe('terminological')
    expect(normalizeImportType('preference')).toBe('behavioral')
    expect(normalizeImportType('pattern')).toBe('behavioral')
  })

  it('defaults unknown or missing types to behavioral', () => {
    expect(normalizeImportType('xyzzy')).toBe('behavioral')
    expect(normalizeImportType(undefined)).toBe('behavioral')
    expect(normalizeImportType('')).toBe('behavioral')
  })
})

// ─── Generic JSON / JSONL / CSV parser ───────────────────────────────────────

describe('generic importer parsing', () => {
  it('parses a JSON array with default field names', () => {
    const content = readFileSync(join(FIXTURES, 'generic.json'), 'utf-8')
    const records = parseGenericContent(content, { filename: 'generic.json' })
    expect(records).toHaveLength(3)
    expect(records[0].statement).toBe('Use pnpm for all installs in the monorepo')
    expect(records[0].type).toBe('procedural')
    expect(records[0].domain).toBe('dev.tooling')
    expect(records[0].tags).toEqual(['pnpm', 'monorepo'])
    expect(records[0].confidence).toBe(0.9)
    expect(records[0].created_at).toBe('2025-11-02T10:00:00Z')
    expect(records[0].source).toBe('notes/dev.md')
    expect(records[1].valid_until).toBe('2026-12-31')
  })

  it('parses JSONL with a field-mapping config (dot-paths, defaults, type normalization)', () => {
    const content = readFileSync(join(FIXTURES, 'generic-mapped.jsonl'), 'utf-8')
    const mapping = JSON.parse(readFileSync(join(FIXTURES, 'mapping.json'), 'utf-8'))
    const records = parseGenericContent(content, { filename: 'generic-mapped.jsonl', mapping })
    expect(records).toHaveLength(2)
    expect(records[0].statement).toBe('Deploy target is fly.io')
    expect(records[0].type).toBe('architectural') // "decision" normalized
    expect(records[0].domain).toBe('infra.deploy') // dot-path meta.area
    expect(records[0].created_at).toBe('2025-08-15T09:30:00Z') // dot-path meta.when
    expect(records[0].tags).toEqual(['deploy'])
    expect(records[0].confidence).toBe(0.8)
    expect(records[0].scope).toBe('project:demo') // mapping default
    expect(records[1].type).toBe('behavioral') // "policy" normalized
    expect(records[1].scope).toBe('project:demo')
  })

  it('parses CSV with quoted commas and pipe-separated tags', () => {
    const content = readFileSync(join(FIXTURES, 'generic.csv'), 'utf-8')
    const records = parseGenericContent(content, { filename: 'generic.csv' })
    expect(records).toHaveLength(2)
    expect(records[0].statement).toBe('Standups happen at 09:30 CET, daily')
    expect(records[0].domain).toBe('team.rituals')
    expect(records[0].tags).toEqual(['standup', 'team'])
    expect(records[0].confidence).toBe(0.7)
    expect(records[1].statement).toBe('Feature flags live in flags.yaml')
    expect(records[1].confidence).toBeUndefined() // empty cell
  })

  it('accepts alternate statement field names (text, memory, content)', () => {
    const records = parseGenericContent(
      JSON.stringify([{ text: 'a fact' }, { memory: 'b fact' }, { content: 'c fact' }]),
      { filename: 'x.json' },
    )
    expect(records.map(r => r.statement)).toEqual(['a fact', 'b fact', 'c fact'])
  })

  it('unwraps common top-level wrappers ({results}, {memories}, {records})', () => {
    for (const key of ['results', 'memories', 'records']) {
      const records = parseGenericContent(
        JSON.stringify({ [key]: [{ statement: 'wrapped fact' }] }),
        { filename: 'x.json' },
      )
      expect(records).toHaveLength(1)
      expect(records[0].statement).toBe('wrapped fact')
    }
  })

  it('throws a clear error on malformed JSON', () => {
    expect(() => parseGenericContent('{not json', { filename: 'x.json' })).toThrow(/parse/i)
  })

  it('normalizes 1-10 confidence scales down to 0-1', () => {
    const records = parseGenericContent(
      JSON.stringify([{ statement: 'scaled', confidence: 8 }]),
      { filename: 'x.json' },
    )
    expect(records[0].confidence).toBeCloseTo(0.8)
  })
})

// ─── mem0 parser ─────────────────────────────────────────────────────────────

describe('mem0 importer parsing', () => {
  const records = () => parseMem0Content(
    readFileSync(join(FIXTURES, 'mem0-export.json'), 'utf-8'),
    { filename: 'mem0-export.json' },
  )

  it('parses the {results: [...]} export shape', () => {
    expect(records()).toHaveLength(3)
  })

  it('maps memory → statement and categories → tags', () => {
    const [first] = records()
    expect(first.statement).toBe('User prefers dark mode in all editors')
    expect(first.tags).toEqual(['preferences', 'ui'])
  })

  it('derives scope from user_id / agent_id', () => {
    const [first, second] = records()
    expect(first.scope).toBe('user:alice')
    expect(second.scope).toBe('agent:scheduler')
  })

  it('preserves temporal metadata (created_at, updated_at → last_accessed, expiration_date → valid_until)', () => {
    const [first, second] = records()
    expect(first.created_at).toBe('2025-09-14T12:00:00.000000-07:00')
    expect(first.last_accessed).toBe('2025-10-01T08:30:00.000000-07:00')
    expect(second.valid_until).toBe('2026-06-30')
  })

  it('stamps the mem0 id into source', () => {
    const [first] = records()
    expect(first.source).toContain('mem0')
    expect(first.source).toContain('a1b2c3d4-0001')
  })

  it('also accepts a bare array export', () => {
    const bare = parseMem0Content(
      JSON.stringify([{ id: 'x-1', memory: 'bare memory' }]),
      { filename: 'bare.json' },
    )
    expect(bare).toHaveLength(1)
    expect(bare[0].statement).toBe('bare memory')
  })
})

// ─── gp-engram (Gentleman-Programming/engram) SQLite parser ──────────────────

describe('gp-engram importer parsing', () => {
  let dbPath: string

  beforeAll(() => {
    // Build the .db from the hand-written SQL fixture (no network).
    const require = createRequire(import.meta.url)
    const Database = require('better-sqlite3')
    const dir = mkdtempSync(join(tmpdir(), 'plur-gp-fixture-'))
    dbPath = join(dir, 'engram.db')
    const db = new Database(dbPath)
    db.exec(readFileSync(join(FIXTURES, 'gp-engram-fixture.sql'), 'utf-8'))
    db.close()
  })

  it('reads observations and excludes soft-deleted rows', () => {
    const records = parseGpEngramDb(dbPath)
    expect(records).toHaveLength(3) // row 4 is deleted
    expect(records.every(r => !r.statement.includes('soft-deleted'))).toBe(true)
  })

  it('joins title and content into the statement', () => {
    const [first] = parseGpEngramDb(dbPath)
    expect(first.statement).toBe(
      'Use SQLite for local persistence: Chose SQLite over Postgres for zero-config local storage',
    )
  })

  it('maps observation types onto PLUR types and keeps the original as a tag', () => {
    const [decision, pattern, config] = parseGpEngramDb(dbPath)
    expect(decision.type).toBe('architectural')
    expect(decision.tags).toContain('decision')
    expect(pattern.type).toBe('behavioral')
    expect(config.type).toBe('procedural')
  })

  it('maps scope: project → project:<name>, global → global', () => {
    const [decision, , config] = parseGpEngramDb(dbPath)
    expect(decision.scope).toBe('project:acme-api')
    expect(config.scope).toBe('global')
  })

  it('converts topic_key to a dotted domain', () => {
    const [decision] = parseGpEngramDb(dbPath)
    expect(decision.domain).toBe('decision.storage')
  })

  it('preserves temporal metadata with SQLite datetimes normalized to ISO', () => {
    const [decision] = parseGpEngramDb(dbPath)
    expect(decision.created_at).toBe('2025-12-01T09:15:00Z')
    expect(decision.last_accessed).toBe('2025-12-02T10:00:00Z') // last_seen_at
  })

  it('carries pinned through', () => {
    const [, pattern] = parseGpEngramDb(dbPath)
    expect(pattern.pinned).toBe(true)
  })

  it('maps expires_at → valid_until but never maps review_after', () => {
    const [decision, , config] = parseGpEngramDb(dbPath)
    // Row 3 has expires_at (a real expiry, Phase 2 upstream) → valid_until.
    expect(config.valid_until).toBe('2026-12-31T00:00:00Z')
    // Row 1 has review_after only — a decay "review by" date, NOT an expiry.
    expect(decision.valid_until).toBeUndefined()
  })

  it('stamps the observation row into source', () => {
    const [decision] = parseGpEngramDb(dbPath)
    expect(decision.source).toContain('gp-engram')
    expect(decision.source).toContain('#1')
  })

  it('throws a clear error for a missing db file', () => {
    expect(() => parseGpEngramDb('/nonexistent/nope.db')).toThrow()
  })
})

// ─── Adapter registry ────────────────────────────────────────────────────────

describe('import source registry', () => {
  it('lists implemented and stubbed sources', () => {
    const sources = listImportSources()
    const names = sources.map(s => s.name)
    expect(names).toEqual(expect.arrayContaining(['generic', 'gp-engram', 'mem0', 'zep', 'letta']))
    expect(sources.find(s => s.name === 'generic')?.implemented).toBe(true)
    expect(sources.find(s => s.name === 'gp-engram')?.implemented).toBe(true)
    expect(sources.find(s => s.name === 'mem0')?.implemented).toBe(true)
    expect(sources.find(s => s.name === 'zep')?.implemented).toBe(false)
    expect(sources.find(s => s.name === 'letta')?.implemented).toBe(false)
  })

  it('zep and letta stubs throw a clear not-implemented error', () => {
    expect(() => getImportSource('zep').parse({ path: 'x.json' })).toThrow(/not.*implemented/i)
    expect(() => getImportSource('letta').parse({ path: 'x.json' })).toThrow(/not.*implemented/i)
  })

  it('unknown source names list the available ones', () => {
    expect(() => getImportSource('supermemory')).toThrow(/generic.*gp-engram.*mem0/s)
  })
})

// ─── Import engine (dedup gates, report, temporal, conflicts) ────────────────

describe('runImport engine', () => {
  let dir: string
  let plur: Plur

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-import-test-'))
    plur = new Plur({ path: dir })
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const rec = (statement: string, extra: Partial<ImportRecord> = {}): ImportRecord =>
    ({ statement, ...extra })

  it('imports records through learn() and reports counts', () => {
    const report = runImport(plur, [rec('fact one'), rec('fact two')], { from: 'generic' })
    expect(report.total).toBe(2)
    expect(report.imported).toBe(2)
    expect(report.skipped).toBe(0)
    expect(report.conflicts).toBe(0)
    expect(report.errors).toBe(0)
    expect(plur.list({})).toHaveLength(2)
    expect(report.records.filter(r => r.action === 'imported')).toHaveLength(2)
    expect(report.records[0].id).toMatch(/^ENG-/)
  })

  it('routes duplicates through the content-hash dedup gate (skipped, not re-added)', () => {
    plur.learn('fact one', { scope: 'global' })
    const report = runImport(plur, [rec('fact one', { scope: 'global' }), rec('fact two')], { from: 'generic' })
    expect(report.imported).toBe(1)
    expect(report.skipped).toBe(1)
    expect(plur.list({})).toHaveLength(2)
    const skipped = report.records.find(r => r.action === 'skipped')
    expect(skipped?.id).toMatch(/^ENG-/) // points at the existing engram
  })

  it('dedups repeated statements within one import run', () => {
    const report = runImport(plur, [rec('same fact'), rec('same fact')], { from: 'generic' })
    expect(report.imported).toBe(1)
    expect(report.skipped).toBe(1)
    expect(plur.list({})).toHaveLength(1)
  })

  it('re-importing the same file is idempotent (all skipped)', () => {
    runImport(plur, [rec('idem one'), rec('idem two')], { from: 'generic' })
    const second = runImport(plur, [rec('idem one'), rec('idem two')], { from: 'generic' })
    expect(second.imported).toBe(0)
    expect(second.skipped).toBe(2)
    expect(plur.list({})).toHaveLength(2)
  })

  it('re-importing an ALREADY-EXPIRED record is still a skip (learn-dedup parity)', () => {
    // learn()'s content-hash dedup ignores temporal validity, so the engine's
    // pre-existing snapshot must too — a plain list() drops engrams whose
    // valid_until has passed, which would misreport the second run as
    // "imported" and re-patch the existing engram's temporal metadata.
    const expired = rec('conference wifi password is hunter2', { valid_until: '2020-01-01' })
    const first = runImport(plur, [expired], { from: 'generic' })
    expect(first.imported).toBe(1)
    const learnedAt = plur.list({ include_expired: true })[0].temporal?.learned_at

    const second = runImport(plur, [rec('conference wifi password is hunter2', {
      valid_until: '2020-01-01',
      created_at: '2010-05-05T00:00:00Z', // must NOT overwrite the existing engram
    })], { from: 'generic' })
    expect(second.imported).toBe(0)
    expect(second.skipped).toBe(1)
    expect(second.records[0].id).toMatch(/^ENG-/)

    const engrams = plur.list({ include_expired: true })
    expect(engrams).toHaveLength(1)
    expect(engrams[0].temporal?.learned_at).toBe(learnedAt)

    // dry-run predicts the same
    const dry = runImport(plur, [expired], { from: 'generic', dryRun: true })
    expect(dry.skipped).toBe(1)
    expect(dry.imported).toBe(0)
  })

  it('dry-run predicts the report without writing anything', () => {
    plur.learn('already here', { scope: 'global' })
    const report = runImport(
      plur,
      [rec('already here', { scope: 'global' }), rec('brand new'), rec('brand new')],
      { from: 'generic', dryRun: true },
    )
    expect(report.dry_run).toBe(true)
    expect(report.total).toBe(3)
    expect(report.imported).toBe(1)
    expect(report.skipped).toBe(2) // one pre-existing dup + one in-file dup
    expect(plur.list({})).toHaveLength(1) // nothing written
  })

  it('applies a scope override to every record', () => {
    runImport(plur, [rec('scoped fact', { scope: 'user:bob' })], { from: 'generic', scope: 'project:acme' })
    const [engram] = plur.list({})
    expect(engram.scope).toBe('project:acme')
  })

  it('preserves temporal metadata from the source', () => {
    runImport(plur, [rec('old knowledge', {
      created_at: '2024-03-01T08:00:00Z',
      last_accessed: '2025-01-15T09:00:00Z',
      valid_until: '2027-01-01',
    })], { from: 'generic' })
    const [engram] = plur.list({})
    expect(engram.temporal?.learned_at).toBe('2024-03-01T08:00:00Z')
    expect(engram.temporal?.valid_until).toBe('2027-01-01')
    expect(engram.temporal?.ingested_at).toBeDefined()
    expect(engram.activation.last_accessed).toBe('2025-01-15')
  })

  it('maps confidence onto episodic.confidence (1-10)', () => {
    runImport(plur, [rec('confident fact', { confidence: 0.9 })], { from: 'generic' })
    const [engram] = plur.list({})
    expect(engram.episodic?.confidence).toBe(9)
  })

  it('flags conflicts against pre-existing engrams and links relations.conflicts', () => {
    const existing = plur.learn('The deploy target is fly.io', { scope: 'global', domain: 'infra.deploy' })
    const report = runImport(
      plur,
      [rec('The deploy target is render.com', { scope: 'global', domain: 'infra.deploy' })],
      { from: 'generic' },
    )
    expect(report.imported).toBe(1)
    expect(report.conflicts).toBe(1)
    const imported = report.records[0]
    expect(imported.conflicts).toContain(existing.id)
    const newEngram = plur.list({}).find(e => e.id === imported.id)
    expect(newEngram?.relations?.conflicts).toContain(existing.id)
  })

  it('counts records that fail the learn gates as errors (e.g. secrets)', () => {
    const report = runImport(
      plur,
      [rec('api key is sk-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGH'), rec('a clean fact')],
      { from: 'generic' },
    )
    expect(report.imported).toBe(1)
    expect(report.errors).toBe(1)
    expect(report.records.find(r => r.action === 'error')?.error).toMatch(/secret/i)
    expect(plur.list({})).toHaveLength(1)
  })

  it('counts empty statements as errors', () => {
    const report = runImport(plur, [rec('')], { from: 'generic' })
    expect(report.errors).toBe(1)
    expect(report.imported).toBe(0)
  })

  it('stamps a default source label when the record has none', () => {
    runImport(plur, [rec('unlabeled fact')], { from: 'mem0', defaultSource: 'import:mem0:memories.json' })
    const [engram] = plur.list({})
    expect(engram.source).toBe('import:mem0:memories.json')
  })
})

// ─── importFrom: file → parse → engine end-to-end ────────────────────────────

describe('importFrom end-to-end', () => {
  let dir: string
  let plur: Plur

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-importfrom-test-'))
    plur = new Plur({ path: dir })
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('imports the generic JSON fixture with dedup of the in-file duplicate', () => {
    const report = importFrom(plur, { from: 'generic', path: join(FIXTURES, 'generic.json') })
    expect(report.from).toBe('generic')
    expect(report.total).toBe(3)
    expect(report.imported).toBe(2)
    expect(report.skipped).toBe(1)
    const engrams = plur.list({})
    expect(engrams).toHaveLength(2)
    const staged = engrams.find(e => e.statement.includes('staging API'))
    expect(staged?.temporal?.valid_until).toBe('2026-12-31')
  })

  it('imports the mem0 fixture preserving scopes and temporal metadata', () => {
    const report = importFrom(plur, { from: 'mem0', path: join(FIXTURES, 'mem0-export.json') })
    expect(report.imported).toBe(3)
    const engrams = plur.list({})
    const darkMode = engrams.find(e => e.statement.includes('dark mode'))
    expect(darkMode?.scope).toBe('user:alice')
    expect(darkMode?.temporal?.learned_at).toBe('2025-09-14T12:00:00.000000-07:00')
    expect(darkMode?.tags).toEqual(['preferences', 'ui'])
  })

  it('imports a gp-engram .db end-to-end', () => {
    const require = createRequire(import.meta.url)
    const Database = require('better-sqlite3')
    const dbPath = join(dir, 'engram.db')
    const db = new Database(dbPath)
    db.exec(readFileSync(join(FIXTURES, 'gp-engram-fixture.sql'), 'utf-8'))
    db.close()

    const report = importFrom(plur, { from: 'gp-engram', path: dbPath })
    expect(report.imported).toBe(3)
    const engrams = plur.list({})
    const pinned = engrams.find(e => e.statement.includes('Error wrapping'))
    expect(pinned?.pinned).toBe(true)
    expect(pinned?.scope).toBe('project:acme-api')
  })

  it('throws for a missing input file', () => {
    expect(() => importFrom(plur, { from: 'generic', path: join(dir, 'nope.json') })).toThrow()
    expect(existsSync(join(dir, 'nope.json'))).toBe(false)
  })
})
