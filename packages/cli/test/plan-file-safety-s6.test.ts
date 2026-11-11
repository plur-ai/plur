/**
 * S6: the plan / proposal files the CLI writes quote memory text, so they are
 * written atomically, owner-only (0600 — also over an existing wider file),
 * and never through a symlink planted at the path. `plur pins audit` without
 * --out writes into the store root, not the current folder.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, statSync, existsSync, readdirSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import { Plur } from '@plur-ai/core'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'
import { writePrivateFile } from '../src/lib/private-file.js'

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'plur-s6-')) })
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe.skipIf(process.platform === 'win32')('writePrivateFile (S6)', () => {
  it('writes 0600, also over an existing 0644 file', () => {
    const p = join(home, 'plan.json')
    writePrivateFile(p, 'a')
    expect(statSync(p).mode & 0o777).toBe(0o600)
    writeFileSync(p, 'old'); chmodSync(p, 0o644)
    writePrivateFile(p, 'b')
    expect(readFileSync(p, 'utf8')).toBe('b')
    expect(statSync(p).mode & 0o777).toBe(0o600)
  })

  it('refuses a symlink at the path and leaves its target untouched', () => {
    const target = join(home, 'victim.txt')
    writeFileSync(target, 'keep')
    const link = join(home, 'plan.json')
    symlinkSync(target, link)
    expect(() => writePrivateFile(link, 'evil')).toThrow(/symlink|symbolic/i)
    expect(readFileSync(target, 'utf8')).toBe('keep')
  })
})

describe('plur pins audit default output (S6)', () => {
  it('lands in the store root, not the current folder', async () => {
    const root = join(home, '.plur')
    mkdirSync(root)
    writeFileSync(join(root, 'config.yaml'), 'embeddings:\n  enabled: false\nindex: false\n')
    await new Plur({ path: root, autoDiscover: false, actor: 'owner' }).learn('Always answer in plain language', { pinned: true })
    const cwd = join(home, 'work')
    mkdirSync(cwd)
    const script = join(home, 'fake-model.cjs')
    writeFileSync(script, `
let input = ''
process.stdin.on('data', c => { input += c })
process.stdin.on('end', () => {
  const out = []
  const re = /- id: (\\S+)\\n/g
  let m
  while ((m = re.exec(input))) out.push({ id: m[1], class: 'situational', reason: 'x' })
  process.stdout.write(JSON.stringify(out))
})
`)
    const child = spawn(process.execPath, [builtCliPath(join(__dirname, '..')), 'pins', 'audit'], {
      cwd, env: { ...isolatedHomeEnv(home), PLUR_PATH: root, PLUR_DISABLE_EMBEDDINGS: '1', PLUR_LLM_CMD: `"${process.execPath}" "${script}"` },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', c => { out += c }); child.stderr.on('data', c => { out += c })
    const status = await new Promise<number | null>(r => child.once('close', r))
    expect(status, out).toBe(0)
    expect(readdirSync(cwd)).toEqual([])
    const written = readdirSync(root).filter(f => f.startsWith('pin-audit-'))
    expect(written).toHaveLength(1)
    if (process.platform !== 'win32') expect(statSync(join(root, written[0]!)).mode & 0o777).toBe(0o600)
    expect(existsSync(join(root, written[0]!))).toBe(true)
  }, 60_000)
})
