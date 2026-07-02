import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}))

import { execSync } from 'child_process'
import { checkGlobalInstall, formatGlobalInstallWarning } from '../src/global-install.js'

const mockExecSync = vi.mocked(execSync)

afterEach(() => vi.clearAllMocks())

describe('checkGlobalInstall', () => {
  it('returns found:false when no global packages installed', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('not found')
    })
    const result = checkGlobalInstall()
    expect(result.found).toBe(false)
    expect(result.packages).toEqual([])
    expect(result.plurBinaryPath).toBeNull()
  })

  it('detects a single globally installed package', () => {
    mockExecSync.mockImplementation((cmd: unknown) => {
      const c = cmd as string
      if (c.includes('@plur-ai/mcp') && !c.includes('which')) {
        return '/opt/homebrew/lib\n└── @plur-ai/mcp@0.7.7\n'
      }
      throw new Error('not found')
    })
    const result = checkGlobalInstall()
    expect(result.found).toBe(true)
    expect(result.packages).toEqual([{ name: '@plur-ai/mcp', version: '0.7.7' }])
  })

  it('detects both packages when both are globally installed', () => {
    mockExecSync.mockImplementation((cmd: unknown) => {
      const c = cmd as string
      if (c.includes('@plur-ai/mcp') && !c.startsWith('which')) {
        return '/opt/homebrew/lib\n└── @plur-ai/mcp@0.9.0\n'
      }
      if (c.includes('@plur-ai/cli') && !c.startsWith('which')) {
        return '/opt/homebrew/lib\n└── @plur-ai/cli@0.9.0\n'
      }
      throw new Error('not found')
    })
    const result = checkGlobalInstall()
    expect(result.found).toBe(true)
    expect(result.packages).toHaveLength(2)
    expect(result.packages[0]).toEqual({ name: '@plur-ai/mcp', version: '0.9.0' })
    expect(result.packages[1]).toEqual({ name: '@plur-ai/cli', version: '0.9.0' })
  })

  it('detects global binary via which', () => {
    mockExecSync.mockImplementation((cmd: unknown) => {
      const c = cmd as string
      if (c.startsWith('which')) return '/opt/homebrew/bin/plur'
      throw new Error('not found')
    })
    const result = checkGlobalInstall()
    expect(result.found).toBe(true)
    expect(result.plurBinaryPath).toBe('/opt/homebrew/bin/plur')
  })

  it('ignores which result that is not on a global path', () => {
    mockExecSync.mockImplementation((cmd: unknown) => {
      const c = cmd as string
      if (c.startsWith('which')) return '/home/user/.local/bin/plur'
      throw new Error('not found')
    })
    const result = checkGlobalInstall()
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
  ])('detects global binary installed via %s', (_manager, path) => {
    mockExecSync.mockImplementation((cmd: unknown) => {
      const c = cmd as string
      if (c.startsWith('which')) return path
      throw new Error('not found')
    })
    const result = checkGlobalInstall()
    expect(result.found).toBe(true)
    expect(result.plurBinaryPath).toBe(path)
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
