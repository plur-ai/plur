import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { enterpriseFixture, sourceCli } from '../helpers/enterprise-install.js'
it('EFI-11 upload preview changes nothing and confirmation names what was sent and retained', async () => {
  const f = await enterpriseFixture()
  try {
    f.configure([]); const p = f.open()
    const team = await p.learn('Approve deployment stages separately', { scope: f.scope })
    const personal = await p.learn('Use a calm editor background', { scope: 'global' })
    await p.close(); f.configure()
    const before = readFileSync(join(f.store, 'engrams.yaml'))
    const preview = await sourceCli(['upload', '--json'], f.env, f.repo)
    expect(preview.status, `Preview must run successfully: ${preview.stderr}`).toBe(0)
    expect(JSON.parse(preview.stdout).proposals.map((r: any) => r.id), 'Preview must actually propose the eligible memory').toEqual([team.id])
    expect(readFileSync(join(f.store, 'engrams.yaml')), 'Preview must preserve primary memory bytes').toEqual(before)
    expect(f.stub.appendCalls, 'Preview must make no upload').toBe(0)
    const confirmed = await sourceCli(['upload', '--yes', '--json'], f.env, f.repo)
    expect(confirmed.status, `Confirmed upload must succeed: ${confirmed.stderr}`).toBe(0)
    const out = JSON.parse(confirmed.stdout)
    expect(out.counts.sent, 'The confirmed eligible memory must be counted as sent').toBe(1)
    expect(out.not_sent.map((r: any) => r.id), 'The personal memory must be accounted for as retained').toContain(personal.id)
    expect(f.stub.appendStatements, 'Confirmation must send only the eligible memory').toEqual(['Approve deployment stages separately'])
  } finally { await f.close() }
})
