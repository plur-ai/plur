# Opt-in Engagement Telemetry — Design Proposal

**Status:** Proposal — open for community comment
**Target release:** v0.9.x
**Comment window:** 7 days from the date this doc lands on `main`

This document describes a proposed opt-in engagement telemetry mechanism for PLUR. No code has been written. We are publishing the design first, deliberately, to invite criticism before building. If blocking feedback surfaces during the comment window, the design will be revised or dropped.

## Why this exists

We need one specific signal we currently cannot get: **is PLUR being actively used after install, or is it install-and-forget?**

External signals we already have — PyPI download counts, GitHub stars, issues filed — cannot distinguish:

- **Active silent use** — engrams being written, `plur_recall` serving responses, user has no reason to open an issue
- **Install-and-forget** — package installed once, never invoked again

Both produce the same external footprint. Without a signal from inside the running instance, we cannot tell if growth in installs represents adoption or just curiosity.

## Design goals

1. **Privacy-first.** Opt-in, not opt-out. No content — ever. No user identity beyond a locally-generated opaque install UUID.
2. **Minimal.** One counter per tool call. No payloads, no traces, no stack. If it doesn't fit in a single small JSON record, it's overreaching.
3. **Trustworthy.** Source is open, endpoint is documented, the user can disable it with a single env var and see exactly what was sent.
4. **Load-bearing only.** The signal must be sufficient to distinguish active use from install-and-forget. Nothing more.

## What would be measured

**Primary metric: weekly learn rate per install.**

- A `learn` event fires when `plur_learn` returns success (engram persisted).
- A `recall` event fires when `plur_recall_hybrid` returns ≥1 hit.
- Counters aggregate locally and flush once per day (or on process exit) as a single record.

Record shape (exact fields, nothing else):

```json
{
  "install_id": "uuid-v4 generated on first run, stored in ~/.plur/install-id",
  "version": "0.9.2",
  "platform": "linux|darwin|win32",
  "date": "2026-04-21",
  "learn_count": 7,
  "recall_count": 23,
  "session_count": 2
}
```

**Explicitly excluded:** engram content, query text, file paths, hostnames, IP addresses (stripped at ingestion), organization names, pack names, error messages.

## Opt-in UX

Three doors, in priority order:

1. **First-run prompt** (interactive TTY only): after `plur init`, ask once: _"Help improve PLUR by sharing anonymous usage counts? No content, only counts. [y/N]"_ Default NO. Choice persists in `~/.plur/telemetry.json`.
2. **Env var override:** `PLUR_TELEMETRY=off|on` wins over saved preference.
3. **Config file:** `~/.plur/telemetry.json` — editable, documents every field sent.

Non-interactive installs (CI, Docker, bare `pip install`) default to OFF and never prompt. This means installs that never run `plur init` interactively get telemetry only if the user explicitly sets `PLUR_TELEMETRY=on` — **deliberately high friction**, because a smaller trusting cohort is worth more than a larger surveilled one.

## Transport

The endpoint will be a self-hosted HTTP collector (`POST /v1/heartbeat`) on infrastructure we operate, with IP address stripping at the ingress layer and basic rate limiting. No third-party analytics SaaS. The endpoint URL will be published in this doc before launch.

A public append-only gist alternative was considered for auditability; the self-hosted option was chosen for launch because it keeps operational complexity low. If auditability concerns surface during the comment window, we will reconsider.

## What we would do with the data

Thresholds measured over any 2-week window after v0.9.x launch:

- **Strong signal:** ≥30% of opted-in installs record ≥5 `learn` events _and_ ≥10 `recall` events per week for 2 consecutive weeks. Implies real second-brain use.
- **Mixed signal:** ≥50% record any `learn` or `recall`, but median activity is <2/week. Installed and poked, not adopted.
- **Weak signal:** <20% record any activity; median `session_count` <1/week. Install-and-forget.

Sample-size floor: no conclusion drawn below **≥30 opted-in installs**.

The outcome of this measurement shapes whether we invest further in the current distribution channel or shift emphasis to driving deeper engagement from the existing user base.

## Risks & tradeoffs

- **Optics.** "PLUR added telemetry" is a headline that burns trust regardless of design details. Mitigation: this doc lands publicly _before_ code, invites criticism, and commits to the strictest-defaults version. The eventual code PR will open with the opt-in UX, not the counter plumbing.
- **Selection bias.** The opted-in cohort skews toward engaged users by definition. Treat measurements as _existence_ tests ("does any real sustained use happen?"), not prevalence estimates for the full user base.
- **Zero-signal ambiguity.** If opt-in volume is too low to hit the sample floor, we learn nothing from telemetry and fall back to qualitative signals. That is an acceptable outcome — telemetry is one path among several, not the only one.

## Out of scope

- Knowledge-pack install attribution — separate question, separate future proposal.
- Dashboards and visualization — worry about those after data exists.
- Any form of content, query, or query-result capture — not now, not later, not behind a flag. A future feature that needs content would require its own separate opt-in decision.

## How to comment

Open a PR review, issue, or discussion on this repository referencing `docs/telemetry-design.md`. Blocking concerns (things that would require a redesign) are especially welcome. The comment window is 7 days from the date this doc merges to `main`. If the doc changes materially, the window resets.
