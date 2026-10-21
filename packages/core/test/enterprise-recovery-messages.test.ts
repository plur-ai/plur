import { expect, it } from 'vitest'
import { enterpriseRecoveryHint } from '../src/enterprise.js'
import { doctorRemoteRemediation, hookRemoteHeaderLine, mcpRemoteWarningLine } from '../src/remote-recall.js'

const host = 'https://plur.example.com'
it('names the setup command and device-key recovery outcome', () => {
  expect(enterpriseRecoveryHint(host)).toBe('run `plur-enterprise init` again — it adds a new key for this device and sends the queued saves (server: https://plur.example.com)')
})
it.each(['auth_expired', 'forbidden'] as const)('enterprise %s recovery uses the setup command on every surface', status => {
  const outcome = { host, status, enterprise: true }
  for (const line of [mcpRemoteWarningLine(outcome), hookRemoteHeaderLine(outcome), doctorRemoteRemediation(outcome)]) {
    expect(line).toContain('plur-enterprise init')
    expect(line).not.toContain('plur_stores_add')
    expect(line).not.toContain('/auth')
  }
})
it('leaves legacy authentication recovery text unchanged', () => {
  const outcome = { host, status: 'auth_expired' as const }
  expect(mcpRemoteWarningLine(outcome)).toBe(`${host}: token expired or revoked — team engrams unavailable; serving local only; tell the user to sign in at ${host}/auth and re-add the store via plur_stores_add.`)
  expect(hookRemoteHeaderLine(outcome)).toBe(`[PLUR] ${host}: token expired or revoked — sign in at ${host}/auth and re-add via plur_stores_add.`)
  expect(doctorRemoteRemediation(outcome)).toBe(`Remote ${host}: token expired or revoked — sign in at ${host}/auth and re-add the store via plur_stores_add (see the onboarding doc). Note: \`plur login\` does not work against enterprise servers.`)
})
