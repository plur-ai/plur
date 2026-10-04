import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))

describe('plur migrate status', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-cli-migrate-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const status = () => spawnSync(process.execPath, [CLI, 'migrate', 'status', '--path', dir, '--json'], {
    encoding: 'utf-8', timeout: 15000, env: { ...process.env, PLUR_AUTO_DISCOVER: '0' },
  })

  it('reads an empty or comment-only config as version 0', () => {
    writeFileSync(join(dir, 'config.yaml'), '# nothing configured yet\n')
    const result = status()
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout).schema_version).toBe(0)
  })

  it('reports a store from a newer PLUR as a clear error, not a stack trace', () => {
    writeFileSync(join(dir, 'config.yaml'), 'schema_version: 9999\n')
    const result = status()
    expect(result.status).toBe(1)
    // --json: the CLI's error boundary reports it as a JSON error object.
    expect(JSON.parse(result.stdout).error).toMatch(/newer PLUR/)
    const output = result.stdout + result.stderr
    expect(output).toMatch(/Upgrade PLUR/)
    expect(output).not.toMatch(/\n\s+at /)
  })
})
