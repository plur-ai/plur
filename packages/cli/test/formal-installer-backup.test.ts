// Regression test for installer finding I1b (spec/formal/findings/installer.md):
// a backup that was only partly written must not count as a backup.
// fs.writeSync may write fewer bytes than asked (it returns the count); the
// mock below makes the next write short, once, while `shortNext` is set.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const ctl = vi.hoisted(() => ({ shortNext: false }))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const writeSync = ((fd: number, buf: unknown, ...rest: unknown[]) => {
    if (ctl.shortNext && Buffer.isBuffer(buf)) {
      // Whatever range was asked for, write only its first half.
      const off = typeof rest[0] === 'number' ? rest[0] : 0
      const len = typeof rest[1] === 'number' ? rest[1] : buf.length - off
      if (len > 1) {
        ctl.shortNext = false
        return actual.writeSync(fd, buf, off, Math.floor(len / 2))
      }
    }
    return (actual.writeSync as (...a: unknown[]) => number)(fd, buf, ...rest)
  }) as typeof actual.writeSync
  return { ...actual, default: { ...actual, writeSync }, writeSync }
})

const { cleanupLegacy } = await import('../src/enterprise/cleanup.js')

let home: string
let plurDir: string
let backupDir: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'plur-formal-bk-'))
  plurDir = join(home, '.plur')
  backupDir = join(home, 'backups')
  mkdirSync(plurDir, { recursive: true })
})

afterEach(() => {
  ctl.shortNext = false
  rmSync(home, { recursive: true, force: true })
})

const env = (): NodeJS.ProcessEnv => ({
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, '.config'),
  OPENCODE_CONFIG_DIR: '',
  CODEX_HOME: join(home, '.codex'),
})

describe('backup completeness (installer I1b)', () => {
  it('one short write still yields a complete backup before the config changes', () => {
    const cursorDir = join(home, '.cursor')
    mkdirSync(cursorDir)
    const target = join(cursorDir, 'mcp.json')
    const original = JSON.stringify(
      { mcpServers: { 'plur-enterprise': { env: { PLUR_ENTERPRISE_TOKEN: 'plur_sk_test_fake' } }, other: {} } },
      null,
      2,
    )
    writeFileSync(target, original)

    ctl.shortNext = true
    const r = cleanupLegacy({ tools: ['cursor'], backupDir, plurDir, home, env: env() }).find(e => e.target === target)

    if (r?.status === 'removed') {
      // The config changed, so its backup must be the whole original.
      expect(readFileSync(r.backup!, 'utf8')).toBe(original)
    } else {
      // Refused: the config is byte-identical and no partial backup is left.
      expect(r?.status).toBe('refused')
      expect(readFileSync(target, 'utf8')).toBe(original)
      expect(existsSync(backupDir) ? readdirSync(backupDir) : []).toEqual([])
    }
  })
})
