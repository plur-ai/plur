/**
 * `plur provenance <id>` says which session saved a memory and what happened
 * to it since (0.23 explainer, scene 4: docs/provenance-explainer.md).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function plur(store: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--json'], { env: { ...process.env, PLUR_PATH: store, ...env }, encoding: 'utf8' })
  return JSON.parse(r.stdout)
}

describe('plur provenance: session and history', () => {
  it('names the session that saved the memory and lists its history', () => {
    const store = mkdtempSync(join(tmpdir(), 'plur-prov-sess-'))
    dirs.push(store)
    writeFileSync(join(store, 'config.yaml'), 'backend: yaml\n')
    const learned = plur(store, ['learn', 'A memory whose story we want to tell'], { PLUR_SESSION_ID: 'session-abc' })
    const out = plur(store, ['provenance', learned.id])
    expect(out.sessions, JSON.stringify(out)).toEqual(['session-abc'])
    expect(Array.isArray(out.history) && out.history[0]?.event, JSON.stringify(out.history)).toBe('engram_created')
  })
})
