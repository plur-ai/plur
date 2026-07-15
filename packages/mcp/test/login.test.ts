/**
 * Tests for MCP server hot-reload support introduced alongside `plur login`.
 *
 * Covers:
 *   - serverPidPath helper returns expected path
 *   - readEnterpriseToken reads/parses config.json correctly
 *   - isPendingReload / clearPendingReload flag lifecycle
 *
 * Process-level signal delivery (SIGUSR1) and marker-file watching are
 * integration concerns tested by the runStdio path; they are not directly
 * unit-testable here without OS-level signaling fixtures. The flag helpers
 * are tested since they are the unit boundary the signal handler updates.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  serverPidPath,
  readEnterpriseToken,
  isPendingReload,
  clearPendingReload,
} from '../src/server.js'

describe('server hot-reload helpers', () => {
  let tmpRoot: string

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'plur-mcp-login-'))
    clearPendingReload()
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('serverPidPath returns a path ending in server.pid', () => {
    const p = serverPidPath(tmpRoot)
    expect(p).toMatch(/server\.pid$/)
    expect(p).toContain(tmpRoot)
  })

  it('readEnterpriseToken returns undefined when config.json is absent', () => {
    const result = readEnterpriseToken(tmpRoot)
    expect(result).toBeUndefined()
  })

  it('readEnterpriseToken returns undefined when enterprise block is missing', () => {
    writeFileSync(join(tmpRoot, 'config.json'), JSON.stringify({ other: 'key' }))
    const result = readEnterpriseToken(tmpRoot)
    expect(result).toBeUndefined()
  })

  it('readEnterpriseToken parses url + token from config.json', () => {
    writeFileSync(join(tmpRoot, 'config.json'), JSON.stringify({
      enterprise: {
        url: 'https://plur.datafund.io',
        token: 'ent_tok_abc123',
        username: 'alice',
      },
    }))
    const result = readEnterpriseToken(tmpRoot)
    expect(result).toBeDefined()
    expect(result!.url).toBe('https://plur.datafund.io')
    expect(result!.token).toBe('ent_tok_abc123')
  })

  it('readEnterpriseToken returns undefined when token is missing from enterprise block', () => {
    writeFileSync(join(tmpRoot, 'config.json'), JSON.stringify({
      enterprise: { url: 'https://plur.datafund.io' },
    }))
    const result = readEnterpriseToken(tmpRoot)
    expect(result).toBeUndefined()
  })

  it('readEnterpriseToken returns undefined on malformed JSON', () => {
    writeFileSync(join(tmpRoot, 'config.json'), '{ not valid json }')
    const result = readEnterpriseToken(tmpRoot)
    expect(result).toBeUndefined()
  })

  it('isPendingReload returns false initially', () => {
    expect(isPendingReload()).toBe(false)
  })

  it('clearPendingReload is idempotent', () => {
    clearPendingReload()
    expect(isPendingReload()).toBe(false)
    clearPendingReload()
    expect(isPendingReload()).toBe(false)
  })
})
