import { describe, it, expect } from 'vitest'
import { checkLaunchVersion, type ExecFn, type LaunchConfig } from '../src/enterprise/launch-check.js'

const LAUNCH: LaunchConfig = { command: '/usr/local/bin/plur', args: [], env: process.env as NodeJS.ProcessEnv }
const NPX_LAUNCH: LaunchConfig = { command: 'node', args: ['npx', '@plur-ai/mcp', '--'], env: process.env as NodeJS.ProcessEnv }
const NPXCMD_LAUNCH: LaunchConfig = { command: 'C:\\npm\\npx.cmd', args: ['@plur-ai/mcp'], env: process.env as NodeJS.ProcessEnv }

const exec_ok: ExecFn = () => ({ status: 0, stdout: '0.22.0\n' })
const exec_old: ExecFn = () => ({ status: 0, stdout: '0.21.5\n' })
const exec_missing: ExecFn = () => ({ status: 127, stdout: '' })

describe('checkLaunchVersion', () => {
  it('returns ok:true when reported version matches expected', () => {
    expect(checkLaunchVersion('Codex', LAUNCH, '0.22.0', exec_ok)).toEqual({ ok: true })
  })

  it('returns ok:false with the reported version when it does not match', () => {
    expect(checkLaunchVersion('Codex', LAUNCH, '0.22.0', exec_old)).toEqual({
      ok: false,
      reported: '0.21.5',
      detail: 'Codex launches PLUR 0.21.5, expected 0.22.0',
    })
  })

  it('returns ok:false with npx detail when args include npx', () => {
    expect(checkLaunchVersion('OpenCode', NPX_LAUNCH, '0.22.0', exec_missing)).toEqual({
      ok: false,
      reported: null,
      detail: 'OpenCode launches PLUR through npx — re-run `plur init` after installing @plur-ai/mcp',
    })
  })

  it('returns ok:false with npx detail when command ends in npx.cmd', () => {
    expect(checkLaunchVersion('OpenCode', NPXCMD_LAUNCH, '0.22.0', exec_missing)).toEqual({
      ok: false,
      reported: null,
      detail: 'OpenCode launches PLUR through npx — re-run `plur init` after installing @plur-ai/mcp',
    })
  })

  it('returns ok:false with could-not-start detail on status 127', () => {
    const result = checkLaunchVersion('Codex', LAUNCH, '0.22.0', exec_missing)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reported).toBeNull()
      expect(result.detail).toMatch(/could not start/)
    }
  })

  // The npx forms `plur init` itself writes, and npx named by an absolute path.
  // None of them may be executed with --version: for the /bin/sh form the
  // flag would land in $0 and npx would start the server instead.
  const NPX_DETAIL = 'OpenCode launches PLUR through npx — re-run `plur init` after installing @plur-ai/mcp'
  const npxForms: Array<[string, LaunchConfig]> = [
    ['/bin/sh -lc exec npx', { command: '/bin/sh', args: ['-lc', 'exec npx -y @plur-ai/mcp@0.22.0'], env: {} }],
    ['cmd.exe /c npx', { command: 'cmd.exe', args: ['/c', 'npx', '-y', '@plur-ai/mcp@0.22.0'], env: {} }],
    ['absolute posix npx', { command: '/opt/homebrew/bin/npx', args: ['-y', '@plur-ai/mcp'], env: {} }],
    ['absolute windows npx.cmd, upper case', { command: 'C:\\Program Files\\nodejs\\NPX.CMD', args: ['@plur-ai/mcp'], env: {} }],
  ]
  for (const [name, launch] of npxForms) {
    it(`detects npx: ${name}, without running it`, () => {
      let ran = false
      const exec: ExecFn = () => {
        ran = true
        return { status: 0, stdout: '0.22.0\n' }
      }
      expect(checkLaunchVersion('OpenCode', launch, '0.22.0', exec)).toEqual({ ok: false, reported: null, detail: NPX_DETAIL })
      expect(ran).toBe(false)
    })
  }

  it('a path that merely contains "npx" is not an npx launch', () => {
    const launch: LaunchConfig = { command: '/home/alice/npx-tools/plur-mcp', args: [], env: {} }
    expect(checkLaunchVersion('Codex', launch, '0.22.0', exec_ok)).toEqual({ ok: true })
  })

  it('runs the launch command with --version, the tool env and a 15 s timeout', () => {
    const calls: Array<Parameters<ExecFn>> = []
    const exec: ExecFn = (...a) => {
      calls.push(a)
      return { status: 0, stdout: '0.22.0\n' }
    }
    const env = { PATH: '/bin', NODE_EXTRA_CA_CERTS: '/h/.plur/company-ca.pem' }
    checkLaunchVersion('Codex', { command: 'C:\\nodejs\\node.exe', args: ['C:\\npm\\mcp\\dist\\index.js'], env }, '0.22.0', exec)
    expect(calls).toEqual([
      ['C:\\nodejs\\node.exe', ['C:\\npm\\mcp\\dist\\index.js', '--version'], { env, timeoutMs: 15_000 }],
    ])
  })
})
