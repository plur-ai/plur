/**
 * Audit M1 on PR #1604 (#1603): macOS and Linux keep main's Codex detection in
 * doctor — "the Codex home exists" — so a `codex` on PATH with no ~/.codex is
 * not reported as an installed-but-unwired Codex.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, delimiter } from 'path'
import { tmpdir } from 'os'
import { execFileSync, spawnSync } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'

const CLI = builtCliPath(join(__dirname, '..'))

describe.skipIf(process.platform === 'win32')('M1: doctor on darwin/linux with a codex on PATH and no ~/.codex', { timeout: 60000 }, () => {
  let home: string
  let bin: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plur-1604-m1-'))
    bin = join(home, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  const env = () => ({ ...isolatedHomeEnv(home), PLUR_DISABLE_EMBEDDINGS: '1', PATH: `${bin}${delimiter}${process.env.PATH}` })

  it('doctor --json reports codexDetected false, as on main', () => {
    expect(existsSync(join(home, '.codex'))).toBe(false)
    let stdout = ''
    try {
      stdout = execFileSync(process.execPath, [CLI, 'doctor', '--no-handshake', '--json'], { encoding: 'utf8', timeout: 45000, env: env(), cwd: home, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err: any) { stdout = err.stdout?.toString() ?? '' }
    expect(JSON.parse(stdout).codexDetected).toBe(false)
  })

  it('the text report has no Codex line and no Codex verdict', () => {
    // A pseudo-terminal, so doctor prints text rather than JSON.
    const line = `'${process.execPath}' '${CLI}' doctor --no-handshake`
    const r = process.platform === 'darwin'
      ? spawnSync('script', ['-q', '/dev/null', 'sh', '-c', line], { encoding: 'utf8', timeout: 45000, env: env(), cwd: home, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawnSync('script', ['-qec', line, '/dev/null'], { encoding: 'utf8', timeout: 45000, env: env(), cwd: home, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = r.stdout ?? ''
    expect(out).toMatch(/Embedding layer DISABLED/) // proof this is the text report
    expect(out).not.toContain('NOT in Codex')
    expect(out).not.toMatch(/Codex: ~\/\.codex\/hooks\.json \+ config\.toml wired/)
  })
})
