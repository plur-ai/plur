import { describe, it, expect } from 'vitest'
import * as entry from '../src/index.js'

// Both actual loaders were exercised: V1 >=1.18.0 selects default.server;
// V2 >=2.0.23 selects default.setup. Neither enumerates named exports then.
describe('plugin entry module', () => {
  it('provides a native V2 definition and the retained V1 server factory', () => {
    expect(entry.default).toMatchObject({ id: 'plur', setup: expect.any(Function), server: entry.PlurPlugin })
    expect(typeof entry.PlurPlugin).toBe('function')
    expect(Object.keys(entry).sort()).toEqual(['PlurPlugin', 'default'])
  })
})
