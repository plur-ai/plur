/**
 * #833 / #832 — every script must produce tokens, not just ASCII and Han.
 *
 * #782 fixed Chinese by indexing Han runs as character bigrams. That was the
 * right first cut and it covered exactly one script: measured on the post-#782
 * tokenizer, Japanese kana, Korean, Arabic and Hindi all returned `[]`, Russian
 * and Thai returned only the embedded English word, and accented Latin was cut
 * at each accent — `déploiement` became `["ploiement","fran","ais"]`.
 *
 * The fix is three parts with a real ordering dependency between them, which is
 * why they are one change rather than three:
 *
 *   1. The character class needs `\p{M}`. `\p{L}\p{N}` alone is NOT enough —
 *      Devanagari vowel signs and Thai tone marks are nonspacing marks, so
 *      Hindi still returns [] and Thai shatters into fragments the length
 *      filter then eats.
 *   2. Space-less runs must be stripped from the WORD path before splitting.
 *      With (1) applied the Unicode class preserves a Han run as one "word", so
 *      without this the run is indexed AND all its bigrams are too.
 *   3. The length floor is Latin-centric. `length > 2` erases two-character
 *      words, which are ordinary in dense scripts — 도커 ("docker") vanished.
 */
import { describe, it, expect } from 'vitest'
import { ftsTokenize } from '../src/fts.js'

describe('ftsTokenize covers non-Latin scripts (#833)', () => {
  // Each of these returned [] or near-[] before the fix — the table in the
  // issue, kept in the same order.
  const cases: Array<[string, string]> = [
    ['Japanese kana', 'テストデプロイ'],
    ['Korean', '배포는 도커를 사용해야 한다'],
    ['Russian', 'развертывание должно использовать docker'],
    ['Arabic', 'يجب استخدام دوكر'],
    ['Hindi', 'तैनाती के लिए डॉकर'],
    ['Thai', 'การปรับใช้ควรใช้ docker'],
  ]
  for (const [label, text] of cases) {
    it(`${label} produces tokens`, () => {
      expect(ftsTokenize(text).length, `${label} tokenized to nothing`).toBeGreaterThan(0)
    })
  }

  it('Russian indexes its own words, not just the embedded English one', () => {
    const t = ftsTokenize('развертывание должно использовать docker')
    // Before: exactly ["docker"] — the Cyrillic was stripped entirely.
    expect(t).toContain('развертывание')
    expect(t).toContain('docker')
  })

  it('Hindi survives its vowel signs — this is the \\p{M} case', () => {
    // With \p{L}\p{N} but no \p{M} this is still [].
    expect(ftsTokenize('तैनाती के लिए डॉकर')).toContain('तैनाती')
  })
})

describe('accented Latin is no longer shredded (#833)', () => {
  it('keeps French words whole', () => {
    const t = ftsTokenize('déploiement français')
    expect(t).toEqual(expect.arrayContaining(['déploiement', 'français']))
    // The old output, kept explicit so a regression is unmistakable.
    expect(t).not.toContain('ploiement')
    expect(t).not.toContain('ais')
  })

  it('keeps Slovenian words whole', () => {
    expect(ftsTokenize('razmeščanje čez šifriran kanal'))
      .toEqual(expect.arrayContaining(['razmeščanje', 'šifriran', 'kanal']))
  })
})

describe('space-less scripts are bigram-indexed exactly once (#833)', () => {
  it('does not double-index a Han run', () => {
    // The ordering dependency. Part 1 without part 2 returns the whole run AND
    // all six bigrams, because the Unicode class now preserves the run as a
    // "word". Measured on the intermediate state before this was fixed.
    const t = ftsTokenize('测试部署应该用')
    expect(t).not.toContain('测试部署应该用')
    expect(t).toContain('测试')
    expect(t).toContain('该用')
  })

  it('bigram-indexes kana, which #782 did not cover', () => {
    const t = ftsTokenize('テストデプロイ')
    expect(t).toContain('テス')
    expect(t).not.toContain('テストデプロイ')
  })

  it('bigram-indexes Thai while keeping an embedded Latin word', () => {
    const t = ftsTokenize('การปรับใช้ควรใช้ docker')
    expect(t).toContain('docker')
    expect(t.some(x => x.length === 2 && /[฀-๿]/.test(x))).toBe(true)
  })
})

describe('the length floor is script-aware (#832)', () => {
  it('keeps a two-character Korean word', () => {
    // 도커 is "docker". It returned [] under every variant tried in the issue,
    // including the otherwise-complete fix.
    expect(ftsTokenize('도커')).toContain('도커')
  })

  it('does NOT emit a single-character token, even in a dense script', () => {
    // #833's table lists a lone 猫 as a failing case and it stays failing, on
    // purpose. MIN_TOKEN_LENGTH = 2 is load-bearing —
    // `PostgresAdapter.reversePrefixes` reads it, and fts.ts records that #782
    // already broke a restated copy of that invariant once, getting away with
    // it only because Han and ASCII alphabets are disjoint. A single character
    // also cannot be bigram-indexed, so it has no route into the index anyway.
    expect(ftsTokenize('猫')).toEqual([])
    // In running text the character is still reachable, via the bigrams of the
    // run it belongs to.
    expect(ftsTokenize('猫和狗')).toContain('猫和')
  })

  it('still drops short ASCII noise, so English behaviour is unchanged', () => {
    const t = ftsTokenize('a an of the quick brown fox')
    expect(t).not.toContain('a')
    expect(t).not.toContain('of')
    expect(t).toEqual(expect.arrayContaining(['quick', 'brown', 'fox']))
  })
})

describe('English tokenization is untouched (#833 regression guard)', () => {
  it('produces the same tokens as before for plain ASCII', () => {
    expect(ftsTokenize('The quick brown fox jumps over the lazy dog'))
      .toEqual(['quick', 'brown', 'fox', 'jumps', 'over', 'lazy', 'dog'])
  })

  it('still strips punctuation', () => {
    expect(ftsTokenize('rebase, then push -- always!')).not.toContain(',')
  })
})
