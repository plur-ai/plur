import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { setupFixture } from '../helpers/enterprise-setup.js'

it('EFI-12 successful setup really saves and recalls through a wired tool, and rerunning reuses the key', async () => {
  const f = await setupFixture()
  try {
    const first = await f.run()
    expect(first.ok, `Setup must prove its installed tools: ${JSON.stringify(first)}`).toBe(true)
    expect(first.tools.length, 'A success with no configured tools is not proof of installation').toBeGreaterThan(0)
    expect(first.tools.every(t => t.proven), 'Every reported tool must have passed its actual save/recall proof').toBe(true)
    expect(f.server.state.writes, 'The hello must actually reach the intended server').toHaveLength(1)
    expect(f.server.state.recalls.length, 'The real installed tool must recall from the server').toBeGreaterThan(0)
    const previous = f.server.state.writes[0].id
    const second = await f.run()
    expect(second.ok, 'Rerunning a working installation must still succeed').toBe(true)
    expect(second.signIn.reused, 'Rerun must reuse the checked working key').toBe(true)
    expect(f.server.state.deviceRequests, 'Rerun must not mint another device key').toBe(1)
    expect(f.server.state.writes, 'Rerun must create a fresh proof hello').toHaveLength(2)
    expect(f.server.state.writes[1].supersedes, 'The new hello must identify the previous proof').toEqual([previous])
    expect(JSON.stringify(second), 'The installation summary must not expose its key').not.toContain(f.server.state.key)
  } finally { await f.close() }
})

it('EFI-12 a tool-install failure before any save restores the previous configuration', async () => {
  const f = await setupFixture()
  try {
    const before = readFileSync(f.configFile)
    const result = await f.run((command, args, opts) => args.includes('init')
      ? { status: 1, stdout: '', stderr: 'fixture installation refusal' } : f.exec(command, args, opts))
    expect(f.server.state.deviceRequests, 'The fixture must reach sign-in before the installation failure').toBe(1)
    expect(result.ok, 'An installation failure must not be reported as success').toBe(false)
    expect(f.server.state.writes, 'Failure before save must send no hello').toHaveLength(0)
    expect(readFileSync(f.configFile), 'The previous configuration must survive this failed installation').toEqual(before)
  } finally { await f.close() }
})
