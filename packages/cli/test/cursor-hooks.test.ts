import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  buildCursorHooks,
  readCursorHooksConfig,
  writeCursorHooksConfig,
  mergeCursorHooks,
  hasPlurCursorHooks,
} from '../src/cursor-hooks.js'

describe('cursor-hooks', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-cursor-hooks-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('builds sessionStart/preToolUse/postToolUse/stop entries with the given command', () => {
    const hooks = buildCursorHooks('/home/u/.plur/bin/plur-hook')
    expect(hooks.sessionStart[0].command).toBe('/home/u/.plur/bin/plur-hook hook-cursor-session-start')
    expect(hooks.preToolUse[0].command).toBe('/home/u/.plur/bin/plur-hook hook-cursor-guard')
    expect(hooks.postToolUse[0].command).toBe('/home/u/.plur/bin/plur-hook hook-cursor-post-tool')
    expect(hooks.stop[0].command).toBe('/home/u/.plur/bin/plur-hook hook-cursor-stop')
  })

  // Audit fix (data evaluator): failClosed must be explicit, not left to an
  // unverified default.
  it('pins failClosed: false on every entry', () => {
    const hooks = buildCursorHooks('plur-hook')
    for (const entries of Object.values(hooks)) {
      for (const entry of entries) {
        expect(entry.failClosed).toBe(false)
      }
    }
  })

  it('reads a missing file as an empty v1 config', () => {
    const config = readCursorHooksConfig(join(dir, 'hooks.json'))
    expect(config).toEqual({ version: 1, hooks: {} })
  })

  it('write then read round-trips', () => {
    const path = join(dir, 'hooks.json')
    const merged = mergeCursorHooks({ version: 1, hooks: {} }, buildCursorHooks('plur-hook'))
    writeCursorHooksConfig(path, merged)
    expect(existsSync(path)).toBe(true)
    const reread = readCursorHooksConfig(path)
    expect(reread.hooks.sessionStart[0].command).toBe('plur-hook hook-cursor-session-start')
  })

  it('preserves a pre-existing non-plur hook when merging', () => {
    const existing = { version: 1, hooks: { afterFileEdit: [{ command: './my-lint.sh' }] } }
    const merged = mergeCursorHooks(existing, buildCursorHooks('plur-hook'))
    expect(merged.hooks.afterFileEdit).toEqual([{ command: './my-lint.sh' }])
    expect(merged.hooks.sessionStart[0].command).toContain('hook-cursor-session-start')
  })

  it('is idempotent — merging twice does not duplicate plur entries', () => {
    let config = mergeCursorHooks({ version: 1, hooks: {} }, buildCursorHooks('plur-hook'))
    config = mergeCursorHooks(config, buildCursorHooks('plur-hook'))
    expect(config.hooks.sessionStart.length).toBe(1)
  })

  it('hasPlurCursorHooks detects an installed plur hook', () => {
    const config = mergeCursorHooks({ version: 1, hooks: {} }, buildCursorHooks('.plur/bin/plur-hook'))
    expect(hasPlurCursorHooks(config)).toBe(true)
    expect(hasPlurCursorHooks({ version: 1, hooks: {} })).toBe(false)
  })
})
