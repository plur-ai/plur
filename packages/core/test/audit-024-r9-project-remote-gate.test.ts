/**
 * 0.24 review round 9 (part of #1947): under `pinning.agents: request` or
 * `deny`, a trusted project's `.plur.yaml` server is used only when
 * config.yaml lists it; otherwise it is withheld (not refused) and the
 * adapter says so. Under `allow`, or without a policy to read, trust is
 * enough, as before.
 */
import { describe, it, expect } from 'vitest'
import { resolveProjectRemoteFromConfig, projectRemoteWithheldNotice } from '../src/project-remote.js'

const URL_ = 'https://repo-server.example.test'
const cfg = { remote_url: URL_, remote_token: 'repo-token', remote_scopes: ['group:x/team'] }
const checker = (policy: string | undefined, stores: Array<{ url?: string }> = []) => ({
  isDirectoryTrusted: () => true,
  ...(policy !== undefined ? { pinPolicyFor: () => policy } : {}),
  config: { stores },
})

describe('round 9: a trusted .plur.yaml server under pinning.agents', () => {
  for (const policy of ['request', 'deny']) {
    it(`${policy}: withheld when config.yaml does not list it`, () => {
      const r = resolveProjectRemoteFromConfig(checker(policy), cfg, '/repo/.plur.yaml')
      expect(r.remoteProject).toBeNull()
      expect(r.refusedFrom).toBeNull()
      expect(r.withheldUrl).toBe(URL_)
      expect(projectRemoteWithheldNotice(r.withheldUrl!)).toMatch(/only the owner adds a server/)
    })
    it(`${policy}: used when config.yaml lists the same server (any spelling)`, () => {
      const r = resolveProjectRemoteFromConfig(checker(policy, [{ url: `${URL_}/sse` }]), cfg, '/repo/.plur.yaml')
      expect(r.remoteProject?.url).toBe(URL_)
    })
  }
  it('a policy that cannot be read is treated as restricted', () => {
    const c = { isDirectoryTrusted: () => true, pinPolicyFor: () => { throw new Error('unreadable') }, config: { stores: [] } }
    expect(resolveProjectRemoteFromConfig(c, cfg, '/repo/.plur.yaml').remoteProject).toBeNull()
  })
  it('allow, or no policy known: trust is enough, as before', () => {
    expect(resolveProjectRemoteFromConfig(checker('allow'), cfg, '/repo/.plur.yaml').remoteProject?.url).toBe(URL_)
    expect(resolveProjectRemoteFromConfig(checker(undefined), cfg, '/repo/.plur.yaml').remoteProject?.url).toBe(URL_)
  })
})
