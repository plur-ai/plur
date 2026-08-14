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
  topByRecall,
  writtenPerDay,
  type BrowseQuery,
  type EngramRow,
} from './query.js'
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
export function renderPage(opts: { title: string; body: string }): string {
  return `<!doctype html>
<html lang="en">
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
function weightCell(count: number, peak: number, hot = false): string {
  if (count === 0) {
    return `<span class="weight"><span class="weight-bar"></span><span class="weight-n zero" title="Never recalled">0</span></span>`
  }
  // `hot` is set for the single busiest engram on the page and nowhere else.
  const cls = hot ? 'weight-fill hot' : 'weight-fill'
  return `<span class="weight" title="Recalled ${count} time${count === 1 ? '' : 's'}"><span class="weight-bar"><i class="${cls}" style="width:${weightPct(count, peak)}%"></i></span><span class="weight-n">${count}</span></span>`
}

/** Engrams written per day, over the trailing month. */
function writtenChart(rows: readonly EngramRow[], now: Date): string {
  const days = writtenPerDay(rows, 30, now)
  const peak = Math.max(1, ...days.map(d => d.count))
  const total = days.reduce((sum, d) => sum + d.count, 0)
  const bars = days.map(d => {
    const height = d.count === 0 ? 2 : Math.max(5, Math.round((d.count / peak) * 100))
    return `<div class="${d.count === 0 ? 'bar empty' : 'bar'}" style="height:${height}%" title="${htmlEscape(d.date)} · ${d.count}"></div>`
  }).join('')
  return `<div class="card">
  <p class="card-title">Written</p>
  <span class="card-sub">${total} engram${total === 1 ? '' : 's'} learned in the last 30 days · peak ${peak}</span>
  <div class="bars">${bars}</div>
  <div class="bar-axis"><span>${htmlEscape(days[0]?.date ?? '')}</span><span>${htmlEscape(days.at(-1)?.date ?? '')}</span></div>
</div>`
}

/** The most-recalled list — one line per item, by design. */
function topRecalledCard(rows: readonly EngramRow[]): string {
  const top = topByRecall(rows, 8)
  const peak = recallCount(top[0])
  const body = top.length === 0
    ? `<div class="empty" style="padding:var(--sp-6) 0;">Nothing recalled yet.</div>`
    : top.map(r => `  <div class="top-row">
    <span class="top-stmt" title="${htmlEscape(r.statement ?? '')}">${htmlEscape(r.statement ?? '')}</span>
    <span class="top-n">${recallCount(r)}</span>
  </div>`).join('\n')
  return `<div class="card">
  <p class="card-title">Most recalled</p>
  <span class="card-sub">what the agent actually pulls into context${peak > 0 ? ` · top ${peak}` : ''}</span>
${body}
</div>`
}

/** The headline stat strip. */
function statStrip(rows: readonly EngramRow[]): string {
  const s = memoryStats(rows)
  return `<div class="stats">
  <div class="stat"><div class="stat-value">${s.total.toLocaleString('en-US')}</div><div class="stat-label">Engrams</div></div>
  <div class="stat"><div class="stat-value">${s.recalled.toLocaleString('en-US')}</div><div class="stat-label">Recalled</div></div>
  <div class="stat${s.neverRecalledPct >= 50 ? ' warn' : ''}"><div class="stat-value">${s.neverRecalled.toLocaleString('en-US')}</div><div class="stat-label">Never recalled${s.total > 0 ? ` · ${s.neverRecalledPct}%` : ''}</div></div>
  <div class="stat"><div class="stat-value">${s.scopes}</div><div class="stat-label">Scope${s.scopes === 1 ? '' : 's'}</div></div>
</div>`
}

/** One expandable record. */
function record(r: EngramRow, peak: number, hot = false): string {
  const stmt = r.statement ?? ''
  const n = recallCount(r)
  const created = createdOn(r) ?? '—'
  const pinned = r.pinned === true ? ` <span class="chip violet">pinned</span>` : ''
  const meta: Array<[string, string]> = [
    ['ID', r.id ?? '—'],
    ['Scope', r.scope ?? '—'],
    ['Created', created],
  ]
  if (r.domain) meta.push(['Domain', r.domain])
  if (r.commitment) meta.push(['Commitment', r.commitment])
  if (r.activation?.last_accessed) meta.push(['Last active', r.activation.last_accessed.slice(0, 10)])
  meta.push(['Recalls', String(n)])

  return `<details class="rec">
  <summary>
    <div class="rec-line">
      <span class="rec-id" title="${htmlEscape(r.id ?? '')}">${htmlEscape((r.id ?? '').slice(0, 20))}</span>
      <span class="rec-stmt">${htmlEscape(stmt)}</span>
      <span class="rec-scope col-scope" title="${htmlEscape(r.scope ?? '')}">${htmlEscape(r.scope ?? '—')}</span>
      ${weightCell(n, peak, hot)}
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
}

/**
 * The footer.
 *
 * PLUR is an acronym before it is a product name, so spelling it out once tells
 * a first-time reader something true rather than decorating the page. It
 * appears here and nowhere else.
 */
function footer(links: BrowseLinks): string {
  const items = [
    links.requestFeature ? `<a href="${htmlEscape(links.requestFeature)}" target="_blank" rel="noreferrer noopener">Request a feature</a>` : '',
    links.contribute ? `<a href="${htmlEscape(links.contribute)}" target="_blank" rel="noreferrer noopener">Contribute</a>` : '',
  ].filter(Boolean).join('<span class="sep">·</span>')
  return `<footer>
  <span class="plur"><span>☮️ Peace</span><span>💜 Love</span><span>🤝 Unity</span><span>✊ Respect</span></span>
  ${items ? `<span class="foot-links">${items}</span>` : ''}
</footer>`
}

/**
 * Render the browse view: stats, two widgets, controls, and the record list.
 *
 * @param opts - rows, filters, and presentation options.
 * @returns the page body (not a full document — see {@link renderPage}).
 */
export function renderBrowse(opts: BrowseOptions): string {
  const now = opts.now ?? new Date()
  const action = opts.action ?? '/'
  const mode: BrowseMode = opts.mode === 'all' ? 'all' : 'top'
  const q = opts.query.q ?? ''

  const href = (params: Record<string, string>): string => {
    const p = new URLSearchParams()
    if (q) p.set('q', q)
    if (opts.query.scope) p.set('scope', opts.query.scope)
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
    ? `<div class="empty">${mode === 'top' && !q ? 'No engrams have been recalled yet.' : 'No engrams match.'}</div>`
    : `<div class="rec-head">
    <span>ID</span><span>Statement</span><span class="col-scope">Scope</span><span>Recalls</span><span class="col-date">Created</span>
  </div>
${ordered.map(r => record(r, peak, recallCount(r) === peak && peak > 0)).join('\n')}`

  const hasPrev = page.offset > 0
  const hasNext = page.offset + page.limit < page.total
  const pager = page.total > page.limit
    ? `<div class="pager">
  ${hasPrev ? `<a href="${href({ mode, offset: String(Math.max(0, page.offset - page.limit)) })}">&larr; Previous</a>` : '<span class="off">&larr; Previous</span>'}
  <span class="off">${page.total.toLocaleString('en-US')} match${page.total === 1 ? '' : 'es'} · showing ${ordered.length} from ${page.offset}</span>
  ${hasNext ? `<a href="${href({ mode, offset: String(page.offset + page.limit) })}">Next &rarr;</a>` : '<span class="off">Next &rarr;</span>'}
</div>`
    : ''

  const links = opts.links ?? {}
  const openFolder = links.openFolder
    ? `<form class="open-folder" method="POST" action="${htmlEscape(links.openFolder)}"><button type="submit" title="Open the store folder in your file manager">Open folder</button></form>`
    : ''

  return `<div class="page-head">
  <h1 class="page-title">Memory</h1>
  <span class="page-aside">
    ${opts.where ? `<span class="page-where">${htmlEscape(opts.where)}</span>` : ''}
    ${openFolder}
  </span>
</div>
<p class="page-sub">What your agents have learned, and what they actually use. Everything here is local to this machine. Select a row to read the full engram.</p>

${statStrip(opts.rows)}

<div class="widgets">
${writtenChart(opts.rows, now)}
${topRecalledCard(opts.rows)}
</div>

<div class="controls">
  <nav class="seg" aria-label="Which engrams to list">
    <a href="${href({ mode: '', offset: '' })}" aria-current="${mode === 'top'}">Most recalled</a>
    <a href="${href({ mode: 'all', offset: '' })}" aria-current="${mode === 'all'}">All</a>
  </nav>
  <form method="GET" action="${htmlEscape(action)}">
    ${mode === 'all' ? '<input type="hidden" name="mode" value="all">' : ''}
    <input name="q" value="${htmlEscape(q)}" placeholder="Search statement or ID" autocomplete="off" aria-label="Search statement or ID">
    <button type="submit">Search</button>
  </form>
</div>

<div class="records">${list}</div>
${pager}
${footer(links)}`
}
