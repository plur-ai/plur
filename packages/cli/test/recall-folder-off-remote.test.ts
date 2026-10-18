/**
 * Where the folder map says memory must not reach a team store, an unscoped
 * `plur recall` / `plur inject` contacts no remote store at all, not even one
 * configured `dial: always` (finding L1 of the PR #1579 audit). Over MCP an
 * `off` folder, an undecided folder and a broken folder map refuse the read
 * outright; the CLI keeps printing what is on this machine, but sends nothing.
 *
 *  - `off` folder: no store is contacted, with or without `--scope` (MCP
 *    refuses an `off` folder whatever scope the call names).
 *  - undecided folder: no store is contacted for an unscoped read; an explicit
 *    `--scope` is the user's own choice and is still honoured.
 *  - broken folders.yaml: no store is contacted, with or without `--scope`,
 *    and stderr says so truthfully (finding L2): it used to say "memory is
 *    paused in every folder" while the same run printed local memory.
 *
 * The dial counter is a raw TCP server behind every store URL: it counts
 * connections of any kind, so no request path can slip past it.
 *
 * Async spawn: the counter lives in this process and must keep accepting.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import { createServer, type Server } from 'net'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))
const TOKEN = 'folder-off-remote-token'
const TEAM = 'group:test/eng'
const LOCAL = 'okapi-local the build uses the slow linker'

describe('no remote store is contacted where the folder map says no (L1, L2)', { timeout: 120000 }, () => {
  let tcp: Server
  let port: number
  let dials = 0
  let root: string
  let home: string
  let store: string
  let work: string

  beforeAll(async () => {
    tcp = createServer(s => { dials++; s.destroy() })
    await new Promise<void>(res => tcp.listen(0, '127.0.0.1', () => res()))
    port = (tcp.address() as { port: number }).port
  })
  afterAll(async () => { await new Promise<void>(res => tcp.close(() => res())) })

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'plur-folder-off-')))
    home = join(root, 'home')
    store = join(root, 'store')
    work = join(root, 'work')
    for (const d of [home, store, work]) mkdirSync(d, { recursive: true })
    // One engram on this machine, saved before any store is configured.
    writeFileSync(join(store, 'config.yaml'), `embeddings:\n  enabled: false\n`)
    const seeded = await run(['learn', LOCAL, '--scope', 'global'], home)
    expect(seeded.status, seeded.stderr).toBe(0)
    writeFileSync(join(store, 'config.yaml'),
      `embeddings:\n  enabled: false\nstores:\n` +
      `  - url: "http://127.0.0.1:${port}"\n    token: "${TOKEN}"\n    scope: "${TEAM}"\n    dial: always\n`)
    dials = 0
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  function mapWork(entry: string): void {
    writeFileSync(join(store, 'folders.yaml'), `version: 1\nfolders:\n  - path: "${work}"\n${entry}`)
  }

  function run(args: string[], cwd = work): Promise<{ stdout: string; stderr: string; status: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn('node', [CLI, ...args, '--path', store, '--json'], {
        env: { ...process.env, HOME: home, USERPROFILE: home, PLUR_DISABLE_EMBEDDINGS: '1', PLUR_PATH: store },
        cwd,
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', d => { stdout += String(d) })
      child.stderr.on('data', d => { stderr += String(d) })
      child.on('error', reject)
      child.on('close', code => resolve({ stdout, stderr, status: code ?? 1 }))
    })
  }

  /** recall (keyword), recall (hybrid) and inject (hybrid), with optional extra args. */
  async function readAll(extra: string[] = []): Promise<Array<{ stdout: string; stderr: string; status: number }>> {
    return [
      await run(['recall', 'okapi-local linker', '--fast', ...extra]),
      await run(['recall', 'okapi-local linker', ...extra]),
      await run(['inject', 'okapi-local linker', ...extra]),
    ]
  }

  it('off folder: an unscoped read contacts no store, and local memory still prints', async () => {
    mapWork(`    plur: off\n`)
    const [fast, hybrid, inject] = await readAll()
    expect(dials).toBe(0)
    expect(fast.stdout).toContain(LOCAL)
    expect(hybrid.stdout).toContain(LOCAL)
    expect(inject.status).toBe(0)
  })

  it('off folder: an explicit --scope contacts no store either (as MCP refuses it)', async () => {
    mapWork(`    plur: off\n`)
    await readAll(['--scope', TEAM])
    expect(dials).toBe(0)
  })

  it('undecided folder: an unscoped read contacts no store, and local memory still prints', async () => {
    const [fast, hybrid] = await readAll()
    expect(dials).toBe(0)
    expect(fast.stdout).toContain(LOCAL)
    expect(hybrid.stdout).toContain(LOCAL)
  })

  it('undecided folder: an explicit --scope is honoured and contacts the store', async () => {
    await run(['recall', 'okapi-local linker', '--fast', '--scope', TEAM])
    expect(dials).toBeGreaterThan(0)
  })

  for (const [form, text] of [
    ['an unclosed list', (w: string) => `version: 1\nfolders:\n  - path: "${w}"\n    plur: on\n    scope: [unclosed\n`],
    ['a wrong shape', () => `version: 1\nfolders: "nope"\n`],
  ] as const) {
    it(`broken folders.yaml (${form}): no store is contacted, with or without --scope; stderr is truthful`, async () => {
      writeFileSync(join(store, 'folders.yaml'), text(work))
      const plain = await readAll()
      const scoped = await readAll(['--scope', TEAM])
      expect(dials).toBe(0)
      expect(plain[0].stdout).toContain(LOCAL)
      for (const r of [...plain, ...scoped]) {
        expect(r.stderr).not.toMatch(/paused in every folder/)
        expect(r.stderr).toMatch(/folders\.yaml/)
        expect(r.stderr).toMatch(/team memory/i)
        expect(r.stderr).toMatch(/plur (--path \S+ )?folders repair/)
      }
    })
  }

  it('guard: a folder mapped on still contacts a dial: always store', async () => {
    mapWork(`    plur: on\n`)
    await run(['recall', 'okapi-local linker', '--fast'])
    expect(dials).toBeGreaterThan(0)
  })

  it('guard: run from the home folder with no decision, a dial: always store is still contacted (as MCP)', async () => {
    await run(['recall', 'okapi-local linker', '--fast'], home)
    expect(dials).toBeGreaterThan(0)
  })
})
