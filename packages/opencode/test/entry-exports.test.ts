/**
 * opencode loads every export of the plugin's entry module as a plugin, and
 * refuses the whole module when one is not a function. Measured against
 * opencode 1.18.33: the published 0.1.2 dist, which also exported the number
 * INJECT_TIMEOUT_MS, failed with "failed to load plugin ... Plugin export is
 * not a function" — the plugin never ran, and nothing told the user.
 */
import { describe, it, expect } from 'vitest'
import * as entry from '../src/index.js'

describe('plugin entry module', () => {
  it('exports only functions (opencode treats every export as a plugin)', () => {
    const notFunctions = Object.entries(entry).filter(([, v]) => typeof v !== 'function').map(([k]) => k)
    expect(notFunctions).toEqual([])
  })
})
