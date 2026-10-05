import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join, delimiter } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'

const CLI = builtCliPath(join(__dirname, '..'))
describe.skipIf(process.platform === 'win32')('Unix Codex PATH precedence (#1604)', () => {
  it.each(['leading', 'interior'])('honours a %s empty PATH component before another Codex', (position) => {
    const home = mkdtempSync(join(tmpdir(), 'plur-unix-codex-'))
    try {
      const cwd = join(home, 'project'), later = join(home, 'later'), empty = join(home, 'empty')
      for (const d of [cwd, later, empty]) mkdirSync(d)
      const log = join(home, 'calls.log')
      for (const [dir, label] of [[cwd, 'current'], [later, 'later']]) {
        writeFileSync(join(dir, 'codex'), `#!/bin/sh\necho '${label}' >> "$CODEX_TEST_LOG"\nexit 0\n`, { mode: 0o755 })
      }
      const dirs = position === 'leading' ? ['', later] : [empty, '', later]
      const result = spawnSync(process.execPath, [CLI, 'init', '--codex', '--no-prompt',
        '--no-desktop', '--no-opencode', '--no-cursor', '--no-antigravity'], {
        cwd, encoding: 'utf8', timeout: 45000,
        env: { ...isolatedHomeEnv(home), CODEX_TEST_LOG: log, PLUR_DISABLE_EMBEDDINGS: '1', PATH: [...dirs, process.env.PATH ?? ''].join(delimiter) },
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('MCP server: registered via `codex mcp add`')
      expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['current', 'current'])
    } finally { rmSync(home, { recursive: true, force: true }) }
  }, 60000)
})
