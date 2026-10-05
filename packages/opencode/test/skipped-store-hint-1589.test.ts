/**
 * #1589: the opencode plugin says once per session and folder when a memory
 * store in its folder was found but not added (the folder is on only through a
 * parent, so the repository's store needs the user's own decision), with the
 * paste-safe command. The same line the CLI prompt hooks print.
 *
 * Everything lives under the system temp folder; PLUR_TEST_DISCOVER_IN_TMP=1
 * turns off core's skip of store discovery for a PLUR home under it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur, saveFolderMap } from '@plur-ai/core'
import { PlurPlugin } from '../src/index.js'

const MEMORY = { count: 1, directives: '[ENG-1] Use pnpm.', constraints: '', consider: '', injected_ids: [], tokens_used: 0 }

describe('opencode: the skipped-store hint (#1589)', () => {
  let base: string
  let root: string
  let code: string
  let proj: string
  let plur: Plur
  const saved = { home: process.env.HOME, flag: process.env.PLUR_TEST_DISCOVER_IN_TMP }

  async function turn(hooks: any, sessionID: string, text: string, n: number): Promise<string> {
    await hooks['chat.message']!({ sessionID } as any, { message: { id: `msg-${sessionID}-${n}` }, parts: [{ type: 'text', text }] } as any)
    const out = { system: ['base'] }
    await hooks['experimental.chat.system.transform']!({ sessionID, model: {} } as any, out as any)
    return out.system.slice(1).join('\n')
  }
  const hint = (t: string) => t.split('\n').filter(l => l.includes('was not added'))

  beforeEach(async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'oc-hint-1589-')))
    root = join(base, 'home', '.plur')
    code = join(base, 'home', 'code')
    proj = join(code, 'proj')
    mkdirSync(root, { recursive: true })
    mkdirSync(join(proj, '.git'), { recursive: true })
    process.env.HOME = join(base, 'home')
    process.env.PLUR_TEST_DISCOVER_IN_TMP = '1'
    await new Plur({ path: join(proj, '.plur'), autoDiscover: false }).learn('Codeword OCREPOSTORE: shipped in the repository')
    saveFolderMap(root, { version: 1, folders: [{ path: code, plur: 'on' }] })
    plur = new Plur({ path: root, autoDiscover: false })
    ;(plur as any).injectHybrid = vi.fn().mockResolvedValue(MEMORY)
    ;(plur as any).learnRouted = vi.fn().mockResolvedValue({})
  })

  afterEach(() => {
    if (saved.home === undefined) delete process.env.HOME
    else process.env.HOME = saved.home
    if (saved.flag === undefined) delete process.env.PLUR_TEST_DISCOVER_IN_TMP
    else process.env.PLUR_TEST_DISCOVER_IN_TMP = saved.flag
    rmSync(base, { recursive: true, force: true })
  })

  it('one line on the first turn of a session, not again in that session, again in a new one', async () => {
    const hooks = await PlurPlugin({ directory: proj, worktree: proj, _plur: plur } as any)
    const sid = `ses-hint-${Date.now()}`
    const first = await turn(hooks, sid, 'how do we deploy', 1)
    expect(first).toContain('[ENG-1]')
    expect(hint(first)).toHaveLength(1)
    expect(hint(first)[0]).toContain(`folders set ${proj} --on`)
    expect(hint(await turn(hooks, sid, 'and the staging lane', 2))).toHaveLength(0)
    expect(hint(await turn(hooks, `${sid}-b`, 'how do we deploy', 1))).toHaveLength(1)
  })
})
