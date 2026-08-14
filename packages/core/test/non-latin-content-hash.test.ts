/**
 * #896 — non-Latin statements must not collapse into one engram.
 *
 * `normalizeStatement` stripped every character outside ASCII `\w`, so a
 * statement written in Japanese, Korean, Chinese, Russian, Greek, Hebrew,
 * Arabic, Hindi or Thai normalized to the EMPTY STRING and hashed to
 * `e3b0c442…`, the SHA-256 of `''`. Every one of them therefore carried the
 * same `content_hash`, `findActiveByContentHash` matched them to each other,
 * and the dedup fast path absorbed them into a single engram — four distinct
 * facts in, one row out, `write_count: 4`, four reported successes.
 *
 * For a product whose job is memory, silently discarding every memory not
 * written in a Latin script is the worst possible failure, so this file tests
 * the end-to-end behaviour (do four writes produce four engrams?) and not just
 * the string function.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur, normalizeStatement, computeContentHash, isHashable } from '../src/index.js'

/** SHA-256 of the empty string — what every non-Latin statement used to get. */
const EMPTY_HASH = computeContentHash('')

describe('non-Latin statements keep their identity (#896)', () => {
  let dir: string
  let plur: Plur
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-896-')); plur = new Plur({ path: dir }) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('four unrelated non-Latin facts stay four engrams', async () => {
    // The measured reproduction. Before the fix this stored ONE engram with
    // write_count 4; the other three statements were gone.
    const statements = [
      'データベースの設定を確認する',
      '도커를 사용해야 한다',
      'развертывание должно быть атомарным',
      '部署前必须运行测试',
    ]
    for (const s of statements) await plur.learn(s, { scope: 'global', type: 'behavioral' })

    const stored = await plur.list({ scope: 'global' })
    expect(stored.map(e => e.statement).sort(), 'each fact must survive as its own engram')
      .toEqual([...statements].sort())
    for (const e of stored) {
      expect((e as { content_hash?: string }).content_hash, `${e.id} got the empty-string hash`)
        .not.toBe(EMPTY_HASH)
    }
  })

  it('normalization keeps letters, digits, marks and _ in any script', () => {
    expect(normalizeStatement('データベースの設定')).toBe('データベースの設定')
    expect(normalizeStatement('Развёртывание — атомарно!')).toBe('развёртывание атомарно')
    expect(normalizeStatement('déploiement')).toBe('déploiement')
    // \p{M}: the vowel sign is part of the word, not punctuation to strip.
    expect(normalizeStatement('हिन्दी')).toBe('हिन्दी')
    // …while behaviour for the ASCII cases the old class handled is unchanged,
    // which is why the overwhelming majority of stored hashes do not move.
    expect(normalizeStatement('  Hello,  World!  ')).toBe('hello world')
    expect(normalizeStatement('Use SNAKE_CASE for APIs.')).toBe('use snake_case for apis')
  })

  it('distinct non-Latin statements hash distinctly', () => {
    const hashes = [
      'データベースの設定を確認する',
      '도커를 사용해야 한다',
      'развертывание должно быть атомарным',
      '部署前必须运行测试',
    ].map(computeContentHash)
    expect(new Set(hashes).size, 'all four collapsed to one hash').toBe(4)
  })

  it('a statement with no hashable content never dedups against another', async () => {
    // The residual case, and why `isHashable` exists as a separate guard: '!!!'
    // and '???' both still normalize to '' and so still share a hash. That is
    // honest — there is no content to key on — but it must not be read as
    // "these are the same fact".
    expect(isHashable('!!!')).toBe(false)
    expect(isHashable('データベース')).toBe(true)

    await plur.learn('!!!', { scope: 'global', type: 'behavioral' })
    await plur.learn('???', { scope: 'global', type: 'behavioral' })
    const stored = await plur.list({ scope: 'global' })
    expect(stored.map(e => e.statement).sort()).toEqual(['!!!', '???'])
  })
})
