/* global React */
const { useMemo, useState, useEffect } = React;

// ---- Defaults for the editable tweak block ----
// Generalised offer — no client interpolation. Tweakable for sales conversations.
window.__PROPOSAL_DEFAULTS__ = /*EDITMODE-BEGIN*/{
  "seats": 50,
  "listPrice": 50,
  "discountPct": 30,
  "featureRequestRate": 85,
  "commitmentMonths": 12,
  "meteredSavingsPct": 20,
  "meteredFloor": 500,
  "brandColor": "#0000FF"
}/*EDITMODE-END*/;

// ---- Number helpers ----
window.fmtEUR = function(n, opts = {}) {
  const { cents = false, compact = false } = opts;
  if (compact && n >= 1000) {
    if (n >= 1_000_000) return '€' + (n/1_000_000).toFixed(1).replace(/\.0$/,'') + 'M';
    return '€' + Math.round(n/1000) + 'k';
  }
  const v = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  }).format(Math.round(n * (cents?100:1)) / (cents?100:1));
  return '€' + v;
};
window.fmtNum = function(n) {
  return new Intl.NumberFormat('en-US').format(n);
};
window.fmtPct = function(n) { return Math.round(n) + '%'; };

// ---- Compute the numbers for a given set of tweaks ----
window.computeOffer = function(t) {
  const seats = t.seats;
  const list = t.listPrice;
  const discount = t.discountPct / 100;
  const fpPrice = Math.round(list * (1 - discount));
  const commitment = t.commitmentMonths;
  const featureRate = t.featureRequestRate;

  // Flat option
  const monthlySub = seats * fpPrice;
  const annualSub = monthlySub * commitment;
  const annualAtList = seats * list * commitment;
  const subSavings = annualAtList - annualSub;

  // Metered option (floor-only, no cap)
  const meteredSavingsPct = t.meteredSavingsPct;
  const meteredFloor = t.meteredFloor;

  // ROI — conservative: 15 min/day/dev, 18 working days/month, €70/h blended
  const hourlyRecovery = 70;
  const monthlyRecoveredPerDev = Math.round(0.25 * 18 * hourlyRecovery);
  const monthlyRecovered = seats * monthlyRecoveredPerDev;
  const annualRecovered = monthlyRecovered * 12;

  return {
    seats, list, fpPrice, discount, commitment, featureRate,
    monthlySub, annualSub, annualAtList, subSavings,
    meteredSavingsPct, meteredFloor,
    annualRecovered, monthlyRecovered, monthlyRecoveredPerDev,
  };
};

// ---- Page frame used in both variants ----
window.Page = function Page({ num, total, variant = 'v1', children, hideFooter = false }) {
  return (
    <div className="page">
      <div className="page__header">
        <span className="hdr-brand"><span className="dot"></span> Datafund × PLUR Enterprise</span>
        <span>Founding Partner Offer · May 2026</span>
      </div>
      {children}
      {!hideFooter && (
        <div className="page__footer">
          <span className="conf">Confidential · Prepared April 2026</span>
          <span>{num} / {total}</span>
        </div>
      )}
    </div>
  );
};

// ---- Eyebrow ----
window.Eyebrow = function Eyebrow({ children }) {
  return <span className="p-eyebrow"><span className="pip"></span>{children}</span>;
};

// ---- Datafund logo mark (real wordmark) ----
window.BrandMark = function BrandMark({ height = 22 }) {
  return (
    <img
      src="assets/datafund.svg"
      alt="Datafund"
      style={{height, width: 'auto', display: 'block'}}
    />
  );
};

// ---- Architecture diagram (SVG, animated) ----
window.ArchDiagram = function ArchDiagram({ tight = false, totalRepos }) {
  const repos = totalRepos ?? window.__PROPOSAL_TWEAKS__?.totalRepos ?? window.__PROPOSAL_DEFAULTS__.totalRepos;
  // Data flow: Developer IDEs → MCP gateway → PLUR server + Postgres/AGE/pgvector
  // + Knowledge extraction pipeline → engrams → knowledge packs
  // + SSO + Audit log
  return (
    <svg className="p-arch" viewBox="0 0 720 300" role="img" aria-label="PLUR Enterprise architecture">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--df-blue)"/>
        </marker>
        <style>{`
          .pulse { animation: pulseAnim 3s ease-in-out infinite; }
          @keyframes pulseAnim {
            0%, 100% { opacity: 0.25; }
            50% { opacity: 1; }
          }
          .pulse-b { animation-delay: 0.5s; }
          .pulse-c { animation-delay: 1.0s; }
          .pulse-d { animation-delay: 1.5s; }
          .pulse-e { animation-delay: 2.0s; }
          .flow {
            stroke: var(--df-blue); stroke-width: 1.4; fill: none;
          }
          .node {
            fill: white; stroke: #111; stroke-width: 1;
          }
          .node-blue { fill: var(--df-blue); stroke: var(--df-blue); }
          .node-soft { fill: #F6F6F6; stroke: rgba(0,0,0,0.25); }
          .tlabel { font-family: Geist, sans-serif; font-size: 10px; font-weight: 600; fill: #000; }
          .tlabel-w { fill: white; }
          .tmono { font-family: "Geist Mono", monospace; font-size: 8px; fill: #8A8A8A; letter-spacing: 0.04em; text-transform: uppercase; }
          .tsmall { font-family: Geist, sans-serif; font-size: 9px; fill: #4A4A4A; }
        `}</style>
      </defs>

      {/* LEFT: Developer IDEs */}
      <g>
        <text x="20" y="18" className="tmono">Your engineers</text>
        {[
          ['Claude Code', 40],
          ['Cursor / Windsurf', 72],
          ['VS Code / JetBrains', 104],
          ['CLI + agents', 136],
        ].map(([t, y], i) => (
          <g key={i}>
            <rect x="20" y={y} width="130" height="22" rx="2" className="node"/>
            <text x="28" y={y+15} className="tlabel">{t}</text>
            <circle cx="146" cy={y+11} r="3" className={`node-blue pulse ${['','pulse-b','pulse-c','pulse-d'][i]}`}/>
          </g>
        ))}
        <text x="20" y="180" className="tmono">50 seats</text>
      </g>

      {/* MCP gateway */}
      <g>
        <line x1="150" y1="62" x2="220" y2="130" className="flow" markerEnd="url(#arrow)"/>
        <line x1="150" y1="94" x2="220" y2="130" className="flow" markerEnd="url(#arrow)"/>
        <line x1="150" y1="126" x2="220" y2="130" className="flow" markerEnd="url(#arrow)"/>
        <line x1="150" y1="158" x2="220" y2="130" className="flow" markerEnd="url(#arrow)"/>

        <rect x="220" y="112" width="118" height="44" rx="2" className="node-blue"/>
        <text x="232" y="131" className="tlabel tlabel-w">MCP Gateway</text>
        <text x="232" y="145" className="tmono" fill="white" opacity="0.8">HTTP · SSE · SSO</text>
      </g>

      {/* Centre: PLUR server */}
      <g>
        <line x1="338" y1="134" x2="378" y2="134" className="flow" markerEnd="url(#arrow)"/>
        <rect x="378" y="60" width="180" height="180" rx="2" className="node-soft"/>
        <text x="390" y="78" className="tmono">PLUR Enterprise Server</text>

        <rect x="390" y="88" width="156" height="30" rx="2" className="node"/>
        <text x="398" y="106" className="tlabel">Knowledge Graph · AGE</text>
        <circle cx="534" cy="103" r="3" className="node-blue pulse"/>

        <rect x="390" y="124" width="156" height="30" rx="2" className="node"/>
        <text x="398" y="142" className="tlabel">Semantic Memory · pgvector</text>
        <circle cx="534" cy="139" r="3" className="node-blue pulse pulse-b"/>

        <rect x="390" y="160" width="156" height="30" rx="2" className="node"/>
        <text x="398" y="178" className="tlabel">Scope · Role · Audit</text>
        <circle cx="534" cy="175" r="3" className="node-blue pulse pulse-c"/>

        <rect x="390" y="196" width="156" height="30" rx="2" className="node"/>
        <text x="398" y="214" className="tlabel">Correction-based Learning</text>
        <circle cx="534" cy="211" r="3" className="node-blue pulse pulse-d"/>
      </g>

      {/* RIGHT: Ingest pipeline */}
      <g>
        <line x1="558" y1="150" x2="600" y2="150" className="flow" markerEnd="url(#arrow)"/>
        <rect x="600" y="60" width="110" height="80" rx="2" className="node"/>
        <text x="610" y="78" className="tmono">Ingest pipeline</text>
        <text x="610" y="95" className="tsmall">{fmtNum(repos)} repos</text>
        <text x="610" y="108" className="tsmall">Engram extract</text>
        <text x="610" y="121" className="tsmall">Convention + pattern</text>

        <rect x="600" y="150" width="110" height="80" rx="2" className="node"/>
        <text x="610" y="168" className="tmono">Knowledge packs</text>
        <text x="610" y="185" className="tsmall">Per project</text>
        <text x="610" y="198" className="tsmall">Per group</text>
        <text x="610" y="211" className="tsmall">Reviewed + curated</text>
        <text x="610" y="224" className="tsmall">Reusable assets</text>
      </g>

      {/* Footer rail */}
      <line x1="20" y1="260" x2="700" y2="260" stroke="rgba(0,0,0,0.12)" strokeWidth="1"/>
      <text x="20" y="278" className="tmono">Self-hosted · On your GitLab infra · SSO · Audit log · Scope-based access</text>
    </svg>
  );
};

// ---- The cost breakdown: three independent quotes ----
window.CostTable = function CostTable({ offer, compact = false }) {
  const o = offer;
  const rate = o.rate;

  function ProjectBlock({ letter, title, subtitle, p, items, total, footnote }) {
    return (
      <div style={{marginBottom: 22, border: '1px solid rgba(0,0,0,0.15)'}}>
        <div style={{display:'grid', gridTemplateColumns:'auto 1fr auto', alignItems:'center', gap:16, padding:'12px 14px', borderBottom:'1px solid rgba(0,0,0,0.15)', background:'#F6F6F6'}}>
          <div className="p-mono p-blue" style={{fontSize:18, fontWeight:700}}>{letter}</div>
          <div>
            <div style={{fontWeight:700, fontSize:13, letterSpacing:'-0.01em'}}>{title}</div>
            <div className="p-mono" style={{color:'var(--df-fg-muted)', marginTop:2}}>{subtitle}</div>
          </div>
          <div style={{textAlign:'right'}}>
            <div className="p-mono">Estimate</div>
            <div style={{fontSize:22, fontWeight:700, color:'var(--df-blue)', letterSpacing:'-0.01em', fontVariantNumeric:'tabular-nums'}}>{fmtEUR(total)}</div>
            <div className="p-mono" style={{color:'var(--df-fg-muted)'}}>{p.hours} h · €{rate}/h · on actuals</div>
          </div>
        </div>
        <table className="p-table p-table--dense" style={{borderTop:'none'}}>
          <thead>
            <tr>
              <th style={{width:16}}>#</th>
              <th>Deliverable</th>
              <th className="num">Product</th>
              <th className="num">Tech</th>
              <th className="num">DevOps</th>
              <th className="num">Data+PM</th>
              <th className="num">Cost</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => {
              const included = it[5] === true;
              const rowCost = (it[1]||0)*rate + (it[2]||0)*rate + (it[3]||0)*rate + (it[4]||0)*rate;
              return (
                <tr key={i}>
                  <td style={{width:16, color:'var(--df-fg-muted)'}}>{i+1}</td>
                  <td>{it[0]}{it[6] ? <div className="p-mono" style={{color:'var(--df-fg-muted)', fontSize:9, fontWeight:400, marginTop:2}}>{it[6]}</div> : null}</td>
                  <td className="num">{it[1] || ''}</td>
                  <td className="num">{it[2] || ''}</td>
                  <td className="num">{it[3] || ''}</td>
                  <td className="num">{it[4] || ''}</td>
                  <td className="num">{included
                    ? <span className="p-mono" style={{color:'var(--df-blue)', fontWeight:700, letterSpacing:'0.04em'}}>INCLUDED</span>
                    : fmtEUR(rowCost)}</td>
                </tr>
              );
            })}
            <tr className="sum">
              <td></td>
              <td>Subtotal{p.tokens ? <span className="p-muted" style={{fontWeight:400, fontSize:10}}> (+ {fmtEUR(p.tokens)} AI compute at cost)</span> : null}</td>
              <td className="num">{p.gregor || ''}</td>
              <td className="num">{p.tadej || ''}</td>
              <td className="num">{p.marko || ''}</td>
              <td className="num">{p.crt || ''}</td>
              <td className="num">{fmtEUR(p.hours * rate)}</td>
            </tr>
            {footnote ? (
              <tr>
                <td></td>
                <td colSpan={6} className="p-mono" style={{color:'var(--df-fg-muted)', fontSize:10, paddingTop:6}}>{footnote}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div>
      <ProjectBlock
        letter="A"
        title="Integration — GitLab & Deployment"
        subtitle="One-time · custom work · GitLab SSO, group sync & workshop included"
        p={o.integration}
        total={o.integrationTotal}
        items={[
          ['GitLab OAuth2 / OIDC + PKCE integration',          0, 0, 0, 0, true],
          ['GitLab group / project membership sync + webhooks', 0, 0, 0, 0, true],
          ['Deployment & configuration for your GitLab instance', 0, 4, 8, 0],
          ['Setup workshop (all hands, 2–3h)',                  0, 0, 0, 0, true],
          ['Project management & weekly check-ins (all phases)', 0, 0, 0, 16],
        ]}
      />
      <ProjectBlock
        letter="B"
        title={`Knowledge Engineering — Phase A · Pipeline + ${o.activeRepos} active repos`}
        subtitle="One-time · custom work · tech-lead driven · you keep the pipeline"
        p={o.phaseA}
        total={o.phaseA.hours * rate}
        footnote="Infra and AI (token) costs are not included — paid directly to your provider."
        items={[
          ['Extraction strategy & kickoff with tech leads',     0,  0, 0,  8],
          ['Custom ingest pipeline development (reusable)',     4, 16, 0,  4],
          ['First 5 repos — extraction + tech-lead review cycle', 4, 0, 0, 8],
          ['Remaining 25 repos — batch extraction + refine',    4,  0, 0,  8, false, 'Pipeline accuracy improves with each batch — progressively less manual review needed.'],
          ['Pipeline handover + phase report',                  0,  4, 0,  4],
        ]}
      />
      <ProjectBlock
        letter="C"
        title={`Knowledge Engineering — Phase B · ${fmtNum(o.remainingRepos)} repos (automated)`}
        subtitle="One-time · custom work · pipeline reuse from Phase A"
        p={o.phaseB}
        total={o.phaseB.hours * rate}
        footnote="Infra and AI (token) costs are not included — paid directly to your provider."
        items={[
          ['Batch run on all remaining repos + monitoring', 0, 0, 0, 8],
          ['Outlier review & quality pass',                 2, 0, 0, 8],
          ['Coverage report & final handover',              0, 0, 0, 4],
        ]}
      />
    </div>
  );
};

// ---- Hours by domain donut chart ----
window.HoursByDomain = function HoursByDomain({ offer }) {
  const o = offer;
  // ETL-honest scope. 114h total: integration 28 + Phase A 64 + Phase B 22.
  const domains = [
    { label: 'Pipeline engineering',              hours: 28, color: '#0000FF' },
    { label: 'Convention extraction & review',    hours: 24, color: '#4A4AFF' },
    { label: 'Project management & check-ins',    hours: 16, color: '#8080FF' },
    { label: 'Batch run & coverage',              hours: 22, color: '#B0B0FF' },
    { label: 'Deployment & DevOps',               hours: 12, color: '#C7C7FF' },
    { label: 'Strategy & planning',               hours:  8, color: '#D9D9FF' },
    { label: 'Handover & documentation',          hours:  4, color: '#E6E6FF' },
  ];
  const total = domains.reduce((s, d) => s + d.hours, 0);
  // Normalise leftover (tiny rounding diff vs o.integrationHours+o.keHours) to PM bucket
  const expected = o.integrationHours + o.keHours;
  const delta = expected - total;
  if (delta !== 0) domains[1].hours += delta;

  const grand = domains.reduce((s, d) => s + d.hours, 0);

  // SVG donut
  const SIZE = 200;
  const R = 88;
  const CX = SIZE / 2;
  const CY = SIZE / 2;
  const STROKE = 36;
  const CIRC = 2 * Math.PI * R;
  let running = 0;
  const segments = domains.map((d) => {
    const frac = d.hours / grand;
    const len = frac * CIRC;
    const dasharray = `${len} ${CIRC - len}`;
    const dashoffset = -running;
    running += len;
    return { ...d, dasharray, dashoffset, frac };
  });

  return (
    <div style={{display:'grid', gridTemplateColumns:'220px 1fr', gap:32, alignItems:'center'}}>
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label="Hours by domain">
        <circle cx={CX} cy={CY} r={R} fill="none" stroke="#F0F0F3" strokeWidth={STROKE}/>
        {segments.map((s, i) => (
          <circle
            key={i}
            cx={CX} cy={CY} r={R}
            fill="none"
            stroke={s.color}
            strokeWidth={STROKE}
            strokeDasharray={s.dasharray}
            strokeDashoffset={s.dashoffset}
            transform={`rotate(-90 ${CX} ${CY})`}
          />
        ))}
        <text x={CX} y={CY - 4} textAnchor="middle" style={{font:'700 28px Geist, sans-serif', letterSpacing:'-0.02em'}}>{grand}</text>
        <text x={CX} y={CY + 14} textAnchor="middle" style={{font:'500 9px "Geist Mono", monospace', letterSpacing:'0.08em', fill:'#8A8A8A', textTransform:'uppercase'}}>engineering hours</text>
      </svg>

      <div>
        <table className="p-table" style={{fontSize:11}}>
          <thead>
            <tr>
              <th style={{width:14}}></th>
              <th>Domain</th>
              <th className="num">Hours</th>
              <th className="num">Share</th>
            </tr>
          </thead>
          <tbody>
            {segments.map((s, i) => (
              <tr key={i}>
                <td><span style={{display:'inline-block', width:10, height:10, background:s.color, borderRadius:1}}></span></td>
                <td>{s.label}</td>
                <td className="num">{s.hours} h</td>
                <td className="num">{Math.round(s.frac * 100)}%</td>
              </tr>
            ))}
            <tr className="sum">
              <td></td>
              <td>Total</td>
              <td className="num">{grand} h</td>
              <td className="num">100%</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ---- FAQ component ----
window.FAQ = function FAQ({ items }) {
  return (
    <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:'14px 36px'}}>
      {items.map((q, i) => (
        <div key={i}>
          <div className="p-h3 p-h3--blue" style={{marginBottom:6}}>{q[0]}</div>
          <div className="p-body">{q[1]}</div>
        </div>
      ))}
    </div>
  );
};

window.FAQ_ITEMS = [
  ['Is it self-hosted?', 'Yes. PLUR Enterprise runs inside your infrastructure — no source code, graphs or prompts leave your network. LLM calls go to the provider you choose (self-hosted or commercial), routed through your gateway.'],
  ['How does it fit our security model?', 'SSO through your IdP, scope-based access, tool allowlist, write enforcement, tamper-evident audit log. We co-author the threat model and the mapping to your controls during deployment.'],
  ['How is this different from Copilot?', 'Copilot autocompletes. PLUR remembers. It retains conventions, decisions, corrections and context across repos and years, and serves them back to any agent or engineer on demand.'],
  ['What happens to the learning if we leave?', 'You keep it. The knowledge graph, engrams and packs are your property. You export them at any time, in open formats.'],
  ['Who owns the IP?', 'You own all extracted knowledge. Datafund retains IP in the PLUR platform itself. The Founding Partner terms guarantee you the best commercial rate, always.'],
  ['Why "Founding Partner"?', 'Because we are shipping this together. Your requirements define the enterprise feature set, you receive 30% off for life, and you hold white-label & reseller rights for your own vertical.'],
  ['What if we use fewer than 50 seats?', 'You pay €1,750/month regardless — that\'s the minimum commitment. It covers up to 50 seats whether you activate 5 or 50. Additional seats beyond 50 are €35/seat/month, same Founding Partner rate.'],
  ['How does the metered alternative work?', 'You bring your own LLM API keys (BYOK). The gateway proxies requests and measures tokens used with vs. without the relevant packs, producing a signed receipt of measurable savings each month. We invoice 20% of measured savings, with a €500/month floor that covers gateway operational cost regardless of usage. There is no cap — heavy-saving months cost more, light months cost the floor.'],
  ['Will the metered methodology be auditable?', 'Yes. The methodology is published and versioned. During the first 30 days you co-sign the savings calculation as fit for your environment. If you don\'t co-sign, the contract automatically reverts to the standard €35/seat Flat rate; no obligation either way.'],
  ['Can we request custom features?', 'Yes. Feature requests are scoped per request and billed on actuals at €85/h, with monthly cap negotiated per request. Roadmap-aligned features ship at no charge. Customer-specific features ship behind a feature flag.'],
];
