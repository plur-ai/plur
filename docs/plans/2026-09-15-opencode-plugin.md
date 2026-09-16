# `@plur-ai/opencode` Implementation Plan

> **SUPERSEDED where it conflicts with the shipped code.** This plan is the
> pre-implementation design record, not the current source of truth — for that,
> read `packages/opencode/ARCHITECTURE.md` and
> `docs/specs/2026-09-15-opencode-plugin-design.md`. Several code samples below
> were found defective during execution and corrected in the implementation:
> a learn-path sample that fed `role: 'assistant'` into `extractLearnings`
> (which skips everything where `role !== 'user'`, so it would have learned
> nothing), an `InjectOptions.cwd` option that does not exist, and a config
> writer placed in the wrong package. The corrections live in a gitignored
> ledger, not here.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@plur-ai/opencode`, an in-process opencode plugin that gives every opencode session automatic PLUR memory — recall injected into the system prompt once per turn, learnings extracted after it — with no accretion in the transcript.

**Architecture:** `chat.message` fires once per user turn and is used as the *recall trigger*: it runs `injectHybrid()` and stores a rendered block in a per-session cache, but injects nothing. `experimental.chat.system.transform` fires once per model request and is the *renderer*: it pushes the cached block into `system[]` in O(1). This split is forced by measurement — injecting at `chat.message` accretes one stale block per turn, permanently; the system array is rebuilt fresh every request. Learning hangs off `event`/`session.idle` (debounced) and `experimental.session.compacting`, both fire-and-forget so no PLUR call ever blocks an agent turn.

**Tech Stack:** TypeScript, `@opencode-ai/plugin` (peer), `@plur-ai/core` (`workspace:*`), tsup, Vitest, pnpm workspaces.

**Spec:** `docs/specs/2026-09-15-opencode-plugin-design.md` — read it first; it carries the probe evidence every decision here rests on.

## Global Constraints

- **Harness floor:** opencode `>= 1.18.0`, `@opencode-ai/plugin` `>= 1.18.0`. Contract verified at exactly **1.18.30**; record that in the README.
- **Version track:** `@plur-ai/opencode` is on an **independent track starting at `0.1.0`**, following the `dsh` precedent (`scripts/release.sh --dsh`). It is *not* bumped in lockstep with core. It ships **with** the 0.20 train; its own version is 0.1.0.
- **No AI attribution** in commits, PRs, or issue comments — no `Co-Authored-By:` lines, no generated-with footers. Repo rule, `CLAUDE.md` § Conventions.
- **Claim before you code:** `gh issue edit <n> --add-assignee @me` before starting.
- **No external API calls in core.** The adapter must work fully offline.
- **Never throw into the host.** Every hook body wrapped; a PLUR failure degrades to no-memory, never a broken turn.
- **Never block the turn.** Learn/capture are fire-and-forget (`void p.catch(...)`), as in claw.
- **Claw imports core's built dist.** After changing core: `pnpm --filter @plur-ai/core build` before running dependent tests.
- **License:** Apache-2.0. Tests in `packages/opencode/test/*.test.ts`.

## File Structure

| File | Responsibility |
|---|---|
| `packages/core/src/memory-block.ts` | **New, shared.** `renderMemoryBlock()` — `InjectionResult` → system-prompt text. Extracted from claw so two adapters render identically. |
| `packages/opencode/src/index.ts` | Plugin export; hook wiring only. No logic. |
| `packages/opencode/src/block.ts` | Per-session cached block: set on turn start, read on every render, cleared on dispose. |
| `packages/opencode/src/capability.ts` | Runtime detection of `system.transform`; picks render path vs fallback. |
| `packages/opencode/src/turn.ts` | Per-session assistant-text accumulation + `session.idle` debounce. |
| `packages/opencode/src/learn.ts` | Turn transcript → `learnRouted()` calls. Wraps core/claw learner. |
| `packages/opencode/src/scope.ts` | Session scope: prefers a real `worktree`, falls back to `directory` (never trusts the degenerate `worktree = "/"`). |
| `packages/opencode/src/setup.ts` | Writes `plugin` + `mcp` entries into `opencode.json`. |
| `packages/opencode/src/version.ts` | `OPENCODE_PLUGIN_VERSION` — the one place the version is written. |

---

### Task 1: Extract the shared memory-block renderer into core

Claw's `assembleContext` contains `PLUR_MEMORY_INSTRUCTIONS` and the engram
formatting. opencode needs byte-identical output. Copying 133 lines would give
us two divergent copies of the memory instructions. Extract the renderer; leave
claw's message-shaped wrapper alone.

**Files:**
- Create: `packages/core/src/memory-block.ts`
- Modify: `packages/core/src/index.ts` (add export)
- Modify: `packages/claw/src/assembler.ts:48-130` (delegate to the shared renderer)
- Test: `packages/core/test/memory-block.test.ts`

**Interfaces:**
- Consumes: `InjectionResult` from `@plur-ai/core`.
- Produces: `renderMemoryBlock(params: { injection: InjectionResult | null; tokenBudget?: number; usedTokens?: number }): string` — returns the full system-prompt section (instructions + memories), or just the instructions when `injection` is null/empty. Exported from `@plur-ai/core`. Task 4 and Task 5 both call it.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/test/memory-block.test.ts
import { describe, it, expect } from 'vitest'
import { renderMemoryBlock } from '../src/memory-block.js'

describe('renderMemoryBlock', () => {
  it('returns the instructions block when there is no injection', () => {
    const out = renderMemoryBlock({ injection: null })
    expect(out).toContain('[PLUR Memory System]')
    expect(out).not.toContain('## Your Memories')
  })

  it('appends directives under a Your Memories heading', () => {
    const out = renderMemoryBlock({
      injection: { count: 1, directives: '[ENG-1] Always use pnpm.', constraints: '', text: '' } as any,
    })
    expect(out).toContain('## Your Memories')
    expect(out).toContain('[ENG-1] Always use pnpm.')
  })

  it('omits directives when the token budget cannot fit them', () => {
    const out = renderMemoryBlock({
      injection: { count: 1, directives: '[ENG-1] Always use pnpm.', constraints: '', text: '' } as any,
      tokenBudget: 10,
      usedTokens: 10,
    })
    expect(out).not.toContain('[ENG-1] Always use pnpm.')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/core/test/memory-block.test.ts`
Expected: FAIL — `Cannot find module '../src/memory-block.js'`

- [ ] **Step 3: Create the module**

Move `PLUR_MEMORY_INSTRUCTIONS` verbatim from `packages/claw/src/assembler.ts`
into the new file — do not retype or reword it; the wording is the product.

```typescript
// packages/core/src/memory-block.ts
import type { InjectionResult } from './index.js'

/** Copied verbatim from packages/claw/src/assembler.ts — do not reword. */
export const PLUR_MEMORY_INSTRUCTIONS = `[PLUR Memory System]
...` // ← paste the exact existing constant here

export function renderMemoryBlock(params: {
  injection: InjectionResult | null
  tokenBudget?: number
  usedTokens?: number
}): string {
  const { injection, tokenBudget, usedTokens = 0 } = params
  const sections: string[] = [PLUR_MEMORY_INSTRUCTIONS]

  if (injection && injection.count > 0) {
    const instructionTokens = Math.ceil(PLUR_MEMORY_INSTRUCTIONS.length / 4)
    const remaining = tokenBudget ? tokenBudget - usedTokens - instructionTokens : Infinity
    const lines: string[] = ['## Your Memories', '']

    if (injection.directives && remaining > 0) {
      lines.push('These are things you have learned and should apply:', '', injection.directives, '')
    }
    if (injection.constraints) {
      const used = Math.ceil(lines.join('\n').length / 4)
      if (remaining - used > 100) lines.push(injection.constraints, '')
    }
    if (lines.length > 2) sections.push(lines.join('\n'))
  }

  return sections.join('\n\n')
}
```

- [ ] **Step 4: Export it from core**

Add to `packages/core/src/index.ts`, next to the other re-exports:

```typescript
export { renderMemoryBlock, PLUR_MEMORY_INSTRUCTIONS } from './memory-block.js'
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test -- packages/core/test/memory-block.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Refactor claw to delegate**

In `packages/claw/src/assembler.ts`, delete the local `PLUR_MEMORY_INSTRUCTIONS`
and the section-building block, and build `systemPromptAddition` from the shared
renderer, passing the message-token estimate it already computes:

```typescript
import { renderMemoryBlock } from '@plur-ai/core'
// ...inside assembleContext, replacing the sections[] construction:
const systemPromptAddition = renderMemoryBlock({
  injection,
  tokenBudget: params.tokenBudget,
  usedTokens: messageTokens,
})
```

- [ ] **Step 7: Rebuild core, then prove claw is unchanged**

Claw imports core's built dist, so the rebuild is mandatory.

Run: `pnpm --filter @plur-ai/core build && pnpm test -- packages/claw/test/assembler.test.ts`
Expected: PASS with no snapshot or assertion changes. **If any claw assertion
changes, the extraction altered behaviour — revert and reconcile before
continuing.** Claw is a shipped package; this task must be behaviour-neutral.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/memory-block.ts packages/core/src/index.ts \
        packages/core/test/memory-block.test.ts packages/claw/src/assembler.ts
git commit -m "refactor(core): extract renderMemoryBlock, shared by claw and opencode"
```

---

### Task 2: Package scaffold and version parity

**Files:**
- Create: `packages/opencode/package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`
- Create: `packages/opencode/src/version.ts`, `packages/opencode/src/index.ts`
- Test: `packages/opencode/test/version-parity.test.ts`

**Interfaces:**
- Produces: `OPENCODE_PLUGIN_VERSION: string` from `src/version.ts`; a default-exported plugin factory `PlurPlugin` from `src/index.ts`. Tasks 4–9 all extend `src/index.ts`.

- [ ] **Step 1: Write the failing test**

Mirrors `packages/claw/test/version-parity.test.ts` — same guard, new package.

```typescript
// packages/opencode/test/version-parity.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OPENCODE_PLUGIN_VERSION } from '../src/version.js'

describe('opencode plugin version parity', () => {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
  ) as { version: string }

  it('src/version.ts matches package.json', () => {
    expect(OPENCODE_PLUGIN_VERSION).toBe(pkg.version)
  })

  it('index.ts imports the constant rather than repeating it', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8')
    expect(src).toContain("from './version.js'")
    expect(src).not.toMatch(/version: '\d+\.\d+\.\d+'/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/opencode/test/version-parity.test.ts`
Expected: FAIL — package does not exist

- [ ] **Step 3: Write package.json**

```json
{
  "name": "@plur-ai/opencode",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist"],
  "scripts": { "build": "tsup", "test": "vitest run" },
  "dependencies": { "@plur-ai/core": "workspace:*" },
  "peerDependencies": { "@opencode-ai/plugin": ">=1.18.0" },
  "peerDependenciesMeta": { "@opencode-ai/plugin": { "optional": true } },
  "devDependencies": { "@opencode-ai/plugin": "1.18.30", "@types/node": "^22.0.0" },
  "license": "Apache-2.0",
  "description": "PLUR memory plugin for opencode — persistent learning across sessions",
  "keywords": ["ai", "memory", "opencode", "plugin", "agent", "learning"],
  "homepage": "https://plur.ai",
  "repository": { "type": "git", "url": "https://github.com/plur-ai/plur", "directory": "packages/opencode" },
  "author": "PLUR <info@plur.ai>",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } }
}
```

- [ ] **Step 4: Write version.ts and a minimal index.ts**

```typescript
// packages/opencode/src/version.ts
/**
 * The opencode plugin's own version — the single place it is written down.
 * `test/version-parity.test.ts` fails the suite if this and package.json
 * disagree. Bumped by `scripts/release.sh --opencode`.
 */
export const OPENCODE_PLUGIN_VERSION = '0.1.0'
```

```typescript
// packages/opencode/src/index.ts
import { OPENCODE_PLUGIN_VERSION } from './version.js'

export const PlurPlugin = async (_ctx: any) => {
  void OPENCODE_PLUGIN_VERSION
  return {}
}

export default PlurPlugin
```

- [ ] **Step 5: Copy tsconfig.json, tsup.config.ts and vitest.config.ts from claw**

Run: `cp packages/claw/tsconfig.json packages/claw/tsup.config.ts packages/claw/vitest.config.ts packages/opencode/`
Then open each and replace any `claw` string with `opencode`.

- [ ] **Step 6: Install and run tests**

Run: `pnpm install && pnpm test -- packages/opencode/test/version-parity.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 7: Commit**

```bash
git add packages/opencode pnpm-lock.yaml
git commit -m "feat(opencode): package scaffold and version parity guard"
```

---

### Task 3: Per-session block cache

The cache is what makes the split architecture cheap: recall writes it once per
turn, the renderer reads it on every model request.

**Files:**
- Create: `packages/opencode/src/block.ts`
- Test: `packages/opencode/test/block.test.ts`

**Interfaces:**
- Produces: `class BlockCache` with `set(sessionID: string, block: string): void`, `get(sessionID: string): string | undefined`, `clear(sessionID: string): void`, `clearAll(): void`. Task 4 constructs one per plugin instance.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/opencode/test/block.test.ts
import { describe, it, expect } from 'vitest'
import { BlockCache } from '../src/block.js'

describe('BlockCache', () => {
  it('returns undefined for an unknown session', () => {
    expect(new BlockCache().get('ses_x')).toBeUndefined()
  })

  it('round-trips a block per session', () => {
    const c = new BlockCache()
    c.set('ses_a', 'A')
    c.set('ses_b', 'B')
    expect(c.get('ses_a')).toBe('A')
    expect(c.get('ses_b')).toBe('B')
  })

  it('overwrites on a later turn rather than appending', () => {
    const c = new BlockCache()
    c.set('ses_a', 'turn1')
    c.set('ses_a', 'turn2')
    expect(c.get('ses_a')).toBe('turn2')
  })

  it('clears one session without touching others', () => {
    const c = new BlockCache()
    c.set('ses_a', 'A'); c.set('ses_b', 'B')
    c.clear('ses_a')
    expect(c.get('ses_a')).toBeUndefined()
    expect(c.get('ses_b')).toBe('B')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/opencode/test/block.test.ts`
Expected: FAIL — `Cannot find module '../src/block.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// packages/opencode/src/block.ts
/**
 * The rendered memory block for each live session.
 *
 * Written once per user turn by the recall trigger; read on every model
 * request by the renderer. Overwrite, never append — the whole point of the
 * system-prompt path is that it does not accrete.
 */
export class BlockCache {
  private blocks = new Map<string, string>()

  set(sessionID: string, block: string): void { this.blocks.set(sessionID, block) }
  get(sessionID: string): string | undefined { return this.blocks.get(sessionID) }
  clear(sessionID: string): void { this.blocks.delete(sessionID) }
  clearAll(): void { this.blocks.clear() }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- packages/opencode/test/block.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/block.ts packages/opencode/test/block.test.ts
git commit -m "feat(opencode): per-session rendered block cache"
```

---

### Task 4: Recall on `chat.message`, render on `system.transform`

The core deliverable. Recall runs once per turn; the system prompt is
re-rendered for free on each of that turn's model requests.

**Files:**
- Modify: `packages/opencode/src/index.ts`
- Test: `packages/opencode/test/hooks.test.ts`

**Interfaces:**
- Consumes: `BlockCache` (Task 3), `renderMemoryBlock` (Task 1).
- Produces: `PlurPlugin(ctx)` returning an object with `"chat.message"`, `"experimental.chat.system.transform"` and `dispose`. Tasks 5–8 add hooks to this same returned object.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/opencode/test/hooks.test.ts
import { describe, it, expect, vi } from 'vitest'
import { PlurPlugin } from '../src/index.js'

const fakePlur = () => ({
  injectHybrid: vi.fn().mockResolvedValue({ count: 1, directives: '[ENG-1] Use pnpm.', constraints: '', text: '' }),
})

describe('recall / render split', () => {
  it('chat.message runs recall but injects nothing into parts', async () => {
    const plur = fakePlur()
    const hooks = await PlurPlugin({ directory: '/tmp/p', _plur: plur } as any)
    const output = { message: { id: 'msg_1' }, parts: [{ id: 'prt_1', type: 'text', text: 'hi' }] }

    await hooks['chat.message']!({ sessionID: 'ses_1' } as any, output as any)

    expect(plur.injectHybrid).toHaveBeenCalledTimes(1)
    expect(output.parts).toHaveLength(1) // ← no accretion
  })

  it('system.transform pushes the cached block', async () => {
    const plur = fakePlur()
    const hooks = await PlurPlugin({ directory: '/tmp/p', _plur: plur } as any)
    await hooks['chat.message']!({ sessionID: 'ses_1' } as any,
      { message: { id: 'msg_1' }, parts: [] } as any)

    const out = { system: ['base prompt'] }
    await hooks['experimental.chat.system.transform']!({ sessionID: 'ses_1', model: {} } as any, out as any)

    expect(out.system).toHaveLength(2)
    expect(out.system[1]).toContain('[ENG-1] Use pnpm.')
  })

  it('renders the same cached block on repeated requests without re-running recall', async () => {
    const plur = fakePlur()
    const hooks = await PlurPlugin({ directory: '/tmp/p', _plur: plur } as any)
    await hooks['chat.message']!({ sessionID: 'ses_1' } as any,
      { message: { id: 'msg_1' }, parts: [] } as any)

    for (let i = 0; i < 3; i++) {
      const out = { system: ['base prompt'] }
      await hooks['experimental.chat.system.transform']!({ sessionID: 'ses_1', model: {} } as any, out as any)
      expect(out.system).toHaveLength(2) // always 1->2, never 1->3
    }
    expect(plur.injectHybrid).toHaveBeenCalledTimes(1)
  })

  it('a recall failure degrades to no memory rather than throwing', async () => {
    const plur = { injectHybrid: vi.fn().mockRejectedValue(new Error('store down')) }
    const hooks = await PlurPlugin({ directory: '/tmp/p', _plur: plur } as any)
    const output = { message: { id: 'msg_1' }, parts: [] }

    await expect(
      hooks['chat.message']!({ sessionID: 'ses_1' } as any, output as any),
    ).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/opencode/test/hooks.test.ts`
Expected: FAIL — `hooks['chat.message'] is not a function`

- [ ] **Step 3: Write the implementation**

`_plur` on the context is the test seam — production passes nothing and the
plugin constructs its own `Plur`, exactly as claw does.

```typescript
// packages/opencode/src/index.ts
import { Plur, renderMemoryBlock } from '@plur-ai/core'
import { BlockCache } from './block.js'
import { OPENCODE_PLUGIN_VERSION } from './version.js'

const log = (msg: string) => { if (process.env.PLUR_DEBUG) console.error(`[plur:opencode] ${msg}`) }

/** Never let a memory failure break the agent's turn. */
async function safe(label: string, fn: () => Promise<void>): Promise<void> {
  try { await fn() } catch (err) { log(`${label} failed: ${(err as Error).message}`) }
}

export const PlurPlugin = async (ctx: any) => {
  const plur = ctx?._plur ?? new Plur({})
  const blocks = new BlockCache()
  void OPENCODE_PLUGIN_VERSION

  return {
    // Recall trigger — once per user turn. Injects NOTHING: a part pushed here
    // is persisted into session history and accretes one stale block per turn.
    'chat.message': async (input: any, output: any) => {
      await safe('chat.message', async () => {
        const query = (output?.parts ?? [])
          .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
          .map((p: any) => p.text).join('\n')
        const injection = await plur.injectHybrid(query, {})
        blocks.set(input.sessionID, renderMemoryBlock({ injection }))
        log(`recall for ${input.sessionID}: ${injection?.count ?? 0} engrams`)
      })
    },

    // Renderer — once per model request (3x in a tool-calling turn). O(1):
    // reads the cache, never recalls. `system` is rebuilt by the host each
    // request, so this never accumulates.
    'experimental.chat.system.transform': async (input: any, output: any) => {
      await safe('system.transform', async () => {
        const block = input.sessionID ? blocks.get(input.sessionID) : undefined
        if (block) output.system.push(block)
      })
    },

    dispose: async () => { blocks.clearAll() },
  }
}

export default PlurPlugin
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @plur-ai/core build && pnpm test -- packages/opencode/test/hooks.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/index.ts packages/opencode/test/hooks.test.ts
git commit -m "feat(opencode): recall on chat.message, render on system.transform"
```

---

### Task 5: Capability detection and the non-experimental fallback

Both primary hooks carry the `experimental.` prefix. If `system.transform`
stops firing after an opencode upgrade, the plugin must degrade to a working
path rather than silently injecting nothing.

**Files:**
- Create: `packages/opencode/src/capability.ts`
- Modify: `packages/opencode/src/index.ts`
- Test: `packages/opencode/test/capability.test.ts`

**Interfaces:**
- Produces: `class RenderPath` with `markRendered(): void`, `markTurn(): void`, `shouldFallback(): boolean`. `shouldFallback()` returns true once a turn has completed with no render.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/opencode/test/capability.test.ts
import { describe, it, expect } from 'vitest'
import { RenderPath } from '../src/capability.js'

describe('RenderPath', () => {
  it('does not fall back before any turn has run', () => {
    expect(new RenderPath().shouldFallback()).toBe(false)
  })

  it('does not fall back while system.transform is rendering', () => {
    const p = new RenderPath()
    p.markTurn(); p.markRendered()
    expect(p.shouldFallback()).toBe(false)
  })

  it('falls back after a turn completes with no render', () => {
    const p = new RenderPath()
    p.markTurn()
    expect(p.shouldFallback()).toBe(true)
  })

  it('stays in fallback once it has decided', () => {
    const p = new RenderPath()
    p.markTurn()
    expect(p.shouldFallback()).toBe(true)
    p.markRendered()
    expect(p.shouldFallback()).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/opencode/test/capability.test.ts`
Expected: FAIL — `Cannot find module '../src/capability.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// packages/opencode/src/capability.ts
/**
 * Which injection path is live.
 *
 * `experimental.chat.system.transform` is the preferred path because it does
 * not accrete. It is also an experimental API on a package that ships almost
 * daily. If a full turn passes and it never fired, the host no longer supports
 * it — latch to the `chat.message` fallback, which accretes but works.
 */
export class RenderPath {
  private rendered = false
  private turns = 0
  private latched = false

  markRendered(): void { this.rendered = true }
  markTurn(): void {
    this.turns++
    if (this.turns > 0 && !this.rendered) this.latched = true
  }
  shouldFallback(): boolean { return this.latched }
}
```

- [ ] **Step 4: Wire it into index.ts**

In `PlurPlugin`, construct `const path = new RenderPath()`. Call
`path.markRendered()` inside the `system.transform` body after the push. In
`chat.message`, after storing the block, add the fallback injection — using the
part shape the probe proved the host requires (`prt_` id, `messageID` from
`output.message.id`, because `input.messageID` is `undefined`):

```typescript
        if (path.shouldFallback()) {
          const block = blocks.get(input.sessionID)
          if (block) {
            output.parts.push({
              id: `prt_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`,
              sessionID: input.sessionID,
              messageID: input.messageID ?? output.message?.id,
              type: 'text',
              text: block,
              synthetic: true,
            })
            log('system.transform unavailable — using chat.message fallback (accretes)')
          }
        }
```

Call `path.markTurn()` from the `session.idle` handler added in Task 6. Until
then, add a temporary call at the end of the `chat.message` body so the
detector advances; Task 6 moves it.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test -- packages/opencode/test/capability.test.ts packages/opencode/test/hooks.test.ts`
Expected: PASS — capability 4 tests, hooks 4 tests, none regressed

- [ ] **Step 6: Commit**

```bash
git add packages/opencode/src/capability.ts packages/opencode/src/index.ts \
        packages/opencode/test/capability.test.ts
git commit -m "feat(opencode): detect system.transform, fall back to chat.message"
```

---

### Task 6: Turn accumulation and debounced learning

`session.idle` fired **twice** per turn in the probe. Without a debounce the
learner runs twice over the same transcript and writes duplicate engrams.

**Files:**
- Create: `packages/opencode/src/turn.ts`
- Modify: `packages/opencode/src/index.ts`
- Test: `packages/opencode/test/turn.test.ts`

**Interfaces:**
- Consumes: `extractLearnings` from `@plur-ai/claw`'s learner — **do not import across packages.** Task 6 Step 3 copies the two pure functions into `packages/opencode/src/turn.ts`'s sibling only if Task 1's extraction did not already move them. Check first: if `@plur-ai/core` exports `extractLearnings`, import it from there.
- Produces: `class TurnBuffer` with `append(sessionID: string, text: string): void`, `takeIfFresh(sessionID: string): string[] | undefined`, `clear(sessionID: string): void`. `takeIfFresh` returns the accumulated text **once** and returns `undefined` on every later call until new text arrives.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/opencode/test/turn.test.ts
import { describe, it, expect } from 'vitest'
import { TurnBuffer } from '../src/turn.js'

describe('TurnBuffer', () => {
  it('accumulates assistant text per session', () => {
    const b = new TurnBuffer()
    b.append('ses_1', 'hello')
    b.append('ses_1', 'world')
    expect(b.takeIfFresh('ses_1')).toEqual(['hello', 'world'])
  })

  it('returns undefined on a second take — session.idle fires twice', () => {
    const b = new TurnBuffer()
    b.append('ses_1', 'hello')
    expect(b.takeIfFresh('ses_1')).toEqual(['hello'])
    expect(b.takeIfFresh('ses_1')).toBeUndefined()
  })

  it('becomes fresh again when the next turn appends', () => {
    const b = new TurnBuffer()
    b.append('ses_1', 'turn one')
    b.takeIfFresh('ses_1')
    b.append('ses_1', 'turn two')
    expect(b.takeIfFresh('ses_1')).toEqual(['turn two'])
  })

  it('ignores empty text', () => {
    const b = new TurnBuffer()
    b.append('ses_1', '')
    expect(b.takeIfFresh('ses_1')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/opencode/test/turn.test.ts`
Expected: FAIL — `Cannot find module '../src/turn.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// packages/opencode/src/turn.ts
/**
 * Assistant text accumulated for the current turn, per session.
 *
 * `session.idle` fires more than once per turn (measured: twice), so the take
 * is one-shot — the buffer goes stale after a take and only becomes fresh
 * again when the next turn appends text. Without this the learner runs twice
 * over one transcript and writes the same engram twice.
 */
export class TurnBuffer {
  private buf = new Map<string, string[]>()
  private fresh = new Map<string, boolean>()

  append(sessionID: string, text: string): void {
    if (!text) return
    const arr = this.buf.get(sessionID) ?? []
    arr.push(text)
    this.buf.set(sessionID, arr)
    this.fresh.set(sessionID, true)
  }

  takeIfFresh(sessionID: string): string[] | undefined {
    if (!this.fresh.get(sessionID)) return undefined
    const arr = this.buf.get(sessionID)
    if (!arr || arr.length === 0) return undefined
    this.fresh.set(sessionID, false)
    this.buf.set(sessionID, [])
    return arr
  }

  clear(sessionID: string): void { this.buf.delete(sessionID); this.fresh.delete(sessionID) }
}
```

- [ ] **Step 4: Wire the event hook into index.ts**

```typescript
    event: async ({ event }: any) => {
      await safe('event', async () => {
        if (event.type === 'message.part.updated' && event.properties?.part?.type === 'text') {
          turns.append(event.properties.part.sessionID, event.properties.part.text ?? '')
        }
        if (event.type === 'session.idle') {
          const sessionID = event.properties?.sessionID
          path.markTurn()
          const texts = turns.takeIfFresh(sessionID)
          if (!texts) return
          // Fire-and-forget: never stall the turn on a slow store.
          void learnFromTurn(plur, texts).catch((e) =>
            log(`learn failed: ${(e as Error).message}`))
        }
        if (event.type === 'session.deleted') {
          const id = event.properties?.sessionID
          blocks.clear(id); turns.clear(id)
        }
      })
    },
```

Remove the temporary `path.markTurn()` call added in Task 5 Step 4.

- [ ] **Step 5: Add `learnFromTurn` in `src/learn.ts`**

```typescript
// packages/opencode/src/learn.ts
import { extractLearnings } from '@plur-ai/core'

/** Extract durable learnings from one turn's assistant text and route them. */
export async function learnFromTurn(plur: any, texts: string[]): Promise<void> {
  const candidates = extractLearnings(
    texts.map((t) => ({ role: 'assistant' as const, content: t })),
  )
  for (const c of candidates) {
    if (c.confidence >= 0.7) await plur.learnRouted(c.statement, c.context ?? {})
  }
}
```

If `extractLearnings` is not exported from `@plur-ai/core` after Task 1, extract
it from `packages/claw/src/learner.ts` into `packages/core/src/learner.ts` using
the same behaviour-neutral procedure as Task 1 Steps 6–7 (rebuild core, run
`packages/claw/test/learner.test.ts`, require zero assertion changes) before
continuing.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @plur-ai/core build && pnpm test -- packages/opencode/`
Expected: PASS — all opencode tests green

- [ ] **Step 7: Commit**

```bash
git add packages/opencode/src/turn.ts packages/opencode/src/learn.ts \
        packages/opencode/src/index.ts packages/opencode/test/turn.test.ts
git commit -m "feat(opencode): debounced turn learning on session.idle"
```

---

### Task 7: Learn before compaction

**Files:**
- Modify: `packages/opencode/src/index.ts`
- Test: `packages/opencode/test/compaction.test.ts`

**Interfaces:**
- Consumes: `TurnBuffer` (Task 6), `learnFromTurn` (Task 6).
- Produces: an `"experimental.session.compacting"` hook on the returned object.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/opencode/test/compaction.test.ts
import { describe, it, expect, vi } from 'vitest'
import { PlurPlugin } from '../src/index.js'

describe('learn before compaction', () => {
  it('pushes the memory block into compaction context', async () => {
    const plur = {
      injectHybrid: vi.fn().mockResolvedValue({ count: 1, directives: '[ENG-9] Keep it.', constraints: '', text: '' }),
      learnRouted: vi.fn().mockResolvedValue(undefined),
    }
    const hooks = await PlurPlugin({ directory: '/tmp/p', _plur: plur } as any)
    await hooks['chat.message']!({ sessionID: 'ses_1' } as any,
      { message: { id: 'msg_1' }, parts: [] } as any)

    const out: { context: string[]; prompt?: string } = { context: [] }
    await hooks['experimental.session.compacting']!({ sessionID: 'ses_1' } as any, out as any)

    expect(out.context.join('\n')).toContain('[ENG-9] Keep it.')
    expect(out.prompt).toBeUndefined() // never replace the host's prompt
  })

  it('does not throw when there is no cached block', async () => {
    const plur = { injectHybrid: vi.fn(), learnRouted: vi.fn() }
    const hooks = await PlurPlugin({ directory: '/tmp/p', _plur: plur } as any)
    const out: { context: string[] } = { context: [] }
    await expect(
      hooks['experimental.session.compacting']!({ sessionID: 'unknown' } as any, out as any),
    ).resolves.toBeUndefined()
    expect(out.context).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/opencode/test/compaction.test.ts`
Expected: FAIL — `hooks['experimental.session.compacting'] is not a function`

- [ ] **Step 3: Write the implementation**

```typescript
    // Context is about to be dropped. Carry memory across the cut, and learn
    // from what is being discarded. Never set `output.prompt` — that replaces
    // the host's compaction prompt entirely.
    'experimental.session.compacting': async (input: any, output: any) => {
      await safe('compacting', async () => {
        const block = blocks.get(input.sessionID)
        if (block) output.context.push(block)
        const texts = turns.takeIfFresh(input.sessionID)
        if (texts) void learnFromTurn(plur, texts).catch(() => {})
      })
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- packages/opencode/test/compaction.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/index.ts packages/opencode/test/compaction.test.ts
git commit -m "feat(opencode): carry memory across compaction and learn before the cut"
```

---

### Task 8: Session scope — prefer `worktree`, fall back to `directory`

The probe measured `worktree = "/"` in a non-git directory with
`projectID = "global"`. Scoping memory by that degenerate value would put
every such session in one bucket, so the guard falls back to `directory`
only in that case — a real `worktree` is used when one is available.

**Files:**
- Create: `packages/opencode/src/scope.ts`
- Modify: `packages/opencode/src/index.ts`
- Test: `packages/opencode/test/scope.test.ts`

**Interfaces:**
- Produces: `resolveScopeRoot(ctx: { directory?: string; worktree?: string }): string` — the path PLUR scopes the session by.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/opencode/test/scope.test.ts
import { describe, it, expect } from 'vitest'
import { resolveScopeRoot } from '../src/scope.js'

describe('resolveScopeRoot', () => {
  it('prefers a real worktree when there is one', () => {
    expect(resolveScopeRoot({ directory: '/repo/sub', worktree: '/repo' })).toBe('/repo')
  })

  it('ignores worktree "/" — measured in non-git dirs', () => {
    expect(resolveScopeRoot({ directory: '/tmp/work', worktree: '/' })).toBe('/tmp/work')
  })

  it('ignores an empty worktree', () => {
    expect(resolveScopeRoot({ directory: '/tmp/work', worktree: '' })).toBe('/tmp/work')
  })

  it('falls back to cwd when neither is usable', () => {
    expect(resolveScopeRoot({})).toBe(process.cwd())
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/opencode/test/scope.test.ts`
Expected: FAIL — `Cannot find module '../src/scope.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// packages/opencode/src/scope.ts
/**
 * Which path this session's memory is scoped by.
 *
 * `worktree` is the right answer inside a git repo and a trap outside one:
 * measured as "/" in a plain directory (opencode 1.18.30), which would scope
 * every non-repo session to the filesystem root.
 */
export function resolveScopeRoot(ctx: { directory?: string; worktree?: string }): string {
  const wt = ctx.worktree
  if (wt && wt !== '/' && wt.length > 1) return wt
  if (ctx.directory) return ctx.directory
  return process.cwd()
}
```

- [ ] **Step 4: Use it in index.ts**

Replace `new Plur({})` with:

```typescript
  const scopeRoot = resolveScopeRoot(ctx ?? {})
  const plur = ctx?._plur ?? new Plur({ path: process.env.PLUR_PATH })
  log(`scope root: ${scopeRoot}`)
```

and pass `scopeRoot` as the `cwd` in the `injectHybrid` options object so scope
routing sees the session's project.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test -- packages/opencode/`
Expected: PASS — all opencode tests green

- [ ] **Step 6: Commit**

```bash
git add packages/opencode/src/scope.ts packages/opencode/src/index.ts \
        packages/opencode/test/scope.test.ts
git commit -m "feat(opencode): scope sessions by directory, not worktree"
```

---

### Task 9: `plur init --opencode`

Writes both layers: the `plugin` entry (automatic memory) and the `mcp` entry
(explicit `plur_*` tools). opencode merges config files rather than replacing
them, so an existing `opencode.json` must be read, merged, and written back.

**Files:**
- Create: `packages/opencode/src/setup.ts`
- Modify: `packages/cli/src/commands/init.ts`
- Test: `packages/opencode/test/setup.test.ts`

**Interfaces:**
- Produces: `writeOpencodeConfig(configPath: string, cliVersion: string): { created: boolean; changed: boolean }`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/opencode/test/setup.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeOpencodeConfig } from '../src/setup.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-oc-')) })

describe('writeOpencodeConfig', () => {
  it('creates a config with both the plugin and the mcp entry', () => {
    const p = join(dir, 'opencode.json')
    const r = writeOpencodeConfig(p, '0.20.0')
    expect(r.created).toBe(true)
    const cfg = JSON.parse(readFileSync(p, 'utf8'))
    expect(cfg.plugin).toContain('@plur-ai/opencode')
    expect(cfg.mcp.plur.type).toBe('local')
    expect(cfg.mcp.plur.command).toEqual(['npx', '-y', '@plur-ai/mcp@0.20.0'])
  })

  it('preserves unrelated keys in an existing config', () => {
    const p = join(dir, 'opencode.json')
    writeFileSync(p, JSON.stringify({ model: 'anthropic/claude-sonnet-4-5', plugin: ['other'] }))
    writeOpencodeConfig(p, '0.20.0')
    const cfg = JSON.parse(readFileSync(p, 'utf8'))
    expect(cfg.model).toBe('anthropic/claude-sonnet-4-5')
    expect(cfg.plugin).toEqual(['other', '@plur-ai/opencode'])
  })

  it('is idempotent — a second run changes nothing', () => {
    const p = join(dir, 'opencode.json')
    writeOpencodeConfig(p, '0.20.0')
    const r = writeOpencodeConfig(p, '0.20.0')
    expect(r.changed).toBe(false)
    expect(JSON.parse(readFileSync(p, 'utf8')).plugin).toEqual(['@plur-ai/opencode'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/opencode/test/setup.test.ts`
Expected: FAIL — `Cannot find module '../src/setup.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// packages/opencode/src/setup.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const PLUGIN = '@plur-ai/opencode'

/**
 * Add PLUR to an opencode config, preserving everything else in it.
 * Both layers: `plugin` for automatic memory, `mcp` for explicit plur_* tools.
 */
export function writeOpencodeConfig(
  configPath: string,
  cliVersion: string,
): { created: boolean; changed: boolean } {
  const created = !existsSync(configPath)
  const cfg: any = created ? { $schema: 'https://opencode.ai/config.json' }
    : JSON.parse(readFileSync(configPath, 'utf8'))
  const before = JSON.stringify(cfg)

  cfg.plugin = Array.isArray(cfg.plugin) ? cfg.plugin : []
  if (!cfg.plugin.includes(PLUGIN)) cfg.plugin.push(PLUGIN)

  cfg.mcp = cfg.mcp ?? {}
  cfg.mcp.plur = {
    type: 'local',
    command: ['npx', '-y', `@plur-ai/mcp@${cliVersion}`],
    enabled: true,
  }

  const changed = JSON.stringify(cfg) !== before
  if (created || changed) writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n')
  return { created, changed }
}
```

- [ ] **Step 4: Wire the flag into the CLI**

In `packages/cli/src/commands/init.ts`, follow the existing `--cursor` /
`--codex` / `--antigravity` pattern exactly: add `--opencode` / `--no-opencode`
to the usage comment block, auto-detect on `existsSync(~/.config/opencode)`, and
call `writeOpencodeConfig(join(homedir(), '.config/opencode/opencode.json'), CLI_VERSION)`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test -- packages/opencode/test/setup.test.ts packages/cli/`
Expected: PASS — setup 3 tests, no CLI regressions

- [ ] **Step 6: Commit**

```bash
git add packages/opencode/src/setup.ts packages/opencode/test/setup.test.ts \
        packages/cli/src/commands/init.ts
git commit -m "feat(cli): plur init --opencode writes plugin and mcp entries"
```

---

### Task 10: Live acceptance gate against a real opencode

Unit tests prove the hooks return the right objects. They cannot prove context
reached the model — the documented failure mode for PLUR plugin releases is a
plugin that loads, registers, reports healthy, and injects nothing.

**Files:**
- Create: `packages/opencode/test/e2e.manual.mjs`
- Modify: `packages/opencode/README.md`

**Interfaces:**
- Consumes: the built `dist/index.js` from Task 2's tsup config.

- [ ] **Step 1: Write the acceptance script**

```javascript
// packages/opencode/test/e2e.manual.mjs
// Manual gate — requires a real opencode binary and a working provider.
// Run: node packages/opencode/test/e2e.manual.mjs
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MODEL = process.env.PLUR_E2E_MODEL || 'openai/gpt-5.5'
const home = mkdtempSync(join(tmpdir(), 'plur-oc-e2e-'))
const work = join(home, 'work'); mkdirSync(work)
mkdirSync(join(home, 'plugins'))
cpSync('packages/opencode/dist', join(home, 'plugins', 'plur'), { recursive: true })
writeFileSync(join(home, 'opencode.json'), JSON.stringify({
  $schema: 'https://opencode.ai/config.json', share: 'disabled', autoupdate: false,
}))

const store = join(home, 'store')
const env = { ...process.env, OPENCODE_CONFIG_DIR: home, OPENCODE_CONFIG: join(home, 'opencode.json'), PLUR_PATH: store }
const run = (msg, extra = []) =>
  execFileSync('opencode', ['run', '--model', MODEL, ...extra, msg], { cwd: work, env, encoding: 'utf8' })

// 1. Teach a fact in one session.
execFileSync('npx', ['-y', '@plur-ai/cli', 'learn', 'The deploy target for project ACME is fra1-node-7.'],
  { env, encoding: 'utf8' })

// 2. A *fresh* session must recall it.
const recalled = run('What is the deploy target for project ACME? Answer in one line.')
if (!/fra1-node-7/.test(recalled)) {
  console.error('FAIL: memory did not reach the model\n' + recalled); process.exit(1)
}

// 3. Three turns must not accrete.
run('Say 1', ['--title', 'accrete'])
run('Say 2', ['-c'])
const counted = run('Count how many separate times the exact heading "PLUR Memory System" appears in the USER and ASSISTANT messages of this conversation, excluding your system prompt and excluding this question. Output only the number.', ['-c'])
if (!/^\s*0\s*$/m.test(counted)) {
  console.error('FAIL: transcript accretion detected — expected 0, got:\n' + counted); process.exit(1)
}

console.log('PASS: recall reached the model; transcript accretion 0')
```

- [ ] **Step 2: Build and run the gate**

Run: `pnpm --filter @plur-ai/core build && pnpm --filter @plur-ai/opencode build && node packages/opencode/test/e2e.manual.mjs`
Expected: `PASS: recall reached the model; transcript accretion 0`

If step 2 fails on accretion, `system.transform` is not firing and the fallback
latched — that is the capability detector working, and it means the harness
contract moved. Re-run `scripts/probes/opencode-plugin-probe.mjs`, update the
spec's verified-version table, and reconcile before shipping.

- [ ] **Step 3: Commit**

```bash
git add packages/opencode/test/e2e.manual.mjs
git commit -m "test(opencode): live acceptance gate for injection and accretion"
```

---

### Task 11: README, release track, roadmap

**Files:**
- Create: `packages/opencode/README.md`, `packages/opencode/ARCHITECTURE.md`
- Modify: `scripts/release.sh`, `CLAUDE.md`, `README.md`
- Modify: `~/Data/5-plur/roadmap.yaml`

- [ ] **Step 1: Write README.md**

Cover: what it does, `plur init --opencode`, the manual `opencode.json` snippet,
the verified version (`opencode 1.18.30` / `@opencode-ai/plugin 1.18.30`), the
`PLUR_DEBUG=1` diagnostic, and what leaves the machine (nothing — core makes no
external calls).

- [ ] **Step 2: Write ARCHITECTURE.md**

Mirror `packages/claw/ARCHITECTURE.md`: the shape in one paragraph, the
top-level layout table, and a hook-mapping table. State the accretion
measurement explicitly — it is the reason the code looks the way it does, and
the next person to touch it will otherwise "simplify" recall back into
`chat.message`.

- [ ] **Step 3: Add the independent release track**

In `scripts/release.sh`, copy the `--dsh` block verbatim and adapt: add
`--opencode <ver>` to the usage header, the argument parser, and a bump block
touching `packages/opencode/package.json` and `packages/opencode/src/version.ts`.
opencode is **not** bumped unless `--opencode` is passed.

- [ ] **Step 4: Update the docs that enumerate packages**

`CLAUDE.md` § "What is PLUR" (the seven-package list becomes eight) and
§ "Version bumps" (add the opencode track next to claw and dsh). Root
`README.md` package table.

- [ ] **Step 5: Run the full suite**

Run: `pnpm build && pnpm test`
Expected: PASS — ~3500 tests plus the new opencode tests, zero failures

- [ ] **Step 6: File the issue and link it to the epic**

```bash
gh issue create --title "opencode adapter — probe done, contract verified" \
  --body "Child of #1034. Spec: docs/specs/2026-09-15-opencode-plugin-design.md. Plan: docs/plans/2026-09-15-opencode-plugin.md. Contract verified against opencode 1.18.30."
```

Then add the new issue number to `E-15.children` in
`~/Data/5-plur/roadmap.yaml` (alongside `1033`) and validate:

Run: `python3 ~/Data/.datacore/lib/roadmap_validate.py`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add packages/opencode/README.md packages/opencode/ARCHITECTURE.md \
        scripts/release.sh CLAUDE.md README.md
git commit -m "docs(opencode): README, architecture, and release track"
```

---

## Self-review

**Spec coverage.** Every spec section maps to a task: the recall/render split →
Task 4; capability detection and the fallback part shape → Task 5; the
`session.idle` double-fire → Task 6; compaction → Task 7; the `worktree = "/"`
gotcha → Task 8; three-layer install (plugin + mcp) → Task 9; the definition of
done (model recites a taught fact, accretion 0) → Task 10. The spec's
out-of-scope decision (no native `tool` definitions) is honoured — no task adds
one.

**Two spec items are deliberately unimplemented:** `permission.ask` and native
tools. Both were listed as out of scope or unexercised; neither is on the
critical path for a memory layer.

**Type consistency.** `renderMemoryBlock` (Task 1) is called with the same
`{ injection, tokenBudget, usedTokens }` shape in Tasks 1, 4 and 7.
`BlockCache` (Task 3) exposes `set/get/clear/clearAll` and every later task uses
only those. `TurnBuffer.takeIfFresh` (Task 6) is used in Tasks 6 and 7 with the
same one-shot contract. `RenderPath` (Task 5) is the only other stateful object
and is touched in Tasks 5 and 6.

**One ordering dependency to watch.** Task 6 Step 5 depends on whether Task 1
moved `extractLearnings` into core. Task 6 states the check and the fallback
procedure explicitly rather than assuming.

**Risk carried, not resolved.** Both primary hooks are `experimental.` on a
package that shipped a new version the day before the probe. Task 5 is the
mitigation; Task 10 is the detector. Neither removes the underlying exposure,
and the README should say so plainly.
