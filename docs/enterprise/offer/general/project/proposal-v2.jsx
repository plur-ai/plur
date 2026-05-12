/* global React, Page, Eyebrow, BrandMark, ArchDiagram, FAQ, FAQ_ITEMS, computeOffer, fmtEUR, fmtNum, fmtPct */

function ProposalV2({ tweaks }) {
  const o = computeOffer(tweaks);
  const TOTAL = 11;

  return (
    <div>
      {/* ==================================================== PAGE 1 — COVER */}
      <Page num="01" total={TOTAL}>
        <div style={{display:'grid', gridTemplateRows:'auto 1fr auto', height:'100%'}}>
          <div>
            <div style={{display:'flex', justifyContent:'space-between', alignItems:'flex-end'}}>
              <div>
                <div className="p-mono" style={{letterSpacing:'0.1em'}}>Document · PLUR-ENT-2026-05</div>
                <div className="p-mono" style={{letterSpacing:'0.1em', marginTop:4}}>Rev. 004 · May 2026 · General</div>
              </div>
              <BrandMark/>
            </div>
            <div className="p-divider" style={{margin:'18px 0 0'}}></div>
          </div>

          <div style={{alignSelf:'center'}}>
            <div className="p-mono p-blue" style={{letterSpacing:'0.15em', marginBottom:20}}>FOUNDING PARTNER OFFER · 2026</div>
            <div style={{fontSize:72, lineHeight:1.0, fontWeight:700, letterSpacing:'-0.02em', textWrap:'balance'}}>
              PLUR Enterprise
            </div>
            <div style={{height:16}}></div>
            <div className="p-lede" style={{maxWidth:540}}>
              Persistent, correction-based organisational memory and learning for AI-augmented engineering teams.
              Self-hosted. Self-deploying. One recurring line.
            </div>
          </div>

          <div>
            <div className="p-divider" style={{marginBottom:16}}></div>
            <table className="p-table" style={{fontSize:11}}>
              <tbody>
                <tr>
                  <td style={{width:'22%'}} className="p-mono">Issued by</td>
                  <td>Datafund d.o.o. · Ljubljana, SI</td>
                  <td style={{width:'22%'}} className="p-mono">Contact</td>
                  <td><a href="mailto:gregor@datafund.io">gregor@datafund.io</a></td>
                </tr>
                <tr>
                  <td className="p-mono">Valid through</td>
                  <td>31 December 2026</td>
                  <td className="p-mono">Founding Partner cohort</td>
                  <td>First 5 companies only</td>
                </tr>
                <tr>
                  <td className="p-mono">Commitment</td>
                  <td>{o.commitment} months from go-live</td>
                  <td className="p-mono">Headline price</td>
                  <td>€{o.fpPrice}/seat/mo</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </Page>

      {/* ==================================================== PAGE 2 — EXECUTIVE SUMMARY */}
      <Page num="02" total={TOTAL}>
        <div style={{display:'grid', gridTemplateColumns:'160px 1fr', gap:24}}>
          <div>
            <div className="p-mono p-blue">§ 01</div>
            <div className="p-mono" style={{marginTop:4}}>Executive<br/>summary</div>
          </div>
          <div>
            <div className="p-h1" style={{textWrap:'balance'}}>Turn every engineer, every agent, and every repository into compounding capital.</div>
            <div className="p-lede" style={{marginTop:24}}>
              PLUR Enterprise is persistent, correction-based organisational memory and learning for AI-augmented engineering teams.
              A developer corrects the AI on Monday — every teammate's AI knows it on Tuesday.
              Conventions captured once persist across all sessions, all IDEs, all years.
            </div>

            <div className="p-divider" style={{margin:'28px 0 20px'}}></div>

            <div className="p-h3" style={{marginBottom:10}}>One recurring line. No mandatory consulting.</div>
            <div className="p-deflist">
              <div className="n">·</div>
              <div className="t">
                <b>€{o.fpPrice}/seat/month</b> (Founding Partner, {fmtPct(o.discount*100)} off list). {o.seats} seats minimum,
                €{o.monthlySub.toLocaleString()}/mo, {o.commitment}-month commitment from go-live.
              </div>
              <div className="n">·</div>
              <div className="t">
                <b>Self-hosted, self-deploying.</b> Docker / Helm + SSO. Contract to coverage in two weeks.
                No integration fees, no consulting bundles.
              </div>
              <div className="n">·</div>
              <div className="t">
                <b>Optional add-ons</b> — feature requests on actuals at €{o.featureRate}/h, and Datacore Enterprise in Q3/Q4 2026 — sit outside the recurring line and are contracted separately.
              </div>
            </div>

            <div className="p-callout" style={{marginTop:20}}>
              <b>Founding Partner terms.</b> {fmtPct(o.discount*100)} off list, guaranteed for life. €{o.monthlySub.toLocaleString()}/month covers your first {o.seats} seats — that's the minimum whether you activate 10 or {o.seats}. Additional seats at €{o.fpPrice}/seat, same rate. Same terms apply to Datacore Enterprise when it is scoped together later in the year.
            </div>
          </div>
        </div>
      </Page>

      {/* ==================================================== PAGE 3 — SCOPE / THE SYSTEM */}
      <Page num="03" total={TOTAL}>
        <div style={{display:'grid', gridTemplateColumns:'160px 1fr', gap:24}}>
          <div>
            <div className="p-mono p-blue">§ 02</div>
            <div className="p-mono" style={{marginTop:4}}>Scope<br/>&amp; system</div>
          </div>
          <div>
            <div className="p-h1">What is shipped, in detail.</div>
            <div className="p-body-lg" style={{marginTop: 16, maxWidth: 580}}>
              PLUR Enterprise is a self-hosted, multi-user memory platform.
              It slots in between engineers, their agents, and the codebase.
              Every interaction with the system is scoped, logged, and reversible.
            </div>
          </div>
        </div>

        <div className="p-divider" style={{margin: '24px 0 18px'}}></div>

        <div className="p-h3" style={{marginBottom: 14}}>§ 02.1 · Included in the subscription</div>
        <table className="p-table">
          <thead>
            <tr>
              <th style={{width:28}}>#</th>
              <th>Capability</th>
              <th>What it does</th>
              <th>Surface</th>
            </tr>
          </thead>
          <tbody>
            {[
              ['PLUR server', 'HTTP/SSE MCP gateway, multi-user, multi-tenant', 'MCP clients'],
              ['Knowledge graph', 'PostgreSQL + Apache AGE — graph over conventions, decisions, entities', 'SQL + GraphQL'],
              ['Semantic memory', 'pgvector — embedding store, native SQL', 'SQL + API'],
              ['Correction learning', 'Every review / revert / rewrite becomes a first-class signal', 'Pipeline'],
              ['SSO', 'OIDC / OAuth2 + PKCE against your IdP', 'Your IdP'],
              ['Access control', 'Scope-based + role-based; per project, per group', 'Admin'],
              ['MCP tool security', 'Tool allowlist, write enforcement, signed audit log', 'Admin'],
              ['Admin dashboard', 'Usage, health, audit — for IT and compliance', 'Web UI'],
              ['Ops', 'TLS, CI/CD, monitoring, alerting — operated by Datafund', 'Managed'],
              ['Maintenance', 'Security patches, dependency updates, platform upgrades', 'Managed'],
              ['Support SLA', 'Priority bug fixes · <24h response · <72h resolution', 'Contract'],
              ['Cadence', 'Weekly check-in + quarterly strategic review', 'Partnership'],
            ].map(([cap, what, surface], i) => (
              <tr key={i}>
                <td style={{color:'var(--df-fg-muted)'}}>{String(i+1).padStart(2,'0')}</td>
                <td><b style={{color:'var(--df-fg-1)'}}>{cap}</b></td>
                <td className="p-body" style={{fontSize:11}}>{what}</td>
                <td className="p-mono">{surface}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Page>

      {/* ==================================================== PAGE 4 — ARCHITECTURE */}
      <Page num="04" total={TOTAL}>
        <div style={{display:'grid', gridTemplateColumns:'160px 1fr', gap:24}}>
          <div>
            <div className="p-mono p-blue">§ 03</div>
            <div className="p-mono" style={{marginTop:4}}>Architecture</div>
          </div>
          <div>
            <div className="p-h1">Self-hosted. Standard parts.<br/>Your infrastructure stays yours.</div>
          </div>
        </div>

        <div className="p-divider" style={{margin:'24px 0 16px'}}></div>

        <ArchDiagram/>

        <div style={{display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:24, marginTop:32}}>
          <div>
            <div className="p-mono p-blue">§ 03.1 · Data residency</div>
            <div className="p-body" style={{marginTop:8}}>
              Deployment on your infrastructure. Source code, graph
              data and prompts never leave your network. LLM routing is
              yours — self-hosted, regional-EU, or commercial — through a
              gateway we configure with you.
            </div>
          </div>
          <div>
            <div className="p-mono p-blue">§ 03.2 · Stack</div>
            <div className="p-body" style={{marginTop:8}}>
              PostgreSQL, Apache AGE, pgvector, Docker, Linux, OIDC. No
              proprietary runtime, no exotic vector database. Your ops team
              reviews it in an afternoon.
            </div>
          </div>
          <div>
            <div className="p-mono p-blue">§ 03.3 · Controls</div>
            <div className="p-body" style={{marginTop:8}}>
              Scope + role access, tool allowlist, write enforcement,
              tamper-evident audit log. Maps cleanly to your existing
              security controls.
            </div>
          </div>
        </div>
      </Page>

      {/* ==================================================== PAGE 5 — PACK ECONOMICS */}
      <Page num="05" total={TOTAL}>
        <div style={{display:'grid', gridTemplateColumns:'160px 1fr', gap:24}}>
          <div>
            <div className="p-mono p-blue">§ 04</div>
            <div className="p-mono" style={{marginTop:4}}>Pack<br/>economics</div>
          </div>
          <div>
            <div className="p-h1">Why agents will pay for memory.</div>
            <div className="p-body-lg" style={{marginTop: 16, maxWidth: 620}}>
              Every agent task today burns API tokens rebuilding the same context — tool schemas, your conventions, prior decisions — from scratch. A pack ships that context once. Loaded once, used forever.
            </div>
          </div>
        </div>

        <div className="p-divider" style={{margin:'24px 0 18px'}}></div>

        <div className="p-h3" style={{marginBottom: 14}}>§ 04.1 · Measured per-task savings (frontier APIs)</div>
        <table className="p-table">
          <thead>
            <tr>
              <th>Workload</th>
              <th className="num">Without pack</th>
              <th className="num">With pack</th>
              <th className="num">Saving</th>
            </tr>
          </thead>
          <tbody>
            {[
              ['Sonnet 4.6 median task',        '$1.48', '$0.45', '69%'],
              ['Opus 4.7 median task',          '$7.42', '$2.27', '69%'],
              ['Floor (input rebuild alone)',   '$0.22', '—',     '—'],
            ].map(([wl, w, wp, sv], i) => (
              <tr key={i}>
                <td><b>{wl}</b></td>
                <td className="num p-mono">{w}</td>
                <td className="num p-mono">{wp}</td>
                <td className="num p-mono">{sv}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:24, marginTop:28}}>
          <div>
            <div className="p-mono p-blue">§ 04.2 · The formula</div>
            <div className="p-mono" style={{marginTop:8, fontSize:13, padding:'10px 14px', background:'var(--df-bg-2, #F4F4F7)', borderRadius:2}}>
              pack_value = cost_without − cost_with − pack_price
            </div>
            <div className="p-body" style={{marginTop:10}}>
              If <b>pack_value &gt; 0</b>, the pack should have been installed. Even the irreducible floor ($0.22 of input rebuild) already exceeds the pack price.
            </div>
          </div>
          <div>
            <div className="p-mono p-blue">§ 04.3 · The reframe that matters</div>
            <div className="p-h2" style={{marginTop:8}}>3.3× more tasks per dollar.</div>
            <div className="p-body" style={{marginTop:8}}>
              The number that survives model price changes. Composes with whatever budget finance approved. At 10,000 Opus tasks/month → <b>~$51,500/month measurable saving</b>. The pack costs less than one task.
            </div>
          </div>
        </div>

        <div className="p-body" style={{marginTop:18, fontSize:11, color:'var(--df-fg-muted)'}}>
          Source: Bai et al. (2026) — agents reasoning from scratch consume an order of magnitude more tokens than agents working from pre-loaded knowledge.
        </div>
      </Page>

      {/* ==================================================== PAGE 6 — PRICING (PRIMARY + OPTION) */}
      <Page num="06" total={TOTAL}>
        <div style={{display:'grid', gridTemplateColumns:'160px 1fr', gap:24}}>
          <div>
            <div className="p-mono p-blue">§ 05</div>
            <div className="p-mono" style={{marginTop:4}}>Pricing</div>
          </div>
          <div>
            <div className="p-h1">€{o.fpPrice} / seat / month.<br/>Founding Partner rate, guaranteed for life.</div>
            <div className="p-body-lg" style={{marginTop:12, maxWidth:620}}>
              Subscription is the only recurring line. Managed operations, support, maintenance, platform upgrades — all included. Infrastructure and AI tokens are paid directly to your provider.
            </div>
          </div>
        </div>

        <div className="p-divider" style={{margin:'24px 0 20px'}}></div>

        {/* Primary price block */}
        <div style={{display:'grid', gridTemplateColumns:'auto 1fr', gap:32, alignItems:'end'}}>
          <div>
            <div className="p-mono">Founding Partner rate</div>
            <div style={{fontSize:96, lineHeight:1, fontWeight:700, letterSpacing:'-0.03em'}} className="p-blue">
              €{o.fpPrice}
            </div>
            <div className="p-mono">per seat · per month · {o.seats} seats · {fmtPct(o.discount*100)} off list</div>
          </div>
          <div style={{borderLeft:'1px solid rgba(0,0,0,0.15)', paddingLeft:24}}>
            <table className="p-table" style={{fontSize:12}}>
              <tbody>
                <tr><td className="p-mono">List price per seat</td><td className="num">€{o.list}/mo</td></tr>
                <tr><td className="p-mono">Founding Partner discount</td><td className="num">{fmtPct(o.discount*100)}</td></tr>
                <tr><td className="p-mono">Founding Partner per seat</td><td className="num" style={{color:'var(--df-blue)', fontWeight:700}}>€{o.fpPrice}/mo</td></tr>
                <tr><td className="p-mono">Seats (minimum tier)</td><td className="num">{o.seats}</td></tr>
                <tr className="grand"><td>Minimum monthly commitment</td><td className="num">{fmtEUR(o.monthlySub)}<span className="p-mono" style={{fontWeight:400}}>/mo</span></td></tr>
                <tr><td className="p-mono">Commitment</td><td className="num">{o.commitment} months from go-live</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <div className="p-divider" style={{margin:'28px 0 18px'}}></div>

        <div className="p-h3" style={{marginBottom:12}}>§ 05.1 · Market context (monthly, per seat)</div>
        <table className="p-table p-compare">
          <thead>
            <tr>
              <th>Product</th>
              <th className="num">Price / seat / mo</th>
              <th>Memory</th>
              <th>Correction-based learning</th>
              <th>Self-hosted</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>GitHub Copilot Enterprise</td><td className="num">$39–60</td><td>28-day window</td><td>No</td><td>No</td></tr>
            <tr><td>Augment Code Standard</td><td className="num">$60</td><td>Project-scoped</td><td>No</td><td>No</td></tr>
            <tr><td>Sourcegraph Cody Enterprise</td><td className="num">$59</td><td>None (search)</td><td>No</td><td>Yes (Ent.)</td></tr>
            <tr><td>JetBrains AI Enterprise</td><td className="num">$60+</td><td>None</td><td>No</td><td>No</td></tr>
            <tr className="highlight">
              <td className="mark">PLUR Enterprise · list</td>
              <td className="num mark">€{o.list}</td>
              <td>Persistent graph + semantic</td>
              <td className="mark">Yes</td>
              <td className="mark">Yes</td>
            </tr>
            <tr className="highlight">
              <td className="mark">PLUR · Founding Partner</td>
              <td className="num mark">€{o.fpPrice}</td>
              <td>Same</td>
              <td className="mark">Yes</td>
              <td className="mark">Yes</td>
            </tr>
          </tbody>
        </table>

        <div className="p-divider" style={{margin:'28px 0 18px'}}></div>

        {/* Metered option — smaller, below */}
        <div style={{padding:'18px 22px', border:'1px solid var(--df-border, #D0D5DD)', borderRadius:2, background:'rgba(0,0,0,0.015)'}}>
          <div style={{display:'grid', gridTemplateColumns:'1fr auto', alignItems:'center', gap:24}}>
            <div>
              <div className="p-mono p-blue" style={{marginBottom:6}}>§ 05.2 · Or, by request — metered pricing</div>
              <div className="p-h3" style={{marginBottom:8}}>Pay-for-outcomes alternative.</div>
              <div className="p-body" style={{fontSize:12, lineHeight:1.6}}>
                For organisations whose CFO wants pay-for-outcomes pricing tied directly to measured API spend reduction:
                <b> {o.meteredSavingsPct}% of measured API savings, €{o.meteredFloor}/month floor, no cap.</b> BYOK — your gateway, your keys, signed receipts each month.
                Ships in Founding Partner Beta through Q3 2026; reverts to standard €{o.fpPrice}/seat Flat if the methodology is not co-signed in the first 30 days.
              </div>
            </div>
            <div style={{textAlign:'right', minWidth:170}}>
              <div className="p-mono" style={{fontSize:10, color:'var(--df-fg-muted)'}}>floor / no cap</div>
              <div style={{fontSize:36, lineHeight:1, fontWeight:700, letterSpacing:'-0.02em', marginTop:4}}>
                {o.meteredSavingsPct}<span style={{fontSize:18, fontWeight:500}}>%</span>
              </div>
              <div className="p-mono" style={{fontSize:10, color:'var(--df-fg-muted)'}}>of measured savings</div>
              <div className="p-mono" style={{fontSize:10, color:'var(--df-fg-muted)', marginTop:6}}>min €{o.meteredFloor}/mo</div>
            </div>
          </div>
        </div>

        <div className="p-callout" style={{marginTop: 18}}>
          <b>The Founding Partner rate is guaranteed for life.</b>{' '}
          €{o.monthlySub.toLocaleString()}/month is the minimum on Flat — it covers {o.seats} seats whether you activate 10 or {o.seats}.
          Additional seats added at €{o.fpPrice}/seat, no renegotiation. The guarantee extends to every future
          PLUR and Datacore product.
        </div>
      </Page>

      {/* ==================================================== PAGE 7 — TIMELINE */}
      <Page num="07" total={TOTAL}>
        <div style={{display:'grid', gridTemplateColumns:'160px 1fr', gap:24}}>
          <div>
            <div className="p-mono p-blue">§ 06</div>
            <div className="p-mono" style={{marginTop:4}}>Timeline<br/>&amp; milestones</div>
          </div>
          <div>
            <div className="p-h1">From contract to coverage<br/>in two weeks.</div>
            <div className="p-body-lg" style={{marginTop:12, maxWidth:600}}>
              The product self-deploys. There is no integration consulting engagement.
            </div>
          </div>
        </div>

        <div className="p-divider" style={{margin:'24px 0 20px'}}></div>

        <div style={{fontSize:11, border:'1px solid rgba(0,0,0,0.15)'}}>
          <div style={{display:'grid', gridTemplateColumns:'200px repeat(6, 1fr)', borderBottom:'1px solid rgba(0,0,0,0.15)', background:'#F6F6F6'}}>
            <div style={{padding:'8px 10px'}} className="p-mono">Workstream</div>
            {['Day 1','Day 3','Day 7','Day 14','Month 2','Q3/Q4'].map((m, i) => (
              <div key={i} style={{padding:'8px 6px', borderLeft:'1px solid rgba(0,0,0,0.08)', textAlign:'center'}} className="p-mono">{m}</div>
            ))}
          </div>
          {[
            ['Contract & kick-off',                    [1,0,0,0,0,0], '#8A8AFF'],
            ['Self-service deployment (Docker / Helm + SSO)', [1,1,0,0,0,0], 'var(--df-blue)'],
            ['First 5 users smoke-test in sandbox',    [0,1,1,0,0,0], 'var(--df-blue)'],
            ['Rollout to wider team',                  [0,0,1,1,0,0], 'var(--df-blue)'],
            ['Go-live · subscription starts',          [0,0,0,1,0,0], '#0000B3'],
            ['Steady-state cadence (weekly + quarterly)', [0,0,0,0,1,0], '#8A8AFF'],
            ['Datacore Enterprise — scoped together',  [0,0,0,0,0,1], '#8A8AFF'],
          ].map(([label, cells, col], i) => (
            <div key={i} style={{display:'grid', gridTemplateColumns:'200px repeat(6, 1fr)', borderBottom: i<6 ? '1px solid rgba(0,0,0,0.06)': 'none'}}>
              <div style={{padding:'10px 10px', fontSize:11}}><b>{label}</b></div>
              {cells.map((c, j) => (
                <div key={j} style={{padding:6, borderLeft:'1px solid rgba(0,0,0,0.06)', display:'flex', alignItems:'center', justifyContent:'center', minHeight:28}}>
                  {c ? <div style={{height:10, width:'100%', background:col, borderRadius:1}}></div> : null}
                </div>
              ))}
            </div>
          ))}
        </div>

        <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:24, marginTop:20}}>
          <div className="p-callout">
            <b>No charges before go-live.</b> Deployment and the first 14 days of evaluation are free.
            If go-live doesn't happen by day 30, the contract lapses with no obligation.
          </div>
          <div className="p-callout" style={{borderLeftColor:'#8A8AFF'}}>
            <b>Q3/Q4 2026 — Datacore Enterprise.</b> Scoped together once the
            memory layer is producing. Priced on same Founding Partner terms.
          </div>
        </div>
      </Page>

      {/* ==================================================== PAGE 8 — ROI */}
      <Page num="08" total={TOTAL}>
        <div style={{display:'grid', gridTemplateColumns:'160px 1fr', gap:24}}>
          <div>
            <div className="p-mono p-blue">§ 07</div>
            <div className="p-mono" style={{marginTop:4}}>Return on<br/>investment</div>
          </div>
          <div>
            <div className="p-h1">The subscription pays for itself<br/>in the first month of use.</div>
          </div>
        </div>

        <div className="p-divider" style={{margin:'24px 0 18px'}}></div>

        <div className="p-callout" style={{marginBottom:24}}>
          Every developer recovers ≈ <b>€{o.monthlyRecoveredPerDev} of time</b> a month. PLUR costs
          <b> €{o.fpPrice} / dev / month</b>. Everything else — faster onboarding, fewer repeated mistakes,
          higher agent accuracy — is upside.
        </div>

        <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:36}}>
          <div>
            <div className="p-h3" style={{marginBottom:8}}>Per-developer math (monthly)</div>
            <table className="p-table">
              <tbody>
                <tr><td className="p-mono">Time recovered / dev / day</td><td className="num">15 min</td></tr>
                <tr><td className="p-mono">Working days / month</td><td className="num">~18</td></tr>
                <tr><td className="p-mono">Blended hourly value</td><td className="num">€70</td></tr>
                <tr className="sum">
                  <td>Recovered value / dev / month</td>
                  <td className="num">≈ €{o.monthlyRecoveredPerDev}</td>
                </tr>
                <tr className="grand">
                  <td>PLUR cost / dev / month</td>
                  <td className="num">€{o.fpPrice}</td>
                </tr>
                <tr>
                  <td className="p-mono">Payback per developer</td>
                  <td className="num">within the first month</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div>
            <div className="p-h3" style={{marginBottom:8}}>Context</div>
            <div className="p-body-lg">
              McKinsey puts developer time spent searching for information at
              <b> 1.8 hours / day</b>. GitHub reports context-switching costs
              engineering organisations an average of <b>~€50,000 per developer per year</b>.
            </div>
            <div className="p-body" style={{marginTop:12}}>
              We model <b>15 minutes / day</b> — roughly an eighth of McKinsey's
              number. Even at that level the subscription pays for itself
              in the first month of use, before the memory layer has had
              time to compound.
            </div>
            <div className="p-callout" style={{marginTop:14}}>
              <b>Upside not modelled.</b> Faster onboarding, higher agent success rates, and — for metered customers — measurable API spend recovery (see § 04).
            </div>
          </div>
        </div>
      </Page>

      {/* ==================================================== PAGE 9 — OPTIONAL ADD-ONS */}
      <Page num="09" total={TOTAL}>
        <div style={{display:'grid', gridTemplateColumns:'160px 1fr', gap:24}}>
          <div>
            <div className="p-mono p-blue">§ 08</div>
            <div className="p-mono" style={{marginTop:4}}>Optional<br/>add-ons</div>
          </div>
          <div>
            <div className="p-h1">The subscription stands on its own.</div>
            <div className="p-body-lg" style={{marginTop:12, maxWidth:600}}>
              Two optional add-ons are available outside the recurring line. Each is contracted and approved on its own — no bundling, no surprises.
            </div>
          </div>
        </div>

        <div className="p-divider" style={{margin:'24px 0 18px'}}></div>

        <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:28}}>
          <div>
            <div className="p-mono p-blue">§ 08.1 · Feature requests</div>
            <div className="p-h3" style={{marginTop:8}}>Billed on actuals.</div>
            <div className="p-body" style={{marginTop:10}}>
              Custom feature requests — new MCP tools, custom ingestion adapters, bespoke admin views, dashboard integrations — are scoped and billed on actuals at <b>€{o.featureRate}/h</b>, with monthly cap negotiated per request.
            </div>
            <ul className="p-body" style={{marginTop:10, paddingLeft:18, lineHeight:1.55}}>
              <li>No fixed-price risk premium.</li>
              <li>Invoiced monthly against real hours.</li>
              <li>Roadmap-aligned features (benefit all customers) ship at no charge.</li>
              <li>Customer-specific features ship behind a feature flag; open-sourcing on mutual agreement.</li>
            </ul>
          </div>

          <div>
            <div className="p-mono p-blue">§ 08.2 · Datacore Enterprise (Q3/Q4 2026)</div>
            <div className="p-h3" style={{marginTop:8}}>AI Development Team.</div>
            <div className="p-body" style={{marginTop:10}}>
              Available Q3/Q4 2026. Scoped together once the memory layer is producing. Founding Partner {fmtPct(o.discount*100)} discount applies on the same terms.
            </div>
            <table className="p-table" style={{marginTop:10}}>
              <thead><tr><th>AI role</th><th>Description</th><th className="num">€/mo (indicative)</th></tr></thead>
              <tbody>
                <tr><td><b>AI Chief of Staff</b></td><td>Org-wide operational intelligence.</td><td className="num">€800</td></tr>
                <tr><td><b>Insight Agent</b></td><td>Proactive pattern detection across repos.</td><td className="num">€600</td></tr>
                <tr><td><b>Onboarding Companion</b></td><td>Interactive buddy for new developers.</td><td className="num">€400</td></tr>
              </tbody>
            </table>
            <div className="p-body" style={{marginTop:8, fontSize:11, color:'var(--df-fg-muted)'}}>
              Pricing is per AI role per month. Exact scope and commercials agreed in Q3/Q4 2026.
            </div>
          </div>
        </div>
      </Page>

      {/* ==================================================== PAGE 10 — FAQ + TERMS */}
      <Page num="10" total={TOTAL}>
        <div style={{display:'grid', gridTemplateColumns:'160px 1fr', gap:24}}>
          <div>
            <div className="p-mono p-blue">§ 09</div>
            <div className="p-mono" style={{marginTop:4}}>Frequently<br/>asked</div>
          </div>
          <div>
            <div className="p-h1">Questions before the first call.</div>
          </div>
        </div>

        <div className="p-divider" style={{margin:'20px 0 20px'}}></div>

        <FAQ items={FAQ_ITEMS}/>

        <div className="p-divider" style={{margin:'24px 0 14px'}}></div>
        <div className="p-h3" style={{marginBottom:10}}>§ 09.1 · Terms &amp; conditions</div>
        <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:'6px 24px'}}>
          {[
            'All prices exclude VAT.',
            `Flat subscription: ${o.commitment}-month commitment starting at go-live. €${o.monthlySub.toLocaleString()}/month minimum covers up to ${o.seats} seats; additional seats at €${o.fpPrice}/seat/month.`,
            `Metered (by request, Founding Partner Beta): ${o.commitment}-month commitment. ${o.meteredSavingsPct}% of measured API savings, €${o.meteredFloor}/month floor, no cap. Methodology co-signed in first 30 days or reverts to Flat €${o.fpPrice}/seat.`,
            'Founding Partner rate is guaranteed for life — best-rate clause binding. Applies to whichever pricing model is selected.',
            `Feature requests (§ 08.1) invoiced monthly on actuals at €${o.featureRate}/h. No fixed-price premium.`,
            'Datacore Enterprise scoped and priced together in Q3/Q4 2026.',
            'IP: customer owns all extracted knowledge; Datafund retains IP in the PLUR platform.',
            'Deployment phase is free — no subscription charges before go-live (typically day 14).',
            'Infrastructure (hosting, hardware) and AI token costs are not included in the subscription.',
          ].map((t, i) => (
            <div key={i} style={{display:'grid', gridTemplateColumns:'22px 1fr', gap:8}}>
              <span className="p-mono p-blue">{String(i+1).padStart(2,'0')}</span>
              <span className="p-body" style={{fontSize:11}}>{t}</span>
            </div>
          ))}
        </div>
      </Page>

      {/* ==================================================== PAGE 11 — ACCEPTANCE */}
      <Page num="11" total={TOTAL}>
        <div style={{display:'grid', gridTemplateColumns:'160px 1fr', gap:24}}>
          <div>
            <div className="p-mono p-blue">§ 10</div>
            <div className="p-mono" style={{marginTop:4}}>Commercials<br/>&amp; acceptance</div>
          </div>
          <div>
            <div className="p-h1">Let's start the Founding Partnership.</div>
            <div className="p-body-lg" style={{marginTop:12, maxWidth:580}}>
              One recurring line for the subscription. Optional feature-request engagements invoiced on actuals when scoped.
            </div>
          </div>
        </div>

        <div className="p-divider" style={{margin:'24px 0 14px'}}></div>

        <table className="p-table">
          <thead>
            <tr>
              <th style={{width:28}}>#</th>
              <th>Line</th>
              <th>Basis</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="p-mono">A</td>
              <td><b>PLUR Enterprise subscription</b><br/><span className="p-mono" style={{color:'var(--df-fg-muted)'}}>{o.seats} seats included · €{o.fpPrice}/seat for additional · €{o.monthlySub.toLocaleString()}/mo minimum</span></td>
              <td className="p-body" style={{fontSize:11}}>Recurring · {o.commitment}-mo commitment</td>
              <td className="num">{fmtEUR(o.monthlySub)}<span className="p-mono" style={{fontWeight:400}}>/mo</span></td>
            </tr>
            <tr>
              <td className="p-mono">B</td>
              <td><b>Metered alternative (by request)</b><br/><span className="p-mono" style={{color:'var(--df-fg-muted)'}}>{o.meteredSavingsPct}% of measured savings · floor €{o.meteredFloor}/mo · no cap</span></td>
              <td className="p-body" style={{fontSize:11}}>Recurring · {o.commitment}-mo commitment</td>
              <td className="num p-mono">≥ €{o.meteredFloor}/mo</td>
            </tr>
            <tr>
              <td className="p-mono">C</td>
              <td><b>Feature requests (optional)</b><br/><span className="p-mono" style={{color:'var(--df-fg-muted)'}}>scoped per request · monthly cap negotiated</span></td>
              <td className="p-body" style={{fontSize:11}}>Optional · on actuals @ €{o.featureRate}/h</td>
              <td className="num p-mono">—</td>
            </tr>
          </tbody>
        </table>

        <div className="p-body" style={{marginTop:10, fontSize:11, color:'var(--df-fg-muted)'}}>
          All amounts exclude VAT. Customer selects A or, by request, B. C is optional and scoped separately when requested.
        </div>

        <div className="p-divider p-divider--blue" style={{margin:'28px 0 18px'}}></div>

        <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:32}}>
          <div>
            <div className="p-h3" style={{marginBottom:8}}>§ 10.1 · Acceptance</div>
            <div className="p-body">
              Reply to <a href="mailto:gregor@datafund.io">gregor@datafund.io</a> with the seat count and (optionally) request the metered alternative.
              We will send the Founding Partner contract within 48 hours and schedule the kick-off call.
            </div>
            <div className="p-body" style={{marginTop:14}}>
              <b>Next step — not a signature.</b> Reply <i>"let's talk"</i> and we
              schedule the first call. The full terms are negotiated in the
              Founding Partner contract, not here.
            </div>
          </div>
          <div>
            <div className="p-h3" style={{marginBottom:8}}>§ 10.2 · What the Founding Partner tier holds</div>
            <div className="p-body" style={{marginBottom:12}}>
              We are limiting the first PLUR Enterprise cohort to <b>five companies</b> who help shape the product. Beyond the headline discount, the partnership carries:
            </div>
            <div className="p-deflist" style={{gridTemplateColumns:'18px 1fr'}}>
              <div className="n">·</div><div className="t">Guaranteed best rate, for life.</div>
              <div className="n">·</div><div className="t">Influence on the product roadmap.</div>
              <div className="n">·</div><div className="t">White-label & reseller rights in your vertical.</div>
              <div className="n">·</div><div className="t">Same terms carry to Datacore Enterprise.</div>
              <div className="n">·</div><div className="t">Case study, co-authored, mutually approved.</div>
              <div className="n">·</div><div className="t">No subscription charges before go-live.</div>
            </div>
          </div>
        </div>
      </Page>
    </div>
  );
}

window.ProposalV2 = ProposalV2;
