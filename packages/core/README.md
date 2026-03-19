# @plur-ai/core

Engram engine for PLUR — persistent, learnable AI memory.

## Install

```bash
npm install @plur-ai/core
```

## Usage

```typescript
import { Plur } from '@plur-ai/core'

const plur = new Plur()

// Learn
const engram = plur.learn('Always validate inputs', { scope: 'global', type: 'behavioral' })

// Recall
const results = plur.recall('input validation')

// Inject — scored engrams within token budget
const injection = plur.inject('build the API', { budget: 2000, scope: 'project:myapp' })

// Feedback — train relevance
plur.feedback(engram.id, 'positive')

// Forget
plur.forget(engram.id, 'outdated')

// Episodic memory
plur.capture('Deployed v2.0', { agent: 'claude-code' })
const episodes = plur.timeline({ agent: 'claude-code' })

// Status
const status = plur.status()
```

## Storage

By default, PLUR stores data in `~/Plur/`. Override with `PLUR_PATH` env var or constructor option:

```typescript
const plur = new Plur({ path: '/custom/path' })
```

## License

MIT
