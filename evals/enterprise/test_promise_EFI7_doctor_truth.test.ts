import { expect, it } from 'vitest'
import { enterpriseFixture, sourceCli } from '../helpers/enterprise-install.js'
it('EFI-7 doctor reports unavailable server permission evidence as unhealthy', async () => {
  const f = await enterpriseFixture()
  try {
    const run = await sourceCli(['doctor', '--no-handshake', '--json'], f.env, f.repo)
    expect(run.status, 'Doctor must exit unsuccessfully when a configured server cannot prove its write path').toBe(1)
    const report = JSON.parse(run.stdout)
    expect(report.serverStores, 'A failing overall status alone is not proof that the server was checked').toHaveLength(1)
    expect(report.serverStores[0].checks.find((c: any) => c.name === 'write-path')?.result,
      'Doctor must expose the missing permission evidence').toBe('could-not-check')
    expect(report.overall, 'Doctor cannot call this installation healthy').toBe('fail')
    expect(f.stub.meCalls, 'The doctor must have contacted the actual configured loopback service').toBeGreaterThan(0)
  } finally { await f.close() }
})
