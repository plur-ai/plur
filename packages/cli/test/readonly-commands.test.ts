import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync, execFile } from 'child_process'
import { promisify } from 'util'
import { createServer, type Server } from 'http'

const CLI = join(__dirname, '..', 'dist', 'index.js')

/**
 * Read-only engine wiring for pure-query commands (#731).
 *
 * `plur list`, `plur status` and `plur tensions` (list mode) open the engine
 * with `readonly: true`; `plur tensions --scan` and the lifecycle actions must
 * keep a WRITABLE engine (a scan that cannot persist its records would be the
 * regression). Byte-identity of engrams.yaml is the strongest observable
 * proof: no activation refresh, no lazy migration, no lock-file litter.
 */
let server: Server
let baseUrl: string

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
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

describe('read-only command wiring (#731)', () => {
  let dir: string
  const execFileAsync = promisify(execFile)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-cli-readonly-'))
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function run(args: string): string {
    return execSync(`node ${CLI} ${args} --path ${dir} --json`, { encoding: 'utf-8', timeout: 15000 }).trim()
  }

  async function runAsync(args: string): Promise<string> {
    const { stdout } = await execFileAsync('node', [CLI, ...args.split(' '), '--path', dir, '--json'], {
      encoding: 'utf-8', timeout: 20000,
    })
    return stdout.trim()
  }

  const engrams = () => readFileSync(join(dir, 'engrams.yaml'), 'utf8')

  it('list and status leave engrams.yaml byte-identical and drop no .lock files', () => {
    run('learn "plur cli version is 0.3.0"')
    const before = engrams()

    const listed = JSON.parse(run('list'))
    expect(listed.engrams.length).toBe(1)
    const status = JSON.parse(run('status'))
    expect(status.engram_count).toBe(1)

    expect(engrams()).toBe(before)
    expect(readdirSync(dir).filter(f => f.endsWith('.lock'))).toEqual([])
  })

  it('tensions list mode is read-only; --scan still gets a writable engine', async () => {
    run('learn "plur cli version is 0.3.0"')
    run('learn "plur cli version is 0.8.2"')
    const before = engrams()

    // List mode: pure read.
    const listed = JSON.parse(run('tensions'))
    expect(listed.count).toBe(0)
    expect(engrams()).toBe(before)

    // Scan mode: must be able to PERSIST what it found — a read-only engine
    // here would fail the scan outright.
    const scanned = JSON.parse(await runAsync(`tensions --scan --llm-base-url ${baseUrl} --llm-api-key k`))
    expect(scanned.persisted_new).toBe(1)
    expect(existsSync(join(dir, 'tensions.yaml'))).toBe(true)
  })
})
