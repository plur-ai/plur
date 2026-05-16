---
name: plur-session-end
description: Extract durable learnings at the end of a session. Saves corrections, preferences, and codebase patterns as engrams — nothing ephemeral, nothing sensitive.
version: 1.0.0
metadata:
  hermes:
    tags: [memory, learning, session-end, engrams, wrap-up]
    category: productivity
    requires_toolsets: []
---

# PLUR Session End

Run this at the end of a conversation to extract what is worth remembering.

PLUR stores durable knowledge — corrections, conventions, preferences, decisions. It does not store session logs, one-off status, or anything that will be irrelevant next week. This skill enforces that discipline.

## When to Use

- The user says "wrap up", "end session", "we're done", or similar
- The conversation is winding down after completing a task
- You want to record what you learned before the context window closes

## Procedure

### Step 1 — Identify learning candidates

Scan the conversation for:

| Category | Examples |
|----------|---------|
| **Corrections** | "No, the API returns snake_case" / "Don't use X, use Y" |
| **Preferences** | "Always run lint before committing" / "User prefers concise explanations" |
| **Codebase conventions** | "This project uses repository pattern" / "Tests live in `__tests__/`" |
| **Decisions** | "We chose PostgreSQL for ACID compliance" |
| **Gotchas** | "The staging env needs `NODE_ENV=staging`, not `production`" |
| **Terminology** | "They call it a 'slot' not a 'channel'" |

### Step 2 — Filter ruthlessly

Skip:

- Anything already obvious from reading the codebase
- Session-specific state ("we're working on the login page right now")
- One-off status ("the build was red this morning")
- Anything you are not confident about
- Secrets, credentials, API keys — never

### Step 3 — Write each learning as a durable assertion

Format: a single clear statement that will make sense to a future agent with no session context.

Good: `"The publish script requires npm 2FA — always run 'npm publish' interactively, never from CI."`

Bad: `"We talked about the publish issue."`

### Step 4 — Assign metadata

For each learning, determine:

- `type`: `correction` | `preference` | `convention` | `decision` | `gotcha` | `fact`
- `domain`: the project, library, or topic area (e.g., `"plur"`, `"typescript"`, `"project:acme"`)
- `scope`: the scope of applicability (e.g., `"global"`, `"project:acme"`)
- `tags`: 2–5 descriptive tags

### Step 5 — Save

If `plur_learn` is available:

```
plur_learn(statement, { type, domain, scope, tags })
```

Call once per learning. Do not batch into one call — separate engrams decay and strengthen independently.

If `plur_session_end` is available, pass learnings as `engram_suggestions` for batch review.

## Quality bar

Fewer, stronger engrams beat many weak ones.

- Prefer **no engram** over a vague one
- One sentence per engram — if you need two sentences, split it into two engrams
- If you're unsure whether something is reusable, skip it

## What a good wrap-up looks like

```
Session learnings saved (3 engrams):

1. [correction] The API returns timestamps in Unix seconds, not milliseconds.
   domain: project:acme | tags: api, timestamps

2. [preference] User prefers TypeScript strict mode — always enable in tsconfig.
   domain: typescript | tags: tsconfig, preferences

3. [gotcha] The staging deploy requires a manual cache bust at /admin/cache.
   domain: project:acme | tags: deploy, staging, ops
```

Keep the user-facing summary short. Show what you saved; do not narrate your reasoning.

## Integration with plur-memory

This skill pairs with `plur-memory`:

- `plur-memory` runs continuously — it injects relevant engrams at the start of each turn
- `plur-session-end` runs once — it extracts and saves what the session produced

Together they close the memory loop: inject at start, learn at end.
