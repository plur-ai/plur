# `@plur-ai/dsh` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a native DeepSeek Harness plugin that puts PLUR engrams directly into the model's system prompt every turn, with no tool call and no context accretion.

**Architecture:** A Cordis plugin registering a `ctx.systemPrompt` section whose `text` is a synchronous function reading a per-agent cache. The cache is refreshed asynchronously at turn boundaries from `agent/pre-step`, content-hash gated so an unchanged memory set never disturbs the KV-cache prefix. Learning, capture and compaction hooks ride the `session/event` emit feed. Every PLUR call is timeout-bounded and cannot throw into the host.

**Tech Stack:** TypeScript (ESM, node22), Cordis 4.x, schemastery, tsup, Vitest, `@plur-ai/core` in-process.

**Spec:** `docs/specs/2026-08-14-dsh-plugin-design.md` — read it first. In particular §1 explains why tail-appended `user/message` injection is **not** used; do not "simplify" the design back into it.

## Global Constraints

- **Dependency pin, exact:** every `@deepseek-ai/dsh-*` package at `0.1.0-rc.6`. `@deepseek-ai/cordis` at `^4.0.1`, `@deepseek-ai/schemastery` at `^3.18.1`. The npm `latest` dist-tag is stale and resolves to a conflicting `0.0.1-rc.1` line — install with explicit versions. Never `--legacy-peer-deps` or `--force`.
- **Node:** `>=20`, tsup target `node22` (matches `@plur-ai/claw`).
- **Module format:** ESM only (`"type": "module"`, tsup `format: ['esm']`, `dts: true`).
- **License:** Apache-2.0. Author `PLUR <info@plur.ai>`.
- **Never throw into the host.** Every call into `@plur-ai/core` — retrieval *and* rendering — goes through `guard()`. The prompt-section `text` provider is synchronous, cache-only, and returns `''` on any miss.
- **Never accrete context.** No `createUserMessage`, no appending to `PreStepDecision.messages`. If a task tempts you toward that, re-read spec §1.
- **Scope is closed by default.** The plugin never reads the ambient global PLUR store unless the user explicitly widens `scope`.
- **Tools: exactly five.** `plur_recall`, `plur_learn`, `plur_forget`, `plur_feedback`, `plur_status`. Schema cost is billed on every request; do not add a sixth without deleting one.
- **Commit after every task.** Conventional commits, no AI attribution lines (repo convention, `CLAUDE.md`).

---

### Task 1: Package scaffold, config schema, manifest contract

**Files:**
- Create: `packages/dsh/package.json`
- Create: `packages/dsh/tsconfig.json`
- Create: `packages/dsh/tsup.config.ts`
- Create: `packages/dsh/vitest.config.ts`
- Create: `packages/dsh/src/config.ts`
- Create: `packages/dsh/cordis.patch.yml`
- Test: `packages/dsh/test/manifest.test.ts`
- Test: `packages/dsh/test/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Config` (interface) and `Config` (schemastery schema) from `src/config.ts`, with fields `path?`, `scope?`, `injectionMode`, `injectionBudget`, `refreshIntervalMs`, `autoLearn`, `autoCapture`, `reranker`, `timeoutMs`, `tabEnabled`.

- [ ] **Step 1: Write the failing manifest test**

```ts
// packages/dsh/test/manifest.test.ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

describe('dsh bundle manifest', () => {
  it('declares the bundle patch dsh plugin add relies on', () => {
    expect(pkg.name).toBe('@plur-ai/dsh')
    expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
  })

  it('ships the patch file and dist in the npm tarball', () => {
    expect(pkg.files).toContain('cordis.patch.yml')
    expect(pkg.files).toContain('dist')
  })

  it('pins every dsh peer to one release line', () => {
    for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
      if (name.startsWith('@deepseek-ai/dsh-')) expect(range).toBe('0.1.0-rc.6')
    }
  })

  it('mounts this package by name in the patch', () => {
    const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('name: "@plur-ai/dsh"')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @plur-ai/dsh test -- manifest`
Expected: FAIL — `package.json` does not exist.

- [ ] **Step 3: Create the package files**

```json
// packages/dsh/package.json
{
  "name": "@plur-ai/dsh",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "scripts": { "build": "tsup", "test": "vitest run" },
  "dependencies": { "@plur-ai/core": "workspace:*" },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-agent": "0.1.0-rc.6",
    "@deepseek-ai/dsh-llm": "0.1.0-rc.6",
    "@deepseek-ai/dsh-session": "0.1.0-rc.6",
    "@deepseek-ai/dsh-skill": "0.1.0-rc.6",
    "@deepseek-ai/dsh-tools": "0.1.0-rc.6"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-agent": "0.1.0-rc.6",
    "@deepseek-ai/dsh-llm": "0.1.0-rc.6",
    "@deepseek-ai/dsh-session": "0.1.0-rc.6",
    "@deepseek-ai/dsh-skill": "0.1.0-rc.6",
    "@deepseek-ai/dsh-tools": "0.1.0-rc.6",
    "@deepseek-ai/schemastery": "^3.18.1",
    "@types/node": "^22.0.0"
  },
  "license": "Apache-2.0",
  "description": "PLUR memory for DeepSeek Harness — engrams injected straight into the prompt, no tool call required",
  "keywords": ["deepseek-harness", "dsh", "dsh-plugin", "cordis", "agent-memory", "llm-memory", "persistent-memory", "local-first", "plur"],
  "homepage": "https://plur.ai",
  "repository": { "type": "git", "url": "https://github.com/plur-ai/plur", "directory": "packages/dsh" },
  "author": "PLUR <info@plur.ai>",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } }
}
```

```yaml
# packages/dsh/cordis.patch.yml
- insert:
    - id: plur
      name: "@plur-ai/dsh"
      config:
        injectionMode: content
        injectionBudget: 2000
        autoLearn: true
        autoCapture: true
        tabEnabled: true
```

```ts
// packages/dsh/tsup.config.ts
import { defineConfig } from 'tsup'
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  dts: true,
  clean: true,
})
```

```ts
// packages/dsh/vitest.config.ts
import { defineConfig } from 'vitest/config'
// Matches packages/claw: @plur-ai/core cold-loads the embedder lazily and can
// exceed the 5s default under parallel suite import.
export default defineConfig({ test: { globals: true, testTimeout: 60000, hookTimeout: 60000 } })
```

```json
// packages/dsh/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

- [ ] **Step 4: Run the manifest test to verify it passes**

Run: `pnpm --filter @plur-ai/dsh test -- manifest`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing config test**

```ts
// packages/dsh/test/config.test.ts
import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.ts'

describe('Config', () => {
  it('defaults injection on, in content mode', () => {
    const c = new Config({})
    expect(c.injectionMode).toBe('content')
    expect(c.injectionBudget).toBe(2000)
  })

  it('defaults the scope closed — never the ambient global store', () => {
    const c = new Config({})
    expect(c.scope).toBe('project:dsh')
  })

  it('rejects a non-positive timeout', () => {
    expect(() => new Config({ timeoutMs: 0 })).toThrow()
  })

  it('rejects an unknown injection mode', () => {
    expect(() => new Config({ injectionMode: 'cue' as never })).toThrow()
  })
})
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm --filter @plur-ai/dsh test -- config`
Expected: FAIL — cannot resolve `../src/config.ts`.

- [ ] **Step 7: Implement the config schema**

```ts
// packages/dsh/src/config.ts
import z from '@deepseek-ai/schemastery'

/** Plugin configuration, surfaced under the `plur` namespace in $DSH_HOME/settings.yaml. */
export interface Config {
  /** PLUR store location. */
  path?: string
  /**
   * Which PLUR scope this harness may read and write. Defaults CLOSED to a
   * dsh-specific scope: a global store accretes across every tool the user has
   * ever pointed PLUR at, and a third-party harness must not inherit all of it.
   */
  scope: string
  /** `content` injects the engrams themselves; `off` disables injection entirely. */
  injectionMode: 'content' | 'off'
  /** Token ceiling for the rendered block. */
  injectionBudget: number
  /** Floor in ms between cache refreshes. 0 means once per turn boundary. */
  refreshIntervalMs: number
  autoLearn: boolean
  autoCapture: boolean
  reranker: 'off' | 'ms-marco-minilm-l6' | 'bge-reranker-v2-m3'
  /** Hard bound on any single PLUR call. */
  timeoutMs: number
  tabEnabled: boolean
}

export const Config: z<Config> = z.object({
  path: z.string(),
  scope: z.string().default('project:dsh'),
  injectionMode: z.union(['content', 'off'] as const).default('content'),
  injectionBudget: z.natural().min(1).default(2000),
  refreshIntervalMs: z.natural().default(0),
  autoLearn: z.boolean().default(true),
  autoCapture: z.boolean().default(true),
  reranker: z.union(['off', 'ms-marco-minilm-l6', 'bge-reranker-v2-m3'] as const).default('off'),
  timeoutMs: z.natural().min(1).default(5000),
  tabEnabled: z.boolean().default(true),
})
```

- [ ] **Step 8: Run the config test to verify it passes**

Run: `pnpm --filter @plur-ai/dsh test -- config`
Expected: PASS (4 tests).

- [ ] **Step 9: Commit**

```bash
git add packages/dsh
git commit -m "feat(dsh): package scaffold, config schema, bundle manifest"
```

---

### Task 2: `guard.ts` — timeout, never-throw, write serialization

**Files:**
- Create: `packages/dsh/src/guard.ts`
- Test: `packages/dsh/test/guard.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `guard<T>(fn: () => Promise<T>, opts: { timeoutMs: number; onError?: (e: unknown) => void }): Promise<T | undefined>` — resolves `undefined` on throw or timeout, never rejects.
  - `createWriteQueue(): <T>(fn: () => Promise<T>) => Promise<T | undefined>` — serializes writes across concurrent sessions in one process.

- [ ] **Step 1: Write the failing test**

```ts
// packages/dsh/test/guard.test.ts
import { describe, expect, it, vi } from 'vitest'
import { createWriteQueue, guard } from '../src/guard.ts'

describe('guard', () => {
  it('returns the value on success', async () => {
    expect(await guard(async () => 42, { timeoutMs: 1000 })).toBe(42)
  })

  it('swallows a throw and returns undefined', async () => {
    const onError = vi.fn()
    const r = await guard(async () => { throw new Error('boom') }, { timeoutMs: 1000, onError })
    expect(r).toBeUndefined()
    expect(onError).toHaveBeenCalledOnce()
  })

  it('swallows a synchronous throw before the promise exists', async () => {
    const r = await guard(() => { throw new Error('sync boom') }, { timeoutMs: 1000 })
    expect(r).toBeUndefined()
  })

  it('times out a hung call and returns undefined', async () => {
    const r = await guard(() => new Promise(() => {}), { timeoutMs: 20 })
    expect(r).toBeUndefined()
  })

  it('does not leave a pending timer after a fast success', async () => {
    vi.useFakeTimers()
    const p = guard(async () => 'ok', { timeoutMs: 60_000 })
    await expect(p).resolves.toBe('ok')
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })
})

describe('createWriteQueue', () => {
  it('serializes overlapping writes', async () => {
    const q = createWriteQueue()
    const order: string[] = []
    const slow = async () => { await new Promise(r => setTimeout(r, 20)); order.push('a') }
    const fast = async () => { order.push('b') }
    await Promise.all([q(slow), q(fast)])
    expect(order).toEqual(['a', 'b'])
  })

  it('a rejected write does not poison the queue', async () => {
    const q = createWriteQueue()
    await q(async () => { throw new Error('bad') })
    expect(await q(async () => 'next')).toBe('next')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @plur-ai/dsh test -- guard`
Expected: FAIL — cannot resolve `../src/guard.ts`.

- [ ] **Step 3: Implement**

```ts
// packages/dsh/src/guard.ts

/** Options for one guarded call. */
export interface GuardOptions {
  /** Hard bound in ms; the call resolves undefined once it elapses. */
  timeoutMs: number
  /** Observer for the swallowed failure. Must not throw. */
  onError?: (error: unknown) => void
}

/**
 * Run one PLUR call so it can never fail the host's turn.
 *
 * Resolves `undefined` on ANY failure — a synchronous throw before the promise
 * exists, a rejection, or the timeout elapsing. Never rejects. The timer is
 * always cleared, so a fast success leaves nothing pending.
 */
export async function guard<T>(fn: () => Promise<T> | T, opts: GuardOptions): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<undefined>(resolve => {
      timer = setTimeout(() => resolve(undefined), opts.timeoutMs)
    })
    // Promise.resolve() also captures a synchronous throw from fn().
    return await Promise.race([Promise.resolve().then(fn), timeout])
  } catch (error: unknown) {
    try { opts.onError?.(error) } catch { /* an observer must never escalate */ }
    return undefined
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Serialize writes against the one on-disk PLUR store.
 *
 * Running in-process means several live dsh sessions share this module, so two
 * auto-learn paths can otherwise read-modify-write the same YAML concurrently —
 * a hazard the subprocess-per-call competitor does not have and our in-process
 * choice introduces. Each queued call runs to settlement before the next starts;
 * a rejection is contained so it cannot poison the chain.
 */
export function createWriteQueue(): <T>(fn: () => Promise<T>) => Promise<T | undefined> {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    const run = tail.then(async (): Promise<T | undefined> => {
      try { return await fn() } catch { return undefined }
    })
    tail = run.catch(() => undefined)
    return run
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @plur-ai/dsh test -- guard`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/dsh/src/guard.ts packages/dsh/test/guard.test.ts
git commit -m "feat(dsh): guard — timeout-bounded, never-throwing PLUR calls plus a write queue"
```

---

### Task 3: `session-log.ts` — shared log-walking helpers

**Files:**
- Create: `packages/dsh/src/session-log.ts`
- Test: `packages/dsh/test/session-log.test.ts`

Four files need to walk `agent.session.events`, and this is the exact category where the design review found bugs. Centralise it and unit-test it once.

**Interfaces:**
- Consumes: nothing (operates on plain event arrays).
- Produces:
  - `type LogEvent = { type: string; time: number; data: unknown }`
  - `recallQueryFrom(events: readonly LogEvent[], turn: number, proposed: readonly { content: unknown }[]): string`
  - `lastAssistantText(events: readonly LogEvent[]): string | undefined`

- [ ] **Step 1: Write the failing test**

```ts
// packages/dsh/test/session-log.test.ts
import { describe, expect, it } from 'vitest'
import { lastAssistantText, recallQueryFrom } from '../src/session-log.ts'

const text = (t: string) => ({ content: [{ type: 'text', text: t }] })

describe('recallQueryFrom', () => {
  it('uses the user messages entered in the current turn', () => {
    const events = [
      { type: 'turn/start', time: 1, data: { turn: 1 } },
      { type: 'user/message', time: 2, data: { ...text('older'), source: { kind: 'user' } } },
      { type: 'turn/start', time: 3, data: { turn: 2 } },
      { type: 'user/message', time: 4, data: { ...text('current'), source: { kind: 'user' } } },
    ]
    expect(recallQueryFrom(events, 2, [])).toBe('current')
  })

  it('includes messages proposed by the pre-step decision', () => {
    const events = [{ type: 'turn/start', time: 1, data: { turn: 1 } }]
    expect(recallQueryFrom(events, 1, [text('proposed')])).toBe('proposed')
  })

  it('ignores plugin-sourced context so memory never recalls on its own output', () => {
    const events = [
      { type: 'turn/start', time: 1, data: { turn: 1 } },
      { type: 'user/message', time: 2, data: { ...text('plugin noise'), source: { kind: 'plugin', plugin: 'plur' } } },
      { type: 'user/message', time: 3, data: { ...text('real ask'), source: { kind: 'user' } } },
    ]
    expect(recallQueryFrom(events, 1, [])).toBe('real ask')
  })

  it('returns empty string when the turn has no user text', () => {
    expect(recallQueryFrom([{ type: 'turn/start', time: 1, data: { turn: 1 } }], 1, [])).toBe('')
  })
})

describe('lastAssistantText', () => {
  it('returns the most recent assistant message text', () => {
    const events = [
      { type: 'assistant/message', time: 1, data: { message: text('first') } },
      { type: 'assistant/message', time: 2, data: { message: text('second') } },
    ]
    expect(lastAssistantText(events)).toBe('second')
  })

  it('returns undefined when there is none', () => {
    expect(lastAssistantText([])).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @plur-ai/dsh test -- session-log`
Expected: FAIL — cannot resolve `../src/session-log.ts`.

- [ ] **Step 3: Implement**

```ts
// packages/dsh/src/session-log.ts

/** The structural subset of a dsh SessionEvent these helpers read. */
export interface LogEvent {
  readonly type: string
  readonly time: number
  readonly data: unknown
}

interface TextBlock { readonly type: string; readonly text?: string }
interface MessageLike { readonly content?: readonly TextBlock[]; readonly source?: { readonly kind?: string } }

/** Concatenate the text blocks of one message-like value. */
function textOf(message: unknown): string {
  const content = (message as MessageLike | undefined)?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is TextBlock & { text: string } => b?.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n')
    .trim()
}

/**
 * Build the recall query for one turn: the human text entered in this turn.
 *
 * Plugin-sourced context is excluded deliberately — including our own injected
 * block would make each recall query drift toward whatever we last recalled.
 */
export function recallQueryFrom(
  events: readonly LogEvent[],
  turn: number,
  proposed: readonly unknown[],
): string {
  const start = events.findLastIndex(e => e.type === 'turn/start' && (e.data as { turn?: number })?.turn === turn)
  const entered = start < 0 ? [] : events.slice(start + 1)
  const parts: string[] = []
  for (const event of entered) {
    if (event.type !== 'user/message') continue
    const data = event.data as MessageLike
    if (data?.source?.kind !== 'user') continue
    const t = textOf(data)
    if (t) parts.push(t)
  }
  for (const message of proposed) {
    const t = textOf(message)
    if (t) parts.push(t)
  }
  return parts.join('\n').trim()
}

/** The most recent assistant message's text, for episode capture. */
export function lastAssistantText(events: readonly LogEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type !== 'assistant/message') continue
    const t = textOf((event.data as { message?: unknown })?.message)
    if (t) return t
  }
  return undefined
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @plur-ai/dsh test -- session-log`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/dsh/src/session-log.ts packages/dsh/test/session-log.test.ts
git commit -m "feat(dsh): shared session-log helpers for recall query and episode text"
```

---

### Task 4: `memory-section.ts` — the block cache and renderer

**Files:**
- Create: `packages/dsh/src/memory-section.ts`
- Test: `packages/dsh/test/memory-section.test.ts`

This is the thesis. The cache is written asynchronously and read synchronously by the prompt-section `text` provider.

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface EngramLike { id: string; statement: string; domain?: string; confidence?: number }`
  - `renderBlock(engrams: readonly EngramLike[], budgetTokens: number): string`
  - `blockHash(block: string): string`
  - `createMemoryCache(): MemoryCache` where
    `MemoryCache = { read(agentId: string): string; write(agentId: string, block: string): boolean; clear(agentId: string): void }`
    — `write` returns `false` when the block is unchanged (hash-gated), `true` when it replaced the cached value.

- [ ] **Step 1: Write the failing test**

```ts
// packages/dsh/test/memory-section.test.ts
import { describe, expect, it } from 'vitest'
import { blockHash, createMemoryCache, renderBlock } from '../src/memory-section.ts'

const e = (id: string, statement: string, confidence = 0.9) => ({ id, statement, confidence })

describe('renderBlock', () => {
  it('renders nothing for an empty set, so the prompt section stays absent', () => {
    expect(renderBlock([], 2000)).toBe('')
  })

  it('renders high-confidence engrams under a DIRECTIVES heading', () => {
    const out = renderBlock([e('ENG-1', 'Always pin dsh deps.')], 2000)
    expect(out).toContain('## DIRECTIVES')
    expect(out).toContain('[ENG-1]')
    expect(out).toContain('Always pin dsh deps.')
  })

  it('separates low-confidence engrams into ALSO CONSIDER', () => {
    const out = renderBlock([e('ENG-1', 'High.', 0.9), e('ENG-2', 'Low.', 0.3)], 2000)
    expect(out.indexOf('## DIRECTIVES')).toBeLessThan(out.indexOf('## ALSO CONSIDER'))
    expect(out).toContain('[ENG-2]')
  })

  it('trims to the token budget rather than emitting an oversized block', () => {
    const many = Array.from({ length: 500 }, (_, i) => e(`ENG-${i}`, 'x'.repeat(200)))
    const out = renderBlock(many, 100)
    // 100 tokens ~= 400 chars; allow generous slack but assert it is bounded.
    expect(out.length).toBeLessThan(1200)
  })

  it('is deterministic for the same input', () => {
    const set = [e('ENG-1', 'One.'), e('ENG-2', 'Two.')]
    expect(renderBlock(set, 2000)).toBe(renderBlock(set, 2000))
  })
})

describe('blockHash', () => {
  it('differs when content differs and matches when it does not', () => {
    expect(blockHash('a')).toBe(blockHash('a'))
    expect(blockHash('a')).not.toBe(blockHash('b'))
  })
})

describe('createMemoryCache', () => {
  it('reads empty string for an unknown agent', () => {
    expect(createMemoryCache().read('nope')).toBe('')
  })

  it('write returns true on change and false when unchanged', () => {
    const cache = createMemoryCache()
    expect(cache.write('a1', 'block one')).toBe(true)
    expect(cache.write('a1', 'block one')).toBe(false)
    expect(cache.write('a1', 'block two')).toBe(true)
  })

  it('keeps agents isolated', () => {
    const cache = createMemoryCache()
    cache.write('a1', 'one')
    cache.write('a2', 'two')
    expect(cache.read('a1')).toBe('one')
    expect(cache.read('a2')).toBe('two')
  })

  it('clear drops an agent so a disposed session leaks nothing', () => {
    const cache = createMemoryCache()
    cache.write('a1', 'one')
    cache.clear('a1')
    expect(cache.read('a1')).toBe('')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @plur-ai/dsh test -- memory-section`
Expected: FAIL — cannot resolve `../src/memory-section.ts`.

- [ ] **Step 3: Implement**

```ts
// packages/dsh/src/memory-section.ts
import { createHash } from 'node:crypto'

/** The engram fields the rendered block uses. */
export interface EngramLike {
  readonly id: string
  readonly statement: string
  readonly domain?: string
  readonly confidence?: number
}

/** Engrams at or above this confidence render as directives. */
const DIRECTIVE_CONFIDENCE = 0.5
/** Rough chars-per-token for budget trimming; deliberately conservative. */
const CHARS_PER_TOKEN = 4

/**
 * Render the memory block that becomes the `plur:memory` system-prompt section.
 *
 * The format matches `@plur-ai/claw`'s assembler and the MCP session-start block
 * — identical output across hosts is a PLUR principle, enforced by a snapshot
 * test in Task 11. Returns '' for an empty set so the section renders nothing
 * rather than an empty heading.
 */
export function renderBlock(engrams: readonly EngramLike[], budgetTokens: number): string {
  if (engrams.length === 0) return ''
  const budgetChars = Math.max(0, budgetTokens) * CHARS_PER_TOKEN
  const directives: string[] = []
  const also: string[] = []
  let used = 0

  for (const engram of engrams) {
    const confidence = engram.confidence ?? 0
    const line = confidence >= DIRECTIVE_CONFIDENCE
      ? `[${engram.id}] ${engram.statement}${engram.domain ? `\n  Domain: ${engram.domain}` : ''}`
      : `[${engram.id}] ${engram.statement}`
    if (used + line.length > budgetChars) break
    used += line.length
    ;(confidence >= DIRECTIVE_CONFIDENCE ? directives : also).push(line)
  }

  const sections: string[] = []
  if (directives.length > 0) sections.push(`## DIRECTIVES\n\n${directives.join('\n\n')}`)
  if (also.length > 0) sections.push(`## ALSO CONSIDER\n\n${also.join('\n')}`)
  return sections.join('\n\n')
}

/** Stable digest of a rendered block, for change detection. */
export function blockHash(block: string): string {
  return createHash('sha256').update(block).digest('hex')
}

/** Per-agent rendered-block store, read synchronously by the prompt section. */
export interface MemoryCache {
  /** The current block for an agent, or '' when there is none. Never throws. */
  read(agentId: string): string
  /** Store a block. Returns false when it is byte-identical to the cached one. */
  write(agentId: string, block: string): boolean
  /** Drop an agent's block when its session ends. */
  clear(agentId: string): void
}

/**
 * Create the cache backing the prompt section.
 *
 * `write` is hash-gated: an unchanged memory set must not rewrite the system
 * prompt, because that would invalidate the request's KV-cache prefix for no
 * benefit. The caller uses the boolean to decide whether anything actually moved.
 */
export function createMemoryCache(): MemoryCache {
  const blocks = new Map<string, string>()
  const hashes = new Map<string, string>()
  return {
    read: (agentId) => blocks.get(agentId) ?? '',
    write: (agentId, block) => {
      const hash = blockHash(block)
      if (hashes.get(agentId) === hash) return false
      hashes.set(agentId, hash)
      blocks.set(agentId, block)
      return true
    },
    clear: (agentId) => { blocks.delete(agentId); hashes.delete(agentId) },
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @plur-ai/dsh test -- memory-section`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/dsh/src/memory-section.ts packages/dsh/test/memory-section.test.ts
git commit -m "feat(dsh): memory block renderer and hash-gated per-agent cache"
```

---

### Task 5: `scope.ts` — per-session scope resolution

**Files:**
- Create: `packages/dsh/src/scope.ts`
- Test: `packages/dsh/test/scope.test.ts`

dsh's default profile is a multi-session web server. One global scope would leak engrams between unrelated project sessions.

**Interfaces:**
- Consumes: `Config` from Task 1.
- Produces: `createScopeResolver(config: Pick<Config, 'scope'>, readWorkspaceScope: (cwd: string) => Promise<string | undefined>): { resolve(agentId: string, cwd: string | undefined): Promise<string> }`

- [ ] **Step 1: Write the failing test**

```ts
// packages/dsh/test/scope.test.ts
import { describe, expect, it, vi } from 'vitest'
import { createScopeResolver } from '../src/scope.ts'

describe('createScopeResolver', () => {
  it('prefers a workspace .plur.yaml scope over the config default', async () => {
    const r = createScopeResolver({ scope: 'project:dsh' }, async () => 'project:acme')
    expect(await r.resolve('a1', '/w/acme')).toBe('project:acme')
  })

  it('falls back to the configured default when the workspace declares none', async () => {
    const r = createScopeResolver({ scope: 'project:dsh' }, async () => undefined)
    expect(await r.resolve('a1', '/w/acme')).toBe('project:dsh')
  })

  it('never returns the ambient global store', async () => {
    const r = createScopeResolver({ scope: 'project:dsh' }, async () => undefined)
    expect(await r.resolve('a1', undefined)).not.toBe('global')
  })

  it('keeps two concurrent agents on their own scopes', async () => {
    const byCwd: Record<string, string> = { '/w/a': 'project:a', '/w/b': 'project:b' }
    const r = createScopeResolver({ scope: 'project:dsh' }, async cwd => byCwd[cwd])
    const [a, b] = await Promise.all([r.resolve('a1', '/w/a'), r.resolve('a2', '/w/b')])
    expect([a, b]).toEqual(['project:a', 'project:b'])
  })

  it('reads the workspace once per agent, then caches', async () => {
    const read = vi.fn(async () => 'project:acme')
    const r = createScopeResolver({ scope: 'project:dsh' }, read)
    await r.resolve('a1', '/w/acme')
    await r.resolve('a1', '/w/acme')
    expect(read).toHaveBeenCalledOnce()
  })

  it('falls back to the default when the workspace read throws', async () => {
    const r = createScopeResolver({ scope: 'project:dsh' }, async () => { throw new Error('nope') })
    expect(await r.resolve('a1', '/w/acme')).toBe('project:dsh')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @plur-ai/dsh test -- scope`
Expected: FAIL — cannot resolve `../src/scope.ts`.

- [ ] **Step 3: Implement**

```ts
// packages/dsh/src/scope.ts

/** Resolves which PLUR scope one live agent may read and write. */
export interface ScopeResolver {
  resolve(agentId: string, cwd: string | undefined): Promise<string>
}

/**
 * Build the per-agent scope resolver.
 *
 * Precedence: the session workspace's own `.plur.yaml` scope, then the
 * configured default. The ambient global store is never a fallback — a
 * third-party harness must not inherit every engram the user has ever stored.
 * Results are memoised per agent so one session resolves once.
 */
export function createScopeResolver(
  config: { scope: string },
  readWorkspaceScope: (cwd: string) => Promise<string | undefined>,
): ScopeResolver {
  const resolved = new Map<string, string>()
  return {
    async resolve(agentId, cwd) {
      const cached = resolved.get(agentId)
      if (cached !== undefined) return cached
      let scope = config.scope
      if (cwd !== undefined) {
        try {
          const declared = await readWorkspaceScope(cwd)
          if (declared) scope = declared
        } catch { /* a broken workspace file must not widen or break scope */ }
      }
      resolved.set(agentId, scope)
      return scope
    },
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @plur-ai/dsh test -- scope`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/dsh/src/scope.ts packages/dsh/test/scope.test.ts
git commit -m "feat(dsh): per-session scope resolution, closed by default"
```

---

### Task 6: `refresh.ts` — when to recompute the block

**Files:**
- Create: `packages/dsh/src/refresh.ts`
- Test: `packages/dsh/test/refresh.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `createRefreshPolicy(opts: { refreshIntervalMs: number; now?: () => number }): { shouldRefresh(agentId: string, step: number): boolean; markRefreshed(agentId: string): void; clear(agentId: string): void }`

- [ ] **Step 1: Write the failing test**

```ts
// packages/dsh/test/refresh.test.ts
import { describe, expect, it } from 'vitest'
import { createRefreshPolicy } from '../src/refresh.ts'

describe('createRefreshPolicy', () => {
  it('refreshes on the first step of a turn', () => {
    expect(createRefreshPolicy({ refreshIntervalMs: 0 }).shouldRefresh('a1', 1)).toBe(true)
  })

  it('does NOT refresh on later steps — one recall per user turn', () => {
    const p = createRefreshPolicy({ refreshIntervalMs: 0 })
    expect(p.shouldRefresh('a1', 2)).toBe(false)
    expect(p.shouldRefresh('a1', 7)).toBe(false)
  })

  it('suppresses a repeat within refreshIntervalMs — the retry-storm guard', () => {
    let t = 1000
    const p = createRefreshPolicy({ refreshIntervalMs: 500, now: () => t })
    expect(p.shouldRefresh('a1', 1)).toBe(true)
    p.markRefreshed('a1')
    t = 1200
    expect(p.shouldRefresh('a1', 1)).toBe(false)
    t = 1600
    expect(p.shouldRefresh('a1', 1)).toBe(true)
  })

  it('with interval 0 allows every turn boundary', () => {
    let t = 1000
    const p = createRefreshPolicy({ refreshIntervalMs: 0, now: () => t })
    expect(p.shouldRefresh('a1', 1)).toBe(true)
    p.markRefreshed('a1')
    t = 1001
    expect(p.shouldRefresh('a1', 1)).toBe(true)
  })

  it('tracks agents independently', () => {
    let t = 1000
    const p = createRefreshPolicy({ refreshIntervalMs: 500, now: () => t })
    p.shouldRefresh('a1', 1); p.markRefreshed('a1')
    expect(p.shouldRefresh('a2', 1)).toBe(true)
  })

  it('clear forgets an agent', () => {
    let t = 1000
    const p = createRefreshPolicy({ refreshIntervalMs: 500, now: () => t })
    p.markRefreshed('a1')
    p.clear('a1')
    expect(p.shouldRefresh('a1', 1)).toBe(true)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @plur-ai/dsh test -- refresh`
Expected: FAIL — cannot resolve `../src/refresh.ts`.

- [ ] **Step 3: Implement**

```ts
// packages/dsh/src/refresh.ts

/** Decides when the memory block is recomputed. */
export interface RefreshPolicy {
  /** True when this step should trigger an out-of-band recall. */
  shouldRefresh(agentId: string, step: number): boolean
  /** Record that a refresh just ran. */
  markRefreshed(agentId: string): void
  /** Forget an agent when its session ends. */
  clear(agentId: string): void
}

/**
 * Refresh at turn boundaries only.
 *
 * Step 1 of a turn is the moment new human input has arrived, which is the only
 * time the recall query can have changed. Recalling on later steps would spend a
 * retrieval per tool-loop iteration and re-fire on every request-recovery retry
 * for no new information. `refreshIntervalMs` adds a floor on top, which also
 * bounds a retry storm that re-enters step 1.
 */
export function createRefreshPolicy(opts: { refreshIntervalMs: number; now?: () => number }): RefreshPolicy {
  const now = opts.now ?? Date.now
  const last = new Map<string, number>()
  return {
    shouldRefresh(agentId, step) {
      if (step !== 1) return false
      if (opts.refreshIntervalMs <= 0) return true
      const previous = last.get(agentId)
      if (previous === undefined) return true
      return now() - previous >= opts.refreshIntervalMs
    },
    markRefreshed(agentId) { last.set(agentId, now()) },
    clear(agentId) { last.delete(agentId) },
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @plur-ai/dsh test -- refresh`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/dsh/src/refresh.ts packages/dsh/test/refresh.test.ts
git commit -m "feat(dsh): turn-boundary refresh policy with retry-storm floor"
```

---

### Task 7: `counters.ts` — local debug counters

**Files:**
- Create: `packages/dsh/src/counters.ts`
- Test: `packages/dsh/test/counters.test.ts`

Independent of the Web tab, so cutting the tab never removes the only debugging surface.

**Interfaces:**
- Consumes: nothing.
- Produces: `createCounters(): { bump(k: CounterKey): void; snapshot(): Record<CounterKey, number> }`, `type CounterKey = 'refresh_attempted' | 'blocks_written' | 'blocks_unchanged' | 'engrams_rendered' | 'learn_captured' | 'errors_swallowed'`

- [ ] **Step 1: Write the failing test**

```ts
// packages/dsh/test/counters.test.ts
import { describe, expect, it } from 'vitest'
import { createCounters } from '../src/counters.ts'

describe('createCounters', () => {
  it('starts every counter at zero', () => {
    expect(createCounters().snapshot()).toEqual({
      refresh_attempted: 0, blocks_written: 0, blocks_unchanged: 0,
      engrams_rendered: 0, learn_captured: 0, errors_swallowed: 0,
    })
  })

  it('bump increments', () => {
    const c = createCounters()
    c.bump('blocks_written'); c.bump('blocks_written')
    expect(c.snapshot().blocks_written).toBe(2)
  })

  it('snapshot is a copy, not a live view', () => {
    const c = createCounters()
    const first = c.snapshot()
    c.bump('errors_swallowed')
    expect(first.errors_swallowed).toBe(0)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @plur-ai/dsh test -- counters`
Expected: FAIL — cannot resolve `../src/counters.ts`.

- [ ] **Step 3: Implement**

```ts
// packages/dsh/src/counters.ts

/** Observable events, surfaced by /plur status and the Web tab. */
export type CounterKey =
  | 'refresh_attempted'
  | 'blocks_written'
  | 'blocks_unchanged'
  | 'engrams_rendered'
  | 'learn_captured'
  | 'errors_swallowed'

const KEYS: readonly CounterKey[] = [
  'refresh_attempted', 'blocks_written', 'blocks_unchanged',
  'engrams_rendered', 'learn_captured', 'errors_swallowed',
]

/** Per-process counters. Purely local — never sent anywhere. */
export interface Counters {
  bump(key: CounterKey): void
  snapshot(): Record<CounterKey, number>
}

/**
 * Create the counter set.
 *
 * "Why didn't it remember that?" is the question this product gets asked most,
 * and these are how it gets answered. Deliberately independent of the Web tab so
 * that cutting the tab does not remove the only human-facing debug surface.
 */
export function createCounters(): Counters {
  const values = new Map<CounterKey, number>(KEYS.map(k => [k, 0]))
  return {
    bump(key) { values.set(key, (values.get(key) ?? 0) + 1) },
    snapshot() {
      return Object.fromEntries(KEYS.map(k => [k, values.get(k) ?? 0])) as Record<CounterKey, number>
    },
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @plur-ai/dsh test -- counters`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/dsh/src/counters.ts packages/dsh/test/counters.test.ts
git commit -m "feat(dsh): local debug counters, independent of the web tab"
```

---

### Task 8: `index.ts` — plugin wiring and the prompt section

**Files:**
- Create: `packages/dsh/src/index.ts`
- Test: `packages/dsh/test/plugin.test.ts`

Wires Tasks 1–7 into a Cordis plugin: register the prompt section per agent, refresh its cache on `agent/pre-step`, clean up on disposal.

**Interfaces:**
- Consumes: everything from Tasks 1–7.
- Produces: `name`, `inject`, `Config`, `apply(ctx, config)` — the Cordis plugin contract.

- [ ] **Step 1: Write the failing test**

```ts
// packages/dsh/test/plugin.test.ts
import { describe, expect, it, vi } from 'vitest'
import { apply, name } from '../src/index.ts'
import { Config } from '../src/config.ts'

/** Minimal Cordis-shaped double: records registrations and lets tests fire events. */
function makeCtx() {
  const listeners = new Map<string, Function[]>()
  const sections: any[] = []
  return {
    ctx: {
      on: (event: string, fn: Function) => {
        listeners.set(event, [...(listeners.get(event) ?? []), fn])
        return () => {}
      },
      systemPrompt: { section: (s: any) => { sections.push(s); return () => {} } },
      tools: { register: () => () => {} },
      skills: { register: () => () => {} },
      commands: { register: () => () => {} },
      logger: { warn: vi.fn(), info: vi.fn() },
    },
    fire: (event: string, ...args: any[]) =>
      Promise.all((listeners.get(event) ?? []).map(fn => fn(...args))),
    sections,
    listeners,
  }
}

const agent = (id = 'a1') => ({ id, session: { events: [], header: { cwd: '/w' } }, ctx: undefined as any })

describe('plugin', () => {
  it('exports the Cordis plugin contract', () => {
    expect(name).toBe('plur')
    expect(typeof apply).toBe('function')
  })

  it('registers a pre-step listener', () => {
    const h = makeCtx()
    apply(h.ctx as any, new Config({}))
    expect(h.listeners.has('agent/pre-step')).toBe(true)
  })

  it('NEVER appends to the pre-step decision — injection is prompt-section only', async () => {
    const h = makeCtx()
    apply(h.ctx as any, new Config({}))
    const decision = { kind: 'enter' as const, messages: [] }
    const next = async () => decision
    const [result] = await h.fire('agent/pre-step', { agent: agent(), turn: 1, step: 1, signal: new AbortController().signal }, next)
    expect(result).toBe(decision)
    expect(result.messages).toHaveLength(0)
  })

  it('returns the delegated decision unchanged when it is a reject', async () => {
    const h = makeCtx()
    apply(h.ctx as any, new Config({}))
    const decision = { kind: 'reject' as const }
    const [result] = await h.fire('agent/pre-step', { agent: agent(), turn: 1, step: 1, signal: new AbortController().signal }, async () => decision)
    expect(result).toBe(decision)
  })

  it('returns the delegated decision even when the refresh path throws', async () => {
    const h = makeCtx()
    apply(h.ctx as any, new Config({}), { recall: async () => { throw new Error('plur down') } } as any)
    const decision = { kind: 'enter' as const, messages: [] }
    const [result] = await h.fire('agent/pre-step', { agent: agent(), turn: 1, step: 1, signal: new AbortController().signal }, async () => decision)
    expect(result).toBe(decision)
  })

  it('registers exactly five model-facing tools', () => {
    const registered: string[] = []
    const h = makeCtx()
    h.ctx.tools.register = (d: any) => { registered.push(d.name); return () => {} }
    apply(h.ctx as any, new Config({}))
    expect(registered.sort()).toEqual(
      ['plur_feedback', 'plur_forget', 'plur_learn', 'plur_recall', 'plur_status'])
  })

  it('does not register the prompt section when injectionMode is off', () => {
    const h = makeCtx()
    apply(h.ctx as any, new Config({ injectionMode: 'off' }))
    expect(h.sections).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @plur-ai/dsh test -- plugin`
Expected: FAIL — cannot resolve `../src/index.ts`.

- [ ] **Step 3: Implement**

```ts
// packages/dsh/src/index.ts
/**
 * PLUR memory for DeepSeek Harness.
 *
 * Engrams reach the model through a `ctx.systemPrompt` section that is
 * re-rendered on every assembly from a cache, NOT through an appended
 * `user/message`. dsh projects injected user messages into derived history
 * verbatim and never removes them, so tail injection would accrete a block per
 * step until compaction. See docs/specs/2026-08-14-dsh-plugin-design.md §1.
 *
 * @module @plur-ai/dsh
 */
import type { Context } from '@deepseek-ai/cordis'
import { Config } from './config.ts'
import { createCounters } from './counters.ts'
import { createWriteQueue, guard } from './guard.ts'
import { createMemoryCache, renderBlock, type EngramLike } from './memory-section.ts'
import { createRefreshPolicy } from './refresh.ts'
import { createScopeResolver } from './scope.ts'
import { recallQueryFrom } from './session-log.ts'
import { registerTools } from './tools.ts'

export { Config }
export const name = 'plur'
export const inject = ['agents', 'systemPrompt', 'tools']

/** The slice of PLUR this plugin uses; injected for testability. */
export interface PlurLike {
  recall(query: string, opts: { scope: string; limit?: number }): Promise<EngramLike[]>
}

/** Section order: after the deployment persona (0), alongside tool guidance (100-199). */
const SECTION_ORDER = 120

export function apply(ctx: Context, config: Config, plur?: PlurLike): void {
  if (config.injectionMode === 'off' && !config.autoLearn) return

  const counters = createCounters()
  const cache = createMemoryCache()
  const refresh = createRefreshPolicy({ refreshIntervalMs: config.refreshIntervalMs })
  const scopes = createScopeResolver(config, async () => undefined)
  const queue = createWriteQueue()
  const registered = new Set<string>()
  const onError = () => counters.bump('errors_swallowed')

  registerTools(ctx, { config, counters, plur })

  ctx.on('agent/pre-step', async (input: any, next: () => Promise<any>) => {
    const decision = await next()
    if (config.injectionMode === 'off') return decision
    const { agent, turn, step, signal } = input
    if (decision?.kind === 'reject' || signal?.aborted) return decision

    // Register this agent's section once. The text provider is synchronous and
    // cache-only, so it cannot throw into prompt assembly.
    if (!registered.has(agent.id)) {
      registered.add(agent.id)
      const target = agent.ctx ?? ctx
      guardSync(() => target.systemPrompt.section({
        name: 'plur:memory',
        order: SECTION_ORDER,
        text: () => cache.read(agent.id),
      }), onError)
    }

    // Refresh out of band: never awaited, so a slow store cannot stall the turn.
    if (refresh.shouldRefresh(agent.id, step)) {
      refresh.markRefreshed(agent.id)
      counters.bump('refresh_attempted')
      void refreshBlock(agent, turn, decision, { config, cache, counters, scopes, queue, plur, onError })
    }

    // Deliberately unchanged. Injection happens through the prompt section.
    return decision
  }, { prepend: true })

  ctx.on('agent/disposed', (agent: any) => {
    registered.delete(agent.id)
    cache.clear(agent.id)
    refresh.clear(agent.id)
  })
}

/** Run a synchronous registration so a host API change cannot crash activation. */
function guardSync(fn: () => void, onError: () => void): void {
  try { fn() } catch { onError() }
}

interface RefreshDeps {
  config: Config
  cache: ReturnType<typeof createMemoryCache>
  counters: ReturnType<typeof createCounters>
  scopes: ReturnType<typeof createScopeResolver>
  queue: ReturnType<typeof createWriteQueue>
  plur: PlurLike | undefined
  onError: () => void
}

/** Recompute and cache one agent's block. Never throws; never awaited by the loop. */
async function refreshBlock(agent: any, turn: number, decision: any, deps: RefreshDeps): Promise<void> {
  const { config, cache, counters, scopes, queue, plur, onError } = deps
  if (!plur) return
  const query = recallQueryFrom(agent.session?.events ?? [], turn, decision?.messages ?? [])
  if (!query) return

  const block = await guard(async () => {
    const scope = await scopes.resolve(agent.id, agent.session?.header?.cwd)
    const engrams = await queue(() => plur.recall(query, { scope })) ?? []
    counters.bump('engrams_rendered')
    // Rendering is INSIDE the guard: a malformed engram must not escape either.
    return renderBlock(engrams, config.injectionBudget)
  }, { timeoutMs: config.timeoutMs, onError })

  if (block === undefined) return
  counters.bump(cache.write(agent.id, block) ? 'blocks_written' : 'blocks_unchanged')
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @plur-ai/dsh test -- plugin`
Expected: PASS (7 tests). Task 9 supplies `registerTools`; stub it as `export function registerTools() {}` in `src/tools.ts` to get green here, then fill it in.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh/src/index.ts packages/dsh/src/tools.ts packages/dsh/test/plugin.test.ts
git commit -m "feat(dsh): plugin wiring — prompt-section injection, out-of-band refresh"
```

---

### Task 9: `tools.ts` — the five model-facing tools

**Files:**
- Modify: `packages/dsh/src/tools.ts`
- Test: `packages/dsh/test/tools.test.ts`

**Interfaces:**
- Consumes: `Config`, `Counters`, `PlurLike`.
- Produces: `registerTools(ctx: Context, deps: { config: Config; counters: Counters; plur?: PlurLike }): void`

- [ ] **Step 1: Write the failing test**

```ts
// packages/dsh/test/tools.test.ts
import { describe, expect, it, vi } from 'vitest'
import { Config } from '../src/config.ts'
import { createCounters } from '../src/counters.ts'
import { registerTools } from '../src/tools.ts'

function collect(plur?: any) {
  const tools: any[] = []
  const ctx = { tools: { register: (d: any) => { tools.push(d); return () => {} } } }
  registerTools(ctx as any, { config: new Config({}), counters: createCounters(), plur })
  return tools
}

describe('registerTools', () => {
  it('registers exactly five tools', () => {
    expect(collect()).toHaveLength(5)
  })

  it('every tool has a name, description and input schema', () => {
    for (const t of collect()) {
      expect(t.name).toMatch(/^plur_/)
      expect(t.description.length).toBeGreaterThan(20)
      expect(t.parameters).toBeDefined()
    }
  })

  it('plur_recall returns matches', async () => {
    const plur = { recall: vi.fn(async () => [{ id: 'ENG-1', statement: 'Pin your deps.' }]) }
    const recall = collect(plur).find(t => t.name === 'plur_recall')!
    const out: any = await recall.execute({ query: 'deps' }, {} as any)
    expect(String(out)).toContain('ENG-1')
  })

  it('a tool reports a failure instead of throwing into the host', async () => {
    const plur = { recall: async () => { throw new Error('store gone') } }
    const recall = collect(plur).find(t => t.name === 'plur_recall')!
    await expect(recall.execute({ query: 'x' }, {} as any)).resolves.toBeDefined()
  })

  it('plur_status reports counters without needing the model to guess', async () => {
    const status = collect().find(t => t.name === 'plur_status')!
    const out: any = await status.execute({}, {} as any)
    expect(String(out)).toContain('refresh_attempted')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @plur-ai/dsh test -- tools`
Expected: FAIL — `registerTools` registers nothing (stub from Task 8).

- [ ] **Step 3: Implement**

```ts
// packages/dsh/src/tools.ts
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.ts'
import type { Counters } from './counters.ts'
import { guard } from './guard.ts'
import type { PlurLike } from './index.ts'

interface Deps { config: Config; counters: Counters; plur?: PlurLike & Record<string, any> }

/**
 * Register the model-facing surface — exactly five tools.
 *
 * dsh bills every registered tool's schema on every request, so this set is
 * deliberately small. The other ~35 PLUR operations remain available through
 * @plur-ai/mcp for users who want them.
 */
export function registerTools(ctx: Context, deps: Deps): void {
  const { config, counters, plur } = deps
  const run = async (fn: () => Promise<unknown>): Promise<string> => {
    const out = await guard(fn, { timeoutMs: config.timeoutMs, onError: () => counters.bump('errors_swallowed') })
    return out === undefined ? 'PLUR is unavailable right now; continuing without memory.' : String(out)
  }

  ctx.tools.register({
    name: 'plur_recall',
    description: 'Search stored memory for engrams relevant to a query. Most relevant memories are already in your system prompt; use this for a targeted lookup beyond them.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'What to search for.' } }, required: ['query'] },
    execute: (args: any) => run(async () => {
      const results = await plur?.recall(String(args?.query ?? ''), { scope: config.scope, limit: 10 }) ?? []
      if (results.length === 0) return 'No matching engrams.'
      return results.map(r => `[${r.id}] ${r.statement}`).join('\n')
    }),
  })

  ctx.tools.register({
    name: 'plur_learn',
    description: 'Store a correction, preference, or durable fact so it is remembered in future sessions.',
    parameters: { type: 'object', properties: { statement: { type: 'string' }, domain: { type: 'string' } }, required: ['statement'] },
    execute: (args: any) => run(async () => {
      await plur?.learn?.({ statement: String(args?.statement ?? ''), domain: args?.domain, scope: config.scope })
      counters.bump('learn_captured')
      return 'Stored.'
    }),
  })

  ctx.tools.register({
    name: 'plur_forget',
    description: 'Retire an engram that is wrong or out of date, by its ID.',
    parameters: { type: 'object', properties: { id: { type: 'string' }, reason: { type: 'string' } }, required: ['id'] },
    execute: (args: any) => run(async () => {
      await plur?.forget?.(String(args?.id ?? ''), args?.reason)
      return 'Retired.'
    }),
  })

  ctx.tools.register({
    name: 'plur_feedback',
    description: 'Rate whether a memory shown to you was useful. This trains what surfaces next time.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, signal: { type: 'string', enum: ['positive', 'negative'] } },
      required: ['id', 'signal'],
    },
    execute: (args: any) => run(async () => {
      await plur?.feedback?.(String(args?.id ?? ''), args?.signal === 'negative' ? -1 : 1)
      return 'Recorded.'
    }),
  })

  ctx.tools.register({
    name: 'plur_status',
    description: 'Report memory-system health and this session\'s memory activity counters.',
    parameters: { type: 'object', properties: {} },
    execute: () => run(async () => {
      const snapshot = counters.snapshot()
      const lines = Object.entries(snapshot).map(([k, v]) => `${k}: ${v}`)
      return [`scope: ${config.scope}`, `injection: ${config.injectionMode}`, ...lines].join('\n')
    }),
  })
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @plur-ai/dsh test -- tools`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/dsh/src/tools.ts packages/dsh/test/tools.test.ts
git commit -m "feat(dsh): five model-facing tools with guarded execution"
```

---

### Task 10: `learn.ts` and `capture.ts` — auto-learn, episodes, learn-before-compaction

**Files:**
- Create: `packages/dsh/src/learn.ts`
- Create: `packages/dsh/src/capture.ts`
- Modify: `packages/dsh/src/index.ts` (wire both)
- Test: `packages/dsh/test/learn.test.ts`

**Interfaces:**
- Consumes: `guard`, `createWriteQueue`, `lastAssistantText`, `Counters`.
- Produces:
  - `detectLearning(text: string): { statement: string; confidence: number } | undefined`
  - `registerLearning(ctx, deps): void` — subscribes to `session/event`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/dsh/test/learn.test.ts
import { describe, expect, it, vi } from 'vitest'
import { detectLearning, registerLearning } from '../src/learn.ts'
import { Config } from '../src/config.ts'
import { createCounters } from '../src/counters.ts'

describe('detectLearning', () => {
  it('catches an explicit correction', () => {
    expect(detectLearning('No, use pnpm not npm here.')?.confidence).toBeGreaterThanOrEqual(0.7)
  })

  it('catches an always/never rule', () => {
    expect(detectLearning('Always pin the dsh packages to one release line.')).toBeDefined()
  })

  it('ignores short chatter', () => {
    expect(detectLearning('ok')).toBeUndefined()
    expect(detectLearning('thanks!')).toBeUndefined()
  })

  it('ignores a plain question', () => {
    expect(detectLearning('What does this function do?')).toBeUndefined()
  })
})

describe('registerLearning', () => {
  function harness(plur: any, config = new Config({})) {
    const listeners: Function[] = []
    const ctx = { on: (e: string, fn: Function) => { if (e === 'session/event') listeners.push(fn); return () => {} } }
    registerLearning(ctx as any, { config, counters: createCounters(), plur })
    return (event: any) => Promise.all(listeners.map(fn => fn({ id: 's1' }, event)))
  }

  it('learns from a user correction', async () => {
    const plur = { learn: vi.fn(async () => {}) }
    const fire = harness(plur)
    await fire({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Always pin the dsh packages.' }] } })
    await vi.waitFor(() => expect(plur.learn).toHaveBeenCalled())
  })

  it('ignores plugin-sourced messages so it never learns from its own injection', async () => {
    const plur = { learn: vi.fn(async () => {}) }
    const fire = harness(plur)
    await fire({ type: 'user/message', data: { source: { kind: 'plugin', plugin: 'plur' }, content: [{ type: 'text', text: 'Always pin the dsh packages.' }] } })
    expect(plur.learn).not.toHaveBeenCalled()
  })

  it('does nothing when autoLearn is off', async () => {
    const plur = { learn: vi.fn(async () => {}) }
    const fire = harness(plur, new Config({ autoLearn: false }))
    await fire({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Always pin the dsh packages.' }] } })
    expect(plur.learn).not.toHaveBeenCalled()
  })

  it('a throwing store does not surface to the caller', async () => {
    const fire = harness({ learn: async () => { throw new Error('down') } })
    await expect(fire({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Always pin things.' }] } })).resolves.toBeDefined()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @plur-ai/dsh test -- learn`
Expected: FAIL — cannot resolve `../src/learn.ts`.

- [ ] **Step 3: Implement**

```ts
// packages/dsh/src/learn.ts
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.ts'
import type { Counters } from './counters.ts'
import { createWriteQueue, guard } from './guard.ts'

/** High-precision correction and rule patterns, ported from @plur-ai/claw's learner. */
const PATTERNS: readonly RegExp[] = [
  /\bno,?\s+(?:use|do|it'?s|that'?s)\b/i,
  /\b(?:always|never)\s+\w+/i,
  /\buse\s+\S+\s+not\s+\S+/i,
  /\bthe right way (?:to|is)\b/i,
  /\b(?:actually|correction),?\s+/i,
  /\bdon'?t\s+\w+.*\binstead\b/i,
]

const MIN_LENGTH = 10
const MAX_LENGTH = 500

/**
 * Decide whether one message states something worth remembering.
 *
 * Deliberately conservative: a false positive is an engram that is wrong
 * forever, a false negative is usually caught by the next correction.
 */
export function detectLearning(text: string): { statement: string; confidence: number } | undefined {
  const trimmed = text.trim()
  if (trimmed.length < MIN_LENGTH || trimmed.length > MAX_LENGTH) return undefined
  if (trimmed.endsWith('?')) return undefined
  for (const sentence of trimmed.split(/(?<=[.!])\s+/)) {
    if (PATTERNS.some(p => p.test(sentence))) {
      return { statement: sentence.trim(), confidence: 0.75 }
    }
  }
  return undefined
}

interface Deps { config: Config; counters: Counters; plur?: Record<string, any> }

/**
 * Subscribe correction detection to the durable event feed.
 *
 * `session/event` is an emit-mode feed whose listener failures dsh contains, and
 * writes are queued so two live sessions cannot interleave a read-modify-write
 * against the same YAML store.
 */
export function registerLearning(ctx: Context, deps: Deps): void {
  const { config, counters, plur } = deps
  if (!config.autoLearn) return
  const queue = createWriteQueue()

  ctx.on('session/event', (_session: unknown, event: any) => {
    if (event?.type !== 'user/message') return
    const data = event.data
    if (data?.source?.kind !== 'user') return
    const text = (data.content ?? [])
      .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text).join('\n')
    const candidate = detectLearning(text)
    if (!candidate) return
    // Fire-and-forget: the turn must never wait on a write.
    void queue(() => guard(async () => {
      await plur?.learn?.({ statement: candidate.statement, scope: config.scope, confidence: candidate.confidence })
      counters.bump('learn_captured')
    }, { timeoutMs: config.timeoutMs, onError: () => counters.bump('errors_swallowed') }))
  })
}
```

```ts
// packages/dsh/src/capture.ts
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.ts'
import type { Counters } from './counters.ts'
import { createWriteQueue, guard } from './guard.ts'
import { lastAssistantText } from './session-log.ts'

interface Deps { config: Config; counters: Counters; plur?: Record<string, any> }

/**
 * Episode capture on turn end, plus learning from content about to be shadowed.
 *
 * NOTE: `compaction/start` is a SessionEventMap entry, not a Cordis event —
 * `ctx.on('compaction/start', ...)` does not exist. It is filtered out of the
 * `session/event` feed. It fires before summarisation, so the pre-shadow content
 * is still readable here.
 */
export function registerCapture(ctx: Context, deps: Deps): void {
  const { config, counters, plur } = deps
  if (!config.autoCapture) return
  const queue = createWriteQueue()
  const opts = { timeoutMs: config.timeoutMs, onError: () => counters.bump('errors_swallowed') }

  ctx.on('agent/turn-stopping', (agent: any) => {
    const summary = lastAssistantText(agent?.session?.events ?? [])
    if (!summary) return
    void queue(() => guard(() => plur?.capture?.({ summary: summary.slice(0, 2000), scope: config.scope }), opts))
  })

  ctx.on('session/event', (session: any, event: any) => {
    if (event?.type !== 'compaction/start') return
    void queue(() => guard(() => plur?.compactLearn?.({
      events: session?.events ?? [],
      scope: config.scope,
    }), opts))
  })
}
```

Wire both into `apply()` in `src/index.ts`, immediately after `registerTools(...)`:

```ts
import { registerLearning } from './learn.ts'
import { registerCapture } from './capture.ts'
// ...
registerTools(ctx, { config, counters, plur })
registerLearning(ctx, { config, counters, plur })
registerCapture(ctx, { config, counters, plur })
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @plur-ai/dsh test`
Expected: PASS — all suites green.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh/src/learn.ts packages/dsh/src/capture.ts packages/dsh/src/index.ts packages/dsh/test/learn.test.ts
git commit -m "feat(dsh): auto-learn, episode capture, learn-before-compaction"
```

---

### Task 11: Skills, commands, and the cross-host format snapshot

**Files:**
- Create: `packages/dsh/src/skills.ts`
- Create: `packages/dsh/src/commands.ts`
- Modify: `packages/dsh/src/index.ts`
- Test: `packages/dsh/test/format-parity.test.ts`

**Interfaces:**
- Consumes: `Config`, `Counters`, `renderBlock`.
- Produces: `registerSkills(ctx, deps)`, `registerCommands(ctx, deps)`.

- [ ] **Step 1: Write the failing parity test**

```ts
// packages/dsh/test/format-parity.test.ts
import { describe, expect, it } from 'vitest'
import { renderBlock } from '../src/memory-section.ts'

// "Identical output across hosts" is claimed as a PLUR principle in the spec,
// so it is enforced here rather than assumed.
describe('rendered block format', () => {
  it('matches the claw/MCP block shape', () => {
    const block = renderBlock([
      { id: 'ENG-1', statement: 'High confidence thing.', domain: 'software', confidence: 0.9 },
      { id: 'ENG-2', statement: 'Lower confidence thing.', confidence: 0.3 },
    ], 2000)
    expect(block).toMatchInlineSnapshot(`
      "## DIRECTIVES

      [ENG-1] High confidence thing.
        Domain: software

      ## ALSO CONSIDER

      [ENG-2] Lower confidence thing."
    `)
  })
})
```

- [ ] **Step 2: Run it to verify it fails or records**

Run: `pnpm --filter @plur-ai/dsh test -- format-parity`
Expected: FAIL if the shape differs from the inline snapshot. Fix `renderBlock`, not the snapshot, if claw's format differs — check `packages/claw/src/assembler.ts` and make them agree.

- [ ] **Step 3: Implement skills and commands**

```ts
// packages/dsh/src/skills.ts
import type { Context } from '@deepseek-ai/cordis'

const SKILL_BODY = `Use PLUR memory deliberately.

Relevant memories are already injected into your system prompt under
"## DIRECTIVES" and "## ALSO CONSIDER" — you do not need to call a tool to see them.

- Call \`plur_recall\` only for a targeted lookup beyond what is already shown.
- Call \`plur_learn\` when the user corrects you or states a durable preference.
- Call \`plur_feedback\` when an injected memory was useful or misleading.
- Call \`plur_forget\` when a memory is wrong or out of date.
`

/** Contribute the plur-memory skill at runtime — no filesystem provider needed. */
export function registerSkills(ctx: Context): void {
  ctx.skills?.register?.({
    name: 'plur-memory',
    description: 'How to use PLUR persistent memory in this session.',
    body: SKILL_BODY,
  })
}
```

```ts
// packages/dsh/src/commands.ts
import type { Context } from '@deepseek-ai/cordis'
import type { Counters } from './counters.ts'
import type { Config } from './config.ts'

/** Human commands, dispatched without spending a model turn. */
export function registerCommands(ctx: Context, deps: { config: Config; counters: Counters }): void {
  ctx.commands?.register?.({
    name: 'plur',
    description: 'PLUR memory status and diagnostics.',
    execute: () => {
      const snapshot = deps.counters.snapshot()
      return [
        `scope: ${deps.config.scope}`,
        `injection: ${deps.config.injectionMode}`,
        ...Object.entries(snapshot).map(([k, v]) => `${k}: ${v}`),
      ].join('\n')
    },
  })
}
```

Wire both in `apply()` after `registerCapture(...)`:

```ts
import { registerSkills } from './skills.ts'
import { registerCommands } from './commands.ts'
// ...
registerSkills(ctx)
registerCommands(ctx, { config, counters })
```

- [ ] **Step 4: Run the full suite**

Run: `pnpm --filter @plur-ai/dsh test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh/src/skills.ts packages/dsh/src/commands.ts packages/dsh/src/index.ts packages/dsh/test/format-parity.test.ts
git commit -m "feat(dsh): plur-memory skill, /plur command, cross-host format parity test"
```

---

### Task 12: Deterministic end-to-end against a real dsh runtime

**Files:**
- Create: `packages/dsh/test/e2e/replay.e2e.test.ts`
- Modify: `packages/dsh/vitest.config.ts` (exclude `e2e` from the default run)
- Modify: `packages/dsh/package.json` (add `"test:e2e": "vitest run --config vitest.e2e.config.ts"`)
- Create: `packages/dsh/vitest.e2e.config.ts`

This is the layer that proves the thesis: the block reaches the model, and a multi-turn session does **not** accrete.

**Interfaces:**
- Consumes: the built plugin.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing E2E test**

```ts
// packages/dsh/test/e2e/replay.e2e.test.ts
import { describe, expect, it } from 'vitest'
import { startReplayHarness } from './harness.ts'

describe('dsh end-to-end (llm-replay)', () => {
  it('puts the memory block in the system prompt, not in the messages', async () => {
    const h = await startReplayHarness({ engrams: [{ id: 'ENG-1', statement: 'Deploy with pnpm.' }] })
    await h.prompt('How do I deploy?')
    const header = h.lastRequestHeader()
    expect(header.system).toContain('[ENG-1] Deploy with pnpm.')
    const injected = h.sessionEvents().filter(e =>
      e.type === 'user/message' && (e.data as any)?.source?.plugin === 'plur')
    expect(injected).toHaveLength(0)   // THE regression guard for spec §1
    await h.dispose()
  })

  it('does not accrete across ten turns', async () => {
    const h = await startReplayHarness({ engrams: [{ id: 'ENG-1', statement: 'Deploy with pnpm.' }] })
    for (let i = 0; i < 10; i++) await h.prompt(`question ${i}`)
    const occurrences = h.lastRequestHeader().system.split('[ENG-1]').length - 1
    expect(occurrences).toBe(1)
    await h.dispose()
  })

  it('keeps two sessions on their own scopes', async () => {
    const h = await startReplayHarness({ multiSession: true })
    const [a, b] = await Promise.all([h.prompt('a', 's1'), h.prompt('b', 's2')])
    expect(a.scopeUsed).not.toBe(b.scopeUsed)
    await h.dispose()
  })

  it('degrades to no block when the store is unreadable, without failing the turn', async () => {
    const h = await startReplayHarness({ brokenStore: true })
    const reply = await h.prompt('still works?')
    expect(reply.ok).toBe(true)
    expect(h.lastRequestHeader().system).not.toContain('## DIRECTIVES')
    await h.dispose()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @plur-ai/dsh test:e2e`
Expected: FAIL — `./harness.ts` does not exist.

- [ ] **Step 3: Build the harness**

Write `packages/dsh/test/e2e/harness.ts` that boots a minimal Cordis context with `@deepseek-ai/dsh-llm-replay@0.1.0-rc.6` as the LLM adapter, mounts this plugin plus `dsh-agent`, `dsh-session`, `dsh-tools`, and `dsh-system-prompt`, and exposes:
- `prompt(text, sessionId?)` — submits a user message and resolves when the turn ends
- `lastRequestHeader()` — folds `request/header` from the session log
- `sessionEvents()` — the raw event array
- `dispose()`

Model the boot on `packages/bundle/headless/` in the dsh clone and the replay adapter's own tests. Record one fixture stream; the model's reply content is irrelevant — the assertions are all on the request side.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @plur-ai/dsh test:e2e`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/dsh/test/e2e packages/dsh/vitest.e2e.config.ts packages/dsh/vitest.config.ts packages/dsh/package.json
git commit -m "test(dsh): deterministic e2e proving prompt-section injection and no accretion"
```

---

### Task 13: README with the provider disclosure

**Files:**
- Create: `packages/dsh/README.md`
- Create: `packages/dsh/README.zh.md`
- Modify: `packages/dsh/test/manifest.test.ts` (assert the install command and disclosure are present)

**Interfaces:** none.

- [ ] **Step 1: Extend the manifest test**

```ts
// append to packages/dsh/test/manifest.test.ts
import { existsSync } from 'node:fs'

describe('README', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')

  it('documents the exact install command', () => {
    expect(readme).toContain('dsh plugin --profile web add @plur-ai/dsh')
  })

  it('discloses that memories are sent to the configured model provider', () => {
    expect(readme.toLowerCase()).toContain('model provider')
    expect(readme).toContain('DeepSeek')
  })

  it('ships a Chinese README, matching the ecosystem convention', () => {
    expect(existsSync(join(root, 'README.zh.md'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @plur-ai/dsh test -- manifest`
Expected: FAIL — README.md missing.

- [ ] **Step 3: Write the READMEs**

`README.md` must contain, at minimum: the one-line pitch, the install command
`dsh plugin --profile web add @plur-ai/dsh`, a "How it works" section stating that memories
land in the system prompt with no tool call, the five tools, the config table, the
published LongMemEval numbers, and this disclosure block verbatim:

```markdown
## What leaves your machine

PLUR stores everything locally in `~/.plur` and searches it locally. But injected
memories become part of the prompt your agent sends to **your configured model
provider** — for a default DeepSeek Harness install, that is DeepSeek's hosted API.

By default this plugin reads only the `project:dsh` scope, not your whole memory
store. Widen it deliberately with `scope:`, narrow it any time, or set
`injectionMode: off` to disable injection entirely.
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @plur-ai/dsh test -- manifest`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh/README.md packages/dsh/README.zh.md packages/dsh/test/manifest.test.ts
git commit -m "docs(dsh): README with install command and provider disclosure"
```

---

### Task 14: Release track

**Files:**
- Modify: `scripts/release.sh`
- Modify: `RELEASING.md`
- Modify: `packages/dsh/src/index.ts` (add `export const VERSION = '0.1.0'`)
- Test: `packages/dsh/test/manifest.test.ts` (version agreement)

**Interfaces:** none.

- [ ] **Step 1: Add the version-agreement test**

```ts
// append to packages/dsh/test/manifest.test.ts
import { VERSION } from '../src/index.ts'

it('keeps the exported VERSION in step with package.json', () => {
  expect(VERSION).toBe(pkg.version)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @plur-ai/dsh test -- manifest`
Expected: FAIL — `VERSION` is not exported.

- [ ] **Step 3: Add the track**

Add `export const VERSION = '0.1.0'` to `src/index.ts`. Then in `scripts/release.sh`, mirror the existing claw block exactly — add `--dsh <ver>` to the usage comment and arg parser, and a bump block:

```bash
# dsh is on an independent version track — only bump if --dsh was provided
if [ -n "$DSH_VERSION" ]; then
  echo "  --- dsh bumps (independent track: $DSH_VERSION) ---"
  node -e "
    const fs = require('fs');
    const path = './packages/dsh/package.json';
    const pkg = JSON.parse(fs.readFileSync(path));
    pkg.version = '$DSH_VERSION';
    fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
  "
  echo "  ✓ packages/dsh/package.json"
  sed -i '' "s/export const VERSION = '.*'/export const VERSION = '$DSH_VERSION'/" packages/dsh/src/index.ts
  echo "  ✓ packages/dsh/src/index.ts"
fi
```

In `RELEASING.md`, add a "dsh track" subsection listing those two files under the manifest gate.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @plur-ai/dsh test -- manifest` → PASS.
Run: `bash scripts/release.sh 0.17.3 --dsh 0.1.0 --dry-run` → shows the dsh bumps and touches nothing else.

- [ ] **Step 5: Commit**

```bash
git add scripts/release.sh RELEASING.md packages/dsh/src/index.ts packages/dsh/test/manifest.test.ts
git commit -m "build(dsh): independent version track in release.sh and the manifest gate"
```

---

### Task 15: Web UI tab (cuttable)

**Files:**
- Create: `packages/dsh/src/client/index.ts`
- Modify: `packages/dsh/package.json` (add the `dsh.client` entry, second tsup entry)

Built last on purpose. If the schedule slips, **cut this task** — Task 7's counters and Task 11's `/plur` command already provide the debugging surface, so nothing else depends on it.

- [ ] **Step 1: Register one tab behind `tabEnabled`**

Follow `dsh-memory-evolve`'s pattern: `ctx.slots.inject('conversation.view', () => …)` from a client module, declared via `"dsh": { "client": { "inject": ["@deepseek-ai/dsh-client-runtime"], "platform": "web" } }` in `package.json`. Render three things only: the current session's cached block, a search box wired to `plur_recall`, and an injection on/off toggle.

- [ ] **Step 2: Respect the scope gate**

The tab renders engram content inside a third-party UI, so it shows only the resolved session scope — never a global listing.

- [ ] **Step 3: Commit**

```bash
git add packages/dsh/src/client packages/dsh/package.json
git commit -m "feat(dsh): web memory tab behind tabEnabled"
```

---

## Self-review

**Spec coverage.** §1 memory section → Tasks 4, 6, 8, 12. §2 scope resolution → Task 5. §3 scope gate and disclosure → Tasks 1 (default `project:dsh`), 5, 13. §4 learn/capture/compaction → Task 10. §5 subagent propagation → **deliberately deferred**: the spec says it ships only with a passing layer-3 test proving the child's first assembly inherits scope; that test is not in Task 12 and the feature is therefore out of v1. §6 five tools → Task 9. §7 skills/commands/counters/tab → Tasks 7, 11, 15. §8 config → Task 1. §9 failure discipline → Task 2, enforced in Tasks 8–10. Testing layers 1–4 → Tasks 2–7 (unit), 8–10 (contract), 12 (E2E), 1/13/14 (manifest). Release → Task 14.

**Placeholders.** None: every code step carries real code. Task 12 step 3 and Task 15 describe harness/UI construction in prose rather than full source, because both must be written against APIs whose exact shape is only knowable with the packages installed — each names the reference implementation to copy.

**Type consistency.** `EngramLike` is defined in Task 4 and imported by Tasks 8 and 9. `PlurLike` is defined in Task 8 and imported by Task 9. `Counters`/`CounterKey` from Task 7 flow into 8, 9, 10, 11. `MemoryCache.write` returns `boolean` in Task 4 and is consumed as a boolean in Task 8. `createScopeResolver` takes `(config, readWorkspaceScope)` in Task 5 and is called that way in Task 8.

**One open dependency.** Task 8 imports `registerTools` from Task 9; the plan stubs it to keep Task 8 green. If executing strictly in order, create the stub as instructed.
