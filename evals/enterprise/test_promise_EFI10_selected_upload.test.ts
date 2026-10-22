import { afterEach, expect, it } from 'vitest'
import { enterpriseFixture } from '../helpers/enterprise-install.js'
let f: Awaited<ReturnType<typeof enterpriseFixture>> | undefined
afterEach(async () => { await f?.close() })
it('EFI-10 only selected eligible local memories leave the primary store', async () => {
  f = await enterpriseFixture(); f.configure([]); const p = f.open()
  const chosen = await p.learn('Use staged deployment approval', { scope: f.scope })
  const omitted = await p.learn('Retain a separate rollback checklist', { scope: f.scope })
  const personal = await p.learn('Prefer a quiet editor theme', { scope: 'global' })
  f.configure()
  const candidates = await p.listUploadCandidates([f.scope])
  expect(candidates.map(x => x.id), 'The fixture must expose all three local candidates').toEqual(expect.arrayContaining([chosen.id, omitted.id, personal.id]))
  expect(candidates.find(x => x.id === personal.id)?.proposed, 'A personal memory must not be offered to the team').toBeNull()
  await p.uploadLocal([chosen.id], { dryRun: true })
  expect(f.stub.appendCalls, 'Preview must send nothing').toBe(0)
  expect(await p.listOutbox(), 'Preview must not queue anything').toHaveLength(0)
  const result = await p.uploadLocal([chosen.id])
  expect(result.results, 'Confirmation must account for the selected item').toHaveLength(1)
  expect(result.results[0].outcome, 'The chosen memory must actually be delivered').toBe('sent')
  expect(f.stub.appendStatements, 'Unselected and personal memories must remain on this machine').toEqual(['Use staged deployment approval'])
})
