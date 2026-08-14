/**
 * Integration against the REAL DeepSeek Harness tool registry.
 *
 * The unit suite registers tools on a hand-written double, which proves the
 * definitions are shaped the way *we* think and nothing more. `dsh-tools`
 * validates definitions on registration and owns the `output.render` contract,
 * so a mismatch there is invisible until a user runs it. It activates with only
 * `systemPrompt` injected, so booting it for real is cheap and there is no
 * excuse for stubbing it.
 */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { beforeAll, describe, expect, it } from 'vitest'
import { Config } from '../src/config.js'
import { apply } from '../src/index.js'
import { cfg } from './helpers/config.js'

const EXPECTED = ['plur_feedback', 'plur_forget', 'plur_learn', 'plur_recall', 'plur_status']

let ctx: Context & Record<string, any>

beforeAll(async () => {
  ctx = new Context() as Context & Record<string, any>
  ctx.plugin(SystemPrompt, {})
  ctx.plugin(Tools, {})
  await new Promise(r => setTimeout(r, 300))
  ctx.skills = { register: () => () => {} }
  ctx.commands = { register: () => () => {} }
  apply(ctx, cfg({ scope: 'project:realtools' }), {
    recall: async () => [{ id: 'ENG-7', statement: 'Real registry round trip.' }],
    learn: async () => ({ id: 'ENG-8' }),
  })
})

describe('real dsh tool registry', () => {
  it('boots the real registry', () => {
    expect(typeof ctx.tools).toBe('object')
  })

  it('the real registry ACCEPTS all five definitions', () => {
    for (const name of EXPECTED) {
      expect(ctx.tools.get(name), `${name} should be registered`).toBeDefined()
    }
  })

  it('surfaces exactly those five schemas to the model', async () => {
    const assembled = await ctx.systemPrompt.assemble({})
    const names = ((assembled.tools ?? []) as Array<{ name: string }>).map(t => t.name).sort()
    expect(names).toEqual(EXPECTED)
  })

  it('execute returns the canonical value the registry declares', async () => {
    const def = ctx.tools.get('plur_recall')!
    const value = await def.execute({ query: 'anything' }, { signal: new AbortController().signal } as never)
    // Must satisfy the declared output.schema: { text: string }
    expect(value).toEqual({ text: '[ENG-7] Real registry round trip.' })
    expect(JSON.parse(JSON.stringify(value))).toEqual(value)
  })

  it('output.render produces valid content blocks', () => {
    const def = ctx.tools.get('plur_recall')!
    const blocks = def.output.render({ query: 'x' }, { text: 'hello' })
    expect(blocks).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('a failing store still yields a renderable result, not a throw', async () => {
    const isolated = new Context() as Context & Record<string, any>
    isolated.plugin(SystemPrompt, {})
    isolated.plugin(Tools, {})
    await new Promise(r => setTimeout(r, 300))
    isolated.skills = { register: () => () => {} }
    isolated.commands = { register: () => () => {} }
    apply(isolated, cfg({}), { recall: async () => { throw new Error('store gone') } })
    const def = isolated.tools.get('plur_recall')!
    const value = await def.execute({ query: 'x' }, { signal: new AbortController().signal } as never)
    expect(String((value as { text: string }).text)).toMatch(/unavailable/i)
  })
})
