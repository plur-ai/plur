import { describe, it, expect, vi } from 'vitest'
import * as entry from '../src/index.js'

// Both actual loaders were exercised: V1 >=1.18.0 selects default.server;
// V2 >=2.0.23 selects default.setup. Neither enumerates named exports then.
describe('plugin entry module', () => {
  it('provides a native V2 definition and the retained V1 server factory', () => {
    expect(entry.default).toMatchObject({ id: 'plur', setup: expect.any(Function), server: entry.PlurPlugin })
    expect(typeof entry.PlurPlugin).toBe('function')
    expect(Object.keys(entry).sort()).toEqual(['PlurPlugin', 'default'])
  })
  it('leaves V1 compatibility setup to the server adapter when native session hooks are absent', async () => {
    const old = process.env.PLUR_DEBUG
    process.env.PLUR_DEBUG = '1'
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const dispose = await entry.default.setup({ location: {} } as any)
      if (typeof dispose === 'function') await dispose()
      expect(log).not.toHaveBeenCalled()
    } finally {
      log.mockRestore()
      if (old === undefined) delete process.env.PLUR_DEBUG
      else process.env.PLUR_DEBUG = old
    }
  })

})
