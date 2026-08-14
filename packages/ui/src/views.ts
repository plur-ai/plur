/**
 * The memory viewer, rendered as self-contained HTML.
 *
 * Pure functions returning strings — the same idiom as the PLUR Enterprise
 * admin, and for the same reason: it needs no framework, no bundler and no
 * browser to test. Assert on the markup.
 *
 * Every value that reaches the page is escaped. Engram statements are user
 * data, and some of them will contain angle brackets because people store code
 * in their memory.
 *
 * @module
 */
import {
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

/** Status pill, matching the enterprise admin's colour vocabulary. */
function statusPill(status: string | undefined, commitment: string | undefined): string {
  const colours: Record<string, string> = {
    active: '110, 231, 183',
    retired: '138, 143, 163',
    candidate: '251, 191, 36',
  }
  const NEUTRAL = '138, 143, 163'
  // A draft awaiting review is not live knowledge, whatever its lifecycle
  // status says — rendering it green would tell the reader it is recallable.
  const rgb = commitment === 'draft' ? NEUTRAL : (colours[status ?? ''] ?? NEUTRAL)
  const label = commitment === 'draft' ? 'draft' : (status ?? 'unknown')
  return `<span class="pill" style="background:rgba(${rgb},0.12);color:rgb(${rgb});border:1px solid rgba(${rgb},0.30);">${htmlEscape(label)}</span>`
}

/** The written-per-day bar chart. */
function writtenChart(rows: readonly EngramRow[], now: Date): string {
  const days = writtenPerDay(rows, 30, now)
  const peak = Math.max(1, ...days.map(d => d.count))
  const total = days.reduce((sum, d) => sum + d.count, 0)
  const bars = days.map(d => {
    const pct = Math.round((d.count / peak) * 100)
    const cls = d.count === 0 ? 'bar empty' : 'bar'
    const height = d.count === 0 ? 2 : Math.max(4, pct)
    return `<div class="${cls}" style="height:${height}%" title="${htmlEscape(d.date)}: ${d.count}"></div>`
  }).join('')
  return `<div class="chart-card">
  <p class="chart-title">Written — last 30 days</p>
  <span class="chart-sub">${total} engram${total === 1 ? '' : 's'} learned in this window</span>
  <div class="bars">${bars}</div>
  <div class="bar-axis"><span>${htmlEscape(days[0]?.date ?? '')}</span><span>${htmlEscape(days.at(-1)?.date ?? '')}</span></div>
</div>`
}

/** The most-recalled list. */
function topRecalledCard(rows: readonly EngramRow[]): string {
  const top = topByRecall(rows, 6)
  if (top.length === 0) {
    return `<div class="chart-card">
  <p class="chart-title">Most recalled</p>
  <span class="chart-sub">what the agent actually pulls into context</span>
  <div class="empty" style="padding:var(--sp-6) 0;">Nothing has been recalled yet.<br><span style="font-size:13px;">A store that only grows is a store nobody is reading.</span></div>
</div>`
  }
  const items = top.map(r => `  <div class="card-engram">
    <span class="card-engram-statement">${htmlEscape(r.statement ?? '')}</span>
    <span class="card-engram-count" title="Pulled into context ${recallCount(r)} times">&#8635; ${recallCount(r)}</span>
  </div>`).join('\n')
  return `<div class="chart-card">
  <p class="chart-title">Most recalled</p>
  <span class="chart-sub">what the agent actually pulls into context</span>
${items}
</div>`
}

/** The headline stat row. */
function statRow(rows: readonly EngramRow[]): string {
  const s = memoryStats(rows)
  return `<div class="stats">
  <div class="stat"><div class="stat-value">${s.total}</div><div class="stat-label">Engrams</div></div>
  <div class="stat"><div class="stat-value">${s.recalled}</div><div class="stat-label">Recalled at least once</div></div>
  <div class="stat${s.neverRecalledPct >= 50 ? ' warn' : ''}"><div class="stat-value">${s.neverRecalled}</div><div class="stat-label">Never recalled${s.total > 0 ? ` · ${s.neverRecalledPct}%` : ''}</div></div>
  <div class="stat"><div class="stat-value">${s.scopes}</div><div class="stat-label">Scope${s.scopes === 1 ? '' : 's'}</div></div>
</div>`
}

/** Options for {@link renderBrowse}. */
export interface BrowseOptions {
  rows: readonly EngramRow[]
  query: BrowseQuery
  /** Injectable clock, for tests. */
  now?: Date
  /** Path the search form submits to. */
  action?: string
}

/**
 * Render the browse view: stats, two widgets, and the engram table.
 *
 * @param opts - rows, active filters, and presentation options.
 * @returns the page body (not a full document — see {@link renderPage}).
 */
export function renderBrowse(opts: BrowseOptions): string {
  const now = opts.now ?? new Date()
  const action = opts.action ?? '/'
  const page = filterEngrams(opts.rows, opts.query)
  const q = opts.query.q ?? ''

  const link = (offset: number, label: string): string => {
    const params = new URLSearchParams()
    if (q) params.set('q', q)
    if (opts.query.scope) params.set('scope', opts.query.scope)
    params.set('offset', String(offset))
    return `<a href="${htmlEscape(action)}?${htmlEscape(params.toString())}">${label}</a>`
  }

  const body = page.rows.length === 0
    ? `<div class="empty">No engrams match these filters.</div>`
    : `<table>
  <thead><tr>
    <th>ID</th><th>Scope</th><th>Status</th><th>Statement</th>
    <th title="Times this engram was pulled into agent context">Recalls</th><th>Learned</th>
  </tr></thead>
  <tbody>
${page.rows.map(r => {
  const stmt = r.statement ?? ''
  const short = stmt.length > 96 ? `${stmt.slice(0, 93)}...` : stmt
  const n = recallCount(r)
  const recalls = n === 0
    ? `<span class="mono" style="color:var(--muted);" title="Never recalled">0</span>`
    : `<span class="mono" style="color:var(--accent);font-weight:500;">${n}</span>`
  const pinned = r.pinned === true ? ` <span class="tag-chip violet">PINNED</span>` : ''
  return `    <tr>
      <td class="mono" style="font-size:13px;" title="${htmlEscape(r.id ?? '')}">${htmlEscape((r.id ?? '').slice(0, 18))}</td>
      <td class="mono" style="font-size:13px;">${htmlEscape(r.scope ?? '—')}</td>
      <td>${statusPill(r.status, r.commitment)}${pinned}</td>
      <td title="${htmlEscape(stmt)}">${htmlEscape(short)}</td>
      <td class="num">${recalls}</td>
      <td class="num" style="color:var(--muted);font-size:13px;">${htmlEscape(r.temporal?.learned_at?.slice(0, 10) ?? '—')}</td>
    </tr>`
}).join('\n')}
  </tbody>
</table>`

  const hasPrev = page.offset > 0
  const hasNext = page.offset + page.limit < page.total
  const pager = page.total > page.limit
    ? `<div class="pager">
  ${hasPrev ? link(Math.max(0, page.offset - page.limit), '&larr; Previous') : '<span class="off">&larr; Previous</span>'}
  <span class="off">${page.total} total · showing ${page.rows.length} (offset ${page.offset})</span>
  ${hasNext ? link(page.offset + page.limit, 'Next &rarr;') : '<span class="off">Next &rarr;</span>'}
</div>`
    : ''

  return `<h1 class="page-title">Memory</h1>
<p class="page-sub">Engrams are atomic units of learned knowledge — corrections, preferences, conventions and patterns your agents recall during sessions. Everything here is local, on this machine.</p>

${statRow(opts.rows)}

<div class="grid2">
${writtenChart(opts.rows, now)}
${topRecalledCard(opts.rows)}
</div>

<form class="search" method="GET" action="${htmlEscape(action)}">
  <label>Search statement or ID
    <input name="q" value="${htmlEscape(q)}" placeholder="deploy, ENG-2026-, pnpm …" autocomplete="off">
  </label>
  <button type="submit">Search</button>
</form>

<div class="scroller">${body}</div>
${pager}`
}
