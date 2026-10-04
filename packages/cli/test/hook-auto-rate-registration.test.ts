/**
 * #1310 — `plur init` registers the auto-rate hook as its OWN end-of-turn
 * entry in every editor, beside (never inside) the existing hooks, and a
 * re-init replaces it rather than duplicating it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'
import { buildCodexHooks, mergeCodexHooks } from '../src/codex-hooks.js'
import { buildCursorHooks, mergeCursorHooks } from '../src/cursor-hooks.js'
import { buildAgyHookSet } from '../src/antigravity-hooks.js'

const CLI = builtCliPath(join(__dirname, '..'))
const CMD = '/home/u/.plur/bin/plur-hook'

describe('auto-rate hook registration (#1310)', () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'plur-auto-rate-init-')) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  function runInit(): void {
    execSync(`node ${CLI} init --global --no-desktop`, {
      encoding: 'utf-8', timeout: 15000, env: isolatedHomeEnv(home), cwd: home,
    })
  }

  it('Claude Code: a separate synchronous Stop entry next to hook-learn-check, once after re-init', () => {
    runInit()
    runInit()
    const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'))
    const stop = settings.hooks.Stop as Array<{ hooks: Array<{ command: string; async?: boolean; timeout?: number }> }>
    const auto = stop.filter(e => e.hooks.some(h => h.command.includes('hook-auto-rate claude')))
    expect(auto).toHaveLength(1)
    expect(auto[0].hooks).toHaveLength(1)
    // Sync: an async Stop hook is killed when a `claude -p` session exits.
    expect(auto[0].hooks[0].async).toBeUndefined()
    expect(auto[0].hooks[0].timeout).toBeLessThanOrEqual(10)
    // The learn nudge keeps its own entry and stays synchronous.
    const learn = stop.filter(e => e.hooks.some(h => h.command.includes('hook-learn-check')))
    expect(learn).toHaveLength(1)
    expect(learn[0].hooks.some(h => h.command.includes('hook-auto-rate'))).toBe(false)
  })

  it('Codex: a synchronous Stop entry, idempotent under merge', () => {
    const hooks = buildCodexHooks(CMD)
    expect(hooks.Stop?.[0]?.hooks[0]?.command).toBe(`${CMD} hook-auto-rate codex`)
    expect((hooks.Stop?.[0]?.hooks[0] as { async?: boolean }).async).toBeUndefined()
    const twice = mergeCodexHooks(mergeCodexHooks({ hooks: {} }, hooks), hooks)
    expect(twice.hooks.Stop).toHaveLength(1)
  })

  it('Cursor: an afterAgentResponse entry (stop carries no reply text), idempotent under merge', () => {
    const hooks = buildCursorHooks(CMD)
    expect(hooks.afterAgentResponse?.[0]?.command).toBe(`${CMD} hook-auto-rate cursor`)
    expect(hooks.afterAgentResponse?.[0]?.failClosed).toBe(false)
    const twice = mergeCursorHooks(mergeCursorHooks({ version: 1, hooks: {} }, hooks), hooks)
    expect(twice.hooks.afterAgentResponse).toHaveLength(1)
  })

  it('Antigravity: a Stop handler in the plur-memory set', () => {
    const set = buildAgyHookSet(CMD)
    expect(set.Stop?.[0]?.command).toBe(`${CMD} hook-auto-rate agy`)
  })
})
