import { expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { setupFixture } from '../helpers/enterprise-setup.js'

it('EFI-13 an old installation upgrades without discarding its backup or installing two identities', async () => {
  const f = await setupFixture(true)
  try {
    const result = await f.run()
    expect(result.ok, `The actual legacy installation must be upgraded: ${JSON.stringify(result)}`).toBe(true)
    const config = yaml.load(readFileSync(f.configFile, 'utf8')) as any
    expect(config.stores.filter((s: any) => s.url === f.server.url), 'Upgrade must leave one server identity').toHaveLength(1)
    expect(readFileSync(f.configFile, 'utf8'), 'The old rejected credential must leave the active config').not.toContain(f.server.state.oldKey)
    expect(result.backupDir, 'Upgrade must give the user a backup path').toBeTruthy()
    expect(readFileSync(join(result.backupDir!, 'config.yaml'), 'utf8'), 'The backup must actually retain the original credential').toContain(f.server.state.oldKey)
    expect(existsSync(join(f.store, 'mcp-enterprise-header')), 'A fully proven upgrade must remove the obsolete header file').toBe(false)
    expect(f.server.state.writes.length, 'Migration success requires an actual accepted hello').toBeGreaterThan(0)
  } finally { await f.close() }
})

it('EFI-13 a tool still launching the old client is explicitly unproven and retains its old entry', async () => {
  const f = await setupFixture(true), oldDir = join(f.home, 'older/packages/mcp/dist')
  mkdirSync(oldDir, { recursive: true }); const old = join(oldDir, 'index.js')
  writeFileSync(old, 'console.log("0.19.4")\n')
  try {
    const result = await f.run((command, args, opts) => {
      const run = f.exec(command, args, opts)
      if (args.includes('init') && run.status === 0) {
        mkdirSync(f.env.CODEX_HOME, { recursive: true })
        writeFileSync(join(f.env.CODEX_HOME, 'config.toml'), `[mcp_servers.plur]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(old)}]\n[mcp_servers.plur-enterprise]\ncommand = "mcp-remote"\nargs = ["${f.server.url}/mcp"]\n`)
      }
      return run
    })
    expect(result.ok, 'A split installation must not be called successful').toBe(false)
    expect(result.tools.find(t => t.tool === 'codex')?.version, 'The failing tool must identify the version it really launches').toMatchObject({ ok: false, reported: '0.19.4' })
    expect(readFileSync(join(f.env.CODEX_HOME, 'config.toml'), 'utf8'), 'The unproven tool must retain its old entry for recovery').toContain('[mcp_servers.plur-enterprise]')
  } finally { await f.close() }
})
