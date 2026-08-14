/**
 * Visual language, ported from the PLUR Enterprise admin.
 *
 * Same tokens, same component shapes — a user who has seen the enterprise
 * engram browser should recognise this immediately. Kept as a plain string so
 * the viewer stays a zero-dependency, zero-bundler package.
 *
 * @module
 */

/** The full stylesheet, inlined into every rendered page. */
export const CSS = `
:root {
  --cyan: #22d3ee;
  --amber: #f0a050;
  --violet: #a78bfa;
  --emerald: #34d399;
  --font-display: -apple-system, BlinkMacSystemFont, system-ui, 'Segoe UI', sans-serif;
  --font-mono: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace;

  --sp-1: 4px;  --sp-2: 8px;  --sp-3: 12px; --sp-4: 16px;
  --sp-5: 20px; --sp-6: 24px; --sp-7: 28px; --sp-8: 32px;

  --bg:             #08080c;
  --bg-subtle:      #0c0c12;
  --bg-card:        rgba(255,255,255,0.04);
  --bg-card-border: rgba(255,255,255,0.10);
  --bg-code:        rgba(255,255,255,0.04);
  --text:           #f0f0f2;
  --text-secondary: rgba(255,255,255,0.76);
  --text-tertiary:  rgba(255,255,255,0.46);
  --muted:          rgba(255,255,255,0.38);
  --line:           rgba(255,255,255,0.06);
  --table-header-bg: rgba(255,255,255,0.03);
  --table-row-hover: rgba(255,255,255,0.02);
  --accent:         var(--cyan);
  --accent-rgb:     34,211,238;
}

/* The viewer is embedded in host chrome that may be light. Follow it. */
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    --bg:             #fafaf9;
    --bg-subtle:      #f5f5f0;
    --bg-card:        rgba(0,0,0,0.03);
    --bg-card-border: rgba(0,0,0,0.10);
    --bg-code:        rgba(0,0,0,0.03);
    --text:           #1a1a1a;
    --text-secondary: rgba(0,0,0,0.72);
    --text-tertiary:  rgba(0,0,0,0.50);
    --muted:          rgba(0,0,0,0.42);
    --line:           rgba(0,0,0,0.08);
    --table-header-bg: rgba(0,0,0,0.02);
    --table-row-hover: rgba(0,0,0,0.02);
    --accent:         #0891b2;
    --accent-rgb:     8,145,178;
  }
}
:root[data-theme="light"] {
  --bg:             #fafaf9;
  --bg-subtle:      #f5f5f0;
  --bg-card:        rgba(0,0,0,0.03);
  --bg-card-border: rgba(0,0,0,0.10);
  --bg-code:        rgba(0,0,0,0.03);
  --text:           #1a1a1a;
  --text-secondary: rgba(0,0,0,0.72);
  --text-tertiary:  rgba(0,0,0,0.50);
  --muted:          rgba(0,0,0,0.42);
  --line:           rgba(0,0,0,0.08);
  --table-header-bg: rgba(0,0,0,0.02);
  --table-row-hover: rgba(0,0,0,0.02);
  --accent:         #0891b2;
  --accent-rgb:     8,145,178;
}

* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font-family: var(--font-display); font-size: 15px; line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 1180px; margin: 0 auto; padding: var(--sp-7) var(--sp-6) var(--sp-8); }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
a:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.mono { font-family: var(--font-mono); }

.page-title { font-size: 26px; font-weight: 600; margin: 0 0 var(--sp-2); letter-spacing: -0.01em; }
.page-sub { font-size: 15px; color: var(--text-tertiary); margin: 0 0 var(--sp-5); max-width: 76ch; }

/* ── stat row ─────────────────────────────────────────────────────────── */
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--sp-3); margin-bottom: var(--sp-6); }
.stat {
  background: var(--bg-card); border: 1px solid var(--bg-card-border);
  border-radius: 10px; padding: var(--sp-4) var(--sp-5);
}
.stat-value { font-family: var(--font-mono); font-size: 26px; font-variant-numeric: tabular-nums; line-height: 1.1; }
.stat-label { font-size: 13px; color: var(--text-tertiary); margin-top: var(--sp-1); }
.stat.warn .stat-value { color: var(--amber); }

/* ── cards / charts ───────────────────────────────────────────────────── */
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: var(--sp-4); margin-bottom: var(--sp-6); }
.chart-card {
  background: var(--bg-card); border: 1px solid var(--bg-card-border);
  border-radius: 12px; padding: var(--sp-5) var(--sp-6); overflow: hidden;
}
.chart-title { font-size: 15px; color: var(--text); font-weight: 500; margin: 0 0 var(--sp-1); }
.chart-sub { font-size: 13px; color: var(--text-tertiary); display: block; margin-bottom: var(--sp-4); }

.bars { display: flex; align-items: flex-end; gap: 2px; height: 92px; }
.bar { flex: 1; min-width: 2px; background: rgba(var(--accent-rgb), 0.55); border-radius: 2px 2px 0 0; }
.bar.empty { background: var(--line); }
.bar-axis { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted); margin-top: var(--sp-2); font-family: var(--font-mono); }

.card-engram {
  display: flex; gap: var(--sp-3); align-items: baseline;
  padding: var(--sp-3) 0; border-bottom: 1px solid var(--line);
}
.card-engram:last-child { border-bottom: none; }
.card-engram-statement { font-size: 14px; color: var(--text-secondary); line-height: 1.5; flex: 1; }
.card-engram-count {
  font-family: var(--font-mono); font-size: 13px; color: var(--accent);
  font-weight: 500; font-variant-numeric: tabular-nums; white-space: nowrap;
}

/* ── chips & pills ────────────────────────────────────────────────────── */
.tag-chip {
  display: inline-block; padding: 2px 8px; border-radius: 999px;
  background: var(--bg-code); border: 1px solid var(--line);
  font-size: 12px; color: var(--text-tertiary); white-space: nowrap;
}
.tag-chip.violet { color: var(--violet); border-color: rgba(167,139,250,0.35); }
.pill {
  display: inline-block; padding: 2px 9px; border-radius: 999px;
  font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase;
  white-space: nowrap; font-weight: 500;
}

/* ── search ───────────────────────────────────────────────────────────── */
.search { display: flex; gap: var(--sp-3); align-items: flex-end; margin-bottom: var(--sp-4); flex-wrap: wrap; }
.search label { display: flex; flex-direction: column; gap: var(--sp-1); font-size: 13px; color: var(--text-tertiary); flex: 1; min-width: 240px; }
.search input {
  background: var(--bg-subtle); border: 1px solid var(--bg-card-border); color: var(--text);
  border-radius: 8px; padding: 8px 12px; font-size: 14px; font-family: inherit; width: 100%;
}
.search button {
  background: var(--bg-card); border: 1px solid var(--bg-card-border); color: var(--text);
  border-radius: 8px; padding: 9px 16px; font-size: 14px; cursor: pointer; font-family: inherit;
}
.search button:hover { border-color: rgba(var(--accent-rgb), 0.35); }

/* ── table ────────────────────────────────────────────────────────────── */
.scroller { overflow-x: auto; border: 1px solid var(--bg-card-border); border-radius: 12px; background: var(--bg-card); }
table { border-collapse: collapse; width: 100%; min-width: 720px; }
th {
  text-align: left; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em;
  color: var(--text-tertiary); font-weight: 500; padding: var(--sp-3) var(--sp-4);
  background: var(--table-header-bg); border-bottom: 1px solid var(--line); white-space: nowrap;
}
td { padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--line); vertical-align: top; font-size: 14px; }
tbody tr:last-child td { border-bottom: none; }
tbody tr:hover { background: var(--table-row-hover); }
td.num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
.empty { padding: var(--sp-8); text-align: center; color: var(--text-tertiary); }
.pager { display: flex; justify-content: space-between; margin-top: var(--sp-4); font-size: 14px; }
.pager .off { color: var(--muted); }
footer { margin-top: var(--sp-8); padding-top: var(--sp-4); border-top: 1px solid var(--line); font-size: 13px; color: var(--muted); }
`
