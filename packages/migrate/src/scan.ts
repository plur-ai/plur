/**
 * Find PLUR calls that stopped being synchronous in 0.16 and were never awaited.
 *
 * ## Why this reports rather than rewrites, by default
 *
 * The 0.16 migration inside this repo was done with codemods over ~1,100 call
 * sites, and they were wrong in instructive ways before they were right. Every
 * class of mistake they made is guarded for here, because a tool that silently
 * corrupts a user's source is worse than no tool:
 *
 *   - **String literals.** An early pass rewrote text inside quotes, turning a
 *     CLI's help output into `hook-await inject` and a user-facing message into
 *     "Add a remote with await plur.sync(...)". Both were valid TypeScript and
 *     both shipped through a green test suite.
 *   - **`Promise.race` / `Promise.all` arrays.** Inserting `await` into an
 *     element resolves that call BEFORE the array is constructed, which
 *     silently disabled a 5s timeout guard — the racing promise was already
 *     settled. Still valid, still green.
 *   - **ASI hazards.** A line beginning `(await ...)` after a line with no
 *     semicolon parses as a call on the previous expression.
 *
 * The compiler catches an un-awaited promise in TypeScript. It cannot catch any
 * of the above, and neither can a test suite. So: report everything, and only
 * rewrite the sites where the transformation is unambiguous.
 */

/**
 * Methods on `Plur` that return a promise as of 0.16 and did not before.
 *
 * Deliberately NOT a list of "every async method" — `recallHybrid`,
 * `injectHybrid` and friends were always async, so a call to them without
 * `await` was already a bug and is not this migration's business.
 *
 * `capture` and `timeline` are absent because they are still synchronous: they
 * are backed by `episodes.yaml`, not the engram store. `suggestScope`,
 * `dismissScope`, `reofferScopes` and `listImportSources` are absent because
 * they were briefly async before release and were reverted.
 */
export const NEWLY_ASYNC = [
  // Derived from git, not from memory: these are the methods whose signature
  // went sync -> async in 0.16. `packages/migrate/test/method-list.test.ts`
  // re-derives the same set from `Plur` and fails if this drifts — the list was
  // hand-written once and was wrong in both directions (it advised `await` on a
  // synchronous `addStore`, and missed eight methods entirely).
  'compact',
  'episodeToEngram',
  'getById',
  'ingest',
  'inject',
  'installPack',
  'learn',
  'list',
  'listPinned',
  'listStores',
  'outboxCount',
  'purgeTensions',
  'recall',
  'receipt',
  'recordTensions',
  'reindex',
  'rerankerEvalStatus',
  'resolveTension',
  'saveMetaEngrams',
  'setPinned',
  'status',
  'sync',
  'updateEngram',
  // Already async before 0.16, so an un-awaited call was always a bug rather
  // than migration fallout — but reporting it costs nothing and helps, and
  // these were in the original list. `addStore` was too and is REMOVED: it is
  // synchronous, so the tool was telling users to add an `await` that does not
  // belong.
  'feedback',
  'flushOutbox',
  'forget',
  'learnBatch',
  'learnRouted',
] as const

export interface Finding {
  file: string
  line: number
  column: number
  method: string
  /** The source line, trimmed. */
  text: string
  /** True when this site can be rewritten mechanically. */
  fixable: boolean
  /** Why it is not fixable, when it is not. */
  reason?: string
  /**
   * End column (1-based, exclusive) of the call expression, when the result is
   * immediately consumed and the insertion therefore needs parentheses.
   *
   * `await plur.list().length` parses as `await (plur.list().length)` — it
   * awaits `undefined` and yields `undefined`. The correct rewrite is
   * `(await plur.list()).length`. Getting this wrong produces code that runs,
   * returns a plausible value, and is silently incorrect — the same failure
   * class this whole tool exists to catch.
   */
  wrapTo?: number
}

/** Spans of the source that are inside a string or template literal. */
function literalSpans(src: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i)
      spans.push([i, end === -1 ? src.length : end])
      i = end === -1 ? src.length : end
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      spans.push([i, end === -1 ? src.length : end + 2])
      i = end === -1 ? src.length : end + 2
      continue
    }
    if (c === '"' || c === "'") {
      const quote = c
      let j = i + 1
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue }
        if (src[j] === quote) break
        j++
      }
      spans.push([i, Math.min(j + 1, src.length)])
      i = j + 1
      continue
    }
    if (c === '`') {
      // A template literal is only PARTLY a literal: everything inside `${...}`
      // is ordinary code. Treating the whole thing as a string hid every call
      // written as `${plur.recall(q)}` — which is the worst place to miss one,
      // because an un-awaited promise there does not throw, it interpolates as
      // the string "[object Promise]" and ships.
      //
      // So push a span for each literal CHUNK and step over the holes.
      let j = i + 1
      let chunkStart = i
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue }
        if (src[j] === '`') break
        if (src[j] === '$' && src[j + 1] === '{') {
          spans.push([chunkStart, j])
          // Walk to the matching `}`, counting nested braces. Nested template
          // literals inside the hole are handled by the outer loop when it
          // reaches them, so only brace depth matters here.
          let depth = 1
          let k = j + 2
          while (k < src.length && depth > 0) {
            if (src[k] === '{') depth++
            else if (src[k] === '}') depth--
            k++
          }
          j = k
          chunkStart = k
          continue
        }
        j++
      }
      spans.push([chunkStart, Math.min(j + 1, src.length)])
      i = j + 1
      continue
    }
    i++
  }
  return spans
}

function inSpans(spans: Array<[number, number]>, idx: number): boolean {
  for (const [a, b] of spans) if (idx >= a && idx < b) return true
  return false
}

/**
 * Characters after which a line-starting `(` cannot splice onto the previous
 * statement: statement terminators (`;`), openers (`{ ( [`), separators
 * (`, :`), and binary/prefix operator tails (`= > & | + - * / % < ! ~ ^ ?`
 * — `>` also covers `=>`). Everything else — `)`, `]`, `}`, quotes,
 * identifier characters — can legally absorb a following `(` as a call or
 * index, which is the ASI splice. See the guard in `scanSource`.
 */
const ASI_SAFE_BEFORE_PAREN = new Set([
  ';', '{', ',', '(', '[', ':', '=', '>', '&', '|', '+', '-', '*', '/', '%', '<', '!', '~', '^', '?',
])

/** The span containing `idx`, or null. */
function spanAt(spans: Array<[number, number]>, idx: number): [number, number] | null {
  for (const s of spans) if (idx >= s[0] && idx < s[1]) return s
  return null
}

/**
 * The last significant character at or before `from`: whitespace is skipped,
 * COMMENT spans are skipped whole, and a string/template literal is
 * significant — its closing quote/backtick is returned, because a string can
 * absorb a following `(` as a call (`'s'(...)` / tagged template), so for the
 * ASI guard it must count as hazardous, not vanish like a comment.
 */
function lastSignificantChar(src: string, from: number, spans: Array<[number, number]>): string | null {
  for (let j = from; j >= 0; j--) {
    const span = spanAt(spans, j)
    if (span) {
      if (src[span[0]] === '/') { j = span[0]; continue } // comment — skip whole
      return src[j] // inside a string/template literal
    }
    if (/\s/.test(src[j])) continue
    return src[j]
  }
  return null
}

/** Index of the line containing `idx`, and the column within it. */
function positionOf(src: string, idx: number): { line: number; column: number; text: string } {
  const before = src.slice(0, idx)
  const line = before.split('\n').length
  const lineStart = before.lastIndexOf('\n') + 1
  const lineEnd = src.indexOf('\n', idx)
  return {
    line,
    column: idx - lineStart + 1,
    text: src.slice(lineStart, lineEnd === -1 ? src.length : lineEnd).trim(),
  }
}


/** Statement keywords that take a parenthesised head — not callable functions. */
const CONTROL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'do'])


/**
 * Is `idx` directly inside a `Promise.all/race/allSettled/any([...])` array?
 *
 * Awaiting an element there resolves that call BEFORE the array is even
 * constructed, so the combinator receives an already-settled promise. For
 * `race` that silently disables a timeout; for `all` it serialises what the
 * caller wrote to run concurrently. Both still parse and still pass tests —
 * this is the bug the tool exists to prevent, so emitting it is the one
 * unacceptable outcome.
 *
 * Detected by scanning outwards for an unmatched `[` rather than by looking
 * back a fixed number of characters. The window version passed the obvious
 * cases and missed anything with a long enough preceding element: verified
 * against a three-element `Promise.all` where the combinator sat beyond the
 * 80-character lookback, and the tool rewrote it.
 */
function insideCombinatorArray(src: string, idx: number, spans: Array<[number, number]>): boolean {
  let square = 0, round = 0, curly = 0
  for (let i = idx - 1; i >= 0; i--) {
    if (inSpans(spans, i)) continue
    const c = src[i]
    if (c === ']') { square++; continue }
    if (c === ')') { round++; continue }
    if (c === '}') { curly++; continue }
    if (c === ')' || c === '}') continue
    if (c === '[') {
      if (square > 0) { square--; continue }
      // Unmatched `[` — the array we are directly inside. Is it a combinator's?
      //
      // The lookback is built from SIGNIFICANT characters only — comment and
      // string spans are skipped, exactly as the bracket walk above skips
      // them. A raw `src.slice` here matched the literal text `Promise.all(`
      // inside an adjacent COMMENT (`process(\n  // Promise.all(\n  [...]`)
      // and refused two perfectly ordinary calls; the false positive fails
      // safe but sends a human to investigate nothing.
      let before = ''
      for (let j = i - 1; j >= 0 && before.length < 60; j--) {
        if (inSpans(spans, j)) continue
        before = src[j] + before
      }
      return /Promise\s*\.\s*(all|race|allSettled|any)\s*\(\s*$/.test(before)
    }
    if (c === '(') {
      if (round > 0) { round--; continue }
      return false // an enclosing call, not an array literal
    }
    if (c === '{') {
      if (curly > 0) { curly--; continue }
      return false // an enclosing block or object
    }
  }
  return false
}

/**
 * Whether the function enclosing `idx` is `async` — or `'top-level'` when the
 * call is not inside a function at all.
 *
 * `await` is a syntax error outside an async function, so inserting one without
 * checking produces source that does not parse. The tool did exactly that:
 * given `function saveIt(plur) { plur.learn('x') }` it emitted
 * `await plur.learn('x')` inside a non-async function, and `node --check`
 * rejected the file. A migration tool that breaks the build is worse than one
 * that reports and leaves the edit to a human.
 *
 * Walks backwards tracking brace depth to find the nearest enclosing `{` that
 * belongs to a function header, then inspects that header. String and comment
 * spans are skipped by the caller's span list.
 */
function enclosingFunctionKind(src: string, idx: number, spans: Array<[number, number]>): 'async' | 'sync' | 'top-level' {
  let depth = 0
  for (let i = idx - 1; i >= 0; i--) {
    if (inSpans(spans, i)) continue
    const c = src[i]
    if (c === '}') { depth++; continue }
    if (c !== '{') continue
    if (depth > 0) { depth--; continue }
    // An unmatched `{` — the block we are directly inside. Is its header a
    // function?
    const header = src.slice(Math.max(0, i - 220), i)
    // `function f(...)`, `async function f(...)`, `(...) =>`, method shorthand.
    const fn = /(?:^|[^\w$])(async\s+)?function\s*\*?\s*[\w$]*\s*\([^()]*\)\s*$/.exec(header)
    if (fn) return fn[1] ? 'async' : 'sync'
    const arrow = /(?:^|[^\w$])(async\s*)?\([^()]*\)\s*=>\s*$/.exec(header)
    if (arrow) return arrow[1] ? 'async' : 'sync'
    const bareArrow = /(?:^|[^\w$])(async\s+)?[\w$]+\s*=>\s*$/.exec(header)
    if (bareArrow) return bareArrow[1] ? 'async' : 'sync'
    // Method shorthand in a class or object literal: `name(args) {`.
    //
    // The keyword guard is load-bearing: `if (...) {`, `for (...) {`,
    // `while (...) {` and `catch (...) {` all match this shape, and treating
    // one as a non-async function made every call inside a conditional or loop
    // unfixable — even inside an async function. Caught by a test that put the
    // call inside `if { for { ... } }`.
    const method = /(?:^|[^\w$])(async\s+)?([\w$]+)\s*\([^()]*\)\s*$/.exec(header)
    if (method && !CONTROL_KEYWORDS.has(method[2])) return method[1] ? 'async' : 'sync'
    // Some other block (if/for/try/class body) — keep walking outwards.
    depth = 0
  }
  return 'top-level'
}

/**
 * True when the file can host a top-level `await`.
 *
 * TypeScript and `.mjs` are modules by default, so top-level await is valid
 * there. `.cjs`/`.cts` never are. Plain `.js` is ambiguous — CommonJS unless the
 * file shows module syntax — so evidence is required before rewriting, since a
 * wrong guess emits source that does not parse.
 */
function isEsm(file: string, src: string): boolean {
  if (/\.(mjs|mts|ts|tsx)$/.test(file)) return true
  if (/\.(cjs|cts)$/.test(file)) return false
  return /^\s*(import\s|export\s|import\()/m.test(src)
}

/**
 * Scan one file's source for un-awaited calls to newly-async methods.
 *
 * Matches `<receiver>.<method>(` where the receiver is any identifier or member
 * expression — this cannot know that the receiver is a `Plur`, so it reports
 * `db.list()` too. That is the correct trade for a text tool: a false positive
 * costs a glance, a false negative ships a silent bug. The report says which
 * receiver it saw so the reader can dismiss it instantly.
 *
 * Receiver chains may include single-level bracket indexes — `stores[0]`,
 * `byName['team']`, `pool[i + 1]` — because arrays/maps of stores are ordinary
 * shapes for this API and a receiver the regex cannot see is a call the user
 * is never told about (the 0.16.0 audit found `arr[0].learn(x)` scanned
 * clean, #752). A NESTED index (`m[a[0]].learn(x)`) still does not match:
 * `[^\]]` cannot span the inner `]`, and every partial interpretation fails
 * to reach the method dot, so the site is missed — not misreported, and
 * never rewritten at the wrong offset.
 */
export function scanSource(file: string, src: string, methods: readonly string[] = NEWLY_ASYNC): Finding[] {
  const spans = literalSpans(src)
  const out: Finding[] = []
  const alt = methods.join('|')
  // `?.` on either side is the same call with the same hazard: `plur?.learn(x)`
  // and `plur.learn?.(x)` both return a promise nobody awaited. Requiring a
  // plain `.` missed both.
  const re = new RegExp(String.raw`([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*|\[[^\]\n]*\])*)\??\.(${alt})\s*(?:\?\.)?\s*\(`, 'g')

  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const idx = m.index
    if (inSpans(spans, idx)) continue

    // Already awaited, yielded, or explicitly handled as a promise.
    const before = src.slice(Math.max(0, idx - 80), idx)
    if (/\b(await|yield)\s*$/.test(before)) continue
    if (/\breturn\s*$/.test(before)) continue          // `return p.learn(...)` is fine
    if (/\bvoid\s*$/.test(before)) continue            // deliberate fire-and-forget

    const after = src.slice(idx)
    // `.then(` / `.catch(` / `.finally(` immediately after the call: handled.
    //
    // The call's `(` is the LAST character of the regex match — taken from the
    // match, not from `indexOf('(', idx)`, which finds the first paren after
    // the receiver's start and therefore lands INSIDE a computed index like
    // `arr[fn(1)].learn(x)`. Balancing from there ends the "call" mid-index,
    // the `.length`-consumption check reads the wrong position, and the
    // rewrite silently awaits the wrong expression — the failure class this
    // tool exists to prevent.
    const callEnd = matchParen(after, m[0].length - 1, spans, idx)
    if (callEnd > 0 && /^\s*\.(then|catch|finally)\s*\(/.test(after.slice(callEnd))) continue

    const pos = positionOf(src, idx)

    // Unambiguous cases only. Anything structural is reported, not rewritten.
    let fixable = true
    let reason: string | undefined
    if (insideCombinatorArray(src, idx, spans)) {
      fixable = false
      reason = 'inside a Promise combinator array — awaiting here settles the call before the combinator sees it'
    } else if (/=>\s*$/.test(before)) {
      fixable = false
      reason = 'concise arrow body — the enclosing function must become async first'
    } else {
      // `await` outside an async function does not parse. Report, do not rewrite.
      const kind = enclosingFunctionKind(src, idx, spans)
      if (kind === 'sync') {
        fixable = false
        reason = 'the enclosing function is not `async` — make it async first, then re-run'
      } else if (kind === 'top-level' && !isEsm(file, src)) {
        fixable = false
        reason = 'top-level await needs an ES module — convert the file, or wrap the call in an async function'
      }
    }

    // Does something consume the result directly? Then `await` must wrap the
    // whole call, not bind looser than the member access.
    let wrapTo: number | undefined
    if (callEnd < 0) {
      // Could not find the closing paren, so whether the result is consumed is
      // unknown. Guessing here is what produced the `.length`-of-a-promise bug.
      fixable = false
      reason = 'could not determine where the call ends — add `await` by hand'
    } else if (callEnd > 0 && /^\s*[.[]/.test(after.slice(callEnd))) {
      const endIdx = idx + callEnd
      const endPos = positionOf(src, endIdx)
      // Only when the call starts and ends on the same line — a multi-line call
      // is reported for a human rather than rewritten blind.
      if (endPos.line === pos.line) wrapTo = endPos.column
      else { fixable = false; reason = 'result is consumed by a multi-line call — needs `(await ...)` by hand' }
    }

    // ASI hazard — the third failure class in the header comment, and the one
    // that shipped without its guard until the 0.16.0 pre-release audit
    // reproduced it (#752). A `wrapTo` rewrite starts the line with `(`. If
    // the PREVIOUS statement never terminated, that `(` splices both lines
    // into one expression:
    //
    //     const x = someFunc()          const x = someFunc()
    //     plur.list().length      ->    (await plur.list()).length
    //
    // parses as `someFunc()(await plur.list()).length` — the previous line's
    // result is CALLED, at runtime, with the awaited value as its argument.
    // Only the paren-wrap form is exposed: a plain inserted `await` cannot
    // continue the previous expression (`f() await` is invalid, so ASI still
    // splits the lines exactly as it did before the rewrite).
    //
    // Applies only when the call starts its line; mid-line insertions sit
    // inside an expression whose parsing is already fixed. The previous
    // significant character decides: an operator, opener, `;`, `,` or `:`
    // means the `(` either starts a fresh statement or continues an
    // expression that was ALREADY continuing — while `)`, `]`, `}`, a quote,
    // or an identifier tail can all legally absorb a following `(` as a call.
    // `}` is refused even though it is usually a block end, because it is
    // also how a function EXPRESSION ends, and `let f = function () {}`
    // followed by `(await ...)` is the splice again. Refusal costs a glance;
    // the splice costs a runtime failure in rewritten user source.
    if (fixable && wrapTo !== undefined) {
      const lineStart = idx - (pos.column - 1)
      if (/^\s*$/.test(src.slice(lineStart, idx))) {
        const prev = lastSignificantChar(src, lineStart - 1, spans)
        if (prev !== null && !ASI_SAFE_BEFORE_PAREN.has(prev)) {
          fixable = false
          reason = 'previous line has no terminator — a leading `(await ...)` splices onto it (ASI); end it with `;` or add `(await ...)` by hand'
        }
      }
    }

    out.push({ file, line: pos.line, column: pos.column, method: m[2], text: pos.text, fixable, reason, wrapTo })
  }
  return out
}

/**
 * Offset just past the `)` closing the `(` at `open`, or -1 if unbalanced.
 *
 * `s` is a suffix of the whole source starting at absolute offset `base`, so
 * span membership is tested against `base + i`. Skipping string and comment
 * spans is not cosmetic: a stray paren in a query string used to shift the
 * match, `matchParen` returned -1, and `callEnd > 0` then read as "nothing
 * consumes the result" — so `plur.recall('has a ( paren').length` was rewritten
 * to `await plur.recall(...).length`, which awaits `.length` OF THE PROMISE and
 * evaluates to undefined. It parses and it is silently wrong.
 */
function matchParen(s: string, open: number, spans: Array<[number, number]>, base: number): number {
  if (open < 0) return -1
  let d = 0
  for (let i = open; i < s.length; i++) {
    if (inSpans(spans, base + i)) continue
    if (s[i] === '(') d++
    else if (s[i] === ')') { d--; if (d === 0) return i + 1 }
  }
  return -1
}

/**
 * Add `await` at the fixable sites. Returns the new source and a count.
 *
 * Applied right-to-left so earlier offsets stay valid, and only to sites the
 * scanner marked fixable.
 */
export function applyFixes(src: string, findings: Finding[]): { src: string; applied: number } {
  const lines = src.split('\n')
  const fixable = findings.filter(f => f.fixable).sort((a, b) =>
    b.line - a.line || b.column - a.column)
  let applied = 0
  for (const f of fixable) {
    const li = f.line - 1
    const line = lines[li]
    if (line === undefined) continue
    const at = f.column - 1
    if (at < 0 || at > line.length) continue
    if (f.wrapTo !== undefined) {
      // `(await call())` — parenthesised, because the result is consumed.
      const end = f.wrapTo - 1
      if (end <= at || end > line.length) continue
      lines[li] = line.slice(0, at) + '(await ' + line.slice(at, end) + ')' + line.slice(end)
    } else {
      lines[li] = line.slice(0, at) + 'await ' + line.slice(at)
    }
    applied++
  }
  return { src: lines.join('\n'), applied }
}
