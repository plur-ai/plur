# PLUR Enterprise — General Offer (Founding Partner)

This folder contains the **general (non-IGEA-specific)** version of the PLUR Enterprise offer. The IGEA version lives in the parent folder (`../`).

## Files

| File | Purpose |
|------|---------|
| `PLUR-Enterprise-Offer-General.md` | **Canonical offer content** — markdown, parameterised, includes pack economics + new business model |
| `README.md` | Original handoff README (from Claude Design) |
| `project/PLUR Enterprise Offer.html` | React-based interactive design prototype with tweak panel |
| `project/PLUR Enterprise Offer-print.html` | Print-optimised version |
| `project/proposal-v2.jsx` | The 9-section structured proposal (data-forward) |
| `project/proposal-shared.jsx` | Shared components, defaults, computeOffer() math |
| `project/design-canvas.jsx`, `tweaks-panel.jsx` | Design canvas + live tweak UI |
| `project/uploads/` | The originally-ingested IGEA-tailored markdown files |

## What's in the canonical markdown

`PLUR-Enterprise-Offer-General.md` is the **source of truth** for the general offer content. It is parameterised (no IGEA-specific numbers) and adds these sections beyond the IGEA version:

1. **Pack Economics — Why Agents Will Pay for Memory** — empirical numbers ($1.48 → $0.45 Sonnet, $7.42 → $2.27 Opus, 69% per-task savings, 65% headline, 3.3× framing)
2. **Two Editions. One Substrate.** — Enterprise (metered gateway) + Individual (local-first), privacy as constitutional moat
3. **The Three-Sided Market — How Your Org Earns From Contribution** — Data owners / Data buyers / Investors triangle, pioneer royalties for Founding Partners
4. **Updated Business Case** — adds direct API spend recovery via gateway alongside developer-time recovery
5. **Expanded FAQ** — gateway pricing, pioneer royalties, relationship between Enterprise and consumer edition

## JSX prototype — synced 2026-05-12

The React prototype is now in sync with the canonical markdown. Page count bumped from 11 to **14** (TOTAL constant) with three new sections inserted between Architecture (§ 03) and Subscription Pricing:

- **Page 5 / § 04 · Pack economics** — empirical table, formula, 3.3× framing, gateway callout
- **Page 6 / § 05 · Two editions. One substrate.** — Enterprise vs Individual side-by-side, privacy moat
- **Page 7 / § 06 · Three-sided market** — Data owners / Data buyers / Investors, pioneer royalties for Founding Partners

Existing pages 5–11 renumbered to 8–14 (Subscription pricing → Acceptance). Three new FAQ items added to `proposal-shared.jsx` (gateway, royalties, consumer-edition relationship).

To open the prototype: open `project/PLUR Enterprise Offer.html` in a browser. The Tweaks panel (right side) controls client name, scope, pricing, brand color live. For PDF export, use the "Open for print / PDF" button which loads `?print=v2`.

The default tweak values (`__PROPOSAL_DEFAULTS__` in `proposal-shared.jsx`) already match the general offer:

```js
seats: 50, listPrice: 50, discountPct: 30, // → €35 FP
consultingRate: 85, commitmentMonths: 12,
totalRepos: 1400, activeRepos: 30, // placeholders — change per client
brandColor: '#0000FF'
```

## Context

**Audience:** AI-native organisations, developer services companies, regulated enterprises. Anywhere agents do repetitive work and the API bill shows it.

**Two products from one company:**
- **PLUR Enterprise** = Organisational Learning subscription (this offer)
- **Datacore Enterprise** = AI Development Team (future, Q3/Q4) — Chief of Staff, Insight Agent, Onboarding Companion

**Headline framing:** *Models commoditise. Knowledge doesn't.*

**Pricing defence:** €35/seat Founding Partner sits below GitHub Copilot Enterprise ($39–60), Augment ($60), Sourcegraph Cody Enterprise ($59), JetBrains AI ($60+). None has correction-based learning + organisational knowledge sharing + privacy-preserving architecture.

**Negotiation notes (internal):**
- 30% is the opening. Budget for 35–40% as acceptable outcome if pushed
- "No charges before go-live" is a concession card — use when they push on commitment length
- Knowledge Engineering has no discount — it's custom work at standard rate
- Founding Partner = guaranteed best rate (MFN-equivalent without the jargon)
- Optional gateway pricing is a win-only path — only invoice when measured savings show up

## Design Direction

- Clean, developer-friendly aesthetic
- Typography-driven, no stock photos
- Architecture diagrams, not illustrations
- Primary: Datafund blue (#0000FF), accent configurable via tweak panel
- All materials in English (localised versions on request)
