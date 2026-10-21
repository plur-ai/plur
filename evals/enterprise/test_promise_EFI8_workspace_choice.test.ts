import { expect, it } from 'vitest'
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { enterpriseFixture } from '../helpers/enterprise-install.js'
import { connectMcp, callTool } from '../helpers/privacy-folders-team-mcp.js'
it('EFI-8 a mixed workspace saves nothing until I choose a destination', async () => {
  const f = await enterpriseFixture(), local = join(f.home, 'notes'); mkdirSync(local)
  writeFileSync(join(f.store, 'folders.yaml'), JSON.stringify({ version: 1, folders: [
    { path: f.repo, plur: 'on', scope: f.scope }, { path: local, plur: 'on' },
  ] }))
  const p = f.open(), mcp = await connectMcp(p, { roots: [f.repo, local] })
  try {
    const refused = await callTool(mcp.client, 'plur_learn', { statement: 'This ambiguous instruction must wait' })
    expect(refused.json, 'A mixed workspace must refuse the unscoped save and offer both destinations').toMatchObject({ saved: false, refused: 'roots-disagree', choices: ['project:example/team/app', 'global'] })
    const batch = await callTool(mcp.client, 'plur_learn_batch', { engrams: [
      { statement: 'Explicit batch entry must wait too', scope: f.scope }, { statement: 'Unscoped batch entry must wait' },
    ] })
    expect(batch.json.refused, 'A partly ambiguous batch must save nothing').toBe('roots-disagree')
    expect(f.stub.appendCalls, 'The refused single and batch saves must send no content').toBe(0)
    const localText = existsSync(join(f.store, 'engrams.yaml')) ? readFileSync(join(f.store, 'engrams.yaml'), 'utf8') : ''
    expect(localText, 'Refusal must not quietly save the ambiguous content locally').not.toContain('must wait')
    const accepted = await callTool(mcp.client, 'plur_learn', { statement: 'This chosen deployment instruction belongs to the team', scope: f.scope })
    expect(accepted.json.delivery, 'The explicit authorized destination must work as a positive control').toBe('remote')
    expect(f.stub.appendCalls, 'Only the explicitly chosen memory should be delivered').toBe(1)
  } finally { await mcp.close(); await f.close() }
})
