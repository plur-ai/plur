import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'
import { Plur } from '@plur-ai/core'

const CLI = join(__dirname, '..', 'dist', 'index.js')

describe('plur learn', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-cli-test-')) })
  afterEach(() => { rmSync(dir, { recursive: true }) })

  function run(args: string): string {
    return execSync(`node ${CLI} ${args} --path ${dir} --json`, {
      encoding: 'utf-8',
      timeout: 10000,
    }).trim()
  }

  it('creates an engram and returns JSON', () => {
    const output = JSON.parse(run('learn "test statement"'))
    expect(output.id).toMatch(/^ENG-/)
    expect(output.statement).toBe('test statement')
    // PR-1 (#353): an un-scoped CLI learn omits the scope key so it flows through
    // core's unscoped routing and lands at the default (global).
    expect(output.scope).toBe('global')
    expect(output.type).toBe('behavioral')
  })

  it('accepts --scope and --type flags', () => {
    const output = JSON.parse(run('learn "typed statement" --scope agent:test --type procedural'))
    expect(output.scope).toBe('agent:test')
    expect(output.type).toBe('procedural')
  })

  it('accepts --domain flag', () => {
    const output = JSON.parse(run('learn "domain statement" --domain software.testing'))
    expect(output.domain).toBe('software.testing')
  })

  it('reads from stdin when no positional arg', () => {
    const output = JSON.parse(
      execSync(`echo "stdin statement" | node ${CLI} learn --path ${dir} --json`, {
        encoding: 'utf-8',
        timeout: 10000,
      }).trim()
    )
    expect(output.statement).toBe('stdin statement')
  })

  it('exits 1 with no statement and no stdin', () => {
    expect(() => run('learn')).toThrow()
  })

  // --- PR-1 (#353): scope routing via learnRouted, no hardcoded global ---

  function writeCoversConfig(covers: string[]): void {
    const coversYaml = covers.map(c => `      - "${c}"`).join('\n')
    writeFileSync(join(dir, 'config.yaml'),
      `index: false\n` +
      `stores:\n` +
      `  - path: ${join(dir, 'core.yaml')}\n` +
      `    scope: "group:plur/core"\n` +
      `    description: "Core"\n` +
      `    covers:\n${coversYaml}\n`,
    )
  }

  it('CLI covers-present: an un-scoped learn routes to a covers-matched scope', () => {
    // CLI has no --tags flag, so reach the threshold with domain-prefix (1.0) +
    // several cover-keyword hits in the statement (each 0.2): raw ≈ 1.8 → conf > 0.5.
    writeCoversConfig(['plur.*', 'embeddings', 'index', 'engine', 'core'])
    const output = JSON.parse(run('learn "the embeddings index for the core engine" --domain plur.core.embeddings'))
    expect(output.scope).toBe('group:plur/core')
  })

  it('CLI no-covers: an un-scoped learn flows through unscoped routing and lands global', () => {
    writeCoversConfig(['plur.*'])
    // No covers match → falls to unscoped_default (global). Proves the scope key
    // was OMITTED (a hardcoded scope:'global' would have skipped routing, but the
    // landing scope is the same; the covers-present test above proves routing ran).
    const output = JSON.parse(run('learn "an unrelated note about lunch preferences"'))
    expect(output.scope).toBe('global')
  })

  it('CLI explicit: --scope is honored', () => {
    const output = JSON.parse(run('learn "explicit scope statement" --scope project:foo'))
    expect(output.scope).toBe('project:foo')
  })

  // --- LOW-10 (#353): surface a scope demotion instead of swallowing it ---

  it('LOW-10 JSON: a demoted shared-scope write reports demoted{from,to,patterns}', () => {
    // Explicit shared scope + a public IP → core demotes to local/private and
    // stamps _demoted. The CLI must surface it (was silent before PR-5).
    const output = JSON.parse(run('learn "deploy target is 139.59.155.82" --scope group:plur/core'))
    expect(output.scope).toBe('local')
    expect(output.demoted).toBeDefined()
    expect(output.demoted.from).toBe('group:plur/core')
    expect(output.demoted.to).toBe('local')
    expect(output.demoted.patterns).toMatch(/public_ipv4/)
    // requested_scope is present only because --scope was passed.
    expect(output.requested_scope).toBe('group:plur/core')
  })

  // Note: text-mode output cannot be exercised through execSync (stdout is
  // piped, so the CLI auto-selects JSON via shouldOutputJson). The text-mode
  // warning mirrors the JSON `demoted` field and the MCP display contract; the
  // JSON tests above/below pin the behavioral contract.

  it('LOW-10 JSON: a clean write has no demoted field (no false warning)', () => {
    const output = JSON.parse(run('learn "a perfectly clean note" --scope group:plur/core'))
    expect(output.scope).toBe('group:plur/core')
    expect(output.demoted).toBeUndefined()
    expect(output.requested_scope).toBeUndefined()
  })

  // --- #8: CLI must accept and forward the context fields Hermes sends ---
  // (was silently dropping --rationale/--tags/--visibility/--dual-coding/
  //  --abstract/--knowledge-anchors/--derived-from). Each test writes via the
  // CLI subprocess, then reads the persisted engram back through core's Plur
  // class against the same --path and asserts the field landed on the engram.

  /** Read the single engram persisted under `dir` back through core. */
  function readEngram() {
    const plur = new Plur({ path: dir })
    const engrams = plur.list({})
    expect(engrams.length).toBe(1)
    return engrams[0]
  }

  it('#8: --rationale reaches the engram', () => {
    run('learn "fly is the deploy host" --rationale "we standardized on fly.io"')
    expect(readEngram().rationale).toBe('we standardized on fly.io')
  })

  it('#8: --tags reaches the engram (comma-split, trimmed)', () => {
    run('learn "tagged note" --tags "deploy, ops ,infra"')
    expect(readEngram().tags).toEqual(['deploy', 'ops', 'infra'])
  })

  it('#8: --visibility reaches the engram', () => {
    run('learn "public note" --visibility public')
    expect(readEngram().visibility).toBe('public')
  })

  it('#8: --abstract reaches the engram', () => {
    run('learn "an instance note" --abstract "ABS-2026-0101-001"')
    expect(readEngram().abstract).toBe('ABS-2026-0101-001')
  })

  it('#8: --derived-from reaches the engram', () => {
    run('learn "a derived note" --derived-from "ENG-2026-0101-009"')
    expect(readEngram().derived_from).toBe('ENG-2026-0101-009')
  })

  it('#8: --knowledge-anchors (JSON) reaches the engram', () => {
    // relevance is a core enum (primary|supporting|example) — pass a valid one
    // so the round-tripped engram survives schema validation.
    run(`learn "anchored note" --knowledge-anchors '[{"path":"fly.toml","relevance":"primary"}]'`)
    const anchors = readEngram().knowledge_anchors
    expect(anchors).toHaveLength(1)
    expect(anchors[0].path).toBe('fly.toml')
    expect(anchors[0].relevance).toBe('primary')
  })

  it('#8: --dual-coding (JSON) reaches the engram', () => {
    run(`learn "dual-coded note" --dual-coding '{"example":"fly deploy","analogy":"like git push"}'`)
    const dc = readEngram().dual_coding
    expect(dc?.example).toBe('fly deploy')
    expect(dc?.analogy).toBe('like git push')
  })

  it('#8: all Hermes-sent fields reach the engram in one call', () => {
    run(
      `learn "kitchen sink note" --domain software.deployment --rationale "why" ` +
      `--tags "a,b" --visibility public --abstract "ABS-2026-0101-002" ` +
      `--derived-from "ENG-2026-0101-010" ` +
      `--knowledge-anchors '[{"path":"p.ts"}]' ` +
      `--dual-coding '{"example":"e","analogy":"a"}'`,
    )
    const e = readEngram()
    expect(e.rationale).toBe('why')
    expect(e.tags).toEqual(['a', 'b'])
    expect(e.visibility).toBe('public')
    expect(e.abstract).toBe('ABS-2026-0101-002')
    expect(e.derived_from).toBe('ENG-2026-0101-010')
    expect(e.knowledge_anchors[0].path).toBe('p.ts')
    expect(e.dual_coding?.example).toBe('e')
    expect(e.dual_coding?.analogy).toBe('a')
  })

  it('#8: malformed --dual-coding JSON exits 1 (loud, not silent drop)', () => {
    expect(() => run(`learn "bad json note" --dual-coding 'not json'`)).toThrow()
  })
})
