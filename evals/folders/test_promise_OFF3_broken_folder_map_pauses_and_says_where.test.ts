// OFF-3: If my folder settings are broken, memory pauses and tells me which line is wrong and how to fix it.
//
// Driven through the MCP server. Two broken folder maps, each wrong on line 4:
// one PLUR can repair (bad indentation), one it cannot (a misspelled value).
// Memory must pause (no store file changes, no memory text returned, the
// answer says PLUR is off), and the message must name the file, the line, and
// how to fix it: the repair command when there is one, otherwise to fix it by
// hand. The control: with a valid map in the same setup, memory answers.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Plur } from '../../packages/core/src/index.js'
import { setEmbeddingsEnabled } from '../../packages/core/src/embeddings.js'
import { callTool, connectMcp, offlineFetch, snapshotTree, treeChanges, writeFolderMap } from '../helpers/privacy-folders-team-mcp.js'

const FACT = 'wombat-fact the nightly backup goes to the cold bucket'

describe('OFF-3 a broken folder map pauses memory and says which line is wrong and how to fix it', () => {
  const dirs: string[] = []
  const closers: Array<() => Promise<void>> = []
  let net: ReturnType<typeof offlineFetch>
  beforeEach(() => { net = offlineFetch() })
  afterEach(async () => {
    for (const c of closers.splice(0)) await c()
    net.restore()
    vi.restoreAllMocks()
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  async function setup() {
    setEmbeddingsEnabled(false, 'eval: embeddings off')
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'plur-eval-off3-home-')))
    const work = realpathSync(mkdtempSync(join(tmpdir(), 'plur-eval-off3-work-')))
    dirs.push(home, work)
    writeFileSync(join(home, 'config.yaml'), 'embeddings:\n  enabled: false\n')
    const plur = new Plur({ path: home, autoDiscover: false })
    await plur.learn(FACT, { scope: 'global' })
    vi.spyOn(process, 'cwd').mockReturnValue(work)
    const conn = await connectMcp(plur)
    closers.push(conn.close)
    return { home, work, client: conn.client }
  }

  it('control: with a valid folder map, memory answers', async () => {
    const s = await setup()
    writeFolderMap(s.home, [{ path: s.work, plur: 'on' }])
    const r = await callTool(s.client, 'plur_recall', { query: 'wombat nightly backup' })
    expect(r.text, 'precondition: with a valid map, recall finds my memory').toContain('wombat-fact')
  })

  const cases = [
    {
      name: 'a line PLUR can repair (bad indentation on line 4)',
      map: (work: string) => `version: 1\nfolders:\n  - path: "${work}"\n     plur: on\n`,
      howToFix: (home: string, msg: string, json: any) => {
        expect(json?.repair_command, 'expected the exact repair command to be offered').toMatch(/folders repair/)
        expect(msg, 'expected the message to give the repair command').toContain(json?.repair_command)
        expect(msg, 'expected the message to name this PLUR home in the command').toContain(home)
      },
    },
    {
      name: 'a line PLUR cannot repair (plur: of on line 4)',
      map: (work: string) => `version: 1\nfolders:\n  - path: "${work}"\n    plur: of\n`,
      howToFix: (_home: string, msg: string) => {
        expect(msg, 'expected the message to say it must be fixed by hand and what the allowed values are').toMatch(/by hand/i)
        expect(msg, 'expected the message to name what the value should be').toMatch(/\bon\b.*\boff\b|\boff\b.*\bon\b/)
      },
    },
  ]

  for (const c of cases) {
    it(c.name, async () => {
      const s = await setup()
      writeFileSync(join(s.home, 'folders.yaml'), c.map(s.work))
      const before = snapshotTree(s.home)
      for (const [tool, args] of [
        ['plur_recall', { query: 'wombat nightly backup' }],
        ['plur_learn', { statement: 'wombat-new learning', scope: 'global' }],
        ['plur_inject_hybrid', { task: 'wombat nightly backup' }],
      ] as const) {
        const r = await callTool(s.client, tool, args)
        const msg = String(r.json?.message ?? '')
        expect(r.raw.isError, `${tool}: should answer without an error; got ${r.text.slice(0, 300)}`).not.toBe(true)
        expect(r.json?.plur, `${tool}: expected memory to pause under a broken folder map; got ${r.text.slice(0, 300)}`).toBe('off')
        expect(r.text, `${tool}: returned memory text under a broken folder map`).not.toContain('wombat-fact')
        expect(msg, `${tool}: expected the message to name the folder map file`).toContain(join(s.home, 'folders.yaml'))
        expect(msg, `${tool}: expected the message to say line 4 is wrong; got: ${msg}`).toMatch(/line 4\b/)
        c.howToFix(s.home, msg, r.json)
      }
      expect(treeChanges(before, snapshotTree(s.home)), 'expected no memory file to change while memory is paused').toEqual([])
    })
  }
})
