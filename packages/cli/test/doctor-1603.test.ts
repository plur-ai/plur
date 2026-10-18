/**
 * #1603 — doctor's verdict and embedding hint.
 *
 * - With Codex installed but not wired, the closing line named only Claude
 *   Code ("✓ Healthy. plur is ready to use in Claude Code.") — misleading when
 *   Codex is the editor in use. It stays advisory (exit code unchanged), but
 *   the line names Codex.
 * - A "fetch failed" model download got hints about HuggingFace connectivity
 *   only. transformers.js downloads with Node's built-in fetch, which ignores
 *   HTTPS_PROXY unless NODE_USE_ENV_PROXY=1 is set (Node 24.0+ / 22.21+).
 */
import { describe, it, expect } from 'vitest'
import { readyLine, embeddingNetworkHint } from '../src/commands/doctor.js'

describe('readyLine names an installed but unwired Codex (#1603)', () => {
  it('does not read as plain "Healthy" when Codex is unwired', () => {
    const line = readyLine(['Claude Code'], ['Codex'])
    expect(line).not.toBe('✓ Healthy. plur is ready to use in Claude Code.')
    expect(line).not.toMatch(/^✓/)
    expect(line).toContain('Codex')
    expect(line).toContain('plur init --codex')
  })

  it('names Codex on a machine whose only hooks are elsewhere too', () => {
    const line = readyLine(['Cursor'], ['Codex'])
    expect(line).toContain('Codex')
    expect(line).toContain('Cursor')
  })

  it('is unchanged with nothing unwired', () => {
    expect(readyLine(['Claude Code'])).toBe('✓ Healthy. plur is ready to use in Claude Code.')
    expect(readyLine(['Claude Code'], [])).toBe('✓ Healthy. plur is ready to use in Claude Code.')
  })
})

describe('embeddingNetworkHint (#1603)', () => {
  it('names HTTPS_PROXY and NODE_USE_ENV_PROXY=1 for "fetch failed" on a Node that supports it', () => {
    const text = embeddingNetworkHint('fetch failed', {}, '24.10.0').join('\n')
    expect(text).toContain('HTTPS_PROXY')
    expect(text).toContain('NODE_USE_ENV_PROXY=1')
  })

  it('says HTTPS_PROXY is being ignored when it is set without NODE_USE_ENV_PROXY', () => {
    const text = embeddingNetworkHint('TypeError: fetch failed', { HTTPS_PROXY: 'http://proxy:8080' }, '22.21.0').join('\n')
    expect(text).toMatch(/HTTPS_PROXY is set/)
    expect(text).toMatch(/ignore/)
    expect(text).toContain('NODE_USE_ENV_PROXY=1')
  })

  it('on an older Node, says NODE_USE_ENV_PROXY needs Node 22.21+ or 24+', () => {
    const text = embeddingNetworkHint('fetch failed', {}, '20.11.1').join('\n')
    expect(text).toContain('HTTPS_PROXY')
    expect(text).toMatch(/22\.21/)
    expect(text).toMatch(/24/)
  })

  it('recognises other network errors', () => {
    expect(embeddingNetworkHint('getaddrinfo ENOTFOUND huggingface.co', {}, '24.0.0').length).toBeGreaterThan(0)
    expect(embeddingNetworkHint('connect ETIMEDOUT 1.2.3.4:443', {}, '24.0.0').length).toBeGreaterThan(0)
  })

  it('says nothing for a non-network error', () => {
    expect(embeddingNetworkHint('Cannot find module onnxruntime-node', {}, '24.10.0')).toEqual([])
    expect(embeddingNetworkHint(undefined, {}, '24.10.0')).toEqual([])
  })
})
