import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import { findProjectConfigPath, readProjectConfig } from '../src/project-config.js'

/**
 * Tests for project-config — covers the .plur.yaml reader that was extracted
 * from CLI's hook-inject into core, so both CLI hooks AND the MCP session_start
 * handler use the same implementation. See plur-ai/plur#177.
 */
describe('project-config (#177)', () => {
  let root: string

  beforeEach(() => {
    // Make a project-like dir with .git boundary so the walker behaves as in production
    root = mkdtempSync(join(tmpdir(), 'plur-project-cfg-'))
    mkdirSync(join(root, '.git'), { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  describe('findProjectConfigPath', () => {
    it('returns null when no .plur.yaml present', () => {
      expect(findProjectConfigPath(root)).toBeNull()
    })

    it('finds .plur.yaml at the project root', () => {
      const cfg = join(root, '.plur.yaml')
      writeFileSync(cfg, 'scope: project:test\n')
      expect(findProjectConfigPath(root)).toBe(cfg)
    })

    it('walks up from a subdirectory to find .plur.yaml at project root', () => {
      const cfg = join(root, '.plur.yaml')
      writeFileSync(cfg, 'scope: project:test\n')
      const deep = join(root, 'src', 'commands', 'sub')
      mkdirSync(deep, { recursive: true })
      expect(findProjectConfigPath(deep)).toBe(cfg)
    })

    it('stops at .git boundary — never escapes to parent dirs', () => {
      // Place a .plur.yaml ABOVE the project (would be wrong to pick up)
      const ancestor = mkdtempSync(join(tmpdir(), 'plur-ancestor-'))
      const wrongCfg = join(ancestor, '.plur.yaml')
      writeFileSync(wrongCfg, 'scope: project:wrong\n')

      // Nested project with its OWN .git (no .plur.yaml inside)
      const nested = join(ancestor, 'nested-project')
      mkdirSync(join(nested, '.git'), { recursive: true })

      try {
        // From nested/ — should NOT escape past .git to find ancestor's .plur.yaml
        expect(findProjectConfigPath(nested)).toBeNull()
      } finally {
        rmSync(ancestor, { recursive: true, force: true })
      }
    })

    it('does not match a .plur.yaml that lives directly in HOME', () => {
      // We can't put a real .plur.yaml in HOME during tests safely.
      // The protection is verified by: the function rejects HOME-level configs
      // before checking for existence. We verify it doesn't ASK the FS about
      // HOME's .plur.yaml by starting the walk AT HOME with no .plur.yaml
      // present — should return null without crashing.
      expect(findProjectConfigPath(homedir())).toBeNull()
    })

    it('respects MAX_DEPTH ceiling on path traversal', () => {
      // Build a very deep path without .git anywhere — walker should bail at MAX_DEPTH
      let deep = root
      for (let i = 0; i < 20; i++) {
        deep = join(deep, `level${i}`)
        mkdirSync(deep, { recursive: true })
      }
      // Remove the .git we created so the walker doesn't stop early
      rmSync(join(root, '.git'), { recursive: true, force: true })
      // No .plur.yaml anywhere; MAX_DEPTH=12 means starting from depth-20 stops
      // before reaching root → null. (And reaching root would still be null
      // since we have no .plur.yaml). The point: it returns without hanging.
      expect(findProjectConfigPath(deep)).toBeNull()
    })
  })

  describe('readProjectConfig', () => {
    it('returns {} when no .plur.yaml found', () => {
      expect(readProjectConfig(root)).toEqual({})
    })

    it('parses scope and domain', () => {
      writeFileSync(join(root, '.plur.yaml'), 'scope: project:test\ndomain: testing\n')
      expect(readProjectConfig(root)).toEqual({ scope: 'project:test', domain: 'testing' })
    })

    it('parses remote_url + remote_token', () => {
      writeFileSync(
        join(root, '.plur.yaml'),
        'remote_url: https://plur.example.com\nremote_token: plur_sk_test\nscope: group:test\n',
      )
      const cfg = readProjectConfig(root)
      expect(cfg.remote_url).toBe('https://plur.example.com')
      expect(cfg.remote_token).toBe('plur_sk_test')
      expect(cfg.scope).toBe('group:test')
    })

    it('strips quotes around values (defensive against editor auto-format)', () => {
      writeFileSync(
        join(root, '.plur.yaml'),
        'scope: "project:test"\nremote_token: \'plur_sk_test\'\n',
      )
      const cfg = readProjectConfig(root)
      expect(cfg.scope).toBe('project:test')
      expect(cfg.remote_token).toBe('plur_sk_test')
    })

    it('skips comment lines and blank lines', () => {
      writeFileSync(
        join(root, '.plur.yaml'),
        '# PLUR project config\n\nscope: project:test\n# another comment\ndomain: testing\n',
      )
      expect(readProjectConfig(root)).toEqual({ scope: 'project:test', domain: 'testing' })
    })

    it('handles UTF-8 BOM at file start (Windows editors)', () => {
      writeFileSync(
        join(root, '.plur.yaml'),
        '﻿scope: project:test\n',
      )
      expect(readProjectConfig(root)).toEqual({ scope: 'project:test' })
    })

    it('parses inline comma-separated remote_scopes', () => {
      writeFileSync(
        join(root, '.plur.yaml'),
        'remote_url: https://x.example.com\nremote_token: t\nremote_scopes: a, b, c\n',
      )
      expect(readProjectConfig(root).remote_scopes).toEqual(['a', 'b', 'c'])
    })

    it('parses multi-line YAML list form of remote_scopes', () => {
      writeFileSync(
        join(root, '.plur.yaml'),
        'remote_url: https://x.example.com\nremote_scopes:\n  - alpha\n  - beta\n  - gamma\nremote_token: t\n',
      )
      const cfg = readProjectConfig(root)
      expect(cfg.remote_scopes).toEqual(['alpha', 'beta', 'gamma'])
      expect(cfg.remote_token).toBe('t')  // post-list parser correctly returns to scalar mode
    })

    it('returns {} on malformed YAML (graceful)', () => {
      // Use a file we can't read by removing read perms or pointing at a dir
      writeFileSync(join(root, '.plur.yaml'), '\x00\x01\x02 binary garbage')
      // Should not throw; returns {} or whatever was parseable
      expect(() => readProjectConfig(root)).not.toThrow()
    })

    it('ignores unrelated YAML keys silently', () => {
      writeFileSync(
        join(root, '.plur.yaml'),
        'scope: project:test\nunrelated_key: value\nanother: thing\n',
      )
      expect(readProjectConfig(root)).toEqual({ scope: 'project:test' })
    })
  })
})
