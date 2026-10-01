import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { parseJsonc, stripJsonc } from '../src/lib/jsonc.js'

/**
 * opencode accepts JSONC (comments, trailing commas) in its config. `plur
 * doctor` reads that file to say whether PLUR is declared, so its read path
 * has to accept the same syntax — or it reports a working install as broken.
 * The stripper is string-aware: `//` and `/*` inside a string (a URL, a glob)
 * are content, never comment openers.
 */
describe('parseJsonc', () => {
  it('parses plain JSON unchanged', () => {
    expect(parseJsonc('{"a":1,"b":[1,2],"c":{"d":"e"}}')).toEqual({ a: 1, b: [1, 2], c: { d: 'e' } })
  })

  it('drops line comments', () => {
    expect(parseJsonc('{\n  // c\n  "a": 1 // trailing\n}\n// end')).toEqual({ a: 1 })
  })

  it('drops block comments, including multi-line ones', () => {
    expect(parseJsonc('/* head */{ /* a\n b */ "a": /* inline */ 1 }')).toEqual({ a: 1 })
  })

  it('allows trailing commas in objects and arrays, including before a comment', () => {
    expect(parseJsonc('{ "a": [1, 2,], "b": { "c": 3, }, }')).toEqual({ a: [1, 2], b: { c: 3 } })
    expect(parseJsonc('{ "a": [1, // x\n ], }')).toEqual({ a: [1] })
  })

  it('keeps `//` and `/*` inside strings (URLs, globs)', () => {
    expect(parseJsonc('{ "u": "https://opencode.ai/config.json", "g": "a/*/b", "x": "*/" }'))
      .toEqual({ u: 'https://opencode.ai/config.json', g: 'a/*/b', x: '*/' })
  })

  it('keeps a trailing-comma lookalike inside a string', () => {
    expect(parseJsonc('{ "s": ",}", "t": ", ]" }')).toEqual({ s: ',}', t: ', ]' })
  })

  it('handles escaped quotes and backslashes in strings', () => {
    expect(parseJsonc('{ "a": "say \\"hi\\" // not a comment", "b": "c:\\\\" // real\n }'))
      .toEqual({ a: 'say "hi" // not a comment', b: 'c:\\' })
  })

  it('still throws on invalid JSON once comments are removed', () => {
    expect(() => parseJsonc('{ "a": }')).toThrow()
    expect(() => parseJsonc('{ "a": 1 /* unterminated')).toThrow()
    expect(() => parseJsonc('{ "a": "unterminated }')).toThrow()
  })

  // A trailing comma must follow a value. opencode's parser rejects `{,}` and
  // `[,]` (ValueExpected); doctor must not report such a file as readable.
  it('rejects a comma with no value before it: {,} [,] [1,,] {"a":1,,}', () => {
    expect(() => parseJsonc('{,}')).toThrow()
    expect(() => parseJsonc('[,]')).toThrow()
    expect(() => parseJsonc('{ , }')).toThrow()
    expect(() => parseJsonc('[ /* c */ , ]')).toThrow()
    expect(() => parseJsonc('[1,,]')).toThrow()
    expect(() => parseJsonc('{"a":1,,}')).toThrow()
    expect(() => parseJsonc('{"a":[,]}')).toThrow()
  })

  it('accepts CRLF line endings, with line comments ended by \\r\\n', () => {
    expect(parseJsonc('{\r\n  // c\r\n  "a": 1, // d\r\n  "b": [2,],\r\n}\r\n')).toEqual({ a: 1, b: [2] })
  })

  it('accepts a leading UTF-8 byte-order mark', () => {
    expect(parseJsonc('﻿{ // c\n "a": 1, }')).toEqual({ a: 1 })
  })

  it('block comments do not nest: the first */ closes the comment', () => {
    expect(parseJsonc('{ /* /* */ "a": 1 }')).toEqual({ a: 1 })
    expect(() => parseJsonc('{ /* /* */ */ "a": 1 }')).toThrow()
  })

  it('a lone / outside a string is not a comment and is rejected', () => {
    expect(() => parseJsonc('{ "a": 1 / }')).toThrow()
    expect(() => parseJsonc('/')).toThrow()
    expect(parseJsonc('{ "a": "x / y" }')).toEqual({ a: 'x / y' })
  })

  it('\\u escapes inside strings are content, including ones that spell // or a quote', () => {
    expect(parseJsonc('{ "a": "\\u002F\\u002F not a comment", "b": "\\u0022 // still string" } // real'))
      .toEqual({ a: '// not a comment', b: '" // still string' })
  })

  it('preserves line structure so a JSON.parse error position still points at the right line', () => {
    const src = '{\n// one\n/* two\nthree */\n"a": 1\n}'
    expect(stripJsonc(src).split('\n').length).toBe(src.split('\n').length)
  })

  it('parses the opencode JSONC fixture', () => {
    const src = readFileSync(join(__dirname, 'fixtures', 'opencode-jsonc', 'opencode.jsonc'), 'utf8')
    const cfg = parseJsonc(src) as Record<string, any>
    expect(cfg.$schema).toBe('https://opencode.ai/config.json')
    expect(cfg.theme).toBe('path/with/*/glob/*')
    expect(cfg.note).toBe('escaped " quote then // still in the string')
    expect(cfg.plugin).toEqual(['@plur-ai/opencode'])
    expect(cfg.mcp.plur.command).toEqual(['npx', '-y', '@plur-ai/mcp@0.21.0'])
  })
})
