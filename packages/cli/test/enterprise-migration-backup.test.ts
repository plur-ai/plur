import { expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '@plur-ai/core'
import { connectServerStore } from '../src/enterprise/server-store.js'

it('a changed legacy backup refuses before writing and cannot be restored over the untouched config', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'migration-backup-')), path = join(dir, 'config.yaml')
  const jwt = [JSON.stringify({ alg: 'HS256' }), JSON.stringify({ sub: 'member' }), 'signature'].map(s => Buffer.from(s).toString('base64url')).join('.')
  const bytes = yaml.dump({ stores: [{ url: 'https://memory.example.invalid', scope: 'user:example:member', token: jwt }] })
  writeFileSync(path, bytes)
  const p = new Plur({ path: dir, autoDiscover: false })
  const list = p.listOutbox.bind(p)
  vi.spyOn(p, 'listOutbox').mockImplementationOnce(async (...args) => {
    const backup = (readdirSync(join(dir, 'backups'), { recursive: true }) as string[]).find(file => file.endsWith('config.yaml'))!
    writeFileSync(join(dir, 'backups', backup), 'stores: []\n# changed backup\n')
    return list(...args)
  })
  try {
    await expect(connectServerStore({ plur: p, server: 'https://memory.example.invalid', token: 'plur_sk_' + 'n'.repeat(32), personalScope: 'user:example:member', configPath: path, migrateLegacyPersonal: true })).rejects.toThrow()
    expect(readFileSync(path, 'utf8')).toBe(bytes)
  } finally { p.close(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }) }
})
