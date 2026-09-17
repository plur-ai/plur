import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { resolveScopeRoot, resolveTrustedScope } from '../src/scope.js'
import { PlurPlugin } from '../src/index.js'

describe('resolveScopeRoot', () => {
  it('prefers a real worktree when there is one', () => {
    expect(resolveScopeRoot({ directory: '/repo/sub', worktree: '/repo' })).toBe('/repo')
  })

  it('ignores worktree "/" — measured in non-git dirs', () => {
    expect(resolveScopeRoot({ directory: '/tmp/work', worktree: '/' })).toBe('/tmp/work')
  })

  it('ignores an empty worktree', () => {
    expect(resolveScopeRoot({ directory: '/tmp/work', worktree: '' })).toBe('/tmp/work')
  })

  it('falls back to cwd when neither is usable', () => {
    expect(resolveScopeRoot({})).toBe(process.cwd())
  })
})

describe('PlurPlugin project config integration', () => {
  let mockPlur: any
  let tempDir: string

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'opencode-scope-test-')))
    mockPlur = {
      injectHybrid: vi.fn().mockResolvedValue({ count: 0, directives: '', constraints: '', consider: '', injected_ids: [], tokens_used: 0 }),
      learnRouted: vi.fn().mockResolvedValue(undefined),
      // D2 (2026-09 audit): the plugin now gates `.plur.yaml` scope adoption
      // on directory trust. Default to trusted here — these fixtures are
      // about scope/domain PROPAGATION once adopted; the untrusted-gate
      // behaviour itself is covered by its own describe block below.
      isDirectoryTrusted: vi.fn().mockReturnValue(true),
    }
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('A. reads and applies fixture scope to injectHybrid (fails if scope not passed or wrong value)', async () => {
    // Create a distinctive fixture scope and domain in .plur.yaml
    const fixtureConfig = `scope: project:fixture-scope-xyz
domain: fixture-domain-abc
`
    writeFileSync(join(tempDir, '.plur.yaml'), fixtureConfig)

    const plur = mockPlur
    const plugin = await PlurPlugin({ directory: tempDir, _plur: plur } as any)

    // Trigger a recall
    const input = { sessionID: 'ses-fixture-a' }
    const output = {
      message: { id: 'msg-1' },
      parts: [{ type: 'text', text: 'test query' }],
    }

    await plugin['chat.message']!(input as any, output as any)

    // Assert injectHybrid was called with EXACTLY the fixture scope value
    expect(plur.injectHybrid).toHaveBeenCalled()
    const callArgs = plur.injectHybrid.mock.calls[0]
    expect(callArgs[1].scope).toBe('project:fixture-scope-xyz')
    // Would FAIL if: scope was undefined, or if readProjectConfig wasn't called, or if wrong directory passed
  })

  it('B. drives full event pipeline to verify domain and scope reach learn (fails if wiring in learn.ts deleted)', async () => {
    const fixtureConfig = `scope: project:fixture-scope-xyz
domain: fixture-domain-abc
`
    writeFileSync(join(tempDir, '.plur.yaml'), fixtureConfig)

    const plur = mockPlur
    const plugin = await PlurPlugin({ directory: tempDir, _plur: plur } as any)

    // Dispatch the full event pipeline like event.test.ts does:
    // 1. User sends message (marks sessionID)
    await plugin['chat.message']!({ sessionID: 'ses-fixture-b' } as any, {
      message: { id: 'msg-user' },
      parts: [{ type: 'text', text: 'Please help' }],
    } as any)

    // 2. Assistant responds with learning block
    await plugin.event!({
      event: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'prt_assist',
            sessionID: 'ses-fixture-b',
            messageID: 'msg-assist',
            type: 'text',
            text: '---\n🧠 I learned:\n- Fixture domain should be fixture-domain-abc.',
          },
        },
      },
    } as any)

    // 3. Idle fires, triggering learn
    await plugin.event!({
      event: { type: 'session.idle', properties: { sessionID: 'ses-fixture-b' } },
    } as any)

    // Wait for async learn to complete
    await vi.waitFor(() => expect(plur.learnRouted).toHaveBeenCalled(), { timeout: 100 })

    // Assert learnRouted was called with EXACTLY the fixture domain and scope
    const learnCall = plur.learnRouted.mock.calls[0]
    expect(learnCall[1]).toMatchObject({
      domain: 'fixture-domain-abc',
      scope: 'project:fixture-scope-xyz',
    })
    // Would FAIL if: domain/scope wiring in learn.ts was deleted, or if readProjectConfig wasn't called from right dir
  })

  it('C. verifies readProjectConfig is called with resolved scope root (fails if cwd wiring removed)', async () => {
    // Create fixture config in temp directory
    const fixtureConfig = `scope: project:cwd-test-scope
domain: cwd-test-domain
`
    writeFileSync(join(tempDir, '.plur.yaml'), fixtureConfig)

    // Call plugin with explicit worktree that should be preferred over directory
    const plur = mockPlur
    const plugin = await PlurPlugin({
      directory: '/tmp/some-other-dir',
      worktree: tempDir, // This should be preferred by resolveScopeRoot
      _plur: plur,
    } as any)

    // Trigger recall
    const input = { sessionID: 'ses-cwd-test' }
    const output = {
      message: { id: 'msg-1' },
      parts: [{ type: 'text', text: 'test' }],
    }

    await plugin['chat.message']!(input as any, output as any)

    // If readProjectConfig was called with the correct directory (tempDir),
    // it will have read the fixture config and passed scope: 'project:cwd-test-scope'
    // If cwd wiring is broken and process.cwd() was used instead, this would fail
    expect(plur.injectHybrid).toHaveBeenCalled()
    const callArgs = plur.injectHybrid.mock.calls[0]
    expect(callArgs[1].scope).toBe('project:cwd-test-scope')
    // Would FAIL if: readProjectConfig(scopeRoot) was changed to readProjectConfig() or readProjectConfig(process.cwd())
  })

  it('handles missing .plur.yaml — scope undefined passed to injectHybrid', async () => {
    // Deliberately create a directory with NO .plur.yaml
    const emptyDir = realpathSync(mkdtempSync(join(tmpdir(), 'opencode-no-config-')))
    const plur = mockPlur

    try {
      const plugin = await PlurPlugin({ directory: emptyDir, _plur: plur } as any)

      const input = { sessionID: 'ses-noconfig' }
      const output = { message: { id: 'msg-1' }, parts: [{ type: 'text', text: 'query' }] }

      await plugin['chat.message']!(input as any, output as any)

      // Should still call injectHybrid, scope will be undefined (not an error)
      expect(plur.injectHybrid).toHaveBeenCalled()
      const callArgs = plur.injectHybrid.mock.calls[0]
      expect(callArgs[1].scope).toBeUndefined()
    } finally {
      rmSync(emptyDir, { recursive: true, force: true })
    }
  })
})

// D2 (2026-09 audit): a `.plur.yaml` scope must only be adopted from a
// directory the user has explicitly trusted (`plur trust`) — see scope.ts's
// `resolveTrustedScope` docstring for the full reasoning (remote/team stores
// are the legitimate use, so the gate is on the DIRECTORY, not on whether
// the scope happens to resolve to a remote store).
describe('PlurPlugin — directory-trust gate on .plur.yaml scope (D2)', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'opencode-trust-test-')))
    writeFileSync(join(tempDir, '.plur.yaml'), 'scope: group:acme/eng\ndomain: acme.eng.build\n')
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('does NOT adopt scope/domain from an untrusted directory', async () => {
    const plur = {
      injectHybrid: vi.fn().mockResolvedValue({ count: 0 }),
      learnRouted: vi.fn().mockResolvedValue(undefined),
      isDirectoryTrusted: vi.fn().mockReturnValue(false),
    }
    const plugin = await PlurPlugin({ directory: tempDir, _plur: plur } as any)
    await plugin['chat.message']!({ sessionID: 's1' } as any, {
      message: { id: 'm1' }, parts: [{ type: 'text', text: 'hi' }],
    } as any)

    expect(plur.isDirectoryTrusted).toHaveBeenCalledWith(tempDir)
    const callArgs = plur.injectHybrid.mock.calls[0]
    expect(callArgs[1].scope).toBeUndefined()
    // Would FAIL if: the plugin adopted projectConfig.scope directly instead
    // of routing it through resolveTrustedScope()/isDirectoryTrusted first.
  })

  it('DOES adopt scope/domain from a trusted directory', async () => {
    const plur = {
      injectHybrid: vi.fn().mockResolvedValue({ count: 0 }),
      learnRouted: vi.fn().mockResolvedValue(undefined),
      isDirectoryTrusted: vi.fn().mockReturnValue(true),
    }
    const plugin = await PlurPlugin({ directory: tempDir, _plur: plur } as any)
    await plugin['chat.message']!({ sessionID: 's1' } as any, {
      message: { id: 'm1' }, parts: [{ type: 'text', text: 'hi' }],
    } as any)

    const callArgs = plur.injectHybrid.mock.calls[0]
    expect(callArgs[1].scope).toBe('group:acme/eng')
  })

  it('carries remote fields ONLY inside remote_project, and only when trusted (#1207)', async () => {
    // Until #1207 this asserted the plugin never read the remote fields at
    // all. It now does — through core's shared gate, the same one every CLI
    // adapter passes (#1196/#1198), because an enterprise user's team memory
    // silently never arriving here was the bug. What survives from the old
    // assertion is the shape: these fields are a REMOTE grant and never
    // become loose recall options or leak from an untrusted directory. The
    // dial/refuse pair itself lives in remote.test.ts.
    writeFileSync(
      join(tempDir, '.plur.yaml'),
      'scope: group:acme/eng\nremote_url: https://evil.example\nremote_token: SHOULD-NEVER-APPEAR\nremote_scopes:\n  - group:acme/eng\n',
    )
    for (const trusted of [true, false]) {
      const plur = {
        injectHybrid: vi.fn().mockResolvedValue({ count: 0 }),
        learnRouted: vi.fn().mockResolvedValue(undefined),
        isDirectoryTrusted: vi.fn().mockReturnValue(trusted),
      }
      const plugin = await PlurPlugin({ directory: tempDir, _plur: plur } as any)
      await plugin['chat.message']!({ sessionID: `s-${trusted}` } as any, {
        message: { id: 'm1' }, parts: [{ type: 'text', text: 'hi' }],
      } as any)
      const opts = plur.injectHybrid.mock.calls[0][1]
      // Never as loose options — `remote_project` is the one channel.
      expect(opts).not.toHaveProperty('remote_url')
      expect(opts).not.toHaveProperty('remote_token')
      expect(opts).not.toHaveProperty('remote_scopes')
      if (trusted) {
        expect(opts.remote_project).toEqual({
          url: 'https://evil.example',
          token: 'SHOULD-NEVER-APPEAR',
          scopes: ['group:acme/eng'],
        })
      } else {
        // Untrusted: the repo named both the host and the credential (#1196),
        // so neither may appear anywhere in what the recall is given.
        expect(opts.remote_project).toBeUndefined()
        expect(JSON.stringify(opts)).not.toContain('evil.example')
        expect(JSON.stringify(opts)).not.toContain('SHOULD-NEVER-APPEAR')
      }
    }
  })
})

describe('resolveTrustedScope (pure function)', () => {
  const warn = () => {}

  it('returns {} when the project config has neither scope nor domain', () => {
    const plur = { isDirectoryTrusted: () => { throw new Error('must not be called') } }
    expect(resolveTrustedScope(plur, {}, '/repo/.plur.yaml', warn)).toEqual({})
  })

  it('returns {} and warns when configPath is trusted but null (defensive — should not happen in practice)', () => {
    const messages: string[] = []
    const plur = { isDirectoryTrusted: () => true }
    const result = resolveTrustedScope(plur, { scope: 'global' }, null, (m) => messages.push(m))
    expect(result).toEqual({})
    expect(messages.length).toBe(1)
  })

  it('adopts scope/domain when the config file\'s directory is trusted', () => {
    const plur = { isDirectoryTrusted: vi.fn().mockReturnValue(true) }
    const result = resolveTrustedScope(plur, { scope: 'group:acme/eng', domain: 'acme.eng' }, '/repo/.plur.yaml', warn)
    expect(result).toEqual({ scope: 'group:acme/eng', domain: 'acme.eng' })
    expect(plur.isDirectoryTrusted).toHaveBeenCalledWith('/repo')
  })

  it('drops scope/domain and warns (naming the file, scope, and trust command) when untrusted', () => {
    const messages: string[] = []
    const plur = { isDirectoryTrusted: () => false }
    const result = resolveTrustedScope(plur, { scope: 'group:acme/eng' }, '/repo/.plur.yaml', (m) => messages.push(m))
    expect(result).toEqual({})
    expect(messages[0]).toContain('/repo/.plur.yaml')
    expect(messages[0]).toContain('group:acme/eng')
    expect(messages[0]).toContain('plur trust /repo')
  })
})
