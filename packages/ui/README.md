# @plur-ai/ui — internal

**Not published.** This package is `private: true`. It holds the memory
viewer's pages, and it is bundled into `@plur-ai/cli` and `@plur-ai/dsh` at
build time (`noExternal: ['@plur-ai/ui']`) rather than shipped to npm.

Why: the viewer is the pages behind two commands, not a library anyone
installs. Publishing it would add a name, a version track, a publish-ordering
constraint and a support surface, to save ~45KB in each of two first-party
consumers. Extracting and publishing it later stays open; npm burns a name and
a version permanently, so this is the reversible direction.

**See what your agents remember.** Browse every engram, and find out which ones
are actually being used:

```bash
plur ui              # the CLI
/plur-memory         # inside DeepSeek Harness
```

Opens in your browser. Everything stays on your machine.

## What you get

**A browse view** over your whole store: statement, scope, status, recall count, creation date. Search by statement or ID. Select any row to read the full engram with its metadata.

**Two things worth knowing at a glance:**

- **Written** — engrams learned per day over the last month. Is memory still accumulating, or did it stop?
- **Most recalled** — what the agent actually pulls into context. This is the list that tells you whether memory is earning its place.

**And the number that matters most:** how many engrams have *never* been recalled. A store that only grows is a store nobody is reading, and it is the one failure a memory system can have while looking perfectly healthy by every other measure.

Recall follows a power law — in a real store, the busiest engram was recalled 594 times against a median of 4. Each row carries a log-scaled weight bar so that shape reads straight down the page, which a bare integer never does.

## Where it shows up

| Surface | How |
|---|---|
| Any machine with PLUR | `plur ui` |
| DeepSeek Harness | The **Memory** tab, via [`@plur-ai/dsh`](../dsh) |

Same renderer behind both.

## Using it as a library

The package is pure functions over engram rows — no framework, no bundler, no runtime dependencies. Give it rows, get HTML.

```ts
import { renderPage, renderBrowse } from '@plur-ai/ui'
import { Plur } from '@plur-ai/core'

const rows = await new Plur({}).list()
const html = renderPage({
  title: 'PLUR Memory',
  body: renderBrowse({ rows, query: { q: 'deploy' }, mode: 'top' }),
})
```

That is the whole integration. Serve the string, write it to a file, or hand it to a host's web shell.

### API

| Export | What it does |
|---|---|
| `renderPage({ title, body })` | Wraps a body in a complete, self-contained document |
| `renderBrowse({ rows, query, mode?, now?, action?, where? })` | The browse view. `mode` is `'top'` (default) or `'all'` |
| `filterEngrams(rows, query)` | Filter, sort and paginate — returns a page plus the total |
| `memoryStats(rows)` | Totals, recalled, never-recalled, distinct scopes |
| `topByRecall(rows, limit)` | Ranked by recall count, never-recalled excluded |
| `writtenPerDay(rows, days, now?)` | One entry per day, including empty ones |
| `recallCount(row)` / `createdOn(row)` | The two derived fields the views depend on |
| `htmlEscape(text)` | Escaping, exported so hosts can extend the markup safely |
| `CSS` | The stylesheet, if you are composing your own page |

## Design notes

**No JavaScript.** Expanding a record uses native `<details>`. That keeps the page identical whether it is served from a bare HTTP server or embedded in a host's web shell, makes it keyboard-operable for free, and means no bundler and no CSP exemption.

**Everything is escaped.** Engram statements are user data and people store code in their memory.

**Read-only.** Editing and retiring memory stays with the PLUR tools and CLI, where the confirmation and audit paths already live.

**Two fields you might expect are deliberately not used.** Recall comes from `activation.frequency`, not `injection_count` — the latter shipped in August 2026 and reports a store with months of history as almost entirely unread. Creation dates are parsed from the engram ID, not `temporal.learned_at`, which is optional and set on roughly one row in five thousand.

## Links

- [plur.ai](https://plur.ai) · [docs.plur.ai](https://docs.plur.ai)
- [github.com/plur-ai/plur](https://github.com/plur-ai/plur)

Apache-2.0
