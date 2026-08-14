import { describe, expect, it, vi } from 'vitest'
import { Config } from '../src/config.ts'
import { createCounters } from '../src/counters.ts'
import { registerTools } from '../src/tools.ts'

function collect(plur?: Record<string, unknown>, config = new Config({})) {
  const tools: any[] = []
  const ctx = { tools: { register: (d: any) => { tools.push(d); return () => {} } } }
  const disposers = registerTools(ctx as any, {
    config,
    counters: createCounters(),
    plur: plur as never,
    resolveScope: async () => config.scope,
  })
  return { tools, disposers }
}

const byName = (tools: any[], name: string) => tools.find(t => t.name === name)!
/** Run a tool the way the registry does: execute, then project through output.render. */
const run = async (tool: any, args: unknown = {}) => {
  const value = await tool.execute(args, { signal: new AbortController().signal })
  return tool.output.render(args, value).map((b: any) => b.text).join('\n')
}

describe('registerTools', () => {
  it('registers exactly the five tools', () => {
    expect(collect().tools.map(t => t.name).sort()).toEqual(
      ['plur_feedback', 'plur_forget', 'plur_learn', 'plur_recall', 'plur_status'],
    )
  })

  it('every tool satisfies the dsh ToolDefinition contract', () => {
    for (const tool of collect().tools) {
      expect(tool.name).toMatch(/^plur_/)
      expect(tool.description.length).toBeGreaterThan(20)
      expect(tool.parameters).toMatchObject({ type: 'object' })
      expect(tool.output.schema).toMatchObject({ type: 'object' })
      expect(typeof tool.output.render).toBe('function')
      expect(typeof tool.execute).toBe('function')
    }
  })

  it('execute returns lossless JSON, not a string', async () => {
    const plur = { recall: async () => [{ id: 'ENG-1', statement: 'Pin your deps.' }] }
    const value = await byName(collect(plur).tools, 'plur_recall').execute({ query: 'deps' }, {} as never)
    expect(JSON.parse(JSON.stringify(value))).toEqual(value)
  })

  it('plur_recall returns matches', async () => {
    const plur = { recall: vi.fn(async () => [{ id: 'ENG-1', statement: 'Pin your deps.' }]) }
    expect(await run(byName(collect(plur).tools, 'plur_recall'), { query: 'deps' }))
      .toContain('[ENG-1] Pin your deps.')
  })

  it('plur_recall says so plainly when nothing matches', async () => {
    const plur = { recall: async () => [] }
    expect(await run(byName(collect(plur).tools, 'plur_recall'), { query: 'x' }))
      .toContain('No matching engrams')
  })

  it('a failing store degrades to a message instead of throwing into the host', async () => {
    const plur = { recall: async () => { throw new Error('store gone') } }
    const tool = byName(collect(plur).tools, 'plur_recall')
    await expect(tool.execute({ query: 'x' }, {} as never)).resolves.toBeDefined()
    expect(await run(tool, { query: 'x' })).toMatch(/unavailable/i)
  })

  it('plur_recall uses the resolved scope, never the ambient global store', async () => {
    const recall = vi.fn(async () => [])
    const config = new Config({ scope: 'project:acme' })
    collect({ recall }, config)
    const tool = byName(collect({ recall }, config).tools, 'plur_recall')
    await tool.execute({ query: 'x' }, {} as never)
    expect(recall).toHaveBeenCalledWith('x', expect.objectContaining({ scope: 'project:acme' }))
  })

  it('plur_learn stores and counts', async () => {
    const learn = vi.fn(async () => {})
    expect(await run(byName(collect({ learn }).tools, 'plur_learn'), { statement: 'Always pin.' }))
      .toContain('Stored')
    expect(learn).toHaveBeenCalled()
  })

  it('plur_feedback maps negative to a negative signal', async () => {
    const feedback = vi.fn(async () => {})
    await byName(collect({ feedback }).tools, 'plur_feedback')
      .execute({ id: 'ENG-1', signal: 'negative' }, {} as never)
    expect(feedback).toHaveBeenCalledWith('ENG-1', -1)
  })

  it('plur_status reports scope, mode and counters', async () => {
    const out = await run(byName(collect().tools, 'plur_status'))
    expect(out).toContain('refresh_attempted')
    expect(out).toContain('project:dsh')
  })

  it('returns a disposer per registered tool', () => {
    const { disposers } = collect()
    expect(disposers).toHaveLength(5)
    expect(() => disposers.forEach(d => d())).not.toThrow()
  })
})
