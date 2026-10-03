/**
 * #1564 review M2: `plur login --status` for a store whose token_env variable
 * is unset tells the user to set that variable — never to paste a token into
 * config.yaml or re-authenticate.
 */
import { describe, it, expect } from 'vitest'
import { buildStatusReport } from '../src/commands/login.js'

describe('login --status with an unset token_env variable (#1564 review M2)', () => {
  it('the remediation names the variable', () => {
    const report = buildStatusReport([{
      url: 'https://plur.example.com', scopes: ['group:o/eng'], status: 'auth_expired', ok: false,
      tokenEnvUnset: 'PLUR_TEAM_TOK', reason: 'unset',
    }])
    const r = report.hosts[0].remediation ?? ''
    expect(r).toContain('PLUR_TEAM_TOK')
    expect(r).not.toMatch(/config\.yaml|re-add|sign in/)
  })
})
