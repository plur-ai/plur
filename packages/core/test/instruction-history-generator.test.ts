import { describe, it, expect } from 'vitest'
// The generator's renderer: scripts/extract-plur-section-history.mjs uses it to
// turn each instruction constant into the text the code installs.
import { evaluateConst } from '../../../scripts/render-instruction-const.mjs'

/**
 * #1520 second re-audit L3: a text the renderer cannot reproduce exactly must
 * fail the generator (non-zero exit), never be recorded wrong.
 */
describe('evaluateConst — renders what it can, refuses what it cannot', () => {
  it('renders concatenated strings and ${NAME} from same-file constants', () => {
    const src = "const A = 'x' +\n  \"y\"\nconst M = '<!-- v4 -->'\nconst S = `## H\\n${A}\\n${M}\\n`\n"
    expect(evaluateConst(src, 'S')).toEqual({ text: '## H\nxy\n<!-- v4 -->\n' })
  })

  it('reports a constant that is not there', () => {
    expect(evaluateConst("const A = 'x'\n", 'B')).toEqual({ missing: true })
  })

  for (const [what, src] of [
    ['a commented-out definition above the real one', "// const S = 'old'\nconst S = 'new'\n"],
    ['a definition inside a block comment', "/*\nconst S = 'old'\n*/\nconst S = 'new'\n"],
    ['two definitions', "const S = 'a'\nconst S = 'b'\n"],
    ['a trailing .replace()', "const S = `x`.replace(/x/, 'y')\n"],
    ['a trailing .toUpperCase() on the next line', "const S = 'x'\n  .toUpperCase()\n"],
    ['a comment between parts', "const S = 'a' /* c */ + 'b'\n"],
    ['a ternary', "const S = 'a' ? 'b' : 'c'\n"],
    ['a function call', "const S = make('a')\n"],
  ] as const) {
    it(`refuses ${what}`, () => {
      const r = evaluateConst(src, 'S')
      if (what === 'a commented-out definition above the real one' || what === 'a definition inside a block comment') {
        // Either the real definition is rendered, or the generator refuses; never the commented-out text.
        expect(r.text === undefined ? r.error : r.text).not.toBe('old')
        if (r.text !== undefined) expect(r.text).toBe('new')
      } else {
        expect(r.error, JSON.stringify(r)).toBeTruthy()
      }
    })
  }
})

describe('evaluateConst — the forms the third re-audit found (#1520 re-audit3 N4)', () => {
  for (const [what, src] of [
    ['a // comment line between + parts', "const S='a'\n// note\n+ 'b'\n"],
    ['an && continuation', "const S='a'\n&& 'b'\n"],
    ['a || continuation', "const S='a' || 'b'\n"],
  ] as const) {
    it(`refuses ${what}`, () => {
      expect(evaluateConst(src, 'S').error, JSON.stringify(evaluateConst(src, 'S'))).toBeTruthy()
    })
  }

  it('a statement ending in ; ends the value, as in JavaScript', () => {
    const r = evaluateConst("const S='a';\n+ 'b'\n", 'S')
    expect(r.text === 'a' || r.error !== undefined).toBe(true)
  })

  it('a "definition" inside a template string is not a definition', () => {
    expect(evaluateConst("const DOC=`example:\nconst S='fake'\n`\n", 'S')).toEqual({ missing: true })
  })

  for (const [what, src] of [
    ['/* inside a // comment', "// matches src/*.ts\nconst S = 'actual'\n"],
    ['/* inside a string', "const GLOB = 'src/*'\nconst S = 'actual'\n"],
    ['/* inside a template', "const U = `https://x.y/*`\nconst S = 'actual'\n"],
    ['a block comment before the definition on the same line', "/* comment */ const S = 'actual'\n"],
  ] as const) {
    it(`still finds the definition after ${what}`, () => {
      expect(evaluateConst(src, 'S')).toEqual({ text: 'actual' })
    })
  }
})

describe('evaluateConst — the #1557 review forms (L5)', () => {
  it('a regex literal with a backtick after return does not hide a later definition', () => {
    const src = "function f(x) {\n  return /`/.test(x)\n}\nconst S = 'actual'\n"
    expect(evaluateConst(src, 'S')).toEqual({ text: 'actual' })
  })

  for (const [what, src] of [
    ['an in continuation on the next line', "const S = 'a'\nin {}\n"],
    ['an instanceof continuation on the next line', "const S = 'a'\ninstanceof Object\n"],
    ['an in continuation on the same line', "const S = 'a' in {}\n"],
  ] as const) {
    it(`refuses ${what}`, () => {
      expect(evaluateConst(src, 'S').error, JSON.stringify(evaluateConst(src, 'S'))).toBeTruthy()
    })
  }

  it('finds a definition after another statement on the same line', () => {
    expect(evaluateConst("let x = 1; const S = 'actual'\n", 'S')).toEqual({ text: 'actual' })
  })

  it('refuses a source whose lexing ends inside a string or template', () => {
    const r = evaluateConst("const S = 'actual'\nconst T = `never closed\n", 'S')
    expect(r.error).toBeTruthy()
  })
})
