import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { enterpriseFixture } from './enterprise-install.js'
import { REPO } from './agent-tools-hooks-cli.js'
import { migrationServer } from '../../packages/cli/test/helpers/migration-server.js'
import { runEnterpriseInit } from '../../packages/cli/src/enterprise/init.js'
import type { ExecFn } from '../../packages/cli/src/enterprise/exec.js'

export async function setupFixture(legacy = false) {
  const f = await enterpriseFixture(), server = await migrationServer()
  if (legacy) cpSync(join(REPO, 'packages/cli/test/fixtures/enterprise/home-0194'), f.home, { recursive: true })
  const configFile = join(f.store, 'config.yaml')
  writeFileSync(configFile, JSON.stringify({ index: false, embeddings: { enabled: false }, stores: legacy ? [
    { url: server.url, token: server.state.oldKey, scope: 'user:example:member' },
  ] : [] }))
  if (legacy) writeFileSync(join(f.store, 'mcp-enterprise-header'), `Authorization: Bearer ${server.state.oldKey}\n`)
  const exec: ExecFn = (command, args, options) => {
    const r = spawnSync(command, args, { cwd: f.home, env: options?.env, input: options?.input,
      encoding: 'utf8', timeout: options?.timeoutMs, killSignal: 'SIGKILL' })
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  }
  const run = (execute = exec) => runEnterpriseInit({ server: server.url, mode: 'full', tokenStdin: false, json: true, noBrowser: true }, {
    home: f.home, env: f.env, exec: execute, fetch, sleep: async () => {}, hostname: () => 'fixture-device',
    platform: process.platform, cliEntry: join(REPO, 'packages/cli/dist/index.js'), print: () => {},
  })
  return { ...f, server, configFile, run, exec, async close() { await server.close(); await f.close() } }
}
