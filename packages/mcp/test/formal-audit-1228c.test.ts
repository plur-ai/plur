/**
 * Audit of #1228, non-core packages (1228-c), MCP findings:
 *
 *  #1 the untrusted-.plur.yaml warning must name a trust command that writes
 *     to the store THIS server checks — `plur --path <root> trust <dir>` when
 *     the store is not the default one;
 *  #2 plur_learn_batch applies the pinned quota per item: each admitted
 *     pinned item's cost is subtracted before the next is judged;
 *  #7 a plur_admin-dispatched error that already names its tool is not
 *     prefixed a second time;
 *  unconfirmed: a remote that echoes its own write_count on a fresh push does
 *     not make plur_learn report NOOP (replayed against a localhost stub).
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '@plur-ai/core'
import { getToolDefinitions, _resetSessionTelemetry } from '../src/tools.js'
import { StubServer } from '../../core/test/helpers/stub-server.js'

describe('trust warning names a command that reaches this store (1228-c #1)', () => {
  let root: string
  let repo: string
  let cwd: string
  let home: string | undefined

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'plur-1228c-trust-')))
    repo = join(root, 'cloned-repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    writeFileSync(join(repo, '.plur.yaml'), 'scope: project:acme-app\n')
    home = process.env.HOME
    process.env.HOME = root
    cwd = process.cwd()
    process.chdir(repo)
    _resetSessionTelemetry()
  })
  afterEach(() => {
    process.chdir(cwd)
    if (home === undefined) delete process.env.HOME
    else process.env.HOME = home
    rmSync(root, { recursive: true, force: true })
  })

  const start = async (plur: Plur) =>
    await getToolDefinitions('full').find(t => t.name === 'plur_session_start')!.handler({ task: 'work' }, plur) as any

  it('a custom store (PLUR_PATH / --path) is named with --path, and that grant is the one the server reads', async () => {
    const store = join(root, 'custom-store')
    const plur = new Plur({ path: store })
    const r = await start(plur)
    const warning = String(r.project_config_warning ?? '')
    expect(warning).toContain(`plur --path ${store} trust ${repo}`)
    // Doing what the warning says (the --path grant) is what makes the server trust it.
    plur.trustDirectory(repo)
    expect(plur.isDirectoryTrusted(repo)).toBe(true)
    const again = await start(plur)
    expect(again.project_config_warning).toBeUndefined()
    expect(again.default_scope).toBe('project:acme-app')
  })

  it('the default store keeps the bare `plur trust <dir>`', async () => {
    const plur = new Plur({ path: join(root, '.plur') })
    const r = await start(plur)
    const warning = String(r.project_config_warning ?? '')
    expect(warning).toContain(`run: plur trust ${repo}`)
    expect(warning).not.toContain('--path')
  })
})

describe('plur_learn_batch pinned quota is per item (1228-c #2)', () => {
  let dir: string
  let plur: Plur
  const call = async (name: string, args: Record<string, unknown>) =>
    await getToolDefinitions('full').find(t => t.name === name)!.handler(args, plur) as any

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-1228c-pin-'))
    // quota = floor(200 × 0.5) = 100 tokens: room for about one of the items below.
    writeFileSync(join(dir, 'config.yaml'),
      'embeddings:\n  enabled: false\ninjection_budget: 200\ninjection:\n  pinned_ratio: 0.5\n')
    plur = new Plur({ path: dir })
    _resetSessionTelemetry()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('five pinned items into room for about one: the later ones are refused, the set is not left over quota by more than one item', async () => {
    const statement = (n: number) =>
      `Pinned safety rule number ${n}: never deploy on a Friday afternoon without a rollback plan, ` +
      `a named owner on call, and the release checklist signed off by a second engineer (${'x'.repeat(40)}).`
    const before = await plur.pinnedQuota()
    expect(before.free).toBe(100)
    const out = await call('plur_learn_batch', {
      engrams: [1, 2, 3, 4, 5].map(n => ({ statement: statement(n), pinned: true, scope: 'global' })),
    })
    const refused = ((out.failures ?? []) as any[]).filter(f => /pinned_quota_exceeded/.test(f.error))
    expect(refused.length).toBeGreaterThanOrEqual(3)
    expect(out.ids.filter((id: string | null) => id !== null).length).toBeLessThanOrEqual(2)
    // Refusals are the LATER items, and each says the batch itself claimed the room.
    expect(refused.map(f => f.index)).toEqual([...refused.map(f => f.index)].sort((a, b) => a - b))
    expect(refused[0].error).toMatch(/earlier pinned items in this batch/)
    const after = await plur.pinnedQuota()
    const maxCost = Math.max(...after.entries.map(e => e.cost))
    expect(after.used).toBeLessThan(after.quota + maxCost)
  })

  it('good case: pinned items that fit are all admitted, and unpinned items are never gated', async () => {
    const out = await call('plur_learn_batch', {
      engrams: [
        { statement: 'short pinned rule one', pinned: true, scope: 'global' },
        { statement: 'short pinned rule two', pinned: true, scope: 'global' },
        { statement: 'an unpinned note that is long enough to matter '.repeat(5), scope: 'global' },
      ],
    })
    expect(out.failures ?? []).toEqual([])
    expect(out.ids.every((id: string | null) => id !== null)).toBe(true)
  })
})

describe('plur_admin does not double a tool-name prefix (1228-c #7)', () => {
  let dir: string
  let plur: Plur
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-1228c-admin-'))
    plur = new Plur({ path: dir })
    _resetSessionTelemetry()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('"plur_session_scope: no session is open…" appears once', async () => {
    const admin = getToolDefinitions('lean').find(t => t.name === 'plur_admin')!
    let message = ''
    try {
      await admin.handler({ action: 'plur_session_scope', args: { op: 'set', scope: 'project:x' } }, plur)
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toMatch(/^plur_session_scope: no session is open/)
    expect(message).not.toMatch(/plur_session_scope: plur_session_scope:/)
  })

  it('a message that does not name the tool still gets the prefix (the log must say which action failed)', async () => {
    const admin = getToolDefinitions('lean').find(t => t.name === 'plur_admin')!
    let message = ''
    try {
      await admin.handler({ action: 'plur_forget', args: { id: 'ENG-1999-0101-999' } }, plur)
    } catch (err) {
      message = (err as Error).message
    }
    if (message) expect(message.startsWith('plur_forget: ')).toBe(true)
  })
})

describe('a remote echoing its own write_count on a fresh push is still ADD (1228-c unconfirmed)', () => {
  const TOKEN = 'wc-token'
  const SCOPE = 'team:wc-test'
  let stub: StubServer
  let url: string
  let dir: string

  beforeAll(async () => {
    stub = new StubServer(TOKEN)
    url = (await stub.start()).url
    // Every 201 row the server returns claims it has been written seven times.
    const json = (stub as any).json.bind(stub)
    ;(stub as any).json = (res: unknown, status: number, body: any) =>
      json(res, status, status === 201 && body?.data ? { ...body, write_count: 7, data: { ...body.data, write_count: 7 } } : body)
  })
  afterAll(async () => { await stub.stop() })
  beforeEach(() => {
    stub.reset()
    dir = mkdtempSync(join(tmpdir(), 'plur-1228c-wc-'))
    writeFileSync(join(dir, 'config.yaml'),
      `embeddings:\n  enabled: false\nstores:\n  - url: "${url}"\n    token: "${TOKEN}"\n    scope: "${SCOPE}"\n`)
    _resetSessionTelemetry()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('plur_learn reports ADD, not NOOP', async () => {
    const plur = new Plur({ path: dir })
    const r = await getToolDefinitions('full').find(t => t.name === 'plur_learn')!
      .handler({ statement: 'Remote writes carry the server id back', scope: SCOPE }, plur) as any
    expect(stub.engramCount).toBe(1)
    expect(r.decision).toBe('ADD')
    expect(r.existing_id).toBeUndefined()
  })
})
