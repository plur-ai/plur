/**
 * The seen-on-server record under concurrent writers (#1532 re-audit 2,
 * S1–S3, S7). It is evidence for refusing a destructive forget after a 401,
 * so it must not lose lines:
 *
 *   S1  Bounding the file never drops a line another process appends at the
 *       same moment (no read-rewrite-rename of the live file).
 *   S2  A record appended after a torn last line (a writer killed mid-append)
 *       is still found.
 *   S3  A record without a numeric `at` is ignored, never an error.
 *   S7  The bound is a real byte bound: long lines do not make every append
 *       re-compact the file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readdirSync, statSync, appendFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import { recordSeenOnServer, seenOnServer, SEEN_ON_SERVER_FILE } from '../src/seen-on-server.js'
import { Plur } from '../src/index.js'
import { createServer } from 'http'

const SRC = join(__dirname, '..', 'src', 'seen-on-server.ts')

describe('seen-on-server record', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-seen-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const totalBytes = (): number => readdirSync(dir).filter(f => f.startsWith('seen-on-server'))
    .reduce((n, f) => n + statSync(join(dir, f)).size, 0)

  it('S1: concurrent writers lose no line while the file is being bounded', async () => {
    // Fill close to the bound, so bounding happens while the children append.
    const scope = 'group:' + 'x'.repeat(200)
    const filler = Array.from({ length: 60_000 }, (_, i) => ({ id: `ENG-FILL-${i}`, scope }))
    for (let i = 0; i < filler.length; i += 5_000) recordSeenOnServer(dir, filler.slice(i, i + 5_000))
    const child = (tag: string): Promise<number> => new Promise(resolve => {
      const script = `
        const { recordSeenOnServer } = await import(${JSON.stringify('file://' + SRC)});
        const scope = 'group:' + 'y'.repeat(200);
        for (let i = 0; i < 1500; i++) recordSeenOnServer(${JSON.stringify(dir)}, [{ id: '${tag}-' + i, scope }]);
      `
      const c = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { stdio: 'ignore', cwd: join(__dirname, '..') })
      c.on('exit', code => resolve(code ?? 1))
    })
    const codes = await Promise.all([child('A'), child('B'), child('C')])
    expect(codes).toEqual([0, 0, 0])
    const missing: string[] = []
    for (const tag of ['A', 'B', 'C']) for (let i = 0; i < 1500; i++) {
      if (!seenOnServer(dir, `${tag}-${i}`)) missing.push(`${tag}-${i}`)
    }
    expect(missing).toEqual([])
  }, 180_000)

  it('S2: a record appended after a torn last line is found', () => {
    writeFileSync(join(dir, SEEN_ON_SERVER_FILE), '{"id":"ENG-OLD-1","scope":"group:t","at":1}\n{"id":"ENG-TORN","sc')
    recordSeenOnServer(dir, [{ id: 'ENG-NEW-1', scope: 'group:t' }])
    expect(seenOnServer(dir, 'ENG-NEW-1')).not.toBeNull()
    expect(seenOnServer(dir, 'ENG-OLD-1')).not.toBeNull()
  })

  it('S3: a record without a numeric at is ignored', () => {
    writeFileSync(join(dir, SEEN_ON_SERVER_FILE), '{"id":"ENG-NOAT","scope":"group:t"}\n{"id":"ENG-STRAT","scope":"group:t","at":"yesterday"}\n')
    expect(seenOnServer(dir, 'ENG-NOAT')).toBeNull()
    expect(seenOnServer(dir, 'ENG-STRAT')).toBeNull()
  })

  it('S3: forget after a 401 is not broken by a damaged record (no RangeError)', async () => {
    const server = createServer((_q, r) => { r.writeHead(401); r.end('{}') })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    try {
      writeFileSync(join(dir, 'config.yaml'), 'embeddings:\n  enabled: false\n')
      const p0 = new Plur({ path: dir }); await p0.ready()
      const id = (await p0.learn('local engram next to a damaged record', { scope: 'global' })).id
      appendFileSync(join(dir, SEEN_ON_SERVER_FILE), JSON.stringify({ id, scope: 'group:test' }) + '\n')
      writeFileSync(join(dir, 'config.yaml'), `embeddings:\n  enabled: false\nstores:\n  - url: "http://127.0.0.1:${port}"\n    token: "t"\n    scope: "group:test"\n`)
      const p = new Plur({ path: dir }); await p.ready()
      const res = await p.forget(id, 'test', { force: true })
      expect(res.warnings.join(' ')).toMatch(/token/i)
    } finally { await new Promise<void>(r => server.close(() => r())) }
  }, 60_000)

  it('S7: long lines keep the record within a real byte bound, and appends stay cheap', () => {
    const scope = 'group:' + 'z'.repeat(400)
    for (let i = 0; i < 60_000; i += 5_000) {
      recordSeenOnServer(dir, Array.from({ length: 5_000 }, (_, k) => ({ id: `ENG-LONG-${i + k}`, scope })))
    }
    const t0 = Date.now()
    for (let i = 0; i < 20; i++) recordSeenOnServer(dir, [{ id: `ENG-TAIL-${i}`, scope }])
    expect(Date.now() - t0).toBeLessThan(1_000)
    expect(totalBytes()).toBeLessThanOrEqual(26 * 1024 * 1024)
    expect(seenOnServer(dir, 'ENG-TAIL-19')).not.toBeNull()
  }, 120_000)
})
