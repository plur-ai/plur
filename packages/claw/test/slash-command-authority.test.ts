// security audit 2026-11-06: memory-changing slash commands are owner/admin only; /recall hides text from non-owners.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import plugin from '../src/index.js'

function register() {
  const dir = mkdtempSync(join(tmpdir(), 'plur-claw-slash-'))
  const commands: Record<string, any> = {}
  const api: any = {
    config: { agents: { defaults: { workspace: dir } } },
    pluginConfig: { path: dir },
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    registerContextEngine() {}, on() {}, registerCli() {}, registerService() {},
    registerCommand: (c: any) => { commands[c.name] = c },
  }
  plugin.register(api)
  return { commands, dir }
}

describe('claw slash command authority', () => {
  it('sync, packs and forget require operator.admin', () => {
    const { commands, dir } = register()
    for (const n of ['sync', 'packs', 'forget']) expect(commands[n]?.requiredScopes).toEqual(['operator.admin'])
    expect(commands.recall?.requiredScopes).toBeUndefined()
    rmSync(dir, { recursive: true, force: true })
  })

  it('/recall shows only a count to a non-owner', async () => {
    const { commands, dir } = register()
    await commands.learn.handler({ args: 'DUMMY-SLASH-MARKER always use pnpm', senderIsOwner: true })
    const other = await commands.recall.handler({ args: 'DUMMY-SLASH-MARKER pnpm', senderIsOwner: false })
    expect(other.text).not.toContain('DUMMY-SLASH-MARKER')
    const owner = await commands.recall.handler({ args: 'DUMMY-SLASH-MARKER pnpm', senderIsOwner: true })
    expect(owner.text).toContain('DUMMY-SLASH-MARKER')
    rmSync(dir, { recursive: true, force: true })
  })
})
