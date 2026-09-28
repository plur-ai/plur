/**
 * Formal verification round 2 — applied on R2-CLI's behalf (findings/r2-cli.md
 * item 2): plur_session_end's checkpoint cleanup resolves the PLUR directory
 * like the CLI hooks do. An EMPTY `PLUR_PATH` means "unset" (`||`, not `??`);
 * with `??` the MCP side looked for checkpoints in `./sessions`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '@plur-ai/core'
import { getToolDefinitions, _resetSessionTelemetry } from '../src/tools.js'

describe('plur_session_end checkpoint cleanup with PLUR_PATH=""', () => {
  let home: string
  let store: string
  const saved = { HOME: process.env.HOME, PLUR_PATH: process.env.PLUR_PATH }
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plur-r2-cp-home-'))
    store = mkdtempSync(join(tmpdir(), 'plur-r2-cp-store-'))
    process.env.HOME = home
    process.env.PLUR_PATH = ''
    _resetSessionTelemetry()
  })
  afterEach(() => {
    process.env.HOME = saved.HOME
    if (saved.PLUR_PATH === undefined) delete process.env.PLUR_PATH
    else process.env.PLUR_PATH = saved.PLUR_PATH
    _resetSessionTelemetry()
    rmSync(home, { recursive: true, force: true })
    rmSync(store, { recursive: true, force: true })
  })

  it('removes the checkpoint under ~/.plur/sessions', async () => {
    const plur = new Plur({ path: store })
    const tools = getToolDefinitions('full')
    const call = async (n: string, a: Record<string, unknown>) => tools.find(t => t.name === n)!.handler(a, plur) as any
    const { session_id } = await call('plur_session_start', { task: 'checkpoint cleanup' })
    const dir = join(home, '.plur', 'sessions')
    mkdirSync(dir, { recursive: true })
    const cp = join(dir, `${String(session_id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)}.checkpoint.json`)
    writeFileSync(cp, '{}')
    await call('plur_session_end', { summary: 'done', session_id, engram_suggestions: [] })
    expect(existsSync(cp)).toBe(false)
  })
})
