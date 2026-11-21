import { describe, it, expect } from 'vitest'
import { flatHooksShapeProblem, hooksShapeExpectation, hooksShapeProblem } from '../src/hooks-shape.js'

// The shared check every installer leg and `plur doctor` run (#1352, #1897).
// Spawned end-to-end cases: packages/cli/test/malformed-hooks-1897.test.ts and
// packages/mcp/test/init-malformed-hooks-1352.test.ts.

describe('hooksShapeProblem (nested: Claude Code, Codex)', () => {
  it('names the first offending path', () => {
    expect(hooksShapeProblem([])).toBe('`hooks` is not an object')
    expect(hooksShapeProblem({ Stop: { hooks: [] } })).toBe('hooks.Stop is not a list')
    expect(hooksShapeProblem({ Stop: [null] })).toBe('hooks.Stop[0] is not an object')
    expect(hooksShapeProblem({ Stop: [{ hooks: {} }] })).toBe('hooks.Stop[0].hooks is not a list')
    expect(hooksShapeProblem({ Stop: [{ hooks: [null] }] })).toBe('hooks.Stop[0].hooks[0] is not an object')
  })

  it('accepts absent and null levels and command-less hooks', () => {
    expect(hooksShapeProblem(undefined)).toBeNull()
    expect(hooksShapeProblem(null)).toBeNull()
    expect(hooksShapeProblem({ Stop: null })).toBeNull()
    expect(hooksShapeProblem({ Stop: [{ matcher: '*' }] })).toBeNull()
    expect(hooksShapeProblem({ Stop: [{ hooks: null }] })).toBeNull()
    expect(hooksShapeProblem({ Stop: [{ hooks: [{ type: 'prompt', prompt: 'x' }] }] })).toBeNull()
  })
})

describe('flatHooksShapeProblem (Cursor)', () => {
  it('names the first offending path', () => {
    expect(flatHooksShapeProblem('x')).toBe('`hooks` is not an object')
    expect(flatHooksShapeProblem([])).toBe('`hooks` is not an object')
    expect(flatHooksShapeProblem({ stop: { command: 'x' } })).toBe('hooks.stop is not a list')
    expect(flatHooksShapeProblem({ stop: [{ command: 'a' }, null] })).toBe('hooks.stop[1] is not an object')
    expect(flatHooksShapeProblem({ stop: ['x'] })).toBe('hooks.stop[0] is not an object')
  })

  it('accepts absent and null levels and entries without a command', () => {
    expect(flatHooksShapeProblem(undefined)).toBeNull()
    expect(flatHooksShapeProblem({})).toBeNull()
    expect(flatHooksShapeProblem({ stop: null })).toBeNull()
    expect(flatHooksShapeProblem({ stop: [{ type: 'prompt' }] })).toBeNull()
  })
})

describe('hooksShapeExpectation', () => {
  it('says what the harness expects at the offending level', () => {
    expect(hooksShapeExpectation('`hooks` is not an object', 'Claude Code'))
      .toBe('Claude Code expects an object mapping each event to a list of hook entries')
    expect(hooksShapeExpectation('`hooks` is not an object', 'Cursor', true))
      .toBe('Cursor expects an object mapping each event to a list of hook objects')
    expect(hooksShapeExpectation('hooks.Stop is not a list', 'Codex')).toBe('Codex expects lists of hook objects there')
  })
})
