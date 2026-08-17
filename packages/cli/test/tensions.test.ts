import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync, execFile } from 'child_process'
import { promisify } from 'util'
import { createServer, type Server } from 'http'
import { Plur } from '@plur-ai/core'

const CLI = join(__dirname, '..', 'dist', 'index.js')

/**
 * Stub OpenAI-compatible chat-completions server. Always answers
 * "CONTRADICTS: yes / 0.9" per pair so tests can observe the temporal
 * gates (#240): whether a pair reached the judge at all, and whether the
 * confidence was discounted afterwards.
 */
let server: Server
let baseUrl: string
const promptsSeen: string[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString())
      const prompt: string = body.messages[0].content
      promptsSeen.push(prompt)
      const n = (prompt.match(/PAIR \d+/g) ?? []).length
      const content = n > 0
        ? Array.from({ length: n }, (_, i) => `PAIR_${i + 1}: CONTRADICTS: yes | CONFIDENCE: 0.9 | REASON: Opposite.`).join('\n')
        : 'CONTRADICTS: yes\nCONFIDENCE: 0.9\nREASON: Opposite.'
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ choices: [{ message: { content } }] }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as { port: number }
  baseUrl = `http://127.0.0.1:${addr.port}/v1`
})

afterAll(() => new Promise<void>(resolve => server.close(() => resolve())))

describe('plur tensions --scan temporal gates (#240)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-cli-tensions-'))
    promptsSeen.length = 0
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  // NOTE: must be async — the stub LLM server lives in this same process, so a
  // synchronous execSync would block the event loop and the server could never
  // answer the child's request (the child would hang until timeout).
  const execFileAsync = promisify(execFile)
  async function run(args: string): Promise<string> {
    const { stdout } = await execFileAsync('node', [CLI, ...args.split(' '), '--path', dir, '--json'], {
      encoding: 'utf-8',
      timeout: 20000,
    })
    return stdout.trim()
  }

  /** Two contradicting engrams recorded ~a month apart (learned_at back-dated). */
  function seedPair(domain?: string): void {
    const plur = new Plur({ path: dir })
    const a = plur.learn('hormuz strait ceasefire holding, passage regulated', domain ? { domain } : undefined)
    const b = plur.learn('hormuz strait ceasefire collapsed, passage closed', domain ? { domain } : undefined)
    for (const [id, learnedAt] of [[a.id, '2026-04-07'], [b.id, '2026-05-05']] as const) {
      const stored = plur.getById(id)!
      plur.updateEngram({ ...stored, temporal: { ...stored.temporal, learned_at: learnedAt } })
    }
  }

  it('reports days_apart and passes recorded dates to the judge', async () => {
    seedPair()
    const out = JSON.parse(await run(`tensions --scan --llm-base-url ${baseUrl} --llm-api-key k`))
    expect(out.pairs_checked).toBe(1)
    expect(out.count).toBe(1)
    expect(out.tensions[0].days_apart).toBe(28)
    expect(out.tensions[0].confidence).toBeCloseTo(0.9)
    expect(promptsSeen.join('\n')).toContain('2026-04-07')
    expect(promptsSeen.join('\n')).toContain('2026-05-05')
  })

  it('config tensions.temporal_domains skips snapshot pairs before the judge', async () => {
    writeFileSync(join(dir, 'config.yaml'), 'tensions:\n  temporal_domains:\n    - war-analysis\n')
    seedPair('war-analysis')
    const out = JSON.parse(await run(`tensions --scan --llm-base-url ${baseUrl} --llm-api-key k`))
    expect(out.pairs_checked).toBe(0)
    expect(out.count).toBe(0)
    expect(promptsSeen).toHaveLength(0)
  })

  it('--temporal-discount multiplies confidence by the days-apart ladder', async () => {
    seedPair()
    const out = JSON.parse(await run(`tensions --scan --temporal-discount --min-confidence 0.2 --llm-base-url ${baseUrl} --llm-api-key k`))
    expect(out.count).toBe(1)
    // 28 days apart → ×0.3 → 0.27
    expect(out.tensions[0].confidence).toBeCloseTo(0.27)
    expect(out.tensions[0].raw_confidence).toBeCloseTo(0.9)
  })

  it('--no-temporal-discount overrides config temporal_discount: true', async () => {
    writeFileSync(join(dir, 'config.yaml'), 'tensions:\n  temporal_discount: true\n')
    seedPair()
    const out = JSON.parse(await run(`tensions --scan --no-temporal-discount --llm-base-url ${baseUrl} --llm-api-key k`))
    expect(out.count).toBe(1)
    expect(out.tensions[0].confidence).toBeCloseTo(0.9)
    expect(out.tensions[0].raw_confidence).toBeUndefined()
  })
})

describe('plur learn --supersedes (#240)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-cli-supersedes-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function run(args: string): string {
    return execSync(`node ${CLI} ${args} --path ${dir} --json`, {
      encoding: 'utf-8',
      timeout: 10000,
    }).trim()
  }

  it('writes the forward edge on the new engram and the reverse edge on the target', () => {
    const oldE = JSON.parse(run('learn "plur cli version is 0.3.0"'))
    const newE = JSON.parse(run(`learn "plur cli version is 0.8.2" --supersedes ${oldE.id}`))

    const plur = new Plur({ path: dir })
    expect(plur.getById(newE.id)?.relations?.supersedes).toEqual([oldE.id])
    expect(plur.getById(oldE.id)?.relations?.superseded_by).toEqual([newE.id])
  })

  it('supersedes-linked pair is not scanned as a tension candidate', () => {
    const oldE = JSON.parse(run('learn "plur cli version is 0.3.0"'))
    JSON.parse(run(`learn "plur cli version is 0.8.2" --supersedes ${oldE.id}`))

    // Scan finds zero candidates, so the (blocked-event-loop) stub server is
    // never contacted — safe to run synchronously.
    const out = JSON.parse(run(`tensions --scan --llm-base-url ${baseUrl} --llm-api-key k`))
    expect(out.pairs_checked).toBe(0)
    expect(out.count).toBe(0)
  })
})
