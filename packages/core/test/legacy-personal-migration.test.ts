import { expect, it } from 'vitest'
import { registerServerEntry } from '../src/server-discovery.js'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'

const url = 'https://memory.example.invalid', personalScope = 'user:example:member'
const jwt = [JSON.stringify({ alg: 'HS256', typ: 'JWT' }), JSON.stringify({ sub: 'legacy-member' }), 'synthetic-signature'].map(s => Buffer.from(s).toString('base64url')).join('.')
const token = 'plur_sk_' + 'n'.repeat(32)
const legacy = { url, scope: personalScope, token: jwt, tier: 'team' }
const reg = { url, token, personalScope, migrateLegacyPersonal: true }

it('explicit legacy migration folds one personal JWT and retains its metadata and unrelated entries', () => {
  const unrelated = { url: 'https://other.example.invalid', scope: 'group:example/team', token: 'other-key' }
  const result = registerServerEntry([legacy, unrelated], reg)
  expect(result.stores).toHaveLength(2)
  expect(result.stores).toContainEqual(unrelated)
  expect(result.entry.token).toBe(token)
  expect(result.entry.scope_settings).toMatchObject({ [personalScope]: { tier: 'team' } })
  expect(result.migratedLegacy).toBe(true)
  expect(JSON.stringify(result.stores)).not.toContain(jwt)
  expect(legacy.token).toBe(jwt)
})

it('generic registration continues to preserve different legacy credentials', () => {
  const result = registerServerEntry([legacy], { url, token, personalScope })
  expect(result.stores).toContainEqual(legacy)
  expect(result.stores).toHaveLength(2)
})

it.each([
  { token: 'plur_sk_' + 'o'.repeat(32) }, { token_env: 'OTHER_TOKEN' },
  { readonly: true }, { path: './local' }, { scope: 'user:example:other' },
  { scope: 'user:example:Member' }, { url: 'https://other.example.invalid' },
  { token: 'legacy.fixture.jwt' }, { scopes: [personalScope], enterprise: {} },
])('does not convert an ineligible entry %j', override => {
  const entry = { ...legacy, ...override }
  try {
    const result = registerServerEntry([entry], reg)
    // A pre-existing C6 entry follows ordinary rotation, not migration.
    if ('enterprise' in override) expect(result.migratedLegacy).toBe(false)
    else expect(result.stores).toContainEqual(entry)
  } catch (error) {
    expect(String(error)).toMatch(/personal scope|legacy|ambiguous/)
  }
  expect(entry.token).toBe(override.token ?? jwt)
})

it('refuses multiple legacy candidates without mutating them', () => {
  const entries = [legacy, { ...legacy }], before = JSON.stringify(entries)
  expect(() => registerServerEntry(entries, reg)).toThrow(/ambiguous/)
  expect(JSON.stringify(entries)).toBe(before)
})

it('refuses a legacy candidate alongside a competing personal route', () => {
  expect(() => registerServerEntry([legacy, { scope: personalScope, path: './personal' }], reg)).toThrow(/ambiguous/)
})

it.each([{ token: 'different-key' }, { readonly: true }, { tier: 'different' }, { token_env: 'ANOTHER_KEY' }])('preserves partial installations with incompatible server settings %j', override => {
  const server = { url, scope: personalScope, token, scopes: [personalScope], enterprise: {}, tier: 'team', ...override }
  const entries = [legacy, server], before = JSON.stringify(entries)
  expect(() => registerServerEntry(entries, reg)).toThrow(/ambiguous/)
  expect(JSON.stringify(entries)).toBe(before)
})

it('requires a backup callback and preserves exact bytes when backup verification refuses', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-backup-')), path = join(dir, 'config.yaml')
  const bytes = yaml.dump({ stores: [legacy] }); writeFileSync(path, bytes)
  const p = new Plur({ path: dir, autoDiscover: false })
  try {
    await expect(p.registerEnterpriseServer(url, reg)).rejects.toThrow(/backup/)
    expect(readFileSync(path, 'utf8')).toBe(bytes)
    await expect(p.registerEnterpriseServer(url, { ...reg, beforeLegacyMigration: config => {
      expect(config).toBe(path); expect(readFileSync(config, 'utf8')).toBe(bytes)
      throw new Error('backup snapshot mismatch')
    } })).rejects.toThrow(/backup snapshot mismatch/)
    expect(readFileSync(path, 'utf8')).toBe(bytes)
    let guarded = false
    await p.registerEnterpriseServer(url, { ...reg, beforeLegacyMigration: () => { guarded = true }, onConfigWrite: before => {
      expect(guarded).toBe(true); expect(before).toBe(bytes)
    } })
    expect(readFileSync(path, 'utf8')).not.toContain(jwt)
  } finally { p.close(); rmSync(dir, { recursive: true, force: true }) }
})
