/**
 * `receipts` in config.yaml: the gateway client itself lives in
 * @plur-ai/gateway; core only reads the setting.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'

const STAMP = 'cd'.repeat(32)
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
function fresh(): string {
  const d = mkdtempSync(join(tmpdir(), 'plur-receipts-config-'))
  dirs.push(d)
  return d
}

describe('receipts config', () => {
  it('config.yaml receipts.stamp_id is read; a malformed one is ignored, not fatal', async () => {
    const good = fresh()
    writeFileSync(join(good, 'config.yaml'), `receipts:\n  store: swarm\n  stamp_id: ${STAMP}\n`)
    expect(new Plur({ path: good, autoDiscover: false }).receiptsConfig()).toEqual({ store: 'swarm', stamp_id: STAMP })
    const bad = fresh()
    writeFileSync(join(bad, 'config.yaml'), `receipts:\n  store: swarm\n  stamp_id: not-a-stamp\n`)
    expect(new Plur({ path: bad, autoDiscover: false }).receiptsConfig()).toEqual({ store: 'swarm' })
  })
})
