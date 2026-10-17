import { describe, it, expect } from 'vitest'
import { spawnSync } from 'child_process'
import { join } from 'path'
import { existsSync, statSync, readdirSync } from 'fs'

const PKG_ROOT = join(__dirname, '..')

function newestMtime(dir: string): number {
  if (!existsSync(dir)) return 0
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(full))
    } else if (entry.isFile()) {
      newest = Math.max(newest, statSync(full).mtimeMs)
    }
  }
  return newest
}

function builtEnterprisePath(): string {
  const bin = join(PKG_ROOT, 'dist', 'enterprise.js')
  if (!existsSync(bin)) {
    throw new Error(
      `Built enterprise bin not found at ${bin}.\n` +
        'Run `pnpm build` in packages/cli first.',
    )
  }
  const builtAt = statSync(bin).mtimeMs
  const sourcedAt = newestMtime(join(PKG_ROOT, 'src'))
  if (sourcedAt > builtAt + 1000) {
    const behindBy = Math.round((sourcedAt - builtAt) / 1000)
    throw new Error(
      `STALE BUILD: ${bin} is ${behindBy}s older than src/. Run \`pnpm build\` and re-run.`,
    )
  }
  return bin
}

const BIN = builtEnterprisePath()

describe('plur-enterprise binary', () => {
  it('--help exits 0, contains "plur-enterprise init", hides --token-stdin', () => {
    const r = spawnSync('node', [BIN, '--help'], { encoding: 'utf-8', timeout: 30_000 })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('plur-enterprise init')
    expect(r.stdout).not.toContain('--token-stdin')
  })

  it('bogus command exits 1, stderr contains "Unknown command: bogus"', () => {
    const r = spawnSync('node', [BIN, 'bogus'], { encoding: 'utf-8', timeout: 30_000 })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Unknown command: bogus')
  })
})
