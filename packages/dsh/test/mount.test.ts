/**
 * Mounting the plugin the way DeepSeek Harness actually mounts it.
 *
 * Every other suite calls `apply(ctx, config, plur)` directly. That bypasses
 * Cordis's dependency machinery entirely — and Cordis THROWS on merely reading a
 * service that the plugin did not declare in `inject`. A `typeof ctx.skills?.x`
 * guard cannot save you, because the property access throws before the guard
 * runs.
 *
 * That is not hypothetical: it took down a real `dsh --profile test` boot with
 * `cannot get property "skills" without inject`, after 189 green tests, a clean
 * typecheck, a passing conformance suite, and a successful `dsh plugin add`.
 * Booting for real was the only thing that caught it.
 *
 * These tests mount through `ctx.plugin()` so the inject contract is enforced.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.js'

const settle = () => new Promise(r => setTimeout(r, 300))

describe('mounting through ctx.plugin(), as dsh does', () => {
  it('activates on a base composition without throwing', async () => {
    const ctx = new Context() as Context & Record<string, any>
    ctx.plugin(SystemPrompt, {})
    ctx.plugin(Tools, {})
    const fiber = ctx.plugin(plugin, {})
    await expect(Promise.resolve(fiber)).resolves.toBeDefined()
    await settle()
    // Its work is visible: the tool registry accepted our definitions.
    expect(ctx.tools.get('plur_recall')).toBeDefined()
  })

  it('does NOT require a skills registry to be present', async () => {
    // The crash. A minimal profile composes no skill registry, and reading
    // ctx.skills without declaring it kills the whole boot.
    const ctx = new Context() as Context & Record<string, any>
    ctx.plugin(SystemPrompt, {})
    ctx.plugin(Tools, {})
    ctx.plugin(plugin, {})
    await settle()
    expect(ctx.tools.get('plur_status')).toBeDefined()
  })

  it('does NOT require a command registry to be present', async () => {
    const ctx = new Context() as Context & Record<string, any>
    ctx.plugin(SystemPrompt, {})
    ctx.plugin(Tools, {})
    ctx.plugin(plugin, {})
    await settle()
    expect(ctx.tools.get('plur_learn')).toBeDefined()
  })

  it('declares only the services it hard-requires', () => {
    // skills/commands must NOT be here — they mount via scoped ctx.inject(),
    // so the plugin still works on a profile that composes neither.
    expect(plugin.inject).toEqual(['systemPrompt', 'tools'])
  })

  it('mounts with injection disabled without touching the prompt', async () => {
    const ctx = new Context() as Context & Record<string, any>
    ctx.plugin(SystemPrompt, {})
    ctx.plugin(Tools, {})
    ctx.plugin(plugin, { injectionMode: 'off' })
    await settle()
    const assembled = await ctx.systemPrompt.assemble({})
    const names = (assembled.sections as Array<{ name: string }>).map(s => s.name)
    expect(names).not.toContain('plur:memory')
  })

  it('an invalid config stops the plugin activating, rather than half-mounting it', async () => {
    // Cordis does not throw here — it declines to activate the entry. Verified
    // against the real container: a bad config leaves the tool registry empty
    // rather than registering a partially configured plugin.
    const ctx = new Context() as Context & Record<string, any>
    ctx.plugin(SystemPrompt, {})
    ctx.plugin(Tools, {})
    ctx.plugin(plugin, { timeoutMs: 0 })
    await settle()
    expect(ctx.tools.get('plur_recall')).toBeUndefined()
  })

  it('registers /plur-memory on a host that HAS a command registry, and serves it', async () => {
    // The whole viewer path, through real Cordis: a real command registry, the
    // real plugin, a real HTTP server, a real fetch. The unit tests fake the
    // server; this proves the wiring that connects them.
    const seen: Array<{ name: string; execute: () => unknown }> = []
    class Commands extends Service {
      constructor(ctx: Context) { super(ctx, 'commands') }
      register(command: { name: string; execute: () => unknown }): () => void {
        seen.push(command)
        return () => {}
      }
    }

    const ctx = new Context() as Context & Record<string, any>
    ctx.plugin(SystemPrompt, {})
    ctx.plugin(Tools, {})
    ctx.plugin(Commands)
    ctx.plugin(plugin, {})
    await settle()

    const command = seen.find(c => c.name === 'plur-memory')
    expect(command, '/plur-memory was not registered').toBeDefined()

    const output = String(await command!.execute())
    const url = /http:\/\/127\.0\.0\.1:\d+\//.exec(output)?.[0]
    expect(url, `no loopback URL in: ${output}`).toBeDefined()

    const res = await fetch(url!)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('hero-title')

    // Unloading the plugin must release the port, not leak a server.
    await ctx.registry.get(plugin)?.dispose?.()
    await settle()
  })
})
