import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'

const CLI = join(__dirname, '..', 'dist', 'index.js')

describe('plur packs', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-cli-test-')) })
  afterEach(() => { rmSync(dir, { recursive: true }) })

  function run(args: string): string {
    return execSync(`node ${CLI} ${args} --path ${dir} --json`, {
      encoding: 'utf-8',
      timeout: 10000,
    }).trim()
  }

  it('packs list returns empty on fresh store', () => {
    const output = JSON.parse(run('packs list'))
    expect(output.packs).toBeInstanceOf(Array)
    expect(output.count).toBe(0)
  })

  it('packs list returns count field', () => {
    const output = JSON.parse(run('packs list'))
    expect(typeof output.count).toBe('number')
  })

  it('packs without subcommand defaults to list', () => {
    const output = JSON.parse(run('packs'))
    expect(output.packs).toBeInstanceOf(Array)
    expect(output.count).toBeGreaterThanOrEqual(0)
  })

  it('packs install adds a pack', () => {
    // Create a minimal pack directory with valid engrams
    const packDir = mkdtempSync(join(tmpdir(), 'test-pack-'))
    try {
      writeFileSync(join(packDir, 'manifest.yaml'), 'name: test-pack\nversion: 1.0.0\n')
      // Write a valid engram YAML — loadEngrams expects { engrams: [...] }
      const engramYaml = [
        'engrams:',
        '  - id: ENG-0001',
        '    version: 2',
        '    status: active',
        '    consolidated: false',
        '    type: behavioral',
        '    scope: global',
        '    visibility: public',
        '    statement: test engram from pack',
        '    activation:',
        '      retrieval_strength: 0.7',
        '      storage_strength: 1.0',
        '      frequency: 0',
        '      last_accessed: "2024-01-01"',
        '    feedback_signals:',
        '      positive: 0',
        '      negative: 0',
        '      neutral: 0',
        '    knowledge_anchors: []',
        '    associations: []',
        '    derivation_count: 1',
        '    tags: []',
        '    pack: null',
        '    abstract: null',
        '    derived_from: null',
        '    polarity: null',
      ].join('\n')
      writeFileSync(join(packDir, 'engrams.yaml'), engramYaml)
      const output = JSON.parse(run(`packs install ${packDir}`))
      expect(output.installed).toBe(1)
      expect(output.name).toBeDefined()
    } finally {
      rmSync(packDir, { recursive: true })
    }
  })

  it('packs install exits 1 with no source', () => {
    expect(() => run('packs install')).toThrow()
  })

  it('invalid subcommand exits 1', () => {
    expect(() => run('packs badcmd')).toThrow()
  })
})

/**
 * The text surface, in-process (review of #1044).
 *
 * A piped stdout makes shouldOutputJson auto-select JSON, so what a person at
 * a terminal reads cannot be exercised through the spawned CLI. Same pattern
 * as quiet.test.ts: explicit `json: false` and a spied stdout.
 *
 * Invariants: the preview says HOW a licence was arrived at (profile §8.4),
 * install reports what it neutralized per field (§5.6.5), and a pack that
 * declares a private engram is refused with the ids named (§5.6.1 step 2).
 */
describe('plur packs — text surface', () => {
  let dir: string
  let out: string[]
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-cli-packs-text-'))
    out = []
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { out.push(String(chunk)); return true }) as never)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never)
  })
  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  })
  const stdout = () => out.join('')

  /** A pack directory with a SKILL.md manifest and the given engrams. */
  function writePack(
    name: string,
    engrams: Array<Record<string, unknown>>,
    opts: { provenance?: Record<string, string> } = {},
  ): string {
    const packDir = join(dir, `pack-${name}`)
    mkdirSync(packDir)
    const metadata = opts.provenance ? '\nmetadata:\n  provenance: true' : ''
    writeFileSync(join(packDir, 'SKILL.md'), `---\nname: ${name}\nversion: "1.0.0"${metadata}\n---\n\n# ${name}\n`)
    const lines = ['engrams:']
    for (const e of engrams) {
      let first = true
      for (const [k, v] of Object.entries(e)) {
        lines.push(`${first ? '  - ' : '    '}${k}: ${typeof v === 'string' ? JSON.stringify(v) : String(v)}`)
        first = false
      }
      lines.push('    activation:', '      retrieval_strength: 0.7', '      storage_strength: 1.0', '      frequency: 0', '      last_accessed: "2026-01-01"')
    }
    writeFileSync(join(packDir, 'engrams.yaml'), lines.join('\n') + '\n')
    if (opts.provenance) {
      mkdirSync(join(packDir, 'provenance'))
      for (const [file, body] of Object.entries(opts.provenance)) writeFileSync(join(packDir, 'provenance', file), body)
    }
    return packDir
  }
  const engram = (id: string, extra: Record<string, unknown> = {}) => ({
    id, statement: `rule ${id}`, type: 'behavioral', scope: 'global', status: 'active', version: 2, visibility: 'public', ...extra,
  })
  const record = (id: string, fields: Record<string, unknown>) => JSON.stringify({
    '@graph': [{ '@id': `engram:${id}`, '@type': ['prov:Entity', 'engram:Engram'], ...fields }],
  })
  const packs = async (args: string[], json = false) => {
    const { run } = await import('../src/commands/packs.js')
    await run(args, { path: dir, json })
  }

  it('preview says HOW each licence was arrived at, not only whether somebody chose it', async () => {
    // The four-state field exists so "the author configured this once" and
    // "nobody ever chose it" read differently. The preview printed only
    // `chosen`, so both collapsed into one suffix on the surface a person runs.
    const packDir = writePack('licsrc', [engram('ENG-2026-0101-001'), engram('ENG-2026-0101-002'), engram('ENG-2026-0101-003')], {
      provenance: {
        'ENG-2026-0101-001.jsonld': record('ENG-2026-0101-001', { 'engram:license': 'cc-by-4.0', 'engram:licenseSource': 'configuredDefault' }),
        'ENG-2026-0101-002.jsonld': record('ENG-2026-0101-002', { 'engram:license': 'cc-by-4.0', 'engram:licenseSource': 'inheritedFromPack', 'engram:licenseIsDefault': true }),
        'ENG-2026-0101-003.jsonld': record('ENG-2026-0101-003', { 'engram:license': 'cc-by-sa-4.0', 'engram:licenseSource': 'schemaDefault', 'engram:licenseIsDefault': true }),
      },
    })
    await packs(['preview', packDir])
    const text = stdout()
    expect(text).toMatch(/Licence\s+cc-by-4\.0 — 2 engram\(s\)\n\s+how: the author's configured default, chosen once in advance; inherited from the pack, not chosen for the engram/)
    expect(text).toMatch(/Licence\s+cc-by-sa-4\.0 — 1 engram\(s\) \(nobody chose this; it is the default\)\n\s+how: the schema default nobody chose/)

    // The JSON surface carries the closed-enum values themselves.
    out.length = 0
    await packs(['preview', packDir], true)
    const json = JSON.parse(stdout())
    const lic = json.provenance.licences.find((l: { name: string }) => l.name === 'cc-by-4.0')
    expect(lic.sources).toEqual(['configuredDefault', 'inheritedFromPack'])
  })

  it('preview prints no "how" line for a record written before the four-state field existed', async () => {
    const packDir = writePack('oldrec', [engram('ENG-2026-0101-001')], {
      provenance: { 'ENG-2026-0101-001.jsonld': record('ENG-2026-0101-001', { 'engram:license': 'cc-by-4.0', 'engram:licenseIsDefault': true }) },
    })
    await packs(['preview', packDir])
    expect(stdout()).toMatch(/Licence\s+cc-by-4\.0 — 1 engram\(s\) \(nobody chose this; it is the default\)/)
    expect(stdout()).not.toMatch(/how:/)
  })

  it('preview never prints a licence source the closed set does not contain', async () => {
    const packDir = writePack('badsrc', [engram('ENG-2026-0101-001')], {
      provenance: { 'ENG-2026-0101-001.jsonld': record('ENG-2026-0101-001', { 'engram:license': 'cc-by-4.0', 'engram:licenseSource': 'pilfered-elsewhere', 'engram:licenseIsDefault': true }) },
    })
    await packs(['preview', packDir])
    expect(stdout()).not.toMatch(/pilfered/)
    expect(stdout()).toMatch(/Licence\s+cc-by-4\.0 — 1 engram\(s\) \(nobody chose this; it is the default\)/)
    expect(stdout()).not.toMatch(/how:/)
    expect(stdout()).toMatch(/licenseSource value this reader does not recognise/)
  })

  it('install reports what it neutralized, per field, on the text surface and in JSON', async () => {
    const packDir = writePack('hostile', [
      engram('ENG-2026-0101-001', { pinned: true }),
      engram('ENG-2026-0101-002', { commitment: 'locked' }),
      engram('ENG-2026-0101-003'),
    ])
    await packs(['install', packDir])
    const text = stdout()
    expect(text).toMatch(/Neutralized on import/)
    expect(text).toMatch(/pinned removed from 1 engram\(s\)/)
    expect(text).toMatch(/commitment: locked downgraded to decided on 1 engram\(s\)/)

    const packDir2 = writePack('hostile2', [engram('ENG-2026-0101-001', { pinned: true, commitment: 'locked' })])
    out.length = 0
    await packs(['install', packDir2], true)
    const json = JSON.parse(stdout())
    expect(json.neutralized).toEqual({ pinned_stripped: 1, locked_downgraded: 1 })
    expect(json.integrity_check.status).toBe('absent')
  })

  it('install stays loud about neutralization under --quiet, and silent when there was none', async () => {
    const { run } = await import('../src/commands/packs.js')
    const hostile = writePack('hostileq', [engram('ENG-2026-0101-001', { pinned: true })])
    await run(['install', hostile], { path: dir, json: false, quiet: true })
    expect(stdout()).toMatch(/Neutralized on import/)
    out.length = 0
    const clean = writePack('clean', [engram('ENG-2026-0101-001')])
    await packs(['install', clean])
    expect(stdout()).not.toMatch(/Neutralized/)
  })

  it('install refuses a pack that declares a private engram, names it, and installs nothing', async () => {
    const packDir = writePack('leak', [engram('ENG-2026-0101-001'), engram('ENG-2026-0101-002', { visibility: 'private' })])
    await expect(packs(['install', packDir])).rejects.toThrow(/declare visibility: private[\s\S]*ENG-2026-0101-002/)
    out.length = 0
    await packs(['list'], true)
    expect(JSON.parse(stdout()).count).toBe(0)
  })
})
