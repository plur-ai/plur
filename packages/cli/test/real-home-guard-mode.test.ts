import { describe, expect, it } from 'vitest'
import { resolveGuardMode } from './setup/real-home-guard.js'

// The real-home guard fails the run in CI and only warns on a workstation,
// where live PLUR clients (MCP servers, editor hooks) legitimately write to the
// real store while the suite runs. PLUR_TEST_HOME_GUARD always wins.
describe('real-home guard mode', () => {
  it('fails under CI=true', () => {
    expect(resolveGuardMode({ CI: 'true' })).toBe('fail')
  })

  it('fails under CI=1', () => {
    expect(resolveGuardMode({ CI: '1' })).toBe('fail')
  })

  it('warns when CI is unset', () => {
    expect(resolveGuardMode({})).toBe('warn')
  })

  it('warns when CI is empty or false', () => {
    expect(resolveGuardMode({ CI: '' })).toBe('warn')
    expect(resolveGuardMode({ CI: 'false' })).toBe('warn')
    expect(resolveGuardMode({ CI: '0' })).toBe('warn')
  })

  it('lets PLUR_TEST_HOME_GUARD override the default either way', () => {
    expect(resolveGuardMode({ CI: 'true', PLUR_TEST_HOME_GUARD: 'warn' })).toBe('warn')
    expect(resolveGuardMode({ CI: 'true', PLUR_TEST_HOME_GUARD: 'off' })).toBe('off')
    expect(resolveGuardMode({ PLUR_TEST_HOME_GUARD: 'fail' })).toBe('fail')
    expect(resolveGuardMode({ PLUR_TEST_HOME_GUARD: 'off' })).toBe('off')
  })

  it('ignores an unrecognised override and falls back to the CI default', () => {
    expect(resolveGuardMode({ CI: 'true', PLUR_TEST_HOME_GUARD: 'loud' })).toBe('fail')
    expect(resolveGuardMode({ PLUR_TEST_HOME_GUARD: 'loud' })).toBe('warn')
  })
})
