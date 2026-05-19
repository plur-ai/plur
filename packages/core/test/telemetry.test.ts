import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveTelemetry, isTelemetryEnabled } from '../src/telemetry.js'

function newDir(): string {
  return mkdtempSync(join(tmpdir(), 'plur-telemetry-'))
}

describe('telemetry gate', () => {
  let dir: string
  let cfg: string
  beforeEach(() => {
    dir = newDir()
    cfg = join(dir, 'telemetry.json')
  })

  it('defaults to off with no env and no config file', () => {
    const r = resolveTelemetry({ env: {}, configPath: cfg })
    expect(r.state).toBe('off')
    expect(r.source).toBe('default')
  })

  it('PLUR_TELEMETRY=on activates the gate', () => {
    const r = resolveTelemetry({ env: { PLUR_TELEMETRY: 'on' }, configPath: cfg })
    expect(r.state).toBe('on')
    expect(r.source).toBe('env')
    expect(isTelemetryEnabled({ env: { PLUR_TELEMETRY: 'on' }, configPath: cfg })).toBe(true)
  })

  it('PLUR_TELEMETRY=off forces the gate off even with config enabled', () => {
    writeFileSync(cfg, JSON.stringify({ enabled: true }))
    const r = resolveTelemetry({ env: { PLUR_TELEMETRY: 'off' }, configPath: cfg })
    expect(r.state).toBe('off')
    expect(r.source).toBe('env')
  })

  it('reads enabled:true from config when env is unset', () => {
    writeFileSync(cfg, JSON.stringify({ enabled: true }))
    const r = resolveTelemetry({ env: {}, configPath: cfg })
    expect(r.state).toBe('on')
    expect(r.source).toBe('config')
  })

  it('reads enabled:false from config', () => {
    writeFileSync(cfg, JSON.stringify({ enabled: false }))
    const r = resolveTelemetry({ env: {}, configPath: cfg })
    expect(r.state).toBe('off')
    expect(r.source).toBe('config')
  })

  it('treats unrecognized env values as unset', () => {
    const r = resolveTelemetry({ env: { PLUR_TELEMETRY: 'maybe' }, configPath: cfg })
    expect(r.state).toBe('off')
    expect(r.source).toBe('default')
  })

  it('treats malformed config as unset (does not throw)', () => {
    writeFileSync(cfg, '{ this is not json')
    const r = resolveTelemetry({ env: {}, configPath: cfg })
    expect(r.state).toBe('off')
    expect(r.source).toBe('default')
  })
})
