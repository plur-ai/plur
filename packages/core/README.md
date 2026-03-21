# @plur-ai/core

The engram engine — store, recall, and inject AI memory.

```bash
npm install @plur-ai/core
```

```typescript
import { Plur } from '@plur-ai/core'

const plur = new Plur()
plur.learn('API uses snake_case', { scope: 'project:myapp', type: 'architectural' })
const injection = plur.inject('fix the endpoint handler', { budget: 2000 })
console.log(injection.directives) // injected context, ready to prepend
```

## API

### `new Plur(options?)`

```typescript
const plur = new Plur({ path: '/custom/storage/path' })
```

Defaults to `~/Plur/`. Override with `PLUR_PATH` env var or `options.path`.

### `learn(statement, context?)`

Create an engram. Returns the created `Engram`.

```typescript
plur.learn('Always run lint before committing', {
  type: 'behavioral',       // behavioral | architectural | procedural | terminological
  scope: 'project:myapp',   // namespace for filtering
  domain: 'software.git',   // dot-separated domain tag
  source: 'user-correction',
})
```

### `recall(query, options?)`

Search engrams by keyword/phrase. Returns `Engram[]`, reactivates accessed engrams.

```typescript
const results = plur.recall('deployment process', {
  scope: 'project:myapp',  // includes global + matching scopes
  domain: 'software',
  limit: 10,
  min_strength: 0.5,
})
```

### `inject(task, options?)`

Select and score engrams within a token budget. Returns directives and considerations as formatted strings, ready to inject into a system prompt.

```typescript
const { directives, consider, count, tokens_used } = plur.inject('refactor the auth module', {
  budget: 2000,
  scope: 'project:myapp',
})
```

### `feedback(id, signal)`

Rate an engram's usefulness. Adjusts retrieval strength over time.

```typescript
plur.feedback('ENG-001', 'positive')   // +0.05 retrieval strength
plur.feedback('ENG-002', 'negative')   // -0.10 retrieval strength
plur.feedback('ENG-003', 'neutral')    // signal recorded, no strength change
```

### `forget(id, reason?)`

Retire an engram. Sets status to `retired` — history is preserved, engram is excluded from recall and injection.

```typescript
plur.forget('ENG-001', 'API changed')
```

### `capture(summary, context?)`

Append an episode to the episodic timeline.

```typescript
plur.capture('Deployed v2.0 to production', {
  agent: 'claude-code',
  session_id: 'abc123',
  channel: 'cli',
  tags: ['deploy', 'production'],
})
```

### `timeline(query?)`

Query the episodic timeline. Returns `Episode[]`.

```typescript
const episodes = plur.timeline({
  since: new Date('2025-01-01'),
  agent: 'claude-code',
  search: 'deploy',
})
```

### `ingest(content, options?)`

Extract engram candidates from text using pattern matching. Looks for phrases like "we decided", "always", "the convention is", etc.

```typescript
const candidates = plur.ingest(markdownContent, {
  extract_only: true,  // preview without saving
  scope: 'project:myapp',
  source: 'docs/architecture.md',
})
// set extract_only: false (default) to auto-save candidates as engrams
```

### `installPack(source)` / `exportPack(...)` / `listPacks()`

Share engram collections between agents or users.

```typescript
plur.installPack('/path/to/pack-directory')
const packs = plur.listPacks()
plur.exportPack(engrams, './output', { name: 'my-pack', version: '1.0.0' })
```

### `status()`

Return system health.

```typescript
const { engram_count, episode_count, pack_count, storage_root } = plur.status()
```

## License

MIT
