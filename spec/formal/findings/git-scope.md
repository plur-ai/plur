# Findings: GitScope (default scope from a repo's git `origin`, #1632) — 2026-10-18

Model: `spec/formal/PlurSpec/GitScope.lean`, covering `gitDefaultScope` in
`packages/core/src/git-origin.ts`. Checks with `lake build` (no sorry, admit, native_decide or
axiom declaration).

## G1. A default scope is only ever one the server listed for this exact project and host — HOLDS

- `scope_sound`: a `scope` outcome needs a parsed `origin`, and a source whose `gitlab_host` is
  set and matches the remote's host, whose cache is fresh, that lists the scope in `scopes`
  (not `pinned_scopes`) and maps it to exactly this project path (after the case fold). The
  outcome names that source's server.
- `scope_unique`: no other (scope, server) pair from a host-matching source maps the path. Two
  candidates are `unknown / ambiguous-mapping`, never a pick.
- `no_hit_no_scope`, `no_host_local`, `read_not_url_no_scope`: no mapping means no scope; no
  source on this GitLab means `local / not-company-gitlab`; anything but a parsed `origin`
  (not a repo, no remote, git unreadable, unparsable url) never yields a scope.
- Counterexample `pinned_counterexample`: reading `scopes ++ pinned_scopes` hands out a pinned,
  unlisted scope as the default; the fixed function answers `local / no-scope-for-project`.

## G2. A stale or missing cache is `unknown`, never a scope — HOLDS

- `problem_unknown`, `stale_never_scope`: one host-matching source with no `discovered_at`
  (`scopes-unavailable`), an unparsable one, one older than `DISCOVERY_MAX_AGE_MS` (7 days) or
  more than one day in the future (`cache-stale`) makes the whole answer `unknown`.
- `problem_absent`, `problem_unparsable`, `problem_too_old`, `problem_future`, `problem_fresh`:
  the boundaries. Exactly the maximum age is fresh; one more millisecond is stale (also pinned
  by the vitest case `exactly the maximum age is still fresh`).
- Counterexamples `stale_counterexample`, `future_counterexample`: without the freshness check, a
  40-day-old or future cache is trusted and yields a scope.

## Mutation check (each run with `lake env lean`, then restored)

| Mutation of the fixed function | Result |
|---|---|
| `hits` reads `scopes ++ pinned` | rejected: `scope_sound`, `no_hit_no_scope`, `pinned_counterexample` |
| `gds` skips the freshness check | rejected: `gds_url` (on which `scope_sound` and `problem_unknown` rest), `stale_counterexample`, `future_counterexample` |
| `pick` returns the first of two candidates | rejected: `pick_scope`, `pick_scope_mem`, `two_servers_ambiguous` |
| a source with no `gitlab_host` matches every host | rejected: `hostOk_iff` |
| a future `discovered_at` is not stale | rejected: `problem_too_old`, `problem_future`, `future_counterexample` |

## Left out

- The host comparison is an oracle `same`: the string rules (exact lower-case hostname, port
  only for http(s) when `gitlab_host` has one, canonical bracketed IPv6 via `isSafeHost`) are
  pinned by `packages/core/test/git-default-scope.test.ts`, not proved.
- Reading git, parsing the url and `loadGitScopeSources` are inputs to the model.
