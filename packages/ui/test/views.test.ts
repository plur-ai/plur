import { describe, expect, it } from 'vitest'
import { renderBrowse, renderPage, htmlEscape } from '../src/views.js'
import type { EngramRow } from '../src/query.js'

const row = (over: Partial<EngramRow> = {}): EngramRow => ({
  id: 'ENG-2026-0814-017',
  statement: 'Pin dsh deps to one release line.',
  scope: 'project:acme',
  status: 'active',
  activation: { frequency: 3 },
  temporal: { learned_at: '2026-08-14' },
  ...over,
})

const browse = (rows: EngramRow[], q = {}, mode: 'top' | 'all' = 'all') =>
  renderBrowse({ rows, query: q, mode, now: new Date('2026-08-14T12:00:00Z') })

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
    const html = browse([row({ activation: { frequency: 0 } }), row({ id: 'B', activation: { frequency: 4 } })])
    expect(html).toContain('Never recalled')
  })

  it('mutes a zero recall count and accents a non-zero one', () => {
    const zero = browse([row({ activation: { frequency: 0 } })])
    expect(zero).toContain('title="Never recalled"')
    const some = browse([row({ activation: { frequency: 7 } })])
    expect(some).toContain('>7<')
  })

  it('marks a pinned engram', () => {
    // Uppercasing is CSS (.chip text-transform); the markup carries the word.
    expect(browse([row({ pinned: true })])).toContain('class="chip violet">pinned<')
  })

  it('renders an empty state rather than a bare table', () => {
    const html = browse([])
    expect(html).toContain('No engrams')
    expect(html).not.toContain('<tbody>\n</tbody>')
  })

  it('renders the written-per-day chart with one bar per day', () => {
    expect((browse([row()]).match(/class="bar[ "]/g) ?? []).length).toBe(30)
  })

  it('renders a top-recalled list when anything has been recalled', () => {
    const html = browse([row({ activation: { frequency: 9 } })])
    expect(html).toContain('Most recalled')
  })

  it('says so plainly when nothing has ever been recalled', () => {
    expect(browse([row({ activation: { frequency: 0 } })])).toMatch(/nothing recalled yet/i)
  })

  it('paginates and reports the offset', () => {
    const rows = Array.from({ length: 120 }, (_, i) => row({ id: `ENG-2026-0101-${i}` }))
    const html = renderBrowse({ rows, query: { limit: 50, offset: 50 }, mode: 'all', now: new Date('2026-08-14T12:00:00Z') })
    expect(html).toContain('offset=100')
    expect(html).toContain('offset=0')
  })

  it('defaults to the most-recalled slice', () => {
    const html = renderBrowse({ rows: [row({ activation: { frequency: 5 } })], query: {}, now: new Date('2026-08-14T12:00:00Z') })
    expect(html).toContain('aria-current="true">Most recalled</a>')
  })

  it('the most-recalled slice hides never-recalled engrams', () => {
    const rows = [row({ id: 'ENG-2026-0101-001', statement: 'Never used.', activation: { frequency: 0 } }),
                  row({ id: 'ENG-2026-0101-002', statement: 'Used a lot.', activation: { frequency: 9 } })]
    const html = renderBrowse({ rows, query: {}, mode: 'top', now: new Date('2026-08-14T12:00:00Z') })
    expect(html).toContain('Used a lot.')
    expect(html.split('<details').length - 1).toBe(1)
  })

  it('the all slice shows everything', () => {
    const rows = [row({ id: 'ENG-2026-0101-001', activation: { frequency: 0 } }),
                  row({ id: 'ENG-2026-0101-002', activation: { frequency: 9 } })]
    const html = renderBrowse({ rows, query: {}, mode: 'all', now: new Date('2026-08-14T12:00:00Z') })
    expect(html.split('<details').length - 1).toBe(2)
  })

  it('renders each record as a native details element — expansion needs no JS', () => {
    const html = browse([row()])
    expect(html).toContain('<details class="rec">')
    expect(html).toContain('<summary>')
    expect(html).not.toContain('<script')
    expect(html).not.toMatch(/onclick=/i)
  })

  it('the expanded body carries the FULL statement, not the truncated one', () => {
    const long = 'A '.repeat(200) + 'END-MARKER'
    const html = browse([row({ statement: long })])
    expect(html).toContain('rec-statement-full')
    expect(html).toContain('END-MARKER')
  })

  it('the expanded body lists the metadata a reader needs', () => {
    const html = browse([row({ domain: 'plur.engineering', scope: 'project:acme' })])
    for (const label of ['ID', 'Scope', 'Created', 'Domain', 'Recalls']) {
      expect(html).toContain(`<dt>${label}</dt>`)
    }
  })

  it('ranks by recall BEFORE paginating, so the top engram is on page one', () => {
    // The bug this guards: paginating by date and re-sorting the page turned
    // "most recalled" into "the newest ones that were recalled", hiding the
    // single busiest engram in the store behind 50 newer rows.
    const rows = [
      ...Array.from({ length: 60 }, (_, i) => row({ id: `ENG-2026-0814-${i}`, activation: { frequency: 2 } })),
      row({ id: 'ENG-2026-0418-001', statement: 'THE BUSIEST ONE', activation: { frequency: 594 } }),
    ]
    const html = renderBrowse({ rows, query: { limit: 50 }, mode: 'top', now: new Date('2026-08-14T12:00:00Z') })
    expect(html).toContain('THE BUSIEST ONE')
  })

  it('scales the recall weight bar logarithmically, so mid-range stays visible', () => {
    // Against a peak of 594, a linear bar renders 4 recalls as a 0.7% sliver.
    const rows = [row({ id: 'ENG-2026-0101-001', activation: { frequency: 594 } }),
                  row({ id: 'ENG-2026-0101-002', activation: { frequency: 4 } })]
    const html = renderBrowse({ rows, query: {}, mode: 'top', now: new Date('2026-08-14T12:00:00Z') })
    const widths = [...html.matchAll(/weight-fill" style="width:(\d+)%/g)].map(m => Number(m[1]))
    expect(Math.min(...widths)).toBeGreaterThan(15)
    expect(Math.max(...widths)).toBe(100)
  })

  it('is read-only — no edit or delete controls', () => {
    const html = browse([row()])
    expect(html).not.toMatch(/method="POST"/i)
    expect(html.toLowerCase()).not.toContain('>delete<')
    expect(html.toLowerCase()).not.toContain('>edit<')
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
