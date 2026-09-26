/**
 * Formal-verification apply phase, decision E3 ("opencode rule everywhere"),
 * 2026-09-26.
 *
 * The MCP server adopts a `.plur.yaml` `scope`/`domain` only from a directory
 * the user trusted (`plur trust <dir>`), and otherwise ignores it and says so,
 * naming the file and the trust command — @plur-ai/opencode's rule. Replayed
 * before the fix (findings/adapters.md §9): a cloned repo's
 * `scope: group:acme/eng` became the session default and an unscoped
 * plur_learn landed there.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '@plur-ai/core'
import { getToolDefinitions, _resetSessionTelemetry } from '../src/tools.js'

describe('MCP .plur.yaml scope/domain needs directory trust (E3)', () => {
  let root: string
  let repo: string
  let plur: Plur
  let cwd: string

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = getToolDefinitions('full').find(t => t.name === name)!
    return await tool.handler(args, plur) as any
  }
  const scopeOf = async (statement: string) =>
    (await plur.list()).find(e => e.statement === statement)

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'plur-e3-mcp-')))
    repo = join(root, 'cloned-repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    writeFileSync(join(repo, '.plur.yaml'), 'scope: project:acme-app\ndomain: acme.eng\n')
    mkdirSync(join(root, 'store'))
    writeFileSync(join(root, 'store', 'config.yaml'), 'embeddings:\n  enabled: false\n')
    plur = new Plur({ path: join(root, 'store') })
    _resetSessionTelemetry()
    cwd = process.cwd()
    process.chdir(repo)
  })

  afterEach(() => {
    process.chdir(cwd)
    rmSync(root, { recursive: true, force: true })
  })

  it('untrusted: session_start ignores the scope and warns with the file and `plur trust`', async () => {
    const r = await call('plur_session_start', { task: 'work' })
    expect(r.default_scope).toBeUndefined()
    expect(r.default_domain).toBeUndefined()
    const warning = String(r.project_config_warning ?? '')
    expect(warning).toContain(join(repo, '.plur.yaml'))
    expect(warning).toContain(`plur trust ${repo}`)
    expect(String(r.guide)).toContain(`plur trust ${repo}`)
  })

  it('untrusted: an unscoped plur_learn neither takes the repo scope nor its domain', async () => {
    const { session_id } = await call('plur_session_start', { task: 'work' })
    await call('plur_learn', { statement: 'a personal note about my editor', session_id })
    const e = await scopeOf('a personal note about my editor')
    expect(e?.scope).not.toBe('project:acme-app')
    expect(e?.domain ?? null).not.toBe('acme.eng')
  })

  it('trusted: behaves as before (scope and domain adopted)', async () => {
    plur.trustDirectory(repo)
    const r = await call('plur_session_start', { task: 'work' })
    expect(r.default_scope).toBe('project:acme-app')
    expect(r.scope_source).toBe('project-config')
    expect(r.default_domain).toBe('acme.eng')
    expect(r.project_config_warning).toBeUndefined()
    await call('plur_learn', { statement: 'the deploy target is the eu cluster', session_id: r.session_id })
    const e = await scopeOf('the deploy target is the eu cluster')
    expect(e?.scope).toBe('project:acme-app')
    expect(e?.domain).toBe('acme.eng')
  })
})
