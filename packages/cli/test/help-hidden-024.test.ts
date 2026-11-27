/**
 * 0.24 command surface (owner decisions 2026-11-26/27): `plur enrich` and
 * `plur consolidate` are not offered in the help. Their work moves into
 * `plur review` in the next release; until then they stay callable by name
 * for testing, unlisted, like the hook-* commands.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'

describe('0.24 help', () => {
  it('does not list enrich or consolidate', () => {
    const home = mkdtempSync(join(tmpdir(), 'plur-help-024-'))
    try {
      const r = spawnSync(process.execPath, [builtCliPath(join(__dirname, '..')), '--help'], { env: isolatedHomeEnv(home), encoding: 'utf8' })
      const help = r.stdout + r.stderr
      expect(help).toMatch(/recall/)
      expect(help).not.toMatch(/\benrich\b/)
      expect(help).not.toMatch(/\bconsolidate\b/)
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
})
