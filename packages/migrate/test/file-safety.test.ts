import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { run } from '../src/index.js'

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof fs>() }))

let root: string
const source = 'async function f() { plur.recall("memory"); }\n'
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'plur-codemod-safety-'))
  vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  vi.spyOn(process.stderr, 'write').mockReturnValue(true)
})
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }) })

it('does not follow source-file symlinks during a directory rewrite', () => {
  const project = join(root, 'project'); fs.mkdirSync(project)
  const outside = join(root, 'outside.ts'); fs.writeFileSync(outside, source)
  fs.symlinkSync(outside, join(project, 'linked.ts'))
  expect(run([project, '--write'])).toBe(1)
  expect(fs.readFileSync(outside, 'utf8')).toBe(source)
  expect(fs.lstatSync(join(project, 'linked.ts')).isSymbolicLink()).toBe(true)
})

it('refuses an explicitly supplied symlink without modifying its target', () => {
  const original = join(root, 'original.ts'); const link = join(root, 'linked.ts')
  fs.writeFileSync(original, source); fs.symlinkSync(original, link)
  expect(run([link, '--write'])).toBe(1)
  expect(fs.readFileSync(original, 'utf8')).toBe(source)
})

it('reports an incomplete scan when a source file cannot be read', () => {
  const file = join(root, 'source.ts'); fs.writeFileSync(file, source)
  const original = fs.readFileSync
  vi.spyOn(fs, 'readFileSync').mockImplementation(((path: any, ...args: any[]) => {
    if (path === file) throw Object.assign(new Error('unreadable'), { code: 'EACCES' })
    return (original as any)(path, ...args)
  }) as any)
  expect(run([root])).toBe(1)
  expect(process.stdout.write).not.toHaveBeenCalledWith(expect.stringContaining('no un-awaited'))
})

it('preserves original bytes and permissions when replacement fails', () => {
  const file = join(root, 'source.ts'); fs.writeFileSync(file, source, { mode: 0o640 })
  vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw Object.assign(new Error('I/O error'), { code: 'EIO' }) })
  expect(run([file, '--write'])).toBe(1)
  expect(fs.readFileSync(file, 'utf8')).toBe(source)
  expect(fs.statSync(file).mode & 0o777).toBe(0o640)
  expect(fs.readdirSync(root)).toEqual(['source.ts'])
})

it('flushes staged bytes before replacing and preserves executable mode', () => {
  const file = join(root, 'source.ts'); fs.writeFileSync(file, source, { mode: 0o750 })
  const sync = vi.spyOn(fs, 'fsyncSync'); const rename = vi.spyOn(fs, 'renameSync')
  expect(run([file, '--write'])).toBe(0)
  expect(fs.readFileSync(file, 'utf8')).toContain('await plur.recall')
  expect(fs.statSync(file).mode & 0o777).toBe(0o750)
  expect(sync.mock.invocationCallOrder[0]).toBeLessThan(rename.mock.invocationCallOrder[0])
  expect(fs.readdirSync(root)).toEqual(['source.ts'])
  expect(run([file, '--write'])).toBe(0)
})

it('refuses to overwrite a file changed while its replacement was staged', () => {
  const file = join(root, 'source.ts'); fs.writeFileSync(file, source)
  const changed = '// concurrent edit\n' + source
  const original = fs.fsyncSync; let injected = false
  vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
    if (!injected) { injected = true; fs.writeFileSync(file, changed) }
    return original(fd)
  })
  expect(run([file, '--write'])).toBe(1)
  expect(fs.readFileSync(file, 'utf8')).toBe(changed)
  expect(fs.readdirSync(root)).toEqual(['source.ts'])
})

it('refuses hard links without changing either source name', () => {
  const file = join(root, 'source.ts'); const alias = join(root, 'alias.ts')
  fs.writeFileSync(file, source); fs.linkSync(file, alias)
  expect(run([file, '--write'])).toBe(1)
  expect(fs.readFileSync(file, 'utf8')).toBe(source)
  expect(fs.readFileSync(alias, 'utf8')).toBe(source)
})

it('preserves source bytes when staging fails after a partial write', () => {
  const file = join(root, 'source.ts'); fs.writeFileSync(file, source)
  const original = fs.writeFileSync
  vi.spyOn(fs, 'writeFileSync').mockImplementation(((path: any, data: any, ...args: any[]) => {
    if (typeof path === 'number') { original(path, 'partial'); throw new Error('disk full') }
    return (original as any)(path, data, ...args)
  }) as any)
  expect(run([file, '--write'])).toBe(1)
  expect(fs.readFileSync(file, 'utf8')).toBe(source)
  expect(fs.readdirSync(root)).toEqual(['source.ts'])
})

it('does not report a failed directory scan as clean', () => {
  vi.spyOn(fs, 'readdirSync').mockImplementation(() => { throw new Error('unreadable') })
  expect(run([root])).toBe(1)
  expect(process.stdout.write).not.toHaveBeenCalled()
})

it('refuses to rewrite non-UTF-8 source instead of replacing undecodable bytes', () => {
  const file = join(root, 'source.ts')
  const bytes = Buffer.concat([Buffer.from('// '), Buffer.from([0xff]), Buffer.from('\n' + source)])
  fs.writeFileSync(file, bytes)
  expect(run([file, '--write'])).toBe(1)
  expect(fs.readFileSync(file)).toEqual(bytes)
})
