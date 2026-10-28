/**
 * Tool-argument validation, pinned to the exact results of 0.22.1 (zod 3).
 *
 * Clients see these: the parsed arguments a handler receives (array coercion,
 * unknown keys kept), and on failure the `Invalid arguments: <path>: <message>`
 * line, `missing_fields` and the drop classification (#281, #297, #772). A
 * schema-library upgrade must not change any of them.
 */
import { describe, it, expect } from 'vitest'
import { getToolDefinitions, validateToolArgs } from '../src/tools.js'

const tools = getToolDefinitions('full')
const tool = (name: string) => {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`no tool ${name}`)
  return t
}

interface Expected {
  ok: boolean
  data?: Record<string, unknown>
  /** The error text up to the received-fields note. */
  error?: string
  missing_fields?: string[]
  missingArrayParams?: string[]
  drop?: 'whole_payload' | 'partial'
}

const CASES: Array<[string, Record<string, unknown>, Expected]> = [
  ["plur_learn", {}, {"ok": false, "error": "Invalid arguments: statement: Required", "missing_fields": ["statement"], "missingArrayParams": [], "drop": "whole_payload"}],
  ["plur_learn", {"scope": "global"}, {"ok": false, "error": "Invalid arguments: statement: Required", "missing_fields": ["statement"], "missingArrayParams": [], "drop": "partial"}],
  ["plur_learn", {"statement": "s", "type": "nope"}, {"ok": false, "error": "Invalid arguments: type: Invalid enum value. Expected 'behavioral' | 'terminological' | 'procedural' | 'architectural', received 'nope'", "missing_fields": [], "missingArrayParams": []}],
  ["plur_learn", {"statement": 5}, {"ok": false, "error": "Invalid arguments: statement: Expected string, received number", "missing_fields": [], "missingArrayParams": []}],
  ["plur_learn", {"statement": "s", "tags": "a, b", "extra": 1}, {"ok": true, "data": {"statement": "s", "tags": ["a", "b"], "extra": 1}}],
  ["plur_learn", {"statement": "s", "tags": "[\"a\",\"b\"]", "pinned": "yes"}, {"ok": false, "error": "Invalid arguments: pinned: Expected boolean, received string", "missing_fields": [], "missingArrayParams": []}],
  ["plur_learn", {"statement": "s", "tags": [1]}, {"ok": false, "error": "Invalid arguments: tags.0: Expected string, received number", "missing_fields": [], "missingArrayParams": []}],
  ["plur_learn", {"statement": "s", "attribution": {"runtime": {}}}, {"ok": true, "data": {"statement": "s", "attribution": {"runtime": {}}}}],
  ["plur_learn", {"statement": "s", "attribution": {"runtime": {"name": "x", "extra": 1}}}, {"ok": true, "data": {"statement": "s", "attribution": {"runtime": {"name": "x", "extra": 1}}}}],
  ["plur_session_end", {"summary": "x"}, {"ok": false, "error": "Invalid arguments: engram_suggestions: Required", "missing_fields": ["engram_suggestions"], "missingArrayParams": ["engram_suggestions"], "drop": "partial"}],
  ["plur_session_end", {"summary": "x", "engram_suggestions": "Use pnpm, not npm"}, {"ok": true, "data": {"summary": "x", "engram_suggestions": ["Use pnpm, not npm"]}}],
  ["plur_session_end", {"summary": "x", "engram_suggestions": [5]}, {"ok": false, "error": "Invalid arguments: engram_suggestions.0: Invalid input", "missing_fields": [], "missingArrayParams": []}],
  ["plur_session_end", {"summary": "x", "engram_suggestions": [{"statement": "a"}, "b"]}, {"ok": true, "data": {"summary": "x", "engram_suggestions": [{"statement": "a"}, "b"]}}],
]

describe('validateToolArgs matches 0.22.1 output', () => {
  for (const [name, args, expected] of CASES) {
    it(`${name} ${JSON.stringify(args)}`, () => {
      const r = validateToolArgs(tool(name), args)
      expect(r.ok).toBe(expected.ok)
      if (r.ok) {
        expect(JSON.stringify(r.data)).toBe(JSON.stringify(expected.data))
        return
      }
      expect(r.errorPayload.error.split('. Received')[0]).toBe(expected.error)
      expect(r.errorPayload.missing_fields).toEqual(expected.missing_fields)
      expect(r.missingArrayParams).toEqual(expected.missingArrayParams)
      expect(r.errorPayload.drop).toBe(expected.drop)
    })
  }
})
