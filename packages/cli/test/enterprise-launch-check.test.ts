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
})
