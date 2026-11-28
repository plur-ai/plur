/**
 * H4: an invalid value in one of the overhaul's config keys is ignored on its
 * own (the rest of config.yaml, stores included, still loads). `plur doctor`
 * names each ignored key so the user can tell their setting is not in effect.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { findInvalidConfigKeys, invalidConfigKeyLines } from '../src/commands/doctor.js'

let dir: string | undefined
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined })

describe('doctor: invalid overhaul config values (H4)', () => {
  it('names each ignored key', () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-doctor-h4-'))
    writeFileSync(join(dir, 'config.yaml'), 'injection:\n  mode: hybrid\n  recall_limit: 5\npinning:\n  agents: maybe\n')
    const keys = findInvalidConfigKeys({ path: dir })
    expect(keys).toEqual(['injection.mode', 'pinning.agents'])
    const text = invalidConfigKeyLines(keys).join('\n')
    expect(text).toContain('injection.mode')
    expect(text).toContain('pinning.agents')
    expect(text).toContain('ignored')
  })

  it('is empty for a valid config, a missing config, or unparseable YAML', () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-doctor-h4-'))
    expect(findInvalidConfigKeys({ path: dir })).toEqual([])
    writeFileSync(join(dir, 'config.yaml'), 'injection:\n  mode: unified\n')
    expect(findInvalidConfigKeys({ path: dir })).toEqual([])
    writeFileSync(join(dir, 'config.yaml'), 'injection: [unclosed\n')
    expect(findInvalidConfigKeys({ path: dir })).toEqual([])
    expect(invalidConfigKeyLines([])).toEqual([])
  })
})
