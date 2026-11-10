/**
 * Overhaul W7 + W10, CLI surface:
 *   plur rescope --plan [--out] | --apply <file> [--limit N] --yes | --undo <id>
 *   plur enrich  --plan [--out] | --apply <file> [--limit N] --yes | --undo <id>
 *   plur learn --body/--kind/--outcome
 *
 * Enrichment uses the command bridge (PLUR_LLM_CMD): a fake model script that
 * reads the prompt on stdin and prints labels.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync, spawnSync } from 'child_process'
import yaml from 'js-yaml'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'

const CLI = builtCliPath(join(__dirname, '..'))

describe('plur rescope --plan / --apply / --undo', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-cli-rescope-plan-'))
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      index: false,
      stores: [{ path: join(dir, 'eng.yaml'), scope: 'group:acme/engineering', covers: ['acme.engineering'] }],
    }))
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const run = (args: string, env: Record<string, string> = {}) =>
    spawnSync('sh', ['-c', `node ${CLI} ${args} --path ${dir}`], { encoding: 'utf-8', timeout: 30000, env: { ...isolatedHomeEnv(join(dir, 'home')), ...env } })
  const learn = (statement: string, extra: string) =>
    JSON.parse(execSync(`node ${CLI} learn "${statement}" ${extra} --path ${dir} --json`, { encoding: 'utf-8', timeout: 15000, env: isolatedHomeEnv(join(dir, 'home')) })).id as string
  const scopeOf = (id: string) => (yaml.load(readFileSync(join(dir, 'engrams.yaml'), 'utf8')) as any).engrams.find((e: any) => e.id === id).scope

  it('plans, previews without --yes, applies one, and undoes it', () => {
    const a = learn('Run the integration suite before tagging', '--scope global --domain acme.engineering.ci')
    const b = learn('Pin the toolchain version in CI', '--scope global --domain acme.engineering.ci')
    const c = learn('Prefer short sentences in replies', '--scope global --domain personal.style')
    const planFile = join(dir, 'plan.json')

    const p = run(`rescope --plan --out ${planFile}`)
    expect(p.status, p.stderr).toBe(0)
    // Not a TTY, so the summary is JSON.
    expect(JSON.parse(p.stdout)).toMatchObject({ out: planFile, placed: 2, unmapped: 1 })
    const plan = JSON.parse(readFileSync(planFile, 'utf8'))
    expect(plan.items.map((i: any) => i.id).sort()).toEqual([a, b].sort())
    expect(plan.unmapped.ids).toEqual([c])

    const preview = run(`rescope --apply ${planFile} --limit 1`)
    expect(preview.status).toBe(1)
    expect(preview.stdout).toContain('Nothing changed')
    expect(scopeOf(a)).toBe('global')

    const applied = run(`rescope --apply ${planFile} --limit 1 --yes --json`)
    expect(applied.status, applied.stderr).toBe(0)
    const out = JSON.parse(applied.stdout)
    expect(out.applied).toHaveLength(1)
    expect(scopeOf(out.applied[0].id)).toBe('group:acme/engineering')

    const undone = run(`rescope --undo ${out.change_id}`)
    expect(undone.status, undone.stderr).toBe(0)
    expect(scopeOf(a)).toBe('global')
    expect(scopeOf(b)).toBe('global')
  })

  it('refuses to undo a change of another kind', () => {
    const id = learn('Something to enrich', '--scope global')
    expect(id).toBeTruthy()
    const r = run('rescope --undo CHG-20260101T000000Z-deadbeef')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('No change')
  })
})

describe('plur enrich --plan / --apply / --undo (command bridge)', () => {
  let dir: string
  let fake: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-cli-enrich-'))
    fake = join(dir, 'fake-model.cjs')
    writeFileSync(fake, `
let s = ''
process.stdin.on('data', d => s += d)
process.stdin.on('end', () => {
  const items = JSON.parse(s.slice(s.indexOf('Items:') + 6))
  console.log(JSON.stringify(items.map(i => ({ id: i.id, kind: /failed/.test(i.text) ? 'failure_lesson' : 'rule', task_family: 'code', outcome: /failed/.test(i.text) ? 'failure' : 'none', applies_when: 'when deploying' }))))
})
`)
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const run = (args: string, env: Record<string, string> = {}) =>
    spawnSync('sh', ['-c', `node ${CLI} ${args} --path ${dir}`], { encoding: 'utf-8', timeout: 30000, env: { ...isolatedHomeEnv(join(dir, 'home')), ...env } })
  const rows = () => (yaml.load(readFileSync(join(dir, 'engrams.yaml'), 'utf8')) as any).engrams as any[]

  it('labels through PLUR_LLM_CMD, applies, is idempotent, and undoes exactly', () => {
    execSync(`node ${CLI} learn "Always tag releases" --scope global --path ${dir}`, { timeout: 15000, env: isolatedHomeEnv(join(dir, 'home')) })
    execSync(`node ${CLI} learn "The deploy failed because the cache was warm" --scope global --path ${dir}`, { timeout: 15000, env: isolatedHomeEnv(join(dir, 'home')) })
    const planFile = join(dir, 'enrich.json')
    const env = { PLUR_LLM_CMD: `node ${fake}`, PLUR_LLM_MODEL: 'fake-model' }

    const p = run(`enrich --plan --out ${planFile}`, env)
    expect(p.status, p.stderr).toBe(0)
    expect(p.stderr).toContain('fake-model via PLUR_LLM_CMD')
    const plan = JSON.parse(readFileSync(planFile, 'utf8'))
    expect(plan.items).toHaveLength(2)
    expect(plan.enricher.model).toBe('fake-model')

    const before = readFileSync(join(dir, 'engrams.yaml'), 'utf8')
    const statements = rows().map(r => [r.id, r.statement, r.content_hash])
    const a = run(`enrich --apply ${planFile} --yes --json`)
    expect(a.status, a.stderr).toBe(0)
    const out = JSON.parse(a.stdout)
    expect(out.applied).toHaveLength(2)
    for (const r of rows()) expect(r.structured_data.enrichment.enricher.model).toBe('fake-model')
    expect(rows().map(r => [r.id, r.statement, r.content_hash])).toEqual(statements)
    expect(rows().find(r => r.statement.includes('failed')).knowledge_type.memory_class).toBe('episodic')

    const after = readFileSync(join(dir, 'engrams.yaml'), 'utf8')
    const again = run(`enrich --apply ${planFile} --yes --json`)
    expect(JSON.parse(again.stdout).change_id).toBeNull()
    expect(readFileSync(join(dir, 'engrams.yaml'), 'utf8')).toBe(after)

    const u = run(`enrich --undo ${out.change_id}`)
    expect(u.status, u.stderr).toBe(0)
    const restored = rows()
    expect(restored.every(r => !r.structured_data?.enrichment)).toBe(true)
    // Undo restores the before-snapshots; the file content matches what it was.
    expect(yaml.load(readFileSync(join(dir, 'engrams.yaml'), 'utf8'))).toEqual(yaml.load(before))
  })

  it('--plan without a model says how to supply one', () => {
    const r = run('enrich --plan', { PLUR_LLM_CMD: '', OPENROUTER_API_KEY: '', OPENAI_API_KEY: '' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('PLUR_LLM_CMD')
  })
})

describe('plur learn --body / --kind / --outcome', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-cli-learn-body-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('stores the structured form and recall finds a body-only term', () => {
    const out = JSON.parse(execSync(
      `node ${CLI} learn "Restart the worker after config edits" --scope global --kind rule --body "When: editing quasargrid settings." --path ${dir} --json`,
      { encoding: 'utf-8', timeout: 15000, env: isolatedHomeEnv(join(dir, 'home')) },
    ))
    const row = (yaml.load(readFileSync(join(dir, 'engrams.yaml'), 'utf8')) as any).engrams.find((e: any) => e.id === out.id)
    expect(row.structured_data).toMatchObject({ kind: 'rule', body: 'When: editing quasargrid settings.' })
    const hits = JSON.parse(execSync(`node ${CLI} recall quasargrid --path ${dir} --json`, { encoding: 'utf-8', timeout: 15000, env: isolatedHomeEnv(join(dir, 'home')) }))
    expect(JSON.stringify(hits)).toContain(out.id)
  })

  it('refuses an unknown --kind', () => {
    const r = spawnSync('sh', ['-c', `node ${CLI} learn "x y z" --kind opinion --path ${dir}`], { encoding: 'utf-8', timeout: 15000, env: isolatedHomeEnv(join(dir, 'home')) })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('--kind')
  })
})
