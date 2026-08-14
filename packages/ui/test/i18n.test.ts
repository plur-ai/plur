import { describe, expect, it } from 'vitest'
import { fill, formatDate, resolveLang, strings } from '../src/i18n.js'
import { renderBrowse, renderPage } from '../src/views.js'
import type { EngramRow } from '../src/query.js'

const ROWS: EngramRow[] = [
  { id: 'ENG-2026-0814-001', statement: 'Pin dsh to the next tag.', scope: 'project:acme', status: 'active', activation: { frequency: 12 } },
  { id: 'ENG-2026-0102-002', statement: 'Deploy with pnpm, never npm.', scope: 'project:acme', status: 'active', activation: { frequency: 3 } },
]

describe('resolveLang', () => {
  it('accepts every shape a browser or query param might send for Chinese', () => {
    for (const tag of ['zh', 'zh-CN', 'zh-Hans', 'ZH-hant', 'zh-TW,zh;q=0.9']) {
      expect(resolveLang(tag)).toBe('zh')
    }
  })

  it('falls back to English for anything else, including junk', () => {
    for (const tag of ['en', 'en-GB', 'fr', '', null, undefined, '../../etc', '<script>']) {
      expect(resolveLang(tag)).toBe('en')
    }
  })
})

describe('strings', () => {
  it('translates every key — a half-translated page is worse than an English one', () => {
    const en = strings('en')
    const zh = strings('zh')
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    // Proper nouns, and the loanwords Chinese technical UIs keep in Latin
    // script: "ID" and "Scope" are not translated by anyone shipping a
    // developer tool, and inventing a rendering would read as machine output.
    const sameOnPurpose = new Set(['github', 'website', 'colId', 'metaId', 'colScope', 'metaScope', 'statScopes'])
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      if (sameOnPurpose.has(key)) continue
      expect(zh[key], `"${key}" was never translated`).not.toBe(en[key])
    }
  })

  it('keeps the placeholders intact in translation', () => {
    // A dropped {n} silently renders a sentence with no number in it.
    const en = strings('en')
    const zh = strings('zh')
    for (const key of ['heroTitle', 'heroSub', 'writtenSub', 'pagerCount', 'recalledTimes'] as const) {
      expect(zh[key].match(/\{\w+\}/g)?.sort()).toEqual(en[key].match(/\{\w+\}/g)?.sort())
    }
  })
})

describe('fill', () => {
  it('substitutes named placeholders', () => {
    expect(fill('{a} and {b}', { a: 1, b: 'two' })).toBe('1 and two')
  })

  it('leaves an unknown placeholder alone rather than printing "undefined"', () => {
    expect(fill('{a} and {b}', { a: 1 })).toBe('1 and {b}')
  })
})

describe('formatDate', () => {
  it('formats for each language', () => {
    expect(formatDate('2026-01-01', 'en')).toBe('1 January 2026')
    expect(formatDate('2026-01-01', 'zh')).toBe('2026年1月1日')
    expect(formatDate('2026-12-25', 'en')).toBe('25 December 2026')
  })

  it('returns nothing for a missing or malformed date', () => {
    expect(formatDate(undefined, 'en')).toBe('')
    expect(formatDate('not-a-date', 'en')).toBe('')
    expect(formatDate('2026-01', 'zh')).toBe('')
  })
})

describe('the bilingual page', () => {
  it('renders Chinese chrome when asked', () => {
    const html = renderBrowse({ rows: ROWS, query: {}, where: '~/.plur', lang: 'zh' })
    expect(html).toContain('本地记忆')
    expect(html).toContain('你的 agent 记住了')
    expect(html).not.toContain('Your agents remember')
  })

  it('punctuates the headline in the language it is written in', () => {
    // An ideographic sentence closed with a Latin full stop reads as machine
    // output. Each language owns its own separator and terminator.
    const zh = renderBrowse({ rows: ROWS, query: {}, where: '', lang: 'zh' })
    const zhTitle = /<h1 class="hero-title">(.*?)<\/h1>/.exec(zh)?.[1] ?? ''
    expect(zhTitle).toContain('，')
    expect(zhTitle.endsWith('。')).toBe(true)
    const en = renderBrowse({ rows: ROWS, query: {}, where: '' })
    const enTitle = /<h1 class="hero-title">(.*?)<\/h1>/.exec(en)?.[1] ?? ''
    expect(enTitle.endsWith('.')).toBe(true)
    expect(enTitle).not.toContain('。')
  })

  it('leaves engram content untranslated — it is the user\'s data, not chrome', () => {
    const html = renderBrowse({ rows: ROWS, query: {}, where: '~/.plur', lang: 'zh', mode: 'all' })
    expect(html).toContain('Pin dsh to the next tag.')
  })

  it('carries the language through every internal link, so switching does not reset the view', () => {
    const html = renderBrowse({ rows: ROWS, query: {}, where: '~/.plur', lang: 'zh', mode: 'all' })
    // The mode switch and the search form both have to keep lang=zh.
    expect(html).toContain('lang=zh')
    expect(html).toContain('<input type="hidden" name="lang" value="zh">')
  })

  it('sets the document language so screen readers and fonts do the right thing', () => {
    expect(renderPage({ title: 'x', body: '', lang: 'zh' })).toContain('<html lang="zh-Hans">')
    expect(renderPage({ title: 'x', body: '' })).toContain('<html lang="en">')
  })

  it('offers both languages with the current one marked', () => {
    const zh = renderBrowse({ rows: ROWS, query: {}, where: '', lang: 'zh' })
    expect(zh).toMatch(/lang="zh-Hans">中文/)
    expect(zh).toMatch(/aria-current="true"[^>]*lang="zh-Hans"/)
    const en = renderBrowse({ rows: ROWS, query: {}, where: '' })
    expect(en).toMatch(/aria-current="true"[^>]*lang="en"/)
  })
})

describe('the hero', () => {
  it('leads with the store\'s real scale rather than the word "Memory"', () => {
    const html = renderBrowse({ rows: ROWS, query: {}, where: '~/.plur' })
    // 2 engrams, 15 recalls between them.
    expect(html).toContain('<em>2</em>')
    expect(html).toContain('<em>15</em>')
    expect(html).toContain('2 January 2026')  // the older of the two IDs
  })

  it('groups digits so a large store reads at a glance', () => {
    const many: EngramRow[] = Array.from({ length: 5429 }, (_, i) => ({
      id: `ENG-2026-0101-${i}`, statement: 's', status: 'active', activation: { frequency: 5 },
    }))
    const html = renderBrowse({ rows: many, query: {}, where: '' })
    expect(html).toContain('<em>5,429</em>')
    expect(html).toContain('<em>27,145</em>')
  })

  it('says something sensible when the store is empty instead of "remember 0 things"', () => {
    const html = renderBrowse({ rows: [], query: {}, where: '' })
    expect(html).toContain('Nothing learned yet')
    expect(html).not.toContain('<em>0</em>')
  })

  it('escapes the store path — a path is not trusted markup', () => {
    const html = renderBrowse({ rows: ROWS, query: {}, where: '<img src=x onerror=alert(1)>' })
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x')
  })
})

describe('header and footer links', () => {
  it('renders GitHub and the website alongside the contribution links', () => {
    const html = renderBrowse({
      rows: ROWS, query: {}, where: '',
      links: {
        requestFeature: 'https://example.com/new',
        contribute: 'https://example.com/contributing',
        github: 'https://github.com/plur-ai/plur',
        website: 'https://plur.ai',
      },
    })
    expect(html).toContain('href="https://github.com/plur-ai/plur"')
    expect(html).toContain('href="https://plur.ai"')
    expect(html).toContain('>GitHub<')
    expect(html).toContain('>plur.ai<')
  })

  it('opens external links safely', () => {
    const html = renderBrowse({ rows: ROWS, query: {}, where: '', links: { github: 'https://github.com/plur-ai/plur' } })
    expect(html).toContain('rel="noreferrer noopener"')
  })

  it('omits links the host did not supply rather than rendering dead anchors', () => {
    const html = renderBrowse({ rows: ROWS, query: {}, where: '', links: {} })
    const foot = html.slice(html.indexOf('<footer'))
    expect(foot).not.toContain('<a ')
  })
})
