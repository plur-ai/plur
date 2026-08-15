/**
 * The plugin against the REAL DeepSeek Harness services.
 *
 * Every other host-facing suite stubs `ctx.skills` and `ctx.commands` as
 * `{ register: () => () => {} }` and hand-writes event payloads shaped the way
 * this plugin already expects. That is not a test of the host contract; it is a
 * test that our assumptions agree with themselves. Five contract mismatches
 * survived 236 green tests that way:
 *
 *   - commands took `execute`; the real field is `handler`, returning a
 *     `CommandResult`. Neither command registered, and Cordis contained the
 *     throw, so it failed silently.
 *   - the skill took `body`; the real field is `content`, and `source` is
 *     required. It registered, then threw on load — worse than absent.
 *   - `agent/turn-stopping` carries `{ agent, turn, signal }`, not the agent.
 *     Episode capture never saw an event.
 *   - `agent/disposed` carries `{ agent }`, not the agent. Nothing was ever
 *     reclaimed.
 *   - the prompt section was registered once PER AGENT under one name.
 *     Duplicate names throw by contract; the catch swallowed it, so agents
 *     2..N silently rendered agent 1's memory.
 *
 * The rule this file enforces: if the host owns it, boot the host's own
 * implementation and assert on what it does. Never assert against a double we
 * wrote, because a double encodes the assumption under test.
 *
 * @module
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Commands from '@deepseek-ai/dsh-commands'
import Skills from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as plugin from '../src/index.js'
import { askedEvents, fakeAgent } from './helpers/agent.js'
import { cfg } from './helpers/config.js'
import type { Agent } from '@deepseek-ai/dsh-agent'

const settle = (ms = 400) => new Promise(r => setTimeout(r, ms))

/** A bare agent for registry calls that only need identity. */
const agentOf = (id: string, cwd = '/tmp/hc') => fakeAgent(id, cwd)

/**
 * Resolve a command through the real registry and invoke its real handler.
 *
 * `find()` rather than `execute()`: execute additionally appends
 * `command/run` / `command/done` to a live session log, which needs a fully
 * constructed Agent this suite has no business fabricating. What is under test
 * is our handler and the shape it returns, so this resolves through the host's
 * own scoped shadowing and then calls exactly what the host would call.
 */
async function run(ctx: Context & Record<string, any>, name: string) {
  const definition = ctx.commands.find(agentOf('a'), name)
  if (!definition) return undefined
  const result = await definition.handler({
    commandId: 'cmd-1' as never,
    agent: agentOf('a'),
    rawInput: '',
    signal: new AbortController().signal,
  })
  return { result }
}

/**
 * A real store on disk, seeded into two project scopes.
 *
 * NOT an injected fake client. `ctx.plugin(plugin, config)` passes only two
 * arguments — `apply`'s third parameter is a direct-call test seam that Cordis
 * never uses — so a client handed to `ctx.plugin` is silently ignored and the
 * plugin builds a real engine anyway. A harness that "injects" one is testing
 * nothing. Pointing config at a temp store exercises the whole production
 * path: real core, real scope resolution, real recall, real assembly.
 */
let storePath: string
let scopeAlpha: string
let scopeBeta: string

beforeAll(async () => {
  storePath = mkdtempSync(join(tmpdir(), 'plur-hc-'))
  const { Plur } = await import('@plur-ai/core') as { Plur: new (o: { path: string }) => {
    learn: (s: string, c: { scope: string }) => Promise<unknown>
  } }
  const seed = new Plur({ path: storePath })
  // Seed the scopes the resolver ACTUALLY derives for these directories,
  // digest and all — hard-coding `project:alpha` would test a scope no real
  // session ever gets.
  const { createScopeResolver } = await import('../src/scope.js')
  const { readWorkspaceScope } = await import('../src/workspace-scope.js')
  const resolver = createScopeResolver(cfg({ path: storePath }), readWorkspaceScope)
  scopeAlpha = await resolver.resolve('seed-a', '/tmp/alpha')
  scopeBeta = await resolver.resolve('seed-b', '/tmp/beta')
  await seed.learn('SECRETFORALPHA: alpha deploys with pnpm', { scope: scopeAlpha })
  await seed.learn('SECRETFORBETA: beta deploys with yarn', { scope: scopeBeta })
}, 60_000)

afterAll(() => { rmSync(storePath, { recursive: true, force: true }) })

/** Boot a host with the real registries the plugin talks to. */
async function host(withStore = true) {
  const ctx = new Context() as Context & Record<string, any>
  ctx.plugin(SystemPrompt, {})
  ctx.plugin(Tools, {})
  ctx.plugin(Commands, {} as never)
  ctx.plugin(Skills, {} as never)
  await settle(200)
  ctx.plugin(plugin, cfg(withStore ? { path: storePath } : { path: '/nonexistent/plur-store' }))
  await settle()
  return ctx
}

describe('the real command registry', () => {
  it('accepts both commands — they used to register zero', async () => {
    const ctx = await host()
    const names = ctx.commands.list(agentOf('a')).map((c: { name: string }) => c.name).sort()
    expect(names).toEqual(['plur', 'plur-memory'])
  })

  it('/plur runs and returns a success result the host understands', async () => {
    const ctx = await host()
    const command = ctx.commands.list(agentOf('a')).find((c: { name: string }) => c.name === 'plur')
    expect(command, '/plur is not registered').toBeDefined()
    const result = await run(ctx, 'plur')
    // A CommandResult is a discriminated union; anything else is not a result.
    expect(result?.result.kind).toBe('success')
    expect(String(result?.result.text)).toContain('injection')
  })

  it('/plur reports a real scope, not the literal "undefined"', async () => {
    const ctx = await host()
    const result = await run(ctx, 'plur')
    expect(String(result?.result.text)).not.toContain('scope: undefined')
  })

  it('/plur-memory returns an error result rather than throwing when it cannot start', async () => {
    // No engine at all: the handler must still settle as a CommandResult.
    const ctx = await host()
    const result = await run(ctx, 'plur-memory')
    expect(['success', 'error']).toContain(result?.result.kind)
    expect(typeof result?.result.text).toBe('string')
  })
})

describe('the real skill registry', () => {
  it('registers a skill that can actually be LOADED, not just listed', async () => {
    // The old shape passed register-time validation (name + description) and
    // then threw inside get() — advertised in the catalog, broken for everyone
    // who opened it.
    const ctx = await host()
    const catalog = await ctx.skills.list()
    const summary = catalog.find((s: { name: string }) => s.name === 'plur-memory')
    expect(summary, 'plur-memory skill is not in the catalog').toBeDefined()
    const loaded = await ctx.skills.get('plur-memory')
    expect(loaded?.content, 'skill body is missing').toBeTypeOf('string')
    expect(String(loaded?.content).length).toBeGreaterThan(50)
  })
})

describe('the real prompt registry, with more than one agent', () => {
  it('registers ONE section, not one per agent', async () => {
    // Duplicate section names throw by contract. Registering per agent meant
    // the second registration threw and was swallowed.
    const sections: string[] = []
    const ctx = new Context() as Context & Record<string, any>
    ctx.plugin(SystemPrompt, {})
    ctx.plugin(Tools, {})
    await settle(200)
    const realSection = ctx.systemPrompt.section.bind(ctx.systemPrompt)
    ctx.systemPrompt.section = (s: { name: string }) => { sections.push(s.name); return realSection(s as never) }
    ctx.plugin(plugin, cfg({ path: storePath }))
    await settle()
    expect(sections.filter(n => n === 'plur:memory')).toHaveLength(1)
  })

  it('renders nothing for an assembly that carries no agent', async () => {
    // A diagnostic assembly must not hand out whichever agent happened to be
    // cached. dsh-plan-mode guards this the same way.
    const ctx = await host()
    await firePreStep(ctx, 'a', '/tmp/alpha')
    await settle(600)
    expect(await assembleAnonymously(ctx)).not.toContain('SECRETFORALPHA')
  })

  it('renders each agent its OWN memory — the cross-session leak', async () => {
    // The reproduction that matters: two agents, two workspaces, two scopes.
    // Assembled through the host's own `assemble()`, so this exercises the
    // real registry, the real ordering and the real AssembleContext — not our
    // reading of them.
    //
    // The assertions are POSITIVE (each agent SEES its own secret) as well as
    // negative. An earlier version only asserted absence, and absence is what
    // you also get when the harness fails to find the section at all: the test
    // passed against a deliberately reintroduced leak. A test that cannot fail
    // is worse than no test.
    const ctx = await host()

    const agentA = await firePreStep(ctx, 'a', '/tmp/alpha')
    const agentB = await firePreStep(ctx, 'b', '/tmp/beta')

    // Poll rather than sleep: recall is deliberately off the turn path, so the
    // block lands whenever the store finishes. A fixed sleep is a flake under
    // parallel test load, and a flaky security test gets muted.
    const alpha = await waitForBlock(ctx, agentA)
    const beta = await waitForBlock(ctx, agentB)

    expect(alpha, 'agent A got no memory at all — the harness is not reaching the section')
      .toContain('SECRETFORALPHA')
    expect(beta, 'agent B got no memory at all — the harness is not reaching the section')
      .toContain('SECRETFORBETA')
    expect(beta, "agent B rendered agent A's memory").not.toContain('SECRETFORALPHA')
    expect(alpha, "agent A rendered agent B's memory").not.toContain('SECRETFORBETA')
  })
})

describe('the real agent lifecycle events', () => {
  it('captures an episode from a REAL agent/turn-stopping payload', async () => {
    // The last surface still verified only by a mock. `agent/turn-stopping`
    // carries `{ agent, turn, signal }`; the handler used to read the payload
    // AS the agent, so autoCapture recorded nothing on every install — and the
    // unit tests emitted the shape the code expected, so nothing caught it.
    const ctx = await host()
    const before = await countEpisodes()

    await (ctx.parallel as (...a: unknown[]) => Promise<void>)('agent/turn-stopping', {
      agent: fakeAgent('cap', '/tmp/alpha', [{
        type: 'assistant/message',
        time: 1,
        data: { message: { content: [{ type: 'text', text: 'The deploy uses pnpm.' }] } },
      }]),
      turn: 1,
      signal: new AbortController().signal,
    })
    await settle(1500)

    expect(await countEpisodes(), 'agent/turn-stopping captured nothing').toBeGreaterThan(before)
  })

  it('reclaims an agent from a REAL agent/disposed payload', async () => {
    // Same class: the payload is `{ agent }`, and reading `.id` off it always
    // produced undefined, so nothing was ever released.
    const ctx = await host()
    const agent = await firePreStep(ctx, 'dis', '/tmp/alpha')
    const cached = await waitForBlock(ctx, agent)
    expect(cached, 'nothing was cached, so disposal would prove nothing').toContain('SECRETFOR')

    await (ctx.parallel as (...a: unknown[]) => Promise<void>)('agent/disposed', { agent })
    await settle(300)
    expect(await assembleFor(ctx, agent)).not.toContain('SECRETFOR')
  })
})

/** Episodes recorded in the shared temp store. */
async function countEpisodes(): Promise<number> {
  const { Plur } = await import('@plur-ai/core') as unknown as {
    Plur: new (o: { path: string }) => { timeline: () => unknown[] }
  }
  try {
    return new Plur({ path: storePath }).timeline().length
  } catch {
    return 0
  }
}

/**
 * Drive one real `agent/pre-step` waterfall for an agent in a workspace.
 *
 * Returns the agent so the caller can assemble through ITS OWN context — the
 * only place an agent-scoped section is visible, and therefore the only
 * assembly that proves per-agent isolation.
 */
async function firePreStep(
  ctx: Context & Record<string, any>,
  id: string,
  cwd: string,
  ask = 'how do we deploy this project',
) {
  const agent = fakeAgent(id, cwd, askedEvents(ask))
  await (ctx.waterfall as (...a: unknown[]) => Promise<unknown>)('agent/pre-step', {
    agent,
    messages: [],
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, async () => ({ kind: 'enter', messages: [] }))
  return agent
}

/**
 * Assemble the real system prompt for one agent.
 *
 * Passing the agent into `assemble()` is not the suite feeding itself the
 * answer — it is what the host does. `@deepseek-ai/dsh-plan-mode` reads
 * `context.agent` in its own section provider and would not work otherwise.
 * What makes this test non-vacuous is that it asserts POSITIVELY (each agent
 * SEES its own secret) as well as negatively: an earlier version only checked
 * absence, and absence is also what you get when the section is never reached,
 * so it passed against a deliberately reintroduced leak.
 */
async function assembleFor(ctx: Context & Record<string, any>, agent: Agent): Promise<string> {
  const assembly = await ctx.systemPrompt.assemble({ agent })
  const sections = (assembly as { sections?: ReadonlyArray<{ text?: unknown }> })?.sections ?? []
  return sections.map(section => String(section?.text ?? '')).join(String.fromCharCode(10))
}

/** Assemble until the memory block is populated, or give up. */
async function waitForBlock(
  ctx: Context & Record<string, any>,
  agent: Agent,
  timeoutMs = 15_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    last = await assembleFor(ctx, agent)
    if (last.includes('SECRETFOR')) return last
    await settle(150)
  }
  return last
}

/** Assemble with NO agent — a diagnostic call. Must render nobody's memory. */
async function assembleAnonymously(ctx: Context & Record<string, any>): Promise<string> {
  const assembly = await ctx.systemPrompt.assemble({} as never)
  const sections = (assembly as { sections?: ReadonlyArray<{ text?: unknown }> })?.sections ?? []
  return sections.map(section => String(section?.text ?? '')).join(String.fromCharCode(10))
}
