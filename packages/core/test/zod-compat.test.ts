/**
 * Parse compatibility across a schema-library upgrade.
 *
 * Stores, packs and configs on disk were written by earlier releases, and the
 * parse result is what gets written back. So the Zod schemas must keep
 * producing the same output for the same input: the same defaults, the same
 * kept and dropped keys, in the same order, and the same rejections.
 *
 * Two layers:
 *   1. A corpus of hand-written inputs (fixtures/zod-compat/corpus.ts) whose
 *      results were recorded on 0.22.1 with zod 3 (golden.json).
 *   2. A store, a pack and a config written by the real 0.22.1 write paths
 *      (fixtures/zod-compat/store-0.22.1/), loaded with the current code.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import yaml from 'js-yaml'
import { runCorpus, type CaseResult } from './fixtures/zod-compat/run.js'
import { EngramSchemaPassthrough } from '../src/schemas/engram.js'
import { EpisodeSchema } from '../src/schemas/episode.js'
import { PackManifestSchema } from '../src/schemas/pack.js'
import { PlurConfigSchema } from '../src/schemas/config.js'
import { loadConfig } from '../src/config.js'
import { Plur } from '../src/index.js'

const FIXTURES = path.join(__dirname, 'fixtures', 'zod-compat')
const STORE = path.join(FIXTURES, 'store-0.22.1')

describe('schema parse results match 0.22.1 (zod 3) output', () => {
  const golden = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'golden.json'), 'utf8')) as CaseResult[]
  const actual = runCorpus()

  it('covers the same cases as the golden file', () => {
    expect(actual.map((r) => `${r.schema}: ${r.name}`)).toEqual(golden.map((r) => `${r.schema}: ${r.name}`))
  })

  for (const [i, expected] of golden.entries()) {
    it(`${expected.schema}: ${expected.name}`, () => {
      // Compare serialized text so key order counts, as it does in a YAML file.
      expect(JSON.stringify(actual[i], null, 2)).toBe(JSON.stringify(expected, null, 2))
    })
  }
})

describe('a store written by 0.22.1 still loads', () => {
  let work: string
  let storeDir: string

  beforeAll(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-zod-compat-'))
    storeDir = path.join(work, 'store')
    fs.cpSync(STORE, storeDir, { recursive: true })
    const configPath = path.join(storeDir, 'config.yaml')
    fs.writeFileSync(configPath, fs.readFileSync(configPath, 'utf8').split('__WORK__').join(work))
  })
  afterAll(() => fs.rmSync(work, { recursive: true, force: true }))

  const readYaml = (file: string) => yaml.load(fs.readFileSync(path.join(STORE, file), 'utf8')) as any

  it('re-parsing every stored engram reproduces it exactly', () => {
    const { engrams } = readYaml('engrams.yaml')
    expect(engrams).toHaveLength(3)
    for (const stored of engrams) {
      const parsed = EngramSchemaPassthrough.parse(stored)
      expect(JSON.stringify(parsed)).toBe(JSON.stringify(stored))
    }
  })

  it('re-parsing every stored episode reproduces it exactly', () => {
    const episodes = readYaml('episodes.yaml')
    expect(episodes).toHaveLength(1)
    for (const stored of episodes) expect(JSON.stringify(EpisodeSchema.parse(stored))).toBe(JSON.stringify(stored))
  })

  it('the exported pack manifest and engrams parse unchanged', () => {
    const skill = fs.readFileSync(path.join(STORE, 'pack', 'SKILL.md'), 'utf8')
    const front = yaml.load(skill.split('---')[1]) as Record<string, unknown>
    // The writer leaves out an empty tag list; the parse fills it back in place.
    const { license, metadata, ...head } = front
    expect(JSON.stringify(PackManifestSchema.parse(front))).toBe(JSON.stringify({ ...head, license, tags: [], metadata }))
    // The pack writer orders keys its own way, so compare values here; key order
    // is covered by the store test above.
    const { engrams } = readYaml('pack/engrams.yaml')
    for (const stored of engrams) expect(EngramSchemaPassthrough.parse(stored)).toEqual(stored)
  })

  it('the config parses without gaining defaults that were never written', () => {
    const raw = readYaml('config.yaml')
    expect(PlurConfigSchema.parse(raw)).toEqual({
      auto_learn: true,
      injection: { spread_cap: 4, spread_budget: 480, co_access: true, pinned_ratio: 0.5, pinned_hard_ratio: 0.5 },
      dedup: { mode: 'off' },
      index: false,
      stores: [{ path: '__WORK__/team', scope: 'group:example/team', shared: true, readonly: false, description: 'Example team store', covers: ['example'] }],
    })
    const loaded = loadConfig(path.join(storeDir, 'config.yaml'))
    expect(loaded.stores?.[0]).toMatchObject({ scope: 'group:example/team', shared: true, readonly: false })
    expect(loaded.dedup).toEqual({ mode: 'off' })
  })

  it('Plur reads the engrams, episodes and pack back', async () => {
    const plur = new Plur({ path: storeDir })
    const all = await plur.list()
    expect(all.map((e) => e.id).sort()).toEqual(['ENG-2026-10-25-001', 'ENG-2026-10-25-002', 'ENG-2026-10-25-003'])
    const first = await plur.getById('ENG-2026-10-25-001')
    expect(first?.statement).toBe('Run pnpm -r build after switching branches')
    expect(first?.feedback_signals).toEqual({ positive: 1, negative: 0, neutral: 0 })
    expect(first?.knowledge_anchors).toEqual([{ path: 'docs/build.md', relevance: 'primary', snippet: 'pnpm -r build' }])
    expect(plur.timeline().map((e) => e.summary)).toContain('Fixture session: learned three engrams')
    const installed = await plur.installPack(path.join(storeDir, 'pack'))
    expect(installed.installed).toBe(1)
  })
})
