import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { isPlurConfigured } from '../src/lib/plur-configured.js'

describe('isPlurConfigured', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plur-configured-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('returns false when no .mcp.json or settings exists', () => {
    expect(isPlurConfigured(root, root)).toBe(false)
  })

  it('returns true when .mcp.json in cwd has a plur server', () => {
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }),
    )
    expect(isPlurConfigured(root, root)).toBe(true)
  })

  it('returns true when .mcp.json in a parent has a plur server', () => {
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }),
    )
    const sub = join(root, 'a', 'b', 'c')
    mkdirSync(sub, { recursive: true })
    expect(isPlurConfigured(sub, sub)).toBe(true)
  })

  it('returns true when project .claude/settings.json has a plur server', () => {
    mkdirSync(join(root, '.claude'), { recursive: true })
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }),
    )
    expect(isPlurConfigured(root, root)).toBe(true)
  })

  it('returns false when .mcp.json exists but has no plur server', () => {
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'other-mcp' } } }),
    )
    expect(isPlurConfigured(root, root)).toBe(false)
  })

  it('returns false on malformed JSON', () => {
    writeFileSync(join(root, '.mcp.json'), '{ not valid json')
    expect(isPlurConfigured(root, root)).toBe(false)
  })
})
