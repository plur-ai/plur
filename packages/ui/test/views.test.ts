import { describe, expect, it } from 'vitest'
import { renderBrowse, renderPage, htmlEscape } from '../src/views.js'
import type { EngramRow } from '../src/query.js'

const row = (over: Partial<EngramRow> = {}): EngramRow => ({
  id: 'ENG-2026-0814-017',
  statement: 'Pin dsh deps to one release line.',
  scope: 'project:acme',
  status: 'active',
  injection_count: 3,
  temporal: { learned_at: '2026-08-14' },
  ...over,
})

const browse = (rows: EngramRow[], q = {}) =>
  renderBrowse({ rows, query: q, now: new Date('2026-08-14T12:00:00Z') })

describe('htmlEscape', () => {
  it('escapes the characters that break out of markup', () => {
    expect(htmlEscape(`<script>"x"&'y'`)).toBe('&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;')
  })

  it('handles non-strings without throwing', () => {
    expect(htmlEscape(undefined as unknown as string)).toBe('')
  })
})

describe('renderBrowse', () => {
  it('renders a row with its statement, scope and recall count', () => {
    const html = browse([row()])
    expect(html).toContain('Pin dsh deps to one release line.')
    expect(html).toContain('project:acme')
    expect(html).toContain('ENG-2026-0814-017')
  })

  it('NEVER emits unescaped engram content — engrams are user data', () => {
    const html = browse([row({ statement: '<img src=x onerror=alert(1)>' })])
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x')
  })

  it('escapes a hostile id and scope too', () => {
    const html = browse([row({ id: '"><script>bad()</script>', scope: '<b>x</b>' })])
    expect(html).not.toContain('<script>bad()')
    expect(html).not.toContain('<b>x</b>')
  })

  it('escapes the search term echoed back into the input', () => {
    const html = browse([row()], { q: '"><script>x</script>' })
    expect(html).not.toContain('<script>x</script>')
  })

  it('shows the never-recalled count as the headline signal', () => {
    const html = browse([row({ injection_count: 0 }), row({ id: 'B', injection_count: 4 })])
    expect(html).toContain('Never recalled')
  })

  it('mutes a zero recall count and accents a non-zero one', () => {
    const zero = browse([row({ injection_count: 0 })])
    expect(zero).toContain('title="Never recalled"')
    const some = browse([row({ injection_count: 7 })])
    expect(some).toContain('>7<')
  })

  it('marks a pinned engram', () => {
    expect(browse([row({ pinned: true })])).toContain('PINNED')
  })

  it('renders an empty state rather than a bare table', () => {
    const html = browse([])
    expect(html).toContain('No engrams')
    expect(html).not.toContain('<tbody>\n</tbody>')
  })

  it('renders the written-per-day chart with one bar per day', () => {
    const html = browse([row()])
    expect((html.match(/class="bar[ "]/g) ?? []).length).toBeGreaterThanOrEqual(14)
  })

  it('renders a top-recalled list when anything has been recalled', () => {
    const html = browse([row({ injection_count: 9 })])
    expect(html).toContain('Most recalled')
  })

  it('says so plainly when nothing has ever been recalled', () => {
    const html = browse([row({ injection_count: 0 })])
    expect(html).toMatch(/nothing has been recalled|no engrams have been recalled/i)
  })

  it('paginates and reports the offset', () => {
    const rows = Array.from({ length: 120 }, (_, i) => row({ id: `E${i}` }))
    const html = renderBrowse({ rows, query: { limit: 50, offset: 50 }, now: new Date('2026-08-14T12:00:00Z') })
    expect(html).toContain('offset=100')
    expect(html).toContain('offset=0')
  })
})

describe('renderPage', () => {
  it('produces a complete, self-contained document', () => {
    const html = renderPage({ title: 'PLUR Memory', body: '<p>hi</p>' })
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<style>')
    expect(html).toContain('<p>hi</p>')
    expect(html).toContain('</html>')
  })

  it('references no external resource — it must work offline', () => {
    const html = renderPage({ title: 'x', body: '' })
    expect(html).not.toMatch(/src="https?:/)
    expect(html).not.toMatch(/href="https?:\/\/[^"]*\.css/)
  })

  it('escapes the title', () => {
    expect(renderPage({ title: '<script>x</script>', body: '' })).not.toContain('<script>x</script>')
  })
})
