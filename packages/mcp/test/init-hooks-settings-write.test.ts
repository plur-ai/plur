import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, linkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { installHooks } from '../src/index.js'

/**
 * Security audit 2026-11-06 (hardening): `plur-mcp init` wrote
 * ~/.claude/settings.json in place with writeFileSync — no backup, no
 * temp-file rename — unlike every other config write. It now goes through
 * core's writeWithBackup: an existing file gets a backup and an atomic
 * replace, and a file it must not rewrite (a hard link) is left untouched.
 * HOME points into a temp directory; the real settings are never read.
 */

const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
let home: string
let settingsPath: string
const USER_SETTINGS = { theme: 'dark', hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: '/opt/mine --flag' }] }] } }

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'plur-mcp-settings-'))
  process.env.HOME = home
  process.env.USERPROFILE = home
  mkdirSync(join(home, '.claude'))
  settingsPath = join(home, '.claude', 'settings.json')
})
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  rmSync(home, { recursive: true, force: true })
})

const backups = () => readdirSync(join(home, '.claude')).filter(f => f.startsWith('settings.json.plur-backup-'))

describe('plur-mcp init writes ~/.claude/settings.json with a backup', () => {
  it('an existing file is backed up before the hooks are added, and keeps the user settings', async () => {
    const original = JSON.stringify(USER_SETTINGS, null, 2) + '\n'
    writeFileSync(settingsPath, original)
    const status = await installHooks()
    expect(status).toContain('installed in')
    expect(backups()).toHaveLength(1)
    expect(readFileSync(join(home, '.claude', backups()[0]), 'utf8')).toBe(original)
    const after = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(after.theme).toBe('dark')
    expect(after.hooks.Stop[0].hooks[0].command).toBe('/opt/mine --flag')
    expect(JSON.stringify(after.hooks)).toContain('hook-session-guard')
  })

  it('a hard-linked settings file is not rewritten in place', async () => {
    const original = JSON.stringify(USER_SETTINGS, null, 2) + '\n'
    writeFileSync(settingsPath, original)
    linkSync(settingsPath, join(home, 'settings-alias.json'))
    const status = await installHooks()
    expect(status).toMatch(/^skipped/)
    expect(readFileSync(settingsPath, 'utf8')).toBe(original)
    expect(readFileSync(join(home, 'settings-alias.json'), 'utf8')).toBe(original)
  })

  it('a missing file is created', async () => {
    const status = await installHooks()
    expect(status).toContain('installed in')
    expect(JSON.stringify(JSON.parse(readFileSync(settingsPath, 'utf8')).hooks)).toContain('hook-session-guard')
  })
})
