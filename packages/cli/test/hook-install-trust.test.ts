import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { recordHookInstall, readHookInstalls, readHookRuns } from '../src/lib/hook-runs.js'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'plur-hook-install-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })
it('records installation without inventing a hook run', () => {
  recordHookInstall('codex', root, true)
  expect(Number.isFinite(Date.parse(readHookInstalls(root).codex!))).toBe(true)
  expect(readHookRuns(root)).toEqual({})
})
it('preserves an unchanged install and other tools, but invalidates evidence after a change', () => {
  writeFileSync(join(root, 'hook-installs.json'), JSON.stringify({ codex: '2000-01-01T00:00:00Z', cursor: '2001-01-01T00:00:00Z' }))
  recordHookInstall('codex', root, false)
  expect(readHookInstalls(root).codex).toBe('2000-01-01T00:00:00Z')
  recordHookInstall('codex', root, true)
  expect(Date.parse(readHookInstalls(root).codex!)).toBeGreaterThan(Date.parse('2001-01-01T00:00:00Z'))
  expect(readHookInstalls(root).cursor).toBe('2001-01-01T00:00:00Z')
  expect(Object.keys(JSON.parse(readFileSync(join(root, 'hook-installs.json'), 'utf8'))).sort()).toEqual(['codex', 'cursor'])
})
it('refuses to replace hooks when the evidence file is locked', () => {
  writeFileSync(join(root, 'hook-installs.json'), JSON.stringify({ codex: '2000-01-01T00:00:00Z' }))
  writeFileSync(join(root, 'hook-installs.json.lock'), String(process.pid))
  let written = false
  expect(() => recordHookInstall('codex', root, true, () => { written = true })).toThrow()
  expect(written).toBe(false)
})
it('invalidates old evidence before changing hooks and leaves failure unverified', () => {
  writeFileSync(join(root, 'hook-installs.json'), JSON.stringify({ codex: '2000-01-01T00:00:00Z' }))
  let attempted = false
  expect(() => recordHookInstall('codex', root, true, () => {
    attempted = true
    expect(readHookInstalls(root).codex).toBeUndefined()
    throw new Error('fixture hook write failure')
  })).toThrow()
  expect(attempted).toBe(true)
  expect(readHookInstalls(root).codex).toBeUndefined()
})
it('cannot reuse old evidence if the final completion write fails', () => {
  const path = join(root, 'hook-installs.json')
  writeFileSync(path, JSON.stringify({ codex: '2000-01-01T00:00:00Z' }))
  expect(() => recordHookInstall('codex', root, true, () => {
    renameSync(path, join(root, 'pending.json'))
    mkdirSync(path)
  })).toThrow()
  expect(readHookInstalls(root).codex).toBeUndefined()
  expect(JSON.parse(readFileSync(join(root, 'pending.json'), 'utf8')).codex).toBe('pending')
})
