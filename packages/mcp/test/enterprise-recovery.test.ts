import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '@plur-ai/core'
import { getToolDefinitions } from '../src/tools.js'
import { StubServer } from '../../core/test/helpers/stub-server.js'
import { discoveryWarnings } from '../src/background-discovery.js'

let root: string, plur: Plur, stub: StubServer
const scope = 'group:example/eng'
const soon = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3 * 86400 })).toString('base64url')}.fixture`
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'plur-enterprise-recovery-'))
  stub = new StubServer(soon)
  const { url } = await stub.start()
  writeFileSync(join(root, 'config.yaml'), JSON.stringify({ index: false, embeddings: { enabled: false }, stores: [{ url,
    token: soon, scope, scopes: [scope], enterprise: {}, discovery: { status: 'ok', org_id: 'example', discovered_at: new Date().toISOString() } }] }))
  plur = new Plur({ path: root, autoDiscover: false })
})
afterEach(async () => { plur.close(); await stub.stop(); rmSync(root, { recursive: true, force: true }) })
const call = (name: string) => getToolDefinitions('full').find(t => t.name === name)!.handler({ task: 'Plan deployment' }, plur) as Promise<any>
it('doctor expiry advice uses enterprise setup rather than manual key editing', async () => {
  const result = await call('plur_doctor')
  const advice = result.remediation.join(' ')
  expect(advice).toContain('plur-enterprise init')
  expect(advice).not.toContain('/me/api-keys')
})
it('doctor rejected-key advice uses enterprise setup', async () => {
  stub.meStatus = 401
  const result = await call('plur_doctor')
  expect(result.remediation.join(' ')).toContain('plur-enterprise init')
  expect(result.remediation.join(' ')).not.toContain('/auth/github')
})
it('session-start expiry advice uses enterprise setup', async () => {
  const result = await call('plur_session_start')
  expect(result.guide).toContain('plur-enterprise init')
  expect(result.guide).not.toContain('/me/api-keys')
})
it('background discovery key-refusal advice names the same setup command', () => {
  expect(discoveryWarnings([{ url: 'https://plur.example.com', status: 'auth_failed', scopes: 0 }]).join(' ')).toContain('plur-enterprise init')
})
async function mixedKeys() {
  const url = plur.remoteEndpointTokenGroups()[0].url
  plur.close()
  writeFileSync(join(root, 'config.yaml'), JSON.stringify({ index: false, embeddings: { enabled: false }, stores: [
    { url, token: soon, scope: 'group:example/legacy' },
    { url, token: 'fixture-enterprise-key', scopes: [scope], enterprise: {}, discovery: { status: 'ok' } },
  ] }))
  plur = new Plur({ path: root, autoDiscover: false })
}
it('doctor retains legacy expiry advice when a different enterprise key shares the endpoint', async () => {
  await mixedKeys()
  const result = await call('plur_doctor')
  const expiryAdvice = result.remediation.find((s: string) => s.includes('expires in'))
  expect(expiryAdvice).toContain('/me/api-keys')
  expect(expiryAdvice).not.toContain('plur-enterprise init')
})
it('session expiry retains legacy advice when a different enterprise key shares the endpoint', async () => {
  await mixedKeys()
  const result = await call('plur_session_start')
  const expiryLine = result.guide.split('\n').find((s: string) => s.includes('expires in'))
  expect(expiryLine).toContain('/me/api-keys')
  expect(expiryLine).not.toContain('plur-enterprise init')
})
