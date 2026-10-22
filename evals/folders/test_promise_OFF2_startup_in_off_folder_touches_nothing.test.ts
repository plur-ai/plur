// OFF-2: Starting PLUR in a folder where memory is off does not touch memory at all.
//
// today: broken (issue 1523). The MCP server is started the way an editor
// starts it: the process's folder is a project folder marked `off` in my
// folder map, and that folder holds its own `.plur/engrams.yaml`. Starting
// the engine and the server, and letting startup work settle, must change no
// file in my PLUR home and none in the project's store.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Plur } from '../../packages/core/src/index.js'
import { setEmbeddingsEnabled } from '../../packages/core/src/embeddings.js'
import { connectMcp, offlineFetch, snapshotTree, treeChanges, writeFolderMap } from '../helpers/privacy-folders-team-mcp.js'

const PROJECT_ENGRAMS = `engrams:
  - id: ENG-2026-01-01-001
    version: 2
    status: active
    consolidated: false
    type: behavioral
    scope: project:offsite
    visibility: private
    statement: the offsite project keeps its build cache on the scratch disk
    activation: { retrieval_strength: 0.7, storage_strength: 1, frequency: 0, last_accessed: '2026-01-01' }
    feedback_signals: { positive: 0, negative: 0, neutral: 0 }
    knowledge_anchors: []
    associations: []
    derivation_count: 1
    pack: null
    abstract: null
    derived_from: null
    polarity: null
`

describe('OFF-2 starting PLUR in an off folder does not touch memory', () => {
  const dirs: string[] = []
  let net: ReturnType<typeof offlineFetch> | undefined
  let close: (() => Promise<void>) | undefined
  afterEach(async () => {
    await close?.(); close = undefined
    net?.restore(); net = undefined
    vi.restoreAllMocks()
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('engine and MCP server start in an off folder that has its own store', async () => {
    net = offlineFetch()
    setEmbeddingsEnabled(false, 'eval: embeddings off')
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'plur-eval-off2-home-')))
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'plur-eval-off2-project-')))
    dirs.push(home, project)
    writeFileSync(join(home, 'config.yaml'), 'embeddings:\n  enabled: false\n')
    writeFileSync(join(home, 'engrams.yaml'), 'engrams: []\n')
    mkdirSync(join(project, '.plur'))
    writeFileSync(join(project, '.plur', 'engrams.yaml'), PROJECT_ENGRAMS)
    writeFolderMap(home, [{ path: project, plur: 'off' }])
    vi.spyOn(process, 'cwd').mockReturnValue(project)

    const homeBefore = snapshotTree(home)
    const projectBefore = snapshotTree(project)
    expect(Object.keys(projectBefore), 'precondition: the off folder holds a PLUR store').toContain(join('.plur', 'engrams.yaml'))

    // Start the engine and the server as the MCP entry point does.
    const plur = new Plur({ path: home })
    const conn = await connectMcp(plur)
    close = conn.close
    await plur.ready().catch(() => {})
    await plur.waitForIndex().catch(() => {})
    await new Promise(r => setTimeout(r, 300))

    const homeChanges = treeChanges(homeBefore, snapshotTree(home))
    const projectChanges = treeChanges(projectBefore, snapshotTree(project))
    expect(homeChanges, `expected starting PLUR in an off folder to change nothing in my PLUR home; it did: ${homeChanges.join(', ')}`).toEqual([])
    expect(projectChanges, `expected starting PLUR in an off folder to change nothing in that folder's store; it did: ${projectChanges.join(', ')}`).toEqual([])
  })
})
