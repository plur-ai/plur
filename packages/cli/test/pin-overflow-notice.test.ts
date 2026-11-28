/**
 * Session-start pin lines in the Claude Code hook (overhaul D2, D3):
 *  - a pin over its share is never dropped invisibly: one line, from the same
 *    fit report `plur pins` prints, so the hook and the CLI agree;
 *  - pin requests waiting for the owner: one line.
 * Each appears only when non-empty.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur, formatPinOverflowLine } from '@plur-ai/core'
import { sessionStartPinLines } from '../src/commands/hook-inject.js'
import { runCli } from './helpers/spawn.js'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))

describe('sessionStartPinLines', () => {
  let dir: string
  const store = (actor?: 'owner' | 'agent') => new Plur({ path: join(dir, '.plur'), autoDiscover: false, ...(actor ? { actor } : {}) })
  const config = (extra: string) => writeFileSync(join(dir, '.plur', 'config.yaml'),
    `embeddings:\n  enabled: false\nindex: false\npinning:\n  agents: request\n${extra}`)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-pin-lines-'))
    mkdirSync(join(dir, '.plur'))
    config('')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('is empty when every pin fits and nothing is waiting', async () => {
    await store('owner').learn('Always answer in plain language', { pinned: true })
    expect(await sessionStartPinLines(store())).toEqual([])
  })

  it('one overflow line, the same text plur pins prints, when pins overflow the share', async () => {
    config('injection_budget: 120\n')
    const owner = store('owner')
    for (let i = 0; i < 6; i++) {
      await owner.learn(`Pinned rule number ${i}: always describe the deployment target, the rollback path and the owner before any release step`, { pinned: true })
    }
    const plur = store()
    const lines = await sessionStartPinLines(plur)
    const expected = formatPinOverflowLine(await plur.pinFitReport())
    expect(expected).not.toBe('')
    expect(lines).toEqual([`[PLUR] ${expected}`])
  })

  it('one line for pending pin requests', async () => {
    await store('agent').learn('Never force-push shared branches', { pinned: true })
    await store('agent').learn('Never rotate credentials unasked', { pinned: true })
    const lines = await sessionStartPinLines(store())
    expect(lines).toHaveLength(1)
    expect(lines[0]).toBe('[PLUR] 2 pin requests waiting for the owner — review with `plur pin review`.')
  })

  it('an advisory failure leaves the line out, never throws', async () => {
    const broken = { pinFitReport: async () => { throw new Error('x') }, pendingPinRequests: async () => { throw new Error('y') } }
    expect(await sessionStartPinLines(broken as never)).toEqual([])
  })
})

describe('hook-inject session start carries the pin lines (end to end)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-pin-lines-hook-'))
    mkdirSync(join(dir, '.plur'))
    mkdirSync(join(dir, 'tmp'))
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const firstPrompt = () => {
    const r = runCli('node', [CLI, 'hook-inject'], {
      input: JSON.stringify({ cwd: dir, session_id: 'S1', hook_event_name: 'UserPromptSubmit', prompt: 'deployment rollback release step owner' }),
      encoding: 'utf-8', timeout: 30_000, cwd: dir,
      env: { ...process.env, HOME: dir, USERPROFILE: dir, TMPDIR: join(dir, 'tmp'), PLUR_PATH: join(dir, '.plur'), PLUR_DISABLE_EMBEDDINGS: '1' },
    })
    expect(r.status).toBe(0)
    return (JSON.parse((r.stdout ?? '').trim()) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext
  }

  it('prints the overflow line and the pending-requests line once each', async () => {
    writeFileSync(join(dir, '.plur', 'config.yaml'), 'embeddings:\n  enabled: false\nindex: false\ninjection_budget: 120\npinning:\n  agents: request\n')
    const owner = new Plur({ path: join(dir, '.plur'), autoDiscover: false, actor: 'owner' })
    for (let i = 0; i < 6; i++) {
      await owner.learn(`Pinned rule number ${i}: always describe the deployment target, the rollback path and the owner before any release step`, { pinned: true })
    }
    await new Plur({ path: join(dir, '.plur'), autoDiscover: false, actor: 'agent' }).learn('Never force-push shared branches', { pinned: true })
    const ctx = firstPrompt()
    const lines = ctx.split('\n')
    expect(lines.filter(l => l.includes('do not fit the pinned share'))).toHaveLength(1)
    expect(lines.filter(l => l.includes('pin request waiting for the owner'))).toHaveLength(1)
  }, 60_000)

  it('prints neither when pins fit and nothing waits', async () => {
    writeFileSync(join(dir, '.plur', 'config.yaml'), 'embeddings:\n  enabled: false\nindex: false\n')
    await new Plur({ path: join(dir, '.plur'), autoDiscover: false, actor: 'owner' }).learn('Always answer in plain language', { pinned: true })
    const ctx = firstPrompt()
    expect(ctx).not.toContain('pinned share')
    expect(ctx).not.toContain('pin request')
  }, 60_000)
})
