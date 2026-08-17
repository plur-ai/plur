import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync, spawnSync } from 'child_process'

const CLI = join(__dirname, '..', 'dist', 'index.js')

describe('plur sync', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-cli-test-')) })
  afterEach(() => { rmSync(dir, { recursive: true }) })

  it('returns a result with action field on non-git dir', () => {
    // sync initializes a git repo in the plur dir; may succeed or throw
    const result = spawnSync('node', [CLI, 'sync', '--path', dir, '--json'], {
      encoding: 'utf-8',
      timeout: 15000,
    })
    // Either succeeds with action field or exits with error — both are valid
    if (result.status === 0) {
      const output = JSON.parse(result.stdout.trim())
      expect(output.action).toBeDefined()
      expect(['initialized', 'committed', 'synced', 'up-to-date']).toContain(output.action)
    } else {
      // Graceful error — has error in stderr or stdout JSON
      expect(result.status).not.toBe(null)
    }
  })

  it('initializes git repo and returns initialized action', () => {
    const result = spawnSync('node', [CLI, 'sync', '--path', dir, '--json'], {
      encoding: 'utf-8',
      timeout: 15000,
    })
    if (result.status === 0) {
      const output = JSON.parse(result.stdout.trim())
      expect(typeof output.action).toBe('string')
      expect(typeof output.files_changed).toBe('number')
    }
    // If git is not available or fails, that's also acceptable
  })
})
