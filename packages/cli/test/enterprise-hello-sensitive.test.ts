import { expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'
import { StubServer } from '../../core/test/helpers/stub-server.js'
import { builtCliPath } from './helpers/built-cli.js'
import { runHello } from '../src/enterprise/hello.js'

it.each([true, false])('reports a real privacy refusal honestly (sensitive=%s)', async sensitive => {
  const dir = mkdtempSync(join(tmpdir(), 'hello-sensitive-')), home = join(dir, 'home'), store = join(home, '.plur')
  mkdirSync(store, { recursive: true })
  const server = new StubServer('synthetic-hello-token')
  try {
    const { url } = await server.start()
    server.setMe({ username: 'member', org_id: 'example', scopes: ['user:example:member'] })
    writeFileSync(join(store, 'config.yaml'), yaml.dump({ index: false, embeddings: { enabled: false }, stores: [{ url, token: 'synthetic-hello-token', scope: 'user:example:member' }] }))
    const result = await runHello({ serverUrl: url, personalScope: 'user:example:member',
      statement: sensitive ? 'Connection check for workstation.internal' : 'Connection check for this device',
      launches: [{ tool: 'codex', launch: { command: process.execPath, args: [builtCliPath(join(__dirname, '..', '..', 'mcp'))],
        env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, PLUR_PATH: store, PLUR_DISABLE_EMBEDDINGS: '1', PLUR_AUTO_DISCOVER: '0' } } }] })
    expect(result.saved.ok).toBe(!sensitive)
    expect(server.appendStatements).toHaveLength(sensitive ? 0 : 1)
    if (sensitive) {
      expect(result.saved).toMatchObject({ ok: false, reason: expect.stringContaining('privacy check kept sensitive content on this device') })
      expect(JSON.stringify(result.saved)).not.toContain('workstation.internal')
      expect(result.perTool).toEqual([])
    }
  } finally { await server.stop(); rmSync(dir, { recursive: true, force: true }) }
}, 60000)
