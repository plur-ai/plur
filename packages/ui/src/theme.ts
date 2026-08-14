/**
 * Visual language, ported from the PLUR Enterprise admin.
 *
 * Same tokens, same component vocabulary — someone who knows the enterprise
 * engram browser should recognise this on sight. Kept as a plain string so the
 * viewer stays a zero-dependency, zero-bundler package, and deliberately
 * script-free so it can be served from a bare HTTP server or embedded in a
 * host's web shell without a build step or a CSP exemption.
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
  --row-hover:      rgba(255,255,255,0.025);
  --accent:         var(--cyan);
  --accent-rgb:     34,211,238;
}

/* Embedded in host chrome that may be light. Follow it. */
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    --bg:             #fafaf9;
    --bg-subtle:      #f5f5f0;
    --bg-card:        rgba(0,0,0,0.025);
    --bg-card-border: rgba(0,0,0,0.09);
    --bg-code:        rgba(0,0,0,0.03);
    --text:           #16161a;
    --text-secondary: rgba(0,0,0,0.72);
    --text-tertiary:  rgba(0,0,0,0.50);
    --muted:          rgba(0,0,0,0.40);
    --line:           rgba(0,0,0,0.08);
    --row-hover:      rgba(0,0,0,0.02);
    --accent:         #0e7490;
    --accent-rgb:     14,116,144;
  }
}
:root[data-theme="light"] {
  --bg:             #fafaf9;
  --bg-subtle:      #f5f5f0;
  --bg-card:        rgba(0,0,0,0.025);
  --bg-card-border: rgba(0,0,0,0.09);
  --bg-code:        rgba(0,0,0,0.03);
  --text:           #16161a;
  --text-secondary: rgba(0,0,0,0.72);
  --text-tertiary:  rgba(0,0,0,0.50);
  --muted:          rgba(0,0,0,0.40);
  --line:           rgba(0,0,0,0.08);
  --row-hover:      rgba(0,0,0,0.02);
  --accent:         #0e7490;
  --accent-rgb:     14,116,144;
}

* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font-family: var(--font-display); font-size: 15px; line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 1140px; margin: 0 auto; padding: var(--sp-7) var(--sp-6) var(--sp-8); }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
.mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }

.page-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-4); flex-wrap: wrap; margin-bottom: var(--sp-2); }
.page-title { font-size: 24px; font-weight: 600; margin: 0; letter-spacing: -0.015em; }
.page-where { font-family: var(--font-mono); font-size: 13px; color: var(--muted); }
.page-sub { font-size: 14px; color: var(--text-tertiary); margin: 0 0 var(--sp-6); max-width: 68ch; }

/* ── stat strip ───────────────────────────────────────────────────────── */
.stats {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(132px, 1fr));
  border: 1px solid var(--bg-card-border); border-radius: 12px;
  background: var(--bg-card); overflow: hidden; margin-bottom: var(--sp-4);
}
.stat { padding: var(--sp-4) var(--sp-5); border-right: 1px solid var(--line); }
.stat:last-child { border-right: none; }
.stat-value { font-family: var(--font-mono); font-size: 23px; font-variant-numeric: tabular-nums; line-height: 1.15; }
.stat-label { font-size: 12px; color: var(--text-tertiary); margin-top: 2px; }
.stat.warn .stat-value { color: var(--amber); }

/* ── widgets ──────────────────────────────────────────────────────────── */
/* The chart earns more width than the list: 30 columns need room to read as a
   series, whereas the list is deliberately one line per item. */
.widgets { display: grid; grid-template-columns: 1.6fr 1fr; gap: var(--sp-4); margin-bottom: var(--sp-6); }
@media (max-width: 860px) { .widgets { grid-template-columns: 1fr; } }
.card {
  background: var(--bg-card); border: 1px solid var(--bg-card-border);
  border-radius: 12px; padding: var(--sp-5); overflow: hidden;
}
.card-title { font-size: 14px; font-weight: 500; margin: 0; }
.card-sub { font-size: 12px; color: var(--text-tertiary); display: block; margin: 2px 0 var(--sp-4); }

.bars { display: flex; align-items: flex-end; gap: 2px; height: 84px; }
.bar { flex: 1; min-width: 2px; background: rgba(var(--accent-rgb),0.5); border-radius: 2px 2px 0 0; }
.bar.empty { background: var(--line); }
.bar-axis { display: flex; justify-content: space-between; font-family: var(--font-mono); font-size: 11px; color: var(--muted); margin-top: var(--sp-2); }

/* One line per item — the previous card stacked six full statements and
   unbalanced the whole row against the sparse chart beside it. */
.top-row { display: grid; grid-template-columns: 1fr auto; gap: var(--sp-3); align-items: baseline; padding: 7px 0; border-bottom: 1px solid var(--line); }
.top-row:last-child { border-bottom: none; }
.top-stmt { font-size: 13px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.top-n { font-family: var(--font-mono); font-size: 12px; color: var(--accent); font-variant-numeric: tabular-nums; }

/* ── controls ─────────────────────────────────────────────────────────── */
.controls { display: flex; gap: var(--sp-3); align-items: center; flex-wrap: wrap; margin-bottom: var(--sp-3); }
.seg { display: inline-flex; border: 1px solid var(--bg-card-border); border-radius: 8px; overflow: hidden; }
.seg a { padding: 6px 13px; font-size: 13px; color: var(--text-tertiary); border-right: 1px solid var(--line); }
.seg a:last-child { border-right: none; }
.seg a:hover { background: var(--row-hover); text-decoration: none; }
.seg a[aria-current="true"] { background: rgba(var(--accent-rgb),0.12); color: var(--accent); }
.controls form { display: flex; gap: var(--sp-2); flex: 1; min-width: 220px; }
.controls input {
  flex: 1; background: var(--bg-subtle); border: 1px solid var(--bg-card-border); color: var(--text);
  border-radius: 8px; padding: 7px 12px; font-size: 13px; font-family: inherit; min-width: 0;
}
.controls button {
  background: var(--bg-card); border: 1px solid var(--bg-card-border); color: var(--text-secondary);
  border-radius: 8px; padding: 7px 14px; font-size: 13px; cursor: pointer; font-family: inherit;
}
.controls button:hover { border-color: rgba(var(--accent-rgb),0.35); color: var(--text); }

/* ── record list ──────────────────────────────────────────────────────── */
/* Each record is a native disclosure element rather than a table row, so
   expanding to read a full engram needs no JavaScript and is keyboard-operable
   for free. (Deliberately no literal angle-bracket tag names in this comment:
   the stylesheet is inlined into the page, and a tag name here shows up in
   anything that scans the served HTML for one.) */
.records { border: 1px solid var(--bg-card-border); border-radius: 12px; background: var(--bg-card); overflow: hidden; }
.rec-head, .rec-line {
  display: grid;
  grid-template-columns: 150px minmax(0,1fr) 128px 74px 92px;
  gap: var(--sp-4); align-items: baseline; padding: 10px var(--sp-5);
}
@media (max-width: 780px) {
  .rec-head { display: none; }
  .rec-line { grid-template-columns: minmax(0,1fr) 74px; row-gap: 4px; }
  .rec-line .col-scope, .rec-line .col-date { display: none; }
}
.rec-head {
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.055em;
  color: var(--text-tertiary); background: rgba(255,255,255,0.02);
  border-bottom: 1px solid var(--line);
}
details.rec { border-bottom: 1px solid var(--line); }
details.rec:last-child { border-bottom: none; }
details.rec > summary { list-style: none; cursor: pointer; }
details.rec > summary::-webkit-details-marker { display: none; }
details.rec > summary:hover { background: var(--row-hover); }
details.rec[open] > summary { background: var(--row-hover); }
.rec-id { font-family: var(--font-mono); font-size: 12px; color: var(--text-tertiary); }
.rec-stmt { font-size: 14px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The row stays one truncated line even when open: the expanded body is the
   single place the full statement appears. Letting the summary wrap printed it
   twice and made the row height jump as you opened records. */
details.rec[open] .rec-stmt { color: var(--text); }
.rec-scope { font-family: var(--font-mono); font-size: 12px; color: var(--text-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rec-date { font-family: var(--font-mono); font-size: 12px; color: var(--muted); }

/* THE SIGNATURE — recall weight as a quantity, not just a number.
   Recall is a power law here: one engram at 594, a median of 4, and a long
   tail of zero. A log-scaled bar makes that shape legible straight down the
   column, which a bare integer never does. */
.weight { display: flex; align-items: center; gap: 7px; }
.weight-bar { flex: 1; height: 3px; border-radius: 2px; background: var(--line); overflow: hidden; }
.weight-fill { display: block; height: 100%; background: var(--accent); border-radius: 2px; }
.weight-n { font-family: var(--font-mono); font-size: 12px; font-variant-numeric: tabular-nums; color: var(--accent); min-width: 3ch; text-align: right; }
.weight-n.zero { color: var(--muted); }

.rec-body { padding: var(--sp-2) var(--sp-5) var(--sp-5); background: var(--bg-subtle); }
.rec-statement-full {
  font-size: 15px; line-height: 1.6; color: var(--text);
  white-space: pre-wrap; overflow-wrap: anywhere; margin: 0 0 var(--sp-4); max-width: 84ch;
}
.rec-meta { display: flex; flex-wrap: wrap; gap: var(--sp-2) var(--sp-5); font-size: 12px; }
.rec-meta div { display: flex; gap: 6px; }
.rec-meta dt { color: var(--text-tertiary); }
.rec-meta dd { margin: 0; font-family: var(--font-mono); color: var(--text-secondary); }

.pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 10.5px; letter-spacing: 0.045em; text-transform: uppercase; white-space: nowrap; font-weight: 500; }
.chip { display: inline-block; padding: 1px 7px; border-radius: 999px; background: var(--bg-code); border: 1px solid var(--line); font-size: 10.5px; color: var(--text-tertiary); white-space: nowrap; }
.chip.violet { color: var(--violet); border-color: rgba(167,139,250,0.32); }

.empty { padding: var(--sp-8); text-align: center; color: var(--text-tertiary); font-size: 14px; }
.pager { display: flex; justify-content: space-between; align-items: center; margin-top: var(--sp-4); font-size: 13px; }
.pager .off { color: var(--muted); }
footer { margin-top: var(--sp-8); padding-top: var(--sp-4); border-top: 1px solid var(--line); font-size: 12px; color: var(--muted); }

@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`
