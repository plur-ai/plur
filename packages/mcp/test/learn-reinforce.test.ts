/**
 * Write-time inflow through MCP (overhaul D8): plur_learn and
 * plur_learn_batch reinforce on an exact normalised restatement by default
 * (MCP_REINFORCE_EXACT_DEFAULT), unless config.yaml says otherwise.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '@plur-ai/core'
import { getToolDefinitions, _resetSessionTelemetry, MCP_REINFORCE_EXACT_DEFAULT } from '../src/tools.js'

describe('MCP learn: REINFORCE on an exact restatement (D8)', () => {
  let dir: string
  let plur: Plur
  const tools = getToolDefinitions('full')
  const call = async (name: string, args: Record<string, unknown>) =>
    tools.find(t => t.name === name)!.handler(args, plur) as Promise<any>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-mcp-reinforce-'))
    writeFileSync(join(dir, 'config.yaml'), 'backend: yaml\nembeddings:\n  enabled: false\n')
    plur = new Plur({ path: dir, autoDiscover: false })
    _resetSessionTelemetry()
  })
  afterEach(() => {
    _resetSessionTelemetry()
    rmSync(dir, { recursive: true, force: true })
  })

  it('is on by default in MCP (one constant)', () => {
    expect(MCP_REINFORCE_EXACT_DEFAULT).toBe(true)
  })

  it('plur_learn reports REINFORCE with the existing id and the swallowed text', async () => {
    const first = await call('plur_learn', { statement: 'Use pnpm, not npm, in this repository', scope: 'global' })
    expect(first.decision).toBe('ADD')
    const again = await call('plur_learn', { statement: 'use pnpm not npm in this repository.', scope: 'global' })
    expect(again.decision).toBe('REINFORCE')
    expect(again.existing_id).toBe(first.id)
    expect(again.reinforced).toEqual({ existing_statement: 'Use pnpm, not npm, in this repository', swallowed: 'use pnpm not npm in this repository.' })
    expect((await plur.getById(first.id))!.feedback_signals.positive).toBe(1)
  })

  it('a correction is written, not reinforced', async () => {
    await call('plur_learn', { statement: 'Use pnpm, not npm', scope: 'global' })
    const r = await call('plur_learn', { statement: 'Use npm', scope: 'global' })
    expect(r.decision).toBe('ADD')
  })

  it('config.yaml learn.reinforce_exact: false turns it off', async () => {
    writeFileSync(join(dir, 'config.yaml'), 'backend: yaml\nembeddings:\n  enabled: false\nlearn:\n  reinforce_exact: false\n')
    plur = new Plur({ path: dir, autoDiscover: false })
    const first = await call('plur_learn', { statement: 'Tag every release', scope: 'global' })
    const again = await call('plur_learn', { statement: 'tag every release', scope: 'global' })
    expect(again.decision).toBe('NOOP')
    expect(again.existing_id).toBe(first.id)
  })

  it('plur_learn_batch reports REINFORCE and counts it', async () => {
    const first = await call('plur_learn', { statement: 'Keep pull requests small', scope: 'global' })
    const b = await call('plur_learn_batch', { engrams: [{ statement: 'keep pull requests small!', scope: 'global' }] })
    expect(b.results[0].decision).toBe('REINFORCE')
    expect(b.results[0].existing_id ?? b.results[0].id).toBe(first.id)
    expect(b.stats.reinforced).toBe(1)
  })
})
