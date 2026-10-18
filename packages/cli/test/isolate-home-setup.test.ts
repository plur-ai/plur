import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { describe, expect, it } from 'vitest'

// Pins what test/setup/isolate-home.ts gives every test file (and the mcp and
// dsh suites, which load the same file).
describe('isolate-home setup', () => {
  it('runs the file under a temp HOME with no inherited PLUR_PATH', () => {
    expect(process.env.HOME).toContain('plur-cli-test-home-')
    expect(process.env.HOME!.startsWith(tmpdir())).toBe(true)
    expect(process.env.PLUR_PATH).toBeUndefined()
  })

  // CI regression: the temp HOME hid the runner's ~/.gitconfig, and the
  // store's first sync commit failed with "empty ident name".
  it('gives git a user identity from the temp HOME', () => {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }
    delete env.GIT_CONFIG_GLOBAL
    const email = execFileSync('git', ['config', '--global', 'user.email'], { env, encoding: 'utf8' }).trim()
    const name = execFileSync('git', ['config', '--global', 'user.name'], { env, encoding: 'utf8' }).trim()
    expect(email).toBe('test@plur.ai')
    expect(name).toBe('PLUR Test')
  })
})
