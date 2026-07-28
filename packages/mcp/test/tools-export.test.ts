/**
 * #714: @plur-ai/mcp/tools subpath export — side-effect-free tool schema access.
 *
 * Validates that the ./tools export (src/tools-export.ts) surfaces the tool
 * definitions as plain, handler-free schema objects without touching
 * process.argv or starting a server.
 */

import { describe, it, expect } from 'vitest'
import {
  getToolSchemas,
  getToolDefinitions,
  CURSOR_CORE_TOOL_NAMES,
} from '../src/tools-export.js'

describe('@plur-ai/mcp/tools subpath export (#714)', () => {
  it('getToolSchemas returns objects with no handler field', () => {
    const schemas = getToolSchemas('full')
    expect(schemas.length).toBeGreaterThan(0)
    for (const s of schemas) {
      expect(s).not.toHaveProperty('handler')
      expect(typeof s.name).toBe('string')
      expect(typeof s.description).toBe('string')
      expect(s.inputSchema.type).toBe('object')
    }
  })

  it('getToolSchemas covers the core tool names', () => {
    const schemas = getToolSchemas()
    const names = new Set(schemas.map(s => s.name))
    for (const core of CURSOR_CORE_TOOL_NAMES) {
      expect(names.has(core)).toBe(true)
    }
  })

  it('getToolDefinitions is re-exported (for consumers building MCP servers)', () => {
    const defs = getToolDefinitions('full')
    expect(defs.length).toBeGreaterThan(0)
    expect(typeof defs[0].handler).toBe('function')
  })

  it('lean and cursor profiles return the same tool count', () => {
    const lean = getToolSchemas('lean')
    const cursor = getToolSchemas('cursor')
    expect(lean.length).toBe(cursor.length)
    expect(lean.map(s => s.name).sort()).toEqual(cursor.map(s => s.name).sort())
  })

  it('full profile returns more tools than lean', () => {
    const full = getToolSchemas('full')
    const lean = getToolSchemas('lean')
    expect(full.length).toBeGreaterThan(lean.length)
  })

  it('CURSOR_CORE_TOOL_NAMES is re-exported', () => {
    expect(CURSOR_CORE_TOOL_NAMES).toBeInstanceOf(Set)
    expect(CURSOR_CORE_TOOL_NAMES.has('plur_learn')).toBe(true)
    expect(CURSOR_CORE_TOOL_NAMES.has('plur_session_start')).toBe(true)
  })
})
