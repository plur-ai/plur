/**
 * Security audit 0.24 finding 5: an owner's `pinning.agents` restriction must
 * survive errors elsewhere in config.yaml. A config that cannot be fully read
 * (an invalid unrelated key, or YAML that does not parse) falls back to
 * defaults for the rest, but never relaxes the pin policy: the owner's
 * readable value is kept, and when it cannot be determined the policy fails
 * safe to `request` — the same rule as for an invalid value of the key itself.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur, loadConfig, pinDecision } from '../src/index.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function cfg(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'plur-f5-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'config.yaml'), text)
  return dir
}
const agentDecision = (dir: string) => pinDecision(loadConfig(join(dir, 'config.yaml')), 'agent')

// A value of the wrong type for a strict core key: the whole-file parse fails.
const BAD_KEY = 'injection_budget: "2k"\n'

describe('finding 5: pinning.agents survives errors elsewhere in config.yaml', () => {
  for (const agents of ['request', 'deny'] as const) {
    it(`${agents} + an invalid unrelated key: the owner's value is kept`, () => {
      const dir = cfg(`${BAD_KEY}pinning:\n  agents: ${agents}\n`)
      expect(agentDecision(dir)).toBe(agents)
    })

    it(`${agents} + YAML that does not parse: the owner's value is kept`, () => {
      const dir = cfg(`pinning:\n  agents: ${agents}\nstores: [unclosed\n`)
      expect(agentDecision(dir)).toBe(agents)
    })
  }

  it('deny + invalid key: an agent pin through core is refused, not stored pinned', async () => {
    const dir = cfg(`${BAD_KEY}embeddings:\n  enabled: false\nindex: false\npinning:\n  agents: deny\n`)
    const plur = new Plur({ path: dir, autoDiscover: false, actor: 'agent' })
    await expect(plur.learn('Always do the thing', { pinned: true, scope: 'global' })).rejects.toMatchObject({ code: 'pin_denied' })
  })

  it('a pinning section that cannot be read itself fails safe to request', () => {
    expect(agentDecision(cfg(`${BAD_KEY}pinning: deny\n`))).toBe('request')
    expect(agentDecision(cfg('pinning: [deny]\n'))).toBe('request')
    // Broken YAML that mentions pinning in a form that cannot be read back.
    expect(agentDecision(cfg('pinning: {agents: deny\n'))).not.toBe('allow')
    expect(agentDecision(cfg('pinning:\n  agents: [\n'))).not.toBe('allow')
  })

  it('a config that never set pinning keeps the allow default, broken or not', () => {
    expect(agentDecision(cfg(BAD_KEY))).toBe('allow')
    expect(agentDecision(cfg('stores: [unclosed\n'))).toBe('allow')
  })

  it('an explicit allow stays allow next to an invalid key', () => {
    expect(agentDecision(cfg(`${BAD_KEY}pinning:\n  agents: allow\n`))).toBe('allow')
  })
})
