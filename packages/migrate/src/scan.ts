/**
 * Find PLUR calls that stopped being synchronous in 0.16 and were never awaited.
 * Reports by default and rewrites only unambiguous sites, because a naive
 * codemod produces valid code that is silently wrong in three ways (neither the
 * compiler nor tests catch them):
 *   - **String literals:** rewriting text inside quotes.
 *   - **`Promise.race` / `Promise.all` arrays:** an inserted `await` settles the
 *     element first, e.g. disabling a timeout guard.
 *   - **ASI hazards:** a line starting `(await ...)` splices onto a previous line with no semicolon.
 */

/**
 * Methods on `Plur` that return a promise as of 0.16 and did not before — NOT
 * every async method (`recallHybrid` etc. were always async). `capture` and
 * `timeline` are absent because they are still synchronous (`episodes.yaml`);
 * `suggestScope`, `dismissScope`, `reofferScopes` and `listImportSources` were
 * briefly async before release and were reverted.
 */
export const NEWLY_ASYNC = [
  // Derived from git, not from memory: these are the methods whose signature
  // went sync -> async in 0.16. `packages/migrate/test/method-list.test.ts`
  // re-derives the same set from `Plur` and fails if this drifts.
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
  // than migration fallout — but reporting it costs nothing and helps.
  // `addStore` is NOT listed: it is synchronous, and an `await` does not
  // belong there.
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
 * statement: `;`, openers `{ ( [`, separators `, :`, and operator tails
 * `= > & | + - * % < ~ ^ ?` (`>` covers `=>`). Anything else (`)`, `]`, `}`,
 * quotes, identifier characters) can absorb a `(` — the ASI splice; see `scanSource`.
 * - `/` and `!` are deliberately absent: they almost always END an expression
 *   (regex literal, non-null assertion), and `literalSpans` does not lex regexes.
 * - Known caveat: a TS instantiation expression tail (`f<string>` at end of
 *   line) ends in `>` and does splice; rare enough to accept.
 */
const ASI_SAFE_BEFORE_PAREN = new Set([
  ';', '{', ',', '(', '[', ':', '=', '>', '&', '|', '+', '-', '*', '%', '<', '~', '^', '?',
])

/** The span containing `idx`, or null. */
function spanAt(spans: Array<[number, number]>, idx: number): [number, number] | null {
  for (const s of spans) if (idx >= s[0] && idx < s[1]) return s
  return null
}

/**
 * Index of the last significant character at or before `from`: whitespace is
 * skipped, COMMENT spans are skipped whole, and a string/template literal is
 * significant — its closing quote/backtick position is returned, because a
 * string can absorb a following `(` as a call (`'s'(...)` / tagged template),
 * so for the ASI guard it must count as hazardous, not vanish like a comment.
 * Callers that need to know they landed inside a literal check `spanAt`.
 */
function lastSignificantIndex(src: string, from: number, spans: Array<[number, number]>): number {
  for (let j = from; j >= 0; j--) {
    const span = spanAt(spans, j)
    if (span) {
      if (src[span[0]] === '/') { j = span[0]; continue } // comment — skip whole
      return j // inside a string/template literal
    }
    if (/\s/.test(src[j])) continue
    return j
  }
  return -1
}

/** The last significant character at or before `from`, or null. See above. */
function lastSignificantChar(src: string, from: number, spans: Array<[number, number]>): string | null {
  const j = lastSignificantIndex(src, from, spans)
  return j < 0 ? null : src[j]
}

/**
 * Index of the first significant character at or after `from`: whitespace is
 * skipped, comment spans are skipped whole. The mirror of
 * `lastSignificantIndex`, used to see what CONSUMES a call's result — a
 * comment sitting between the call and its `.length` must not make a consumed
 * call look bare, because the bare form gets a plain `await`, which for a
 * consumed result awaits the wrong expression.
 */
function nextSignificantIndex(src: string, from: number, spans: Array<[number, number]>): number {
  for (let j = from; j < src.length; j++) {
    const span = spanAt(spans, j)
    if (span) {
      if (src[span[0]] === '/') { j = span[1] - 1; continue } // comment — skip whole
      return j
    }
    if (/\s/.test(src[j])) continue
    return j
  }
  return -1
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
 * Awaiting an element there settles it before the array exists (disabling a
 * `race` timeout, serialising an `all`), so emitting it is unacceptable.
 * Scans outward for an unmatched `[`; a fixed look-back window would miss
 * combinators with long preceding elements.
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
      // them. A raw `src.slice` would match the literal text `Promise.all(`
      // inside an adjacent COMMENT (`process(\n  // Promise.all(\n  [...]`)
      // and refuse ordinary calls; that fails safe but sends a human to
      // investigate nothing.
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
 * call is not inside a function. `await` outside an async function does not
 * parse, so a rewrite there would break the build. Walks backwards by brace
 * depth to the nearest enclosing function header; string and comment spans are
 * skipped by the caller's span list.
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
    // one as a non-async function would make every call inside a conditional
    // or loop unfixable — even inside an async function.
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

const IDENT_CHAR = /[\w$]/

/**
 * Words that may sit directly before a `(...)` or `[...]` group without
 * calling or indexing it — prefix operators and statement keywords. They
 * decide the receiver walk below: `await (getPlur()).recall(q)` must resolve
 * the GROUP as the receiver head (and then be recognised as already awaited),
 * not treat `await` as a callee — treating it as one re-anchors the finding
 * past the `await` and reports (then mangles) already-correct code.
 * `new` is deliberately absent: it is handled specially, because `await`
 * cannot be inserted between `new` and its callee.
 */
const NON_CALLEE_WORDS = new Set([
  'await', 'yield', 'return', 'throw', 'typeof', 'void', 'delete',
  'in', 'of', 'case', 'else', 'instanceof',
])

/** Index of the `(` matching the `)` at `close`, or -1. Spans skipped whole. */
function matchBackwardParen(src: string, close: number, spans: Array<[number, number]>): number {
  let d = 0
  for (let i = close; i >= 0; i--) {
    const span = spanAt(spans, i)
    if (span) { i = span[0]; continue }
    if (src[i] === ')') d++
    else if (src[i] === '(') { d--; if (d === 0) return i }
  }
  return -1
}

/** Index of the `[` matching the `]` at `close`, or -1. Spans skipped whole. */
function matchBackwardBracket(src: string, close: number, spans: Array<[number, number]>): number {
  let d = 0
  for (let i = close; i >= 0; i--) {
    const span = spanAt(spans, i)
    if (span) { i = span[0]; continue }
    if (src[i] === ']') d++
    else if (src[i] === '[') { d--; if (d === 0) return i }
  }
  return -1
}

/**
 * Resolve the start of the receiver chain whose method dot sits at `dot`, or
 * null when the receiver is not one this tool understands. Walks BACKWARD
 * through identifiers, `?.`, bracket indexes, call arguments and parenthesised
 * heads, skipping whitespace and comments. A regex would miss multi-line chains
 * and re-anchor mid-chain (`getStore().await plur.recall(q)`). Anything
 * unclassifiable returns null: a missed finding beats a mis-anchored rewrite.
 */
function receiverStart(src: string, dot: number, spans: Array<[number, number]>): number | null {
  let i = dot - 1
  if (src[i] === '?') i-- // the `?.` before the method — one token, always adjacent
  for (;;) {
    i = lastSignificantIndex(src, i, spans)
    if (i < 0) return null
    if (spanAt(spans, i)) return null // a string/template cannot head this chain
    const c = src[i]

    if (c === ')') {
      // A call in the chain (`getPlur().recall(q)`, `plur.scoped(s).recall(q)`)
      // or a parenthesised head (`(store as Plur).recall(q)`). What precedes
      // the `(` decides which.
      const open = matchBackwardParen(src, i, spans)
      if (open < 0) return null
      const p = lastSignificantIndex(src, open - 1, spans)
      if (p < 0) return open                 // `(...)` at file start heads the receiver
      if (spanAt(spans, p)) return null      // tagged-template call — not a chain this tool reads
      if (IDENT_CHAR.test(src[p])) {
        let w = p
        while (w > 0 && IDENT_CHAR.test(src[w - 1])) w--
        const word = src.slice(w, p + 1)
        // `new Plur().recall(q)` — the insertion must cover the `new`:
        // `new await Plur()` does not parse, `await new Plur()...` does.
        if (word === 'new') return w
        if (NON_CALLEE_WORDS.has(word)) return open // `await (...)`, `typeof (...)`, …
        if (CONTROL_KEYWORDS.has(word)) return null // `for (...) (x).recall(q)` — a statement header, not a callee
        if (/[0-9]/.test(src[w])) return null       // a number is not a callee
        i = p                                       // ordinary call — the callee continues the chain
        continue
      }
      if (src[p] === ')' || src[p] === ']') { i = p; continue } // f()(…) / arr[0](…)
      return open // parenthesised expression heads the receiver
    }

    if (c === ']') {
      const open = matchBackwardBracket(src, i, spans)
      if (open < 0) return null
      const p = lastSignificantIndex(src, open - 1, spans)
      if (p < 0) return open                 // `[...]` literal at file start
      if (spanAt(spans, p)) return null      // `'str'[0]` — a string receiver is not this tool's pattern
      if (src[p] === '.' && src[p - 1] === '?') { i = p - 2; continue } // arr?.[0]
      if (IDENT_CHAR.test(src[p])) {
        let w = p
        while (w > 0 && IDENT_CHAR.test(src[w - 1])) w--
        const word = src.slice(w, p + 1)
        // `return [a, b].learn(x)` — the `[` does not index the keyword.
        if (word === 'new' || NON_CALLEE_WORDS.has(word) || CONTROL_KEYWORDS.has(word)) return open
        i = p
        continue
      }
      if (src[p] === ')' || src[p] === ']') { i = p; continue } // f()[0] / a[0][1]
      return open // array literal heads the receiver
    }

    if (IDENT_CHAR.test(c)) {
      let s = i
      while (s > 0 && IDENT_CHAR.test(src[s - 1])) s--
      if (/[0-9]/.test(src[s])) return null // a number literal, not an identifier
      const p = lastSignificantIndex(src, s - 1, spans)
      if (p >= 0 && !spanAt(spans, p) && src[p] === '.') {
        if (src[p - 1] === '?') { i = p - 2; continue } // x?.y link
        if (src[p - 1] === '.') return s               // `...plur` — spread dots, the chain starts here
        i = p - 1                                       // plain member link
        continue
      }
      if (p >= 0 && !spanAt(spans, p) && IDENT_CHAR.test(src[p])) {
        let w = p
        while (w > 0 && IDENT_CHAR.test(src[w - 1])) w--
        if (src.slice(w, p + 1) === 'new') return w // `new Plur().recall(q)` via a bare callee
      }
      return s
    }

    return null // an operator or opener where an element was expected
  }
}

/**
 * Scan one file's source for un-awaited calls to newly-async methods. Anchored
 * on the METHOD; the receiver is resolved by `receiverStart`, so multi-line
 * chains resolve like single-line ones. It cannot know the receiver is a
 * `Plur`, so it also reports e.g. `db.list()`: a false positive costs a glance,
 * a false negative ships a bug. The report names the receiver it saw.
 */
export function scanSource(file: string, src: string, methods: readonly string[] = NEWLY_ASYNC): Finding[] {
  const spans = literalSpans(src)
  const out: Finding[] = []
  const alt = methods.join('|')
  // `?.` on either side is the same call with the same hazard: `plur?.learn(x)`
  // and `plur.learn?.(x)` both return a promise nobody awaited. Requiring a
  // plain `.` missed both. The dot may carry whitespace on either side —
  // `plur\n  .recall(q)` and `plur.\n  recall(q)` are both ordinary styles.
  const re = new RegExp(String.raw`\.\s*(${alt})\s*(?:\?\.)?\s*\(`, 'g')
  // One finding per receiver head: `plur.recall(q).learn(x)` produces two
  // method matches that resolve to the SAME chain start, and rewriting both
  // would insert twice at one offset.
  const seen = new Set<number>()

  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const dot = m.index
    if (inSpans(spans, dot)) continue

    const idx = receiverStart(src, dot, spans)
    if (idx === null || seen.has(idx)) continue

    // The call's `(` is the LAST character of the regex match — taken from the
    // match, not from `indexOf('(', idx)`, which finds the first paren after
    // the receiver's start and therefore lands INSIDE a computed index like
    // `arr[fn(1)].learn(x)`. Balancing from there ends the "call" mid-index,
    // the `.length`-consumption check reads the wrong position, and the
    // rewrite silently awaits the wrong expression — the failure class this
    // tool exists to prevent.
    const parenIdx = dot + m[0].length - 1

    // Already awaited, yielded, or explicitly handled as a promise — checked
    // at the CHAIN head: `await plur\n  .recall(q)` is awaited however many
    // lines the chain spans.
    const before = src.slice(Math.max(0, idx - 80), idx)
    if (/\b(await|yield)\s*$/.test(before)) continue
    if (/\breturn\s*$/.test(before)) continue          // `return p.learn(...)` is fine
    if (/\bvoid\s*$/.test(before)) continue            // deliberate fire-and-forget

    const after = src.slice(idx)
    const callEnd = matchParen(after, parenIdx - idx, spans, idx)
    // What consumes the result is the next SIGNIFICANT character after the
    // call — significant, so a comment between the call and its `.length`
    // cannot make a consumed call look bare (the bare form gets a plain
    // `await`, which for a consumed result awaits the wrong expression).
    const nsi = callEnd > 0 ? nextSignificantIndex(src, idx + callEnd, spans) : -1
    // `.then(` / `.catch(` / `.finally(` after the call: handled.
    if (nsi >= 0 && /^(?:\?\.|\.)\s*(?:then|catch|finally)\s*\(/.test(src.slice(nsi, nsi + 80))) continue

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
    // whole call, not bind looser than the member access. `?.` counts: `await
    // plur.recall(q)?.length` awaits `.length` OF THE PROMISE exactly as the
    // plain dot does.
    let wrapTo: number | undefined
    if (callEnd < 0) {
      // Could not find the closing paren, so whether the result is consumed is
      // unknown. Guessing here risks awaiting `.length` of the promise.
      fixable = false
      reason = 'could not determine where the call ends — add `await` by hand'
    } else if (nsi >= 0 && (src[nsi] === '.' || src[nsi] === '[' || (src[nsi] === '?' && src[nsi + 1] === '.'))) {
      const endIdx = idx + callEnd
      const endPos = positionOf(src, endIdx)
      // Only when the whole expression — chain head through closing paren —
      // sits on one line. A consumed call that spans lines (a multi-line
      // argument list, or a receiver chain split across lines: `plur\n
      // .recall(q)\n  .length`) is reported for a human
      // rather than rewritten blind.
      if (endPos.line === pos.line) wrapTo = endPos.column
      else { fixable = false; reason = 'result is consumed by a multi-line expression — needs `(await ...)` by hand' }
    }

    // ASI hazard (the third class in the header). A `wrapTo` rewrite starts the
    // line with `(`; if the previous statement never terminated, that splices:
    //     const x = someFunc()          const x = someFunc()
    //     plur.list().length      ->    (await plur.list()).length
    // calls `someFunc()` with the awaited value. Only paren-wraps at line start
    // are exposed. Refuse unless the previous significant character is in
    // ASI_SAFE_BEFORE_PAREN; `}` is refused too, since a function expression
    // ends with it.
    if (fixable && wrapTo !== undefined) {
      const lineStart = idx - (pos.column - 1)
      if (/^\s*$/.test(src.slice(lineStart, idx))) {
        const prev = lastSignificantChar(src, lineStart - 1, spans)
        if (prev !== null && !ASI_SAFE_BEFORE_PAREN.has(prev)) {
          fixable = false
          reason = 'previous line has no terminator — a leading `(await ...)` splices onto it (ASI); end it with `;` or add `(await ...)` by hand'
        }
      }
    } else if (fixable && (src[idx] === '(' || src[idx] === '[')) {
      // The receiver HEAD is a parenthesised expression or array literal —
      // the same splice read in the other direction. When that head starts
      // its line and the previous line never terminated, the head is
      // currently CONTINUING the previous expression (`let f = function ()
      // {}` + `(store as Plur).recall(q)` calls f). A plain inserted `await`
      // would cut that continuation and change what runs, so it is refused
      // exactly as the leading-`(await ...)` wrap is.
      const lineStart = idx - (pos.column - 1)
      if (/^\s*$/.test(src.slice(lineStart, idx))) {
        const prev = lastSignificantChar(src, lineStart - 1, spans)
        if (prev !== null && !ASI_SAFE_BEFORE_PAREN.has(prev)) {
          fixable = false
          reason = 'previous line has no terminator, so this line continues it (ASI) — inserting `await` would split that; end the previous line with `;` and re-run'
        }
      }
    }

    seen.add(idx)
    out.push({ file, line: pos.line, column: pos.column, method: m[1], text: pos.text, fixable, reason, wrapTo })
  }
  return out
}

/**
 * Offset just past the `)` closing the `(` at `open`, or -1 if unbalanced.
 *
 * `s` is a suffix of the whole source starting at absolute offset `base`, so
 * span membership is tested against `base + i`. Skipping string and comment
 * spans is not cosmetic: a stray paren in a query string would shift the
 * match, `matchParen` would return -1, and `callEnd > 0` would then read as
 * "nothing consumes the result" — so `plur.recall('has a ( paren').length`
 * would become `await plur.recall(...).length`, which awaits `.length` OF THE
 * PROMISE and evaluates to undefined. It parses and it is silently wrong.
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
 * Add `await` at the fixable sites. Returns the new source, the count applied,
 * and the fixable sites it could NOT apply (for the caller to report).
 * Applied right-to-left so a site's START never moves; its END can (a fixable
 * call nested in another's arguments on the same line), so every position is
 * mapped through the insertions already made on that line.
 */
export function applyFixes(src: string, findings: Finding[]): { src: string; applied: number; skipped: Finding[] } {
  const lines = src.split('\n')
  const original = lines.slice()
  const fixable = findings.filter(f => f.fixable).sort((a, b) =>
    b.line - a.line || b.column - a.column)
  // Per line: insertions made so far, as [original offset, inserted length].
  const inserted = new Map<number, Array<[number, number]>>()
  const map = (li: number, orig: number): number => {
    let shift = 0
    for (const [at, len] of inserted.get(li) ?? []) if (at < orig) shift += len
    return orig + shift
  }
  let applied = 0
  const skipped: Finding[] = []
  for (const f of fixable) {
    const li = f.line - 1
    const line = lines[li]
    const origLen = original[li]?.length ?? -1
    const at = f.column - 1
    if (line === undefined || at < 0 || at > origLen) { skipped.push(f); continue }
    const ins = inserted.get(li) ?? []
    if (f.wrapTo !== undefined) {
      // `(await call())` — parenthesised, because the result is consumed.
      const end = f.wrapTo - 1
      if (end <= at || end > origLen) { skipped.push(f); continue }
      const a = map(li, at), e = map(li, end)
      lines[li] = line.slice(0, a) + '(await ' + line.slice(a, e) + ')' + line.slice(e)
      ins.push([at, '(await '.length], [end, 1])
    } else {
      const a = map(li, at)
      lines[li] = line.slice(0, a) + 'await ' + line.slice(a)
      ins.push([at, 'await '.length])
    }
    inserted.set(li, ins)
    applied++
  }
  return { src: lines.join('\n'), applied, skipped }
}
