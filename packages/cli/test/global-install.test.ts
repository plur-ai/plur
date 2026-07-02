import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('child_process', () => ({
  exec: vi.fn(),
}))

import { exec } from 'child_process'
import { checkGlobalInstall, formatGlobalInstallWarning } from '../src/global-install.js'

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void

const mockExec = vi.mocked(exec)

/** Answer each subprocess by command string; return an Error to simulate failure. */
function mockCommands(respond: (cmd: string) => string | Error) {
  mockExec.mockImplementation(((cmd: string, _opts: unknown, cb: ExecCallback) => {
    const result = respond(cmd)
    // Deliver asynchronously, like real exec
    queueMicrotask(() => {
      if (result instanceof Error) cb(result, '', '')
      else cb(null, result, '')
    })
    return undefined as never
  }) as never)
}

afterEach(() => vi.clearAllMocks())

describe('checkGlobalInstall', () => {
  it('returns found:false when no global packages installed', async () => {
    mockCommands(() => new Error('not found'))
    const result = await checkGlobalInstall()
    expect(result.found).toBe(false)
    expect(result.packages).toEqual([])
    expect(result.plurBinaryPath).toBeNull()
  })

  it('detects a single globally installed package', async () => {
    mockCommands((c) => {
      if (c.includes('@plur-ai/mcp') && !c.startsWith('which')) {
        return '/opt/homebrew/lib\n└── @plur-ai/mcp@0.7.7\n'
      }
      return new Error('not found')
    })
    const result = await checkGlobalInstall()
    expect(result.found).toBe(true)
    expect(result.packages).toEqual([{ name: '@plur-ai/mcp', version: '0.7.7' }])
  })

  it('detects both packages when both are globally installed', async () => {
    mockCommands((c) => {
      if (c.includes('@plur-ai/mcp') && !c.startsWith('which')) {
        return '/opt/homebrew/lib\n└── @plur-ai/mcp@0.9.0\n'
      }
      if (c.includes('@plur-ai/cli') && !c.startsWith('which')) {
        return '/opt/homebrew/lib\n└── @plur-ai/cli@0.9.0\n'
      }
      return new Error('not found')
    })
    const result = await checkGlobalInstall()
    expect(result.found).toBe(true)
    expect(result.packages).toHaveLength(2)
    expect(result.packages[0]).toEqual({ name: '@plur-ai/mcp', version: '0.9.0' })
    expect(result.packages[1]).toEqual({ name: '@plur-ai/cli', version: '0.9.0' })
  })

  it('detects global binary via which', async () => {
    mockCommands((c) => (c.startsWith('which') ? '/opt/homebrew/bin/plur\n' : new Error('not found')))
    const result = await checkGlobalInstall()
    expect(result.found).toBe(true)
    expect(result.plurBinaryPath).toBe('/opt/homebrew/bin/plur')
  })

  it('ignores which result that is not on a global path', async () => {
    mockCommands((c) => (c.startsWith('which') ? '/home/user/.local/bin/plur' : new Error('not found')))
    const result = await checkGlobalInstall()
    expect(result.found).toBe(false)
    expect(result.plurBinaryPath).toBeNull()
  })

  // Issue #190 — version-manager global installs (nvm/fnm/volta) must be detected
  it.each([
    ['nvm', '/Users/dev/.nvm/versions/node/v20.11.1/bin/plur'],
    ['volta', '/Users/dev/.volta/bin/plur'],
    ['fnm (macOS data dir)', '/Users/dev/Library/Application Support/fnm/node-versions/v20.12.2/installation/bin/plur'],
    ['fnm (Linux data dir)', '/home/dev/.local/share/fnm/node-versions/v20.12.2/installation/bin/plur'],
    ['fnm (multishell symlink)', '/run/user/1000/fnm_multishells/12345_1700000000000/bin/plur'],
  ])('detects global binary installed via %s', async (_manager, path) => {
    mockCommands((c) => (c.startsWith('which') ? path : new Error('not found')))
    const result = await checkGlobalInstall()
    expect(result.found).toBe(true)
    expect(result.plurBinaryPath).toBe(path)
  })

  // Issue #191 — subprocess checks must run concurrently, not serially.
  // Serial execSync meant up to 5s + 5s + 2s of blocking on the startup path.
  it('dispatches all subprocess checks before any completes (#191)', async () => {
    const pending: ExecCallback[] = []
    mockExec.mockImplementation(((_cmd: string, _opts: unknown, cb: ExecCallback) => {
      pending.push(cb)
      return undefined as never
    }) as never)

    const promise = checkGlobalInstall()
    // 2x `npm list` + 1x `which` all started before the first one answers.
    // A serial implementation would show 1 here.
    expect(pending).toHaveLength(3)
    for (const cb of pending) cb(new Error('not found'), '', '')
    const result = await promise
    expect(result.found).toBe(false)
  })

  it('bounds every subprocess with a timeout', async () => {
    const timeouts: number[] = []
    mockExec.mockImplementation(((_cmd: string, opts: { timeout?: number }, cb: ExecCallback) => {
      timeouts.push(opts?.timeout ?? 0)
      queueMicrotask(() => cb(new Error('not found'), '', ''))
      return undefined as never
    }) as never)
    await checkGlobalInstall()
    expect(timeouts).toHaveLength(3)
    for (const t of timeouts) expect(t).toBeGreaterThan(0)
  })
})

describe('formatGlobalInstallWarning', () => {
  it('returns empty array when nothing found', () => {
    const lines = formatGlobalInstallWarning({ found: false, packages: [], plurBinaryPath: null })
    expect(lines).toHaveLength(0)
  })

  it('includes package name + version and remediation command', () => {
    const lines = formatGlobalInstallWarning({
      found: true,
      packages: [{ name: '@plur-ai/mcp', version: '0.7.7' }],
      plurBinaryPath: null,
    })
    const joined = lines.join('\n')
    expect(joined).toContain('@plur-ai/mcp@0.7.7')
    expect(joined).toContain('npm uninstall -g')
  })

  it('includes binary path when detected', () => {
    const lines = formatGlobalInstallWarning({
      found: true,
      packages: [],
      plurBinaryPath: '/opt/homebrew/bin/plur',
    })
    const joined = lines.join('\n')
    expect(joined).toContain('/opt/homebrew/bin/plur')
    expect(joined).toContain('npm uninstall -g')
  })

  it('lists all detected packages', () => {
    const lines = formatGlobalInstallWarning({
      found: true,
      packages: [
        { name: '@plur-ai/mcp', version: '0.7.7' },
        { name: '@plur-ai/cli', version: '0.7.7' },
      ],
      plurBinaryPath: null,
    })
    const joined = lines.join('\n')
    expect(joined).toContain('@plur-ai/mcp@0.7.7')
    expect(joined).toContain('@plur-ai/cli@0.7.7')
  })
})
