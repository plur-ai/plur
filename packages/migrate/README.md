# @plur-ai/migrate

Find PLUR calls left un-awaited by the 0.16 async migration.

```bash
npx @plur-ai/migrate            # report (default — changes nothing)
npx @plur-ai/migrate --write    # apply the unambiguous fixes
```

## Why you need this

As of 0.16 the engine's read and write methods return promises, so a store can
live across a network. A call left un-awaited **does not throw** — it yields a
`Promise`, and most things you do with a Promise succeed:

```js
plur.recall(q).length     // undefined, not an error
{...plur.status()}        // {}
plur.learn(x)             // resolves later, or never
```

TypeScript catches every one of these. JavaScript catches none of them, which
is what this tool is for.

## What it will and won't rewrite

It rewrites only where adding `await` is unambiguous, and **parenthesises when
the result is consumed**:

```js
const n = plur.list().length      →  const n = (await plur.list()).length
```

`await plur.list().length` would parse as `await (plur.list().length)` — it
awaits `undefined` and yields `undefined`. Getting that wrong produces code
that runs and returns a plausible value.

It reports, but refuses to rewrite:

- **calls inside `Promise.race` / `Promise.all` arrays** — awaiting there
  settles the call *before* the combinator sees it. This silently disabled a 5s
  timeout guard in PLUR's own CLI, and the test suite stayed green.
- **concise arrow bodies** — the enclosing function has to become `async` first.
- **calls whose result is consumed across multiple lines.**

It never touches string literals or comments. An early version of the codemod
that migrated PLUR itself rewrote a CLI help string into `hook-await inject`
and a user-facing message into "Add a remote with `await plur.sync(...)`" —
both valid TypeScript, both shipped.

## Exit codes

`0` clean, or all findings fixed. `2` when something needs a human — so it
composes in CI.

## Scope

Only methods that became async **in 0.16**. `recallHybrid` and friends were
always async — an un-awaited call there was already a bug. `capture` and
`timeline` are still synchronous.
