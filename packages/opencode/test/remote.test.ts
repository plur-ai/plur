/**
 * #1207 — opencode reaches PLUR Enterprise, gated on directory trust.
 *
 * The same pair of assertions `packages/cli/test/adapter-remote-recall.test.ts`
 * makes for every CLI adapter, made here for the one adapter that lives
 * outside the CLI package and so could not join that table.
 *
 * Half one: a project's `.plur.yaml` remote fields reach `injectHybrid` as
 * `remote_project`, so an enterprise user following the documented
 * `plur init-remote` onboarding gets team memory here too, instead of the
 * silence #1207 was filed about.
 *
 * Half two: they are refused, loudly, from an untrusted directory — because
 * the repo supplies BOTH the host and the token (#1196), and closing #1198 by
 * copying the capability without the gate is the mistake the gate exists to
 * prevent. A future change that takes one without the other fails here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { PlurPlugin } from '../src/index.js'

const REMOTE_CONFIG = `scope: group:acme/eng
remote_url: https://plur.acme.internal
remote_token: plur_ent_secret
remote_scopes:
  - group:acme/eng
`

describe('project remote settings (#1207)', () => {
  let mockPlur: any
  let tempDir: string
  let warned: string[]
  let errSpy: ReturnType<typeof vi.spyOn>

  /** Drive one user turn and return the options `injectHybrid` was called with. */
  async function recallOptions(dir: string): Promise<any> {
    const plugin = await PlurPlugin({ directory: dir, _plur: mockPlur } as any)
    await plugin['chat.message']!(
      { sessionID: 'ses-remote' } as any,
      { message: { id: 'msg-1' }, parts: [{ type: 'text', text: 'how do we deploy' }] } as any,
    )
    expect(mockPlur.injectHybrid).toHaveBeenCalled()
    return mockPlur.injectHybrid.mock.calls[0][1]
  }

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'opencode-remote-test-')))
    mockPlur = {
      injectHybrid: vi.fn().mockResolvedValue({ count: 0, directives: '', constraints: '', consider: '', injected_ids: [], tokens_used: 0 }),
      learnRouted: vi.fn().mockResolvedValue(undefined),
      isDirectoryTrusted: vi.fn().mockReturnValue(true),
    }
    warned = []
    errSpy = vi.spyOn(console, 'error').mockImplementation((msg?: unknown) => { warned.push(String(msg)) })
  })

  afterEach(() => {
    errSpy.mockRestore()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('dials: passes remote_project to injectHybrid from a trusted directory', async () => {
    writeFileSync(join(tempDir, '.plur.yaml'), REMOTE_CONFIG)

    const opts = await recallOptions(tempDir)

    expect(opts.remote_project).toEqual({
      url: 'https://plur.acme.internal',
      token: 'plur_ent_secret',
      scopes: ['group:acme/eng'],
    })
    // The local visibility filter still travels alongside it.
    expect(opts.scope).toBe('group:acme/eng')
    expect(mockPlur.isDirectoryTrusted).toHaveBeenCalledWith(tempDir)
    // Would FAIL if: remote_project were dropped from the injectHybrid call —
    // the #1207 regression, where recall is local-only while every other
    // adapter reaches the team store.
  })

  it('refuses: no remote_project from an untrusted directory, and says so', async () => {
    writeFileSync(join(tempDir, '.plur.yaml'), REMOTE_CONFIG)
    mockPlur.isDirectoryTrusted.mockReturnValue(false)

    const opts = await recallOptions(tempDir)

    expect(opts.remote_project).toBeUndefined()
    const notice = warned.find(w => w.includes('Ignored remote memory settings'))
    expect(notice).toBeDefined()
    // The user must be able to act on it without already knowing the model:
    // the directory, and the exact command.
    expect(notice).toContain(tempDir)
    expect(notice).toContain(`plur trust ${tempDir}`)
    // Would FAIL if: the gate were removed (a cloned repo's host and token
    // adopted unchecked, #1196), or if the refusal went silent — which is
    // indistinguishable from a broken remote leg.
  })

  it('refuses closed when the trust check itself throws', async () => {
    // Remote fields only, no `scope`: a config that also declares a scope
    // reaches `resolveTrustedScope` first, whose own trust check does not
    // catch — the throw lands in the D7 load boundary and the session runs
    // with no memory at all. That path is deliberate and pre-existing; this
    // one is about the remote gate, which catches and drops the remote leg
    // rather than dialing on an unanswerable trust question.
    writeFileSync(join(tempDir, '.plur.yaml'), 'remote_url: https://plur.acme.internal\nremote_token: plur_ent_secret\n')
    mockPlur.isDirectoryTrusted.mockImplementation(() => { throw new Error('trust store unreadable') })

    const opts = await recallOptions(tempDir)

    expect(opts.remote_project).toBeUndefined()
    // Would FAIL if: the error path defaulted to trusted.
  })

  it('costs nothing for a scope-only project: no remote_project, no notice', async () => {
    writeFileSync(join(tempDir, '.plur.yaml'), 'scope: project:local-only\n')

    const opts = await recallOptions(tempDir)

    expect(opts.remote_project).toBeUndefined()
    expect(opts.scope).toBe('project:local-only')
    expect(warned.find(w => w.includes('Ignored remote memory settings'))).toBeUndefined()
    // `scope`/`domain` are local visibility filters that send nothing
    // anywhere — a project using `.plur.yaml` purely for scoping must be
    // untouched by the remote gate, and must not be warned at.
  })

  it('never logs the token', async () => {
    writeFileSync(join(tempDir, '.plur.yaml'), REMOTE_CONFIG)
    const debug = process.env.PLUR_DEBUG
    process.env.PLUR_DEBUG = '1'
    try {
      await recallOptions(tempDir)
    } finally {
      if (debug === undefined) delete process.env.PLUR_DEBUG
      else process.env.PLUR_DEBUG = debug
    }

    expect(warned.some(w => w.includes('https://plur.acme.internal'))).toBe(true)
    expect(warned.some(w => w.includes('plur_ent_secret'))).toBe(false)
    // The debug line exists so a user can see WHICH store a session dials.
    // That is the host. A credential in a log is a credential on disk.
  })
})
