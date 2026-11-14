// security audit 2026-11-06: memory-changing slash commands are owner/admin only; /recall hides text from non-owners.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import plugin from '../src/index.js'

function register(p: any = plugin) {
  const dir = mkdtempSync(join(tmpdir(), 'plur-claw-slash-'))
  const commands: Record<string, any> = {}
  const api: any = {
    config: { agents: { defaults: { workspace: dir } } },
    pluginConfig: { path: dir },
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    registerContextEngine() {}, on() {}, registerCli() {}, registerService() {},
    registerCommand: (c: any) => { commands[c.name] = c },
  }
  p.register(api)
  return { commands, dir }
}

describe('claw slash command authority', () => {
  it('sync, packs and forget require operator.admin', () => {
    const { commands, dir } = register()
    for (const n of ['sync', 'packs', 'forget']) expect(commands[n]?.requiredScopes).toEqual(['operator.admin'])
    expect(commands.recall?.requiredScopes).toEqual(['operator.read'])
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

  // Goes through OpenClaw's own executePluginCommand (the installed devDependency), which only
  // passes senderIsOwner to commands that declare requiredScopes.
  it('/recall through OpenClaw: owner sees text, non-owner never does', async () => {
    const exec = await loadOpenClawExecutePluginCommand()
    // The plugin caches one engine per module; load a fresh copy so it opens this test's store.
    vi.resetModules()
    const { commands, dir } = register((await import('../src/index.js')).default)
    await commands.learn.handler({ args: 'DUMMY-SLASH-MARKER always use pnpm', senderIsOwner: true })
    const run = (extra: Record<string, unknown>) => exec({
      command: { ...commands.recall, pluginId: 'plur' }, args: 'DUMMY-SLASH-MARKER pnpm',
      senderId: 'u1', channel: 'telegram', isAuthorizedSender: true,
      commandBody: '/recall DUMMY-SLASH-MARKER pnpm', config: {}, ...extra,
    })
    expect((await run({ senderIsOwner: true })).text).toContain('DUMMY-SLASH-MARKER')
    expect((await run({ senderIsOwner: true, gatewayClientScopes: ['operator.read'] })).text).toContain('DUMMY-SLASH-MARKER')
    const nonOwnerGateway = await run({ senderIsOwner: false, gatewayClientScopes: ['operator.read'] })
    expect(nonOwnerGateway.text).toMatch(/^Found \d+ memories\. Only the owner/)
    expect((await run({ senderIsOwner: false })).text).not.toContain('DUMMY-SLASH-MARKER')
    rmSync(dir, { recursive: true, force: true })
  })
})

async function loadOpenClawExecutePluginCommand(): Promise<(p: any) => Promise<any>> {
  const distDir = fileURLToPath(new URL('../node_modules/openclaw/dist', import.meta.url))
  for (const f of readdirSync(distDir)) {
    if (!/^commands-.*\.js$/.test(f)) continue
    const src = readFileSync(join(distDir, f), 'utf8')
    const m = src.match(/executePluginCommand as (\w+)\b/)
    if (!src.includes('async function executePluginCommand') || !m) continue
    const mod = await import(pathToFileURL(join(distDir, f)).href)
    return mod[m[1]]
  }
  throw new Error('executePluginCommand not found in the installed openclaw dist')
}
