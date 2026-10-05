import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'
import { readOpencodeConfig, writeOpencodeConfig } from '../src/opencode-config.js'

const CLI = builtCliPath(join(__dirname, '..'))
const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'opencode-jsonc', 'opencode.jsonc'), 'utf8')

/**
 * opencode accepts JSONC in its config (comments, trailing commas). Doctor
 * used a plain JSON.parse on the read path, so a JSONC config that declares
 * both the plugin and `mcp.plur` was reported as declaring neither, and
 * doctor's overall verdict went to fail. The read path now accepts JSONC.
 * The writer now edits owned JSONC values in place, preserving comments.
 */
describe('plur doctor — opencode.jsonc with comments and trailing commas', { timeout: 60000 }, () => {
  let home: string
  let configPath: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plur-doctor-jsonc-'))
    const dir = join(home, '.config', 'opencode')
    mkdirSync(dir, { recursive: true })
    configPath = join(dir, 'opencode.jsonc')
    writeFileSync(configPath, FIXTURE)
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('readOpencodeConfig reports plugin and mcp.plur declared', () => {
    const snap = readOpencodeConfig(configPath)
    expect(snap.exists).toBe(true)
    expect(snap.ok).toBe(true)
    expect(snap.pluginDeclared).toBe(true)
    expect(snap.mcpPlurDeclared).toBe(true)
  })

  it('doctor --json reports pluginDeclared and mcpPlurDeclared true, and writes nothing', () => {
    const before = statSync(configPath).mtimeMs
    let stdout: string
    try {
      stdout = execSync(`node ${CLI} doctor --no-handshake --json`, {
        encoding: 'utf-8', timeout: 15000, env: isolatedHomeEnv(home), cwd: home,
      })
    } catch (err: any) {
      // A fresh HOME has no hooks/MCP for Claude Code, so doctor's overall
      // verdict is fail for reasons unrelated to opencode — read the report.
      stdout = err.stdout?.toString() ?? ''
    }
    const report = JSON.parse(stdout)

    expect(report.opencode).not.toBeNull()
    expect(report.opencode.configPath).toBe(configPath)
    expect(report.opencode.ok).toBe(true)
    expect(report.opencode.pluginDeclared).toBe(true)
    expect(report.opencode.mcpPlurDeclared).toBe(true)

    // Read-only: the file is byte-for-byte what we wrote, mtime unchanged.
    expect(readFileSync(configPath, 'utf8')).toBe(FIXTURE)
    expect(statSync(configPath).mtimeMs).toBe(before)
  })

  it('readOpencodeConfig accepts a BOM-prefixed JSONC config', () => {
    writeFileSync(configPath, '﻿' + FIXTURE)
    const snap = readOpencodeConfig(configPath)
    expect(snap.ok).toBe(true)
    expect(snap.pluginDeclared).toBe(true)
    expect(snap.mcpPlurDeclared).toBe(true)
  })

  it('readOpencodeConfig reports ok:false for {,} (a comma with no value), as opencode rejects it', () => {
    writeFileSync(configPath, '{ "plugin": ["@plur-ai/opencode"], "mcp": {,} }')
    expect(readOpencodeConfig(configPath).ok).toBe(false)
  })

  it('init accepts JSONC and preserves an already configured document', () => {
    const r = writeOpencodeConfig(configPath, '0.21.0')
    expect(r.ok).toBe(true)
    expect(r.changed).toBe(false)
    expect(readFileSync(configPath, 'utf8')).toBe(FIXTURE)
  })
})
