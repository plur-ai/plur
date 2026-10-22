import { afterEach, expect, it } from 'vitest'
import { enterpriseFixture } from '../helpers/enterprise-install.js'
import { getToolDefinitions } from '../../packages/mcp/src/tools.js'
let f: Awaited<ReturnType<typeof enterpriseFixture>> | undefined
afterEach(async () => { await f?.close() })
it('EFI-2 single, batch and session suggestions each tell me where the successful save went', async () => {
  f = await enterpriseFixture(); const p = f.open(); p.bindFolder(f.repo)
  const call = (name: string, args: any) => getToolDefinitions('full').find(t => t.name === name)!.handler(args, p as any) as Promise<any>
  const one = await call('plur_learn', { statement: 'Deployments require a tested rollback', scope: f.scope })
  expect(one.destination, 'The saved result must name its actual server scope').toBe('saved to project:example/team/app (server)')
  const batch = await call('plur_learn_batch', { engrams: [{ statement: 'Schema changes need a backup', scope: f.scope }] })
  expect(batch.results, 'The batch must actually save an item').toHaveLength(1)
  expect(batch.results[0].destination, 'Every batch result must name its destination').toBe('saved to project:example/team/app (server)')
  const end = await call('plur_session_end', { summary: 'Reviewed the deployment', engram_suggestions: [{ statement: 'Use a canary before rollout', scope: f.scope }] })
  expect(end.engrams_created, 'The session suggestion must actually be saved').toBe(1)
  expect(JSON.stringify(end), 'The completed session save must say where it went').toContain('saved to project:example/team/app (server)')
  expect(f.stub.appendCalls, 'All three reported remote saves must reach the server').toBe(3)
  f.stub.appendErrorResponse = { status: 503, body: 'temporarily unavailable' }
  const queued = await call('plur_learn', { statement: 'Record unavailable deployment capacity', scope: f.scope })
  expect(queued.destination, 'A queued save must not claim it reached the server').toContain('not on the server yet')
})
