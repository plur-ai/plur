import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync, execFile } from 'child_process'
import { promisify } from 'util'
import { createServer, type Server } from 'http'
import { Plur } from '@plur-ai/core'

const CLI = join(__dirname, '..', 'dist', 'index.js')

/**
 * plur tensions lifecycle CLI (#181): scan persistence, suppress-list,
 * confirm/dismiss/resolve subcommands.
 *
 * Stub OpenAI-compatible server answers CONTRADICTS: yes / 0.9 per pair.
 * Scan-tests must use the async runner — the stub lives in this process, so
 * a blocking execSync would starve its event loop.
 */
let server: Server
let baseUrl: string
let llmCalls = 0

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      llmCalls++
      const prompt: string = JSON.parse(Buffer.concat(chunks).toString()).messages[0].content
      const n = (prompt.match(/PAIR \d+/g) ?? []).length
      const content = n > 0
        ? Array.from({ length: n }, (_, i) => `PAIR_${i + 1}: CONTRADICTS: yes | CONFIDENCE: 0.9 | REASON: Opposite.`).join('\n')
        : 'CONTRADICTS: yes\nCONFIDENCE: 0.9\nREASON: Opposite.'
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ choices: [{ message: { content } }] }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
})

afterAll(() => new Promise<void>(resolve => server.close(() => resolve())))

describe('plur tensions lifecycle (#181)', () => {
  let dir: string
  const execFileAsync = promisify(execFile)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-cli-tension-lc-'))
    llmCalls = 0
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  async function runAsync(args: string): Promise<string> {
    const { stdout } = await execFileAsync('node', [CLI, ...args.split(' '), '--path', dir, '--json'], {
      encoding: 'utf-8', timeout: 20000,
    })
    return stdout.trim()
  }

  function run(args: string): string {
    return execSync(`node ${CLI} ${args} --path ${dir} --json`, { encoding: 'utf-8', timeout: 10000 }).trim()
  }

  function seed(): { aId: string; bId: string } {
    const a = JSON.parse(run('learn "plur cli version is 0.3.0"'))
    const b = JSON.parse(run('learn "plur cli version is 0.8.2"'))
    return { aId: a.id, bId: b.id }
  }

  it('scan persists records; second scan is suppressed', async () => {
    seed()
    const first = JSON.parse(await runAsync(`tensions --scan --llm-base-url ${baseUrl} --llm-api-key k`))
    expect(first.count).toBe(1)
    expect(first.persisted_new).toBe(1)
    expect(first.tensions[0].tension_id).toMatch(/^T-/)
    expect(existsSync(join(dir, 'tensions.yaml'))).toBe(true)

    const callsAfterFirst = llmCalls
    const second = JSON.parse(await runAsync(`tensions --scan --llm-base-url ${baseUrl} --llm-api-key k`))
    expect(second.pairs_checked).toBe(0)
    expect(llmCalls).toBe(callsAfterFirst)
  })

  it('--no-persist scans without recording', async () => {
    seed()
    const out = JSON.parse(await runAsync(`tensions --scan --no-persist --llm-base-url ${baseUrl} --llm-api-key k`))
    expect(out.count).toBe(1)
    expect(out.persisted_new).toBeUndefined()
    const list = JSON.parse(run('tensions'))
    expect(list.count).toBe(0)
  })

  it('list shows persisted records; --status filters', async () => {
    seed()
    const scan = JSON.parse(await runAsync(`tensions --scan --llm-base-url ${baseUrl} --llm-api-key k`))
    const id = scan.tensions[0].tension_id

    const list = JSON.parse(run('tensions'))
    expect(list.count).toBe(1)
    expect(list.tensions[0].id).toBe(id)
    expect(list.tensions[0].status).toBe('detected')

    run(`tensions dismiss ${id}`)
    expect(JSON.parse(run('tensions')).count).toBe(0)
    expect(JSON.parse(run('tensions --status all')).count).toBe(1)
    expect(JSON.parse(run('tensions --status dismissed')).count).toBe(1)
  })

  it('confirm then resolve retires the loser', async () => {
    const { aId, bId } = seed()
    const scan = JSON.parse(await runAsync(`tensions --scan --llm-base-url ${baseUrl} --llm-api-key k`))
    const id = scan.tensions[0].tension_id

    const confirmed = JSON.parse(run(`tensions confirm ${id}`))
    expect(confirmed.record.status).toBe('confirmed')

    const resolved = JSON.parse(run(`tensions resolve ${id} --winner ${bId}`))
    expect(resolved.record.status).toBe('resolved')
    expect(resolved.record.resolved_by).toBe(bId)
    expect(resolved.retired).toBe(aId)

    const plur = new Plur({ path: dir })
    expect(plur.getById(aId)?.status).toBe('retired')
    expect(plur.getById(bId)?.status).toBe('active')
  })

  it('resolve without --winner exits 1', async () => {
    seed()
    const scan = JSON.parse(await runAsync(`tensions --scan --llm-base-url ${baseUrl} --llm-api-key k`))
    expect(() => run(`tensions resolve ${scan.tensions[0].tension_id}`)).toThrow()
  })
})
