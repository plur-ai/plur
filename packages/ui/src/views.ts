/**
 * The memory viewer, rendered as self-contained HTML.
 *
 * Pure functions returning strings — the same idiom as the PLUR Enterprise
 * admin, and for the same reason: no framework, no bundler, and no browser
 * needed to test it. Assert on the markup.
 *
 * Deliberately script-free. Expanding a record uses native `<details>`, so the
 * page works identically served from a bare HTTP server and embedded in a
 * host's web shell, with keyboard operation for free and no CSP exemption.
 *
 * Every value that reaches the page is escaped. Engram statements are user
 * data, and people store code in their memory.
 *
 * @module
 */
import {
  createdOn,
  filterEngrams,
  memoryStats,
  recallCount,
  storeSpan,
  topByRecall,
  writtenPerDay,
  type BrowseQuery,
  type EngramRow,
} from './query.js'
import { fill, formatDate, resolveLang, strings, type Lang } from './i18n.js'
import { CSS } from './theme.js'

/** Escape a value for interpolation into HTML text or an attribute. */
export function htmlEscape(value: string): string {
  if (typeof value !== 'string') return ''
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Wrap a body in a complete, offline-capable document. */
export function renderPage(opts: { title: string; body: string; lang?: Lang }): string {
  return `<!doctype html>
<html lang="${opts.lang === 'zh' ? 'zh-Hans' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEscape(opts.title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
${opts.body}
</div>
</body>
</html>`
}

/** Rows per page, matching `filterEngrams`'s own default. */
const DEFAULT_PAGE = 25

/** Which slice of the store the record list is showing. */
export type BrowseMode = 'top' | 'all'

/** Status pill, matching the enterprise admin's colour vocabulary. */
function statusPill(status: string | undefined, commitment: string | undefined): string {
  const colours: Record<string, string> = {
    active: '110, 231, 183',
    retired: '138, 143, 163',
    candidate: '251, 191, 36',
  }
  const NEUTRAL = '138, 143, 163'
  // A draft awaiting review is not live knowledge whatever its lifecycle status
  // says; rendering it green would tell the reader it is recallable.
  const rgb = commitment === 'draft' ? NEUTRAL : (colours[status ?? ''] ?? NEUTRAL)
  const label = commitment === 'draft' ? 'draft' : (status ?? 'unknown')
  return `<span class="pill" style="background:rgba(${rgb},0.12);color:rgb(${rgb});border:1px solid rgba(${rgb},0.28);">${htmlEscape(label)}</span>`
}

/**
 * Recall weight as a proportion of the busiest engram, log-scaled.
 *
 * Linear scaling is useless here: against a maximum of 594, an engram recalled
 * four times renders as an invisible 0.7% sliver, so the entire middle of the
 * distribution reads as empty. Log makes the working range visible while the
 * outlier still tops out.
 */
function weightPct(count: number, peak: number): number {
  if (count <= 0 || peak <= 0) return 0
  return Math.max(6, Math.round((Math.log1p(count) / Math.log1p(peak)) * 100))
}

/** The recall-weight cell: the page's one piece of visual editorialising. */
function weightCell(count: number, peak: number, hot: boolean, t: ReturnType<typeof strings>): string {
  if (count === 0) {
    return `<span class="weight"><span class="weight-bar"></span><span class="weight-n zero" title="Never recalled">0</span></span>`
  }
  // `hot` is set for the single busiest engram on the page and nowhere else.
  const cls = hot ? 'weight-fill hot' : 'weight-fill'
  return `<span class="weight" title="${htmlEscape(count === 0 ? t.neverRecalled : fill(t.recalledTimes, { n: count }))}"><span class="weight-bar"><i class="${cls}" style="width:${weightPct(count, peak)}%"></i></span><span class="weight-n">${count}</span></span>`
}

/** Engrams written per day, over the trailing month. */
function writtenChart(rows: readonly EngramRow[], now: Date, t: ReturnType<typeof strings>): string {
  const days = writtenPerDay(rows, 30, now)
  const peak = Math.max(1, ...days.map(d => d.count))
  const total = days.reduce((sum, d) => sum + d.count, 0)
  const bars = days.map(d => {
    const height = d.count === 0 ? 2 : Math.max(5, Math.round((d.count / peak) * 100))
    // `bar-zero`, NOT `bar empty`: `.empty` belongs to the record list's
    // "no results" message and carries 32px of padding. A zero-count day that
    // borrowed it rendered as a grey slab six times the width of a real bar.
    return `<div class="${d.count === 0 ? 'bar bar-zero' : 'bar'}" style="height:${height}%" title="${htmlEscape(d.date)} · ${d.count}"></div>`
  }).join('')
  return `<div class="card">
  <p class="card-title">${htmlEscape(t.written)}</p>
  <span class="card-sub">${htmlEscape(fill(t.writtenSub, { n: total, peak }))}</span>
  <div class="bars">${bars}</div>
  <div class="bar-axis"><span>${htmlEscape(days[0]?.date ?? '')}</span><span>${htmlEscape(days.at(-1)?.date ?? '')}</span></div>
</div>`
}

/** The most-recalled list — one line per item, by design. */
function topRecalledCard(rows: readonly EngramRow[], t: ReturnType<typeof strings>): string {
  const top = topByRecall(rows, 8)
  const peak = recallCount(top[0])
  const body = top.length === 0
    ? `<div class="empty" style="padding:var(--sp-6) 0;">${htmlEscape(t.nothingRecalled)}</div>`
    : top.map(r => `  <div class="top-row">
    <span class="top-stmt" title="${htmlEscape(r.statement ?? '')}">${htmlEscape(r.statement ?? '')}</span>
    <span class="top-n">${recallCount(r)}</span>
  </div>`).join('\n')
  return `<div class="card">
  <p class="card-title">${htmlEscape(t.mostRecalled)}</p>
  <span class="card-sub">${htmlEscape(t.mostRecalledSub)}${peak > 0 ? ` · ${peak}` : ''}</span>
${body}
</div>`
}

/** The headline stat strip. */
function statStrip(rows: readonly EngramRow[], t: ReturnType<typeof strings>): string {
  const s = memoryStats(rows)
  const n = (v: number) => v.toLocaleString('en-US')
  // Deliberately does NOT repeat the engram and recall totals: the headline
  // above already states both, and a strip that echoes them reads as filler.
  // This describes the store's composition instead.
  return `<div class="stats">
  <div class="stat accent"><div class="stat-value">${n(s.recalled)}</div><div class="stat-label">${htmlEscape(t.statRecalled)}</div></div>
  <div class="stat${s.neverRecalledPct >= 50 ? ' warn' : ''}"><div class="stat-value">${n(s.neverRecalled)}</div><div class="stat-label">${htmlEscape(t.statNever)}${s.total > 0 ? ` · ${s.neverRecalledPct}%` : ''}</div></div>
  <div class="stat"><div class="stat-value">${n(s.scopes)}</div><div class="stat-label">${htmlEscape(t.statScopes)}</div></div>
  <div class="stat"><div class="stat-value">${n(s.domains)}</div><div class="stat-label">${htmlEscape(t.statDomains)}</div></div>
</div>`
}

/** One expandable record. */
function record(r: EngramRow, peak: number, hot: boolean, t: ReturnType<typeof strings>): string {
  const stmt = r.statement ?? ''
  const n = recallCount(r)
  const created = createdOn(r) ?? '—'
  const pinned = r.pinned === true ? ` <span class="chip violet">${htmlEscape(t.pinned)}</span>` : ''
  const meta: Array<[string, string]> = [
    [t.metaId, r.id ?? '—'],
    [t.metaScope, r.scope ?? '—'],
    [t.metaCreated, created],
  ]
  if (r.domain) meta.push([t.metaDomain, r.domain])
  if (r.commitment) meta.push([t.metaCommitment, r.commitment])
  if (r.activation?.last_accessed) meta.push([t.metaLastActive, r.activation.last_accessed.slice(0, 10)])
  meta.push([t.metaRecalls, String(n)])

  return `<details class="rec">
  <summary>
    <div class="rec-line">
      <span class="rec-id" title="${htmlEscape(r.id ?? '')}">${htmlEscape((r.id ?? '').slice(0, 20))}</span>
      <span class="rec-stmt">${htmlEscape(stmt)}</span>
      <span class="rec-scope col-scope" title="${htmlEscape(r.scope ?? '')}">${htmlEscape(r.scope ?? '—')}</span>
      ${weightCell(n, peak, hot, t)}
      <span class="rec-date col-date">${htmlEscape(created)}</span>
    </div>
  </summary>
  <div class="rec-body">
    <p class="rec-statement-full">${htmlEscape(stmt)}</p>
    <div style="margin-bottom:var(--sp-3);">${statusPill(r.status, r.commitment)}${pinned}</div>
    <dl class="rec-meta">
${meta.map(([k, v]) => `      <div><dt>${htmlEscape(k)}</dt><dd>${htmlEscape(v)}</dd></div>`).join('\n')}
    </dl>
  </div>
</details>`
}

/** Links shown in the header. Omitted links are simply not rendered. */
export interface BrowseLinks {
  /** Where to file a feature request. */
  requestFeature?: string
  /** Where to contribute. */
  contribute?: string
  /** The source repository. */
  github?: string
  /** The product site. */
  website?: string
  /**
   * Endpoint that opens the store folder in the OS file manager.
   *
   * Rendered as a POST form rather than a link: a `file://` href is blocked
   * from an `http://` page by every Chromium browser, and a side-effecting GET
   * could be fired by any page on the machine with an `img` tag.
   */
  openFolder?: string
}

/** Options for {@link renderBrowse}. */
export interface BrowseOptions {
  rows: readonly EngramRow[]
  query: BrowseQuery
  /** Which slice to list. Defaults to `top` — the useful default on a big store. */
  mode?: BrowseMode
  /** Injectable clock, for tests. */
  now?: Date
  /** Path the search form and links target. */
  action?: string
  /** Shown beside the title, e.g. the store path. */
  where?: string
  /** Header links. */
  links?: BrowseLinks
  /** Display language. Defaults to English. */
  lang?: Lang
}

/**
 * The footer.
 *
 * PLUR is an acronym before it is a product name, so spelling it out once tells
 * a first-time reader something true rather than decorating the page. It
 * appears here and nowhere else.
 */
function footer(links: BrowseLinks, t: ReturnType<typeof strings>): string {
  const link = (href: string | undefined, label: string): string =>
    href ? `<a href="${htmlEscape(href)}" target="_blank" rel="noreferrer noopener">${htmlEscape(label)}</a>` : ''
  const items = [
    link(links.requestFeature, t.requestFeature),
    link(links.contribute, t.contribute),
    link(links.github, t.github),
    link(links.website, t.website),
  ].filter(Boolean).join('<span class="sep">·</span>')
  return `<footer>
  <span class="plur"><span>☮️ ${htmlEscape(t.peace)}</span><span>💜 ${htmlEscape(t.love)}</span><span>🤝 ${htmlEscape(t.unity)}</span><span>✊ ${htmlEscape(t.respect)}</span></span>
  ${items ? `<span class="foot-links">${items}</span>` : ''}
</footer>`
}

/**
 * Render the browse view: stats, two widgets, controls, and the record list.
 *
 * @param opts - rows, filters, and presentation options.
 * @returns the page body (not a full document — see {@link renderPage}).
 */
/**
 * The PLUR mark: four nodes wired P→L→U→R across a 3×3 grid.
 *
 * The "home" frame of the animated mark on plur.ai, at the same geometry
 * (200 viewBox, grid at 40/100/160, nodes r=21 at indices 0/4/5/8, dim dots
 * r=7 at the rest, bars stroke 11 round-capped at 0.72). Rendered without the
 * P/L/U/R letters: at header size each node is about six pixels across and the
 * letters would be mud. The wordmark beside it carries the name.
 *
 * Transparent — no tile. The four node colours are the brand's own and carry
 * the mark on either ground; the five dim grid dots use `currentColor` so they
 * follow the page instead of assuming one.
 *
 * Inline rather than an asset, because the viewer ships as one self-contained
 * string with no files to serve and no external request to make.
 */
const MARK = `<svg class="mark" viewBox="0 0 200 200" width="32" height="32" aria-hidden="true" focusable="false">
  <g stroke-width="11" stroke-linecap="round" opacity="0.72" fill="none">
    <line x1="40" y1="40" x2="100" y2="100" stroke="var(--cyan)"/>
    <line x1="100" y1="100" x2="160" y2="100" stroke="var(--amber)"/>
    <line x1="160" y1="100" x2="160" y2="160" stroke="var(--violet)"/>
  </g>
  <g fill="currentColor" opacity="0.20">
    <circle cx="100" cy="40" r="7"/><circle cx="160" cy="40" r="7"/>
    <circle cx="40" cy="100" r="7"/><circle cx="40" cy="160" r="7"/>
    <circle cx="100" cy="160" r="7"/>
  </g>
  <circle cx="40" cy="40" r="21" fill="var(--cyan)"/>
  <circle cx="100" cy="100" r="21" fill="var(--amber)"/>
  <circle cx="160" cy="100" r="21" fill="var(--violet)"/>
  <circle cx="160" cy="160" r="21" fill="var(--emerald)"/>
</svg>`

export function renderBrowse(opts: BrowseOptions): string {
  const now = opts.now ?? new Date()
  const action = opts.action ?? '/'
  const mode: BrowseMode = opts.mode === 'all' ? 'all' : 'top'
  const q = opts.query.q ?? ''
  const lang = resolveLang(opts.lang)
  const t = strings(lang)

  const href = (params: Record<string, string>): string => {
    const p = new URLSearchParams()
    if (q) p.set('q', q)
    if (opts.query.scope) p.set('scope', opts.query.scope)
    // Carried on every link, so switching language does not reset the page.
    if (lang !== 'en') p.set('lang', lang)
    for (const [k, v] of Object.entries(params)) { if (v) p.set(k, v); else p.delete(k) }
    const qs = p.toString()
    return htmlEscape(qs ? `${action}?${qs}` : action)
  }

  // Order BEFORE paginating. Sorting a page that was already sliced by date
  // silently turns "most recalled" into "the newest ones that happen to have
  // been recalled" — which hid the single most-recalled engram in the store
  // behind 50 newer rows.
  const matching = filterEngrams(opts.rows, { ...opts.query, limit: Number.MAX_SAFE_INTEGER, offset: 0 }).rows
  const ranked = mode === 'top'
    ? matching.filter(r => recallCount(r) > 0).sort((a, b) => recallCount(b) - recallCount(a))
    : matching
  const limit = Math.max(1, opts.query.limit ?? DEFAULT_PAGE)
  const offset = Math.max(0, opts.query.offset ?? 0)
  const ordered = ranked.slice(offset, offset + limit)
  const page = { total: ranked.length, limit, offset }
  const peak = Math.max(1, ...opts.rows.map(r => recallCount(r)))

  const list = ordered.length === 0
    ? `<div class="empty">${htmlEscape(mode === 'top' && !q ? t.emptyNoRecalls : t.emptyNoMatch)}</div>`
    : `<div class="rec-head">
    <span>${htmlEscape(t.colId)}</span><span>${htmlEscape(t.colStatement)}</span><span class="col-scope">${htmlEscape(t.colScope)}</span><span>${htmlEscape(t.colRecalls)}</span><span class="col-date">${htmlEscape(t.colCreated)}</span>
  </div>
${ordered.map(r => record(r, peak, recallCount(r) === peak && peak > 0, t)).join('\n')}`

  const hasPrev = page.offset > 0
  const hasNext = page.offset + page.limit < page.total
  const pager = page.total > page.limit
    ? `<div class="pager">
  ${hasPrev ? `<a href="${href({ mode, offset: String(Math.max(0, page.offset - page.limit)) })}">&larr; ${htmlEscape(t.prev)}</a>` : `<span class="off">&larr; ${htmlEscape(t.prev)}</span>`}
  <span class="off">${htmlEscape(fill(t.pagerCount, { total: page.total.toLocaleString('en-US'), shown: ordered.length, offset: page.offset }))}</span>
  ${hasNext ? `<a href="${href({ mode, offset: String(page.offset + page.limit) })}">${htmlEscape(t.next)} &rarr;</a>` : `<span class="off">${htmlEscape(t.next)} &rarr;</span>`}
</div>`
    : ''

  const links = opts.links ?? {}
  const openFolder = links.openFolder
    ? `<form class="open-folder" method="POST" action="${htmlEscape(lang === 'zh' ? `${links.openFolder}?lang=zh` : links.openFolder)}"><button type="submit" title="${htmlEscape(t.openFolderHint)}">${htmlEscape(t.openFolder)}</button></form>`
    : ''

  // The store's own scale is the headline. A viewer that opens on the word
  // "Memory" says nothing; one that opens on 27,987 recalls says what the
  // thing is for.
  const span = storeSpan(opts.rows)
  const n = (v: number) => v.toLocaleString('en-US')
  const headline = opts.rows.length === 0
    ? htmlEscape(t.heroEmpty)
    : fill(htmlEscape(t.heroTitle), {
        n: `<em>${n(opts.rows.length)}</em>`,
        r: `<em>${n(span.totalRecalls)}</em>`,
      })
  const standfirst = opts.rows.length === 0
    ? htmlEscape(t.heroSubEmpty)
    : fill(htmlEscape(t.heroSub), { since: formatDate(span.earliest, lang) })

  const langSwitch = `<nav class="lang" aria-label="${htmlEscape(t.langSwitch)}">
    <a href="${href({ lang: '' })}" aria-current="${lang === 'en'}" lang="en">EN</a>
    <a href="${href({ lang: 'zh' })}" aria-current="${lang === 'zh'}" lang="zh-Hans">中文</a>
  </nav>`

  return `<header class="hero">
  <div class="hero-top">
    <span class="lockup">${MARK}<span class="wordmark">PLUR</span><span class="lockup-rule"></span><span class="lockup-product">${htmlEscape(t.brand)}</span></span>
    ${langSwitch}
  </div>
  <h1 class="hero-title">${headline}</h1>
  <p class="hero-sub">${standfirst}</p>
  <div class="hero-meta">
    ${opts.where ? `<span class="page-where">${htmlEscape(opts.where)}</span>` : ''}
    ${openFolder}
  </div>
</header>

${statStrip(opts.rows, t)}

<div class="widgets">
${writtenChart(opts.rows, now, t)}
${topRecalledCard(opts.rows, t)}
</div>

<div class="controls">
  <nav class="seg" aria-label="${htmlEscape(t.modeTop)} / ${htmlEscape(t.modeAll)}">
    <a href="${href({ mode: '', offset: '' })}" aria-current="${mode === 'top'}">${htmlEscape(t.modeTop)}</a>
    <a href="${href({ mode: 'all', offset: '' })}" aria-current="${mode === 'all'}">${htmlEscape(t.modeAll)}</a>
  </nav>
  <form method="GET" action="${htmlEscape(action)}">
    ${mode === 'all' ? '<input type="hidden" name="mode" value="all">' : ''}
    ${lang !== 'en' ? `<input type="hidden" name="lang" value="${lang}">` : ''}
    <input name="q" value="${htmlEscape(q)}" placeholder="${htmlEscape(t.searchPlaceholder)}" autocomplete="off" aria-label="${htmlEscape(t.searchPlaceholder)}">
    <button type="submit">${htmlEscape(t.search)}</button>
  </form>
</div>

<div class="records">${list}</div>
${pager}
${footer(links, t)}`
}
