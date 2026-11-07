/**
 * Security audit 2026-11-06 (hardening): readCodexHooksConfig flattened an
 * unparseable or non-object hooks.json to `{ hooks: {} }`, a value that any
 * caller writing it back would use to destroy the user's file; only
 * installCodex's own pre-check stood in the way. It now throws, a missing
 * file still reads as empty, and `plur init --codex` still refuses to touch a
 * malformed file. Spawned CLI with HOME and CODEX_HOME in a temp directory and
 * a stub `codex` on PATH.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join, delimiter } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { readCodexHooksConfig } from '../src/codex-hooks.js'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'

const CLI = builtCliPath(join(__dirname, '..'))
const BAD = ['{ not json', '12345', '"text"', '[1,2]', 'null']

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'plur-codex-read-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

describe('readCodexHooksConfig', () => {
  it.each(BAD)('throws on %j instead of reading it as empty', (bad) => {
    const path = join(home, 'hooks.json')
    writeFileSync(path, bad)
    expect(() => readCodexHooksConfig(path)).toThrow(/hooks\.json/)
  })

  it('a missing file reads as empty; an object without hooks gets an empty map', () => {
    expect(readCodexHooksConfig(join(home, 'absent.json'))).toEqual({ hooks: {} })
    const path = join(home, 'hooks.json')
    writeFileSync(path, JSON.stringify({ description: 'mine' }))
    expect(readCodexHooksConfig(path)).toEqual({ description: 'mine', hooks: {} })
  })
})

describe.skipIf(process.platform === 'win32')('plur init --codex still refuses a malformed hooks.json', () => {
  it.each(['{ not json', '[1,2]'])('leaves %j untouched and says so', (bad) => {
    const bin = join(home, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const codexHome = join(home, '.codex')
    mkdirSync(codexHome)
    writeFileSync(join(codexHome, 'hooks.json'), bad)
    const r = spawnSync(process.execPath, [CLI, 'init', '--codex', '--no-prompt',
      '--no-desktop', '--no-opencode', '--no-cursor', '--no-antigravity'], {
      cwd: home, encoding: 'utf8', timeout: 45000,
      env: { ...isolatedHomeEnv(home), PLUR_DISABLE_EMBEDDINGS: '1', PATH: [bin, process.env.PATH ?? ''].join(delimiter) },
    })
    expect(r.error).toBeUndefined()
    expect(r.stdout).toMatch(/hooks skipped — .*hooks\.json exists but is not a JSON object/)
    expect(readFileSync(join(codexHome, 'hooks.json'), 'utf8')).toBe(bad)
  }, 60000)
})
