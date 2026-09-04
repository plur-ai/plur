import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  buildCodexHooks,
  readCodexHooksConfig,
  writeCodexHooksConfig,
  mergeCodexHooks,
  hasPlurCodexHooks,
  type CodexHooksConfig,
} from '../src/codex-hooks.js'

const SHIM = '/home/u/.plur/bin/plur-hook'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-codex-hooks-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('buildCodexHooks', () => {
  it('covers the five events the adapter needs', () => {
    const hooks = buildCodexHooks(SHIM)
    expect(Object.keys(hooks).sort()).toEqual([
      'PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'UserPromptSubmit',
    ])
  })

  it('emits Claude Code’s nested {matcher, hooks:[]} shape', () => {
    const hooks = buildCodexHooks(SHIM)
    for (const entries of Object.values(hooks)) {
      expect(Array.isArray(entries)).toBe(true)
      for (const entry of entries) {
        expect(Array.isArray(entry.hooks)).toBe(true)
        for (const spec of entry.hooks) {
          expect(spec.type).toBe('command')
          expect(spec.command).toContain(SHIM)
        }
      }
    }
  })

  // THE regression test for this adapter. Codex supports `async: true` as of
  // 0.149.1, but an async hook's additionalContext is delivered at the "next
  // safe point" rather than to the turn that triggered it — so in `codex exec`
  // it is dropped entirely, and interactively memory runs a turn behind.
  // Claude Code's buildInjectionHooks() DOES use async (correctly, for its own
  // harness); anyone porting more of that map across must not bring the flag.
  it('never marks a hook async', () => {
    const hooks = buildCodexHooks(SHIM)
    const specs = Object.values(hooks).flatMap(e => e.flatMap(x => x.hooks))
    expect(specs.length).toBeGreaterThan(0)
    for (const spec of specs) {
      expect(spec).not.toHaveProperty('async')
    }
  })

  it('keeps SessionEnd inside the 3s ceiling Codex clamps to', () => {
    const spec = buildCodexHooks(SHIM).SessionEnd[0].hooks[0]
    expect(spec.timeout).toBeLessThanOrEqual(3)
  })

  it('gives tool events a matcher and lifecycle events none', () => {
    const hooks = buildCodexHooks(SHIM)
    expect(hooks.PreToolUse[0].matcher).toBe('.*')
    expect(hooks.PostToolUse[0].matcher).toBe('.*')
    expect(hooks.SessionStart[0].matcher).toBeUndefined()
    expect(hooks.UserPromptSubmit[0].matcher).toBeUndefined()
  })
})

describe('mergeCodexHooks', () => {
  it('is idempotent — re-running init does not duplicate entries', () => {
    const once = mergeCodexHooks({ hooks: {} }, buildCodexHooks(SHIM))
    const twice = mergeCodexHooks(once, buildCodexHooks(SHIM))
    expect(twice).toEqual(once)
  })

  it('replaces stale PLUR entries on upgrade rather than stacking them', () => {
    const old = mergeCodexHooks({ hooks: {} }, buildCodexHooks('/old/path/plur-hook'))
    const upgraded = mergeCodexHooks(old, buildCodexHooks(SHIM))
    const commands = upgraded.hooks.SessionStart.flatMap(e => e.hooks.map(h => h.command))
    expect(commands).toHaveLength(1)
    expect(commands[0]).toContain(SHIM)
  })

  it('preserves a user’s own hooks in the same event array', () => {
    const mine: CodexHooksConfig = {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: './scripts/my-banner.sh' }] }],
      },
    }
    const merged = mergeCodexHooks(mine, buildCodexHooks(SHIM))
    const commands = merged.hooks.SessionStart.flatMap(e => e.hooks.map(h => h.command))
    expect(commands).toContain('./scripts/my-banner.sh')
    expect(commands.some(c => c.includes('hook-codex-session-start'))).toBe(true)
  })

  it('preserves foreign specs inside an entry that also holds a PLUR spec', () => {
    const mixed: CodexHooksConfig = {
      hooks: {
        PreToolUse: [{
          matcher: '.*',
          hooks: [
            { type: 'command', command: `${SHIM} hook-codex-guard` },
            { type: 'command', command: './scripts/audit.sh' },
          ],
        }],
      },
    }
    const merged = mergeCodexHooks(mixed, buildCodexHooks(SHIM))
    const commands = merged.hooks.PreToolUse.flatMap(e => e.hooks.map(h => h.command))
    expect(commands).toContain('./scripts/audit.sh')
    expect(commands.filter(c => c.includes('hook-codex-guard'))).toHaveLength(1)
  })

  // Same class of bug the Cursor adapter had to fix: matching a bare
  // `hook-codex-` substring would claim a user's own script and delete it.
  it('does not claim a foreign script whose name merely contains hook-codex-', () => {
    const mine: CodexHooksConfig = {
      hooks: {
        PreToolUse: [{ hooks: [{ type: 'command', command: './scripts/hook-codex-lint.sh' }] }],
      },
    }
    expect(hasPlurCodexHooks(mine)).toBe(false)
    const merged = mergeCodexHooks(mine, buildCodexHooks(SHIM))
    const commands = merged.hooks.PreToolUse.flatMap(e => e.hooks.map(h => h.command))
    expect(commands).toContain('./scripts/hook-codex-lint.sh')
  })

  it('does not claim a PLUR-binary invocation of a non-PLUR subcommand', () => {
    const mine: CodexHooksConfig = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: `${SHIM} some-other-thing` }] }] },
    }
    expect(hasPlurCodexHooks(mine)).toBe(false)
  })

  it('recognises the npx fallback form as PLUR-owned', () => {
    const npx: CodexHooksConfig = {
      hooks: {
        SessionStart: [{
          hooks: [{ type: 'command', command: 'npx @plur-ai/cli hook-codex-session-start' }],
        }],
      },
    }
    expect(hasPlurCodexHooks(npx)).toBe(true)
  })
})

describe('read/write round trip', () => {
  it('writes valid JSON that reads back identically', () => {
    const path = join(dir, 'hooks.json')
    const config = mergeCodexHooks({ hooks: {} }, buildCodexHooks(SHIM))
    writeCodexHooksConfig(path, config)
    expect(existsSync(path)).toBe(true)
    expect(() => JSON.parse(readFileSync(path, 'utf8'))).not.toThrow()
    expect(readCodexHooksConfig(path).hooks).toEqual(config.hooks)
  })

  it('adds a description so a human opening the file knows who owns it', () => {
    const path = join(dir, 'hooks.json')
    writeCodexHooksConfig(path, { hooks: buildCodexHooks(SHIM) })
    expect(JSON.parse(readFileSync(path, 'utf8')).description).toMatch(/PLUR/)
  })

  it('does not overwrite a description the user already set', () => {
    const path = join(dir, 'hooks.json')
    writeCodexHooksConfig(path, { description: 'mine', hooks: {} })
    expect(JSON.parse(readFileSync(path, 'utf8')).description).toBe('mine')
  })

  it('treats a malformed file as empty when READING (init refuses to write over it)', () => {
    const path = join(dir, 'hooks.json')
    writeFileSync(path, '{ not json')
    expect(readCodexHooksConfig(path)).toEqual({ hooks: {} })
  })

  it('reads a config with no hooks key without throwing', () => {
    const path = join(dir, 'hooks.json')
    writeFileSync(path, JSON.stringify({ description: 'empty' }))
    expect(readCodexHooksConfig(path).hooks).toEqual({})
  })
})
