import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'

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
})
