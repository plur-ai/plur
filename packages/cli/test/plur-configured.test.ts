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
    expect(isPlurConfigured(root)).toBe(false)
  })

  it('returns true when .mcp.json in cwd has a plur server', () => {
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }),
    )
    expect(isPlurConfigured(root)).toBe(true)
  })

  it('returns true when .mcp.json in a parent has a plur server', () => {
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }),
    )
    const sub = join(root, 'a', 'b', 'c')
    mkdirSync(sub, { recursive: true })
    expect(isPlurConfigured(sub)).toBe(true)
  })

  it('returns true when project .claude/settings.json has a plur server', () => {
    mkdirSync(join(root, '.claude'), { recursive: true })
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }),
    )
    expect(isPlurConfigured(root)).toBe(true)
  })

  it('returns false when .mcp.json exists but has no plur server', () => {
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'other-mcp' } } }),
    )
    expect(isPlurConfigured(root)).toBe(false)
  })

  it('returns false on malformed JSON', () => {
    writeFileSync(join(root, '.mcp.json'), '{ not valid json')
    expect(isPlurConfigured(root)).toBe(false)
  })

  it('returns false when only global ~/.claude/settings.json has a plur server (#247)', () => {
    // Regression: the global fallback made this return true for every
    // project after `plur init --global`, blocking tools everywhere.
    const home = mkdtempSync(join(tmpdir(), 'plur-configured-home-'))
    try {
      mkdirSync(join(home, '.claude'), { recursive: true })
      writeFileSync(
        join(home, '.claude', 'settings.json'),
        JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }),
      )
      expect(isPlurConfigured(root, home)).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('returns true when .plur.yaml exists in cwd', () => {
    writeFileSync(join(root, '.plur.yaml'), 'scope: "project:test"\n')
    expect(isPlurConfigured(root)).toBe(true)
  })

  it('returns true when .plur.yaml exists in a parent', () => {
    writeFileSync(join(root, '.plur.yaml'), 'scope: "project:test"\n')
    const sub = join(root, 'a', 'b')
    mkdirSync(sub, { recursive: true })
    expect(isPlurConfigured(sub)).toBe(true)
  })

  // Audit fix (evaluator review, 2026-07-08): the test above used SIBLING
  // temp dirs for root/home, so the walk-up from `root` never actually
  // reached `home` — it passed even when the underlying "stop at home"
  // logic was completely absent. This nests the project under home, the
  // way virtually every real project is (~/Data/..., ~/code/..., etc.), so
  // the walk-up genuinely has to pass through `home/.claude/settings.json`
  // to reach the false result it's supposed to.
  it('returns false when only global settings has a plur server, project NESTED under home (#247)', () => {
    const home = mkdtempSync(join(tmpdir(), 'plur-configured-home-'))
    try {
      mkdirSync(join(home, '.claude'), { recursive: true })
      writeFileSync(
        join(home, '.claude', 'settings.json'),
        JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }),
      )
      const nestedProject = join(home, 'Data', 'some-project')
      mkdirSync(nestedProject, { recursive: true })
      expect(isPlurConfigured(nestedProject, home)).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('still finds a project-level marker that happens to be nested under home', () => {
    const home = mkdtempSync(join(tmpdir(), 'plur-configured-home-'))
    try {
      const nestedProject = join(home, 'Data', 'some-project')
      mkdirSync(nestedProject, { recursive: true })
      writeFileSync(
        join(nestedProject, '.mcp.json'),
        JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }),
      )
      expect(isPlurConfigured(nestedProject, home)).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('isPlurConfigured — Cursor', () => {
  it('detects .cursor/mcp.json with a plur server entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plur-configured-cursor-'))
    mkdirSync(join(dir, '.cursor'), { recursive: true })
    writeFileSync(
      join(dir, '.cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp', args: [] } } }),
    )
    expect(isPlurConfigured(dir)).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not falsely detect an unrelated .cursor/mcp.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plur-configured-cursor-neg-'))
    mkdirSync(join(dir, '.cursor'), { recursive: true })
    writeFileSync(
      join(dir, '.cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: { github: { command: 'gh-mcp', args: [] } } }),
    )
    expect(isPlurConfigured(dir)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })
})
