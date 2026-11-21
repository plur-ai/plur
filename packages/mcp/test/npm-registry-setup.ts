// Every MCP test file starts with npm pointed at a 127.0.0.1 port nothing
// listens on, through an npm configuration of its own (empty user and global
// npmrc, none of the runner's npm_config_* variables). createServer's update
// check runs npm in a child process, which no fetch stub reaches; without this
// it would ask the developer's or CI's real registry. Tests that check the
// update notice opt in with their own mirror (npmSandbox(...).apply()).
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { refusedPort } from '../../core/test/npm-mirror.js'

const dir = mkdtempSync(join(tmpdir(), 'plur-mcp-npmrc-'))
writeFileSync(join(dir, 'npmrc'), '')
const registry = `http://127.0.0.1:${await refusedPort()}/`
for (const k of Object.keys(process.env)) if (/^npm_config_/i.test(k) || k === 'npm_execpath') delete process.env[k]
Object.assign(process.env, {
  npm_config_userconfig: join(dir, 'npmrc'),
  npm_config_globalconfig: join(dir, 'npmrc'),
  npm_config_registry: registry,
  'npm_config_@plur-ai:registry': registry,
})
