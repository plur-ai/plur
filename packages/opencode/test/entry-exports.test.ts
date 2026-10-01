import { describe, it, expect } from 'vitest'
import * as entry from '../src/index.js'

// opencode loads every export of the plugin's entry module as a plugin and
// refuses a non-function export ("Plugin export is not a function"), so the
// whole plugin fails to load. Constants must live in another module.
describe('plugin entry module', () => {
  it('exports only functions', () => {
    const nonFunctions = Object.entries(entry)
      .filter(([, value]) => typeof value !== 'function')
      .map(([name]) => name)
    expect(nonFunctions).toEqual([])
  })
})
