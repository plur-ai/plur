# @plur-ai/core

The engram engine — store, recall, and inject AI memory. Local-first, zero API calls for search, plain YAML storage.

```bash
npm install @plur-ai/core
```

```typescript
import { Plur } from '@plur-ai/core'

const plur = new Plur()

// Learn from a correction
plur.learn('toEqual() in Vitest is strict — use toMatchObject() for partial matching', {
  type: 'behavioral',
  scope: 'project:my-app',
  domain: 'dev/testing'
})

// Recall (hybrid: BM25 + embeddings via RRF, zero cost)
const results = await plur.recallHybrid('vitest assertion matching')

// Inject relevant engrams into agent context
const { directives, consider, count, tokens_used } = plur.inject('Write tests for the user service', {
  scope: 'project:my-app',
  budget: 2000
})

// Feedback trains the system
plur.feedback(results[0].id, 'positive')

// Sync across machines
plur.sync('git@github.com:you/plur-memory.git')
```

## API

### `new Plur(options?)`

```typescript
const plur = new Plur({ path: '/custom/storage/path' })
```

Defaults to `~/.plur/`. Override with `PLUR_PATH` env var or `options.path`.

### `learn(statement, context?)`

Create an engram. Detects conflicts with existing engrams in the same scope.

```typescript
plur.learn('Always run lint before committing', {
  type: 'behavioral',       // behavioral | architectural | procedural | terminological
  scope: 'project:myapp',   // namespace for filtering
  domain: 'software.git',   // dot-separated domain tag
  source: 'user-correction',
})
```

### Search methods

Five search modes, from fastest to most accurate:

| Method | Speed | API calls | Best for |
|--------|-------|-----------|----------|
| `recall(query)` | Instant | None | Quick keyword lookup |
| `recallSemantic(query)` | ~200ms | None | Meaning-based search (local embeddings) |
| `recallHybrid(query)` | ~200ms | None | **Best default** — BM25 + embeddings via RRF |
| `recallAsync(query, { llm })` | ~1s | 1 LLM call | LLM-assisted semantic filtering |
| `recallExpanded(query, { llm })` | ~3s | 3-5 LLM calls | Query expansion + hybrid + RRF merge |

All accept the same options:

```typescript
const results = await plur.recallHybrid('deployment process', {
  scope: 'project:myapp',  // includes global + matching scopes
  domain: 'software',       // prefix match
  limit: 10,
  min_strength: 0.5,
})
```

### `inject(task, options?)`

Select and score engrams within a token budget. Returns formatted strings ready to prepend to a system prompt.

```typescript
const { directives, consider, count, tokens_used } = plur.inject('refactor the auth module', {
  budget: 2000,
  scope: 'project:myapp',
})
```

### `feedback(id, signal)`

Rate an engram's usefulness. Trains injection relevance over time.

```typescript
plur.feedback('ENG-001', 'positive')   // +0.05 retrieval strength
plur.feedback('ENG-002', 'negative')   // -0.10 retrieval strength
```

### `forget(id, reason?)`

Retire an engram. History preserved, excluded from recall and injection.

```typescript
plur.forget('ENG-001', 'API changed')
```

### `sync(remote?)`

Git-based sync across machines. Initializes on first call, commits + push/pull on subsequent calls.

```typescript
// First time — init repo and push
plur.sync('git@github.com:you/plur-memory.git')

// Later — commit, pull, push
plur.sync()
```

```typescript
// Check sync status (no changes made)
const status = plur.syncStatus()
// { initialized, remote, dirty, branch, ahead, behind }
```

### `capture(summary, context?)` / `timeline(query?)`

Episodic memory — record what happened, query the timeline.

```typescript
plur.capture('Deployed v2.0 to production', {
  agent: 'claude-code',
  session_id: 'abc123',
  tags: ['deploy'],
})

const episodes = plur.timeline({ since: new Date('2025-01-01'), agent: 'claude-code' })
```

### `ingest(content, options?)`

Extract engram candidates from text using pattern matching.

```typescript
const candidates = plur.ingest(markdownContent, {
  extract_only: true,  // preview without saving
  scope: 'project:myapp',
  source: 'docs/architecture.md',
})
```

### `installPack(source)` / `exportPack(...)` / `listPacks()`

Share engram collections between agents or users.

```typescript
plur.installPack('/path/to/pack-directory')
const packs = plur.listPacks()
plur.exportPack(engrams, './output', { name: 'my-pack', version: '1.0.0' })
```

### `status()`

```typescript
const { engram_count, episode_count, pack_count, storage_root, config } = plur.status()
```

## Storage

Everything is plain YAML. Open it, read it, edit it.

```
~/.plur/
├── engrams.yaml     # learned knowledge
├── episodes.yaml    # session timeline
├── candidates.yaml  # pending engrams
├── config.yaml      # settings
└── packs/           # installed engram packs
```

## License

Apache-2.0
