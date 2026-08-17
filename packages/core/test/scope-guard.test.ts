/**
 * Write-time sensitivity demotion — the primary leak guard. When an engram is
 * written to a *shared* scope (group/project/space/...) with infra-sensitive
 * content, it is demoted to a private local scope rather than shared. This is
 * what actually closes the leak class: it sits in learn()/learnRouted(), the
 * paths every client (CLI, MCP, hooks, OpenClaw, Hermes) routes through.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur, isSharedScope } from '../src/index.js'

describe('isSharedScope', () => {
  it('treats group/project/space/team/org/public as shared (others can read)', () => {
    for (const s of ['group:plur/engineering', 'project:plur', 'space:5-plur', 'team:x', 'org:y', 'public'])
      expect(isSharedScope(s)).toBe(true)
  })
  it('treats local/global/user/agent as personal (not shared)', () => {
    for (const s of ['local', 'global', 'user:plur:gregor', 'agent:abc123'])
      expect(isSharedScope(s)).toBe(false)
  })
})

describe('write-time sensitivity demotion (learn)', () => {
  const dirs: string[] = []
  const freshPlur = () => {
    const dir = mkdtempSync(join(tmpdir(), 'plur-guard-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({ stores: [], index: false }, { noRefs: true }))
    return new Plur({ path: dir })
  }
  afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

  it('demotes a shared-scope write with a public IP to local/private', () => {
    const e = freshPlur().learn('deploy target is 139.59.155.82', { scope: 'group:plur/engineering', domain: 'infra' }) as { scope: string; visibility: string }
    expect(e.scope).toBe('local')
    expect(e.visibility).toBe('private')
  })

  it('demotes a shared-scope write with a basic-auth internal host', () => {
    const e = freshPlur().learn('login at https://team:pw1234@hub-staging.plur.ai', { scope: 'project:plur' }) as { scope: string; visibility: string }
    expect(e.scope).toBe('local')
    expect(e.visibility).toBe('private')
  })

  it('keeps a clean shared-scope write at its scope', () => {
    const e = freshPlur().learn('SKILL.md is the canonical pack format', { scope: 'group:plur/engineering', domain: 'plur.packs' }) as { scope: string }
    expect(e.scope).toBe('group:plur/engineering')
  })

  it('does NOT demote a personal (local) scope, even with an IP — infra notes live there legitimately', () => {
    const e = freshPlur().learn('my droplet is 139.59.155.82', { scope: 'local' }) as { scope: string }
    expect(e.scope).toBe('local')
  })

  it('scans CONTEXT fields too — sensitive content outside the statement still demotes (finding 1)', () => {
    const e = freshPlur().learn('a totally clean statement', { scope: 'group:plur/engineering', source: 'pulled from 139.59.155.82' } as never) as { scope: string; visibility: string }
    expect(e.scope).toBe('local')
    expect(e.visibility).toBe('private')
  })

  it('stamps a demotion marker the agent can see (finding 2)', () => {
    const e = freshPlur().learn('deploy at 139.59.155.82', { scope: 'group:plur/engineering' }) as { structured_data?: { _demoted?: { from: string; to: string; patterns: string } } }
    expect(e.structured_data?._demoted?.from).toBe('group:plur/engineering')
    expect(e.structured_data?._demoted?.to).toBe('local')
    expect(e.structured_data?._demoted?.patterns).toMatch(/public_ipv4/)
  })
})
