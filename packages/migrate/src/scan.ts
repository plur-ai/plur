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
    if (c === '"' || c === "'" || c === '`') {
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
    i++
  }
  return spans
}

function inSpans(spans: Array<[number, number]>, idx: number): boolean {
  for (const [a, b] of spans) if (idx >= a && idx < b) return true
  return false
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

/**
 * Scan one file's source for un-awaited calls to newly-async methods.
 *
 * Matches `<receiver>.<method>(` where the receiver is any identifier or member
 * expression — this cannot know that the receiver is a `Plur`, so it reports
 * `db.list()` too. That is the correct trade for a text tool: a false positive
 * costs a glance, a false negative ships a silent bug. The report says which
 * receiver it saw so the reader can dismiss it instantly.
 */
export function scanSource(file: string, src: string, methods: readonly string[] = NEWLY_ASYNC): Finding[] {
  const spans = literalSpans(src)
  const out: Finding[] = []
  const alt = methods.join('|')
  const re = new RegExp(String.raw`([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.(${alt})\s*\(`, 'g')

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
    const callEnd = matchParen(after, after.indexOf('('))
    if (callEnd > 0 && /^\s*\.(then|catch|finally)\s*\(/.test(after.slice(callEnd))) continue

    const pos = positionOf(src, idx)

    // Unambiguous cases only. Anything structural is reported, not rewritten.
    let fixable = true
    let reason: string | undefined
    if (/(Promise\s*\.\s*(all|race|allSettled|any)\s*\(\s*\[[^\]]*)$/.test(before)) {
      fixable = false
      reason = 'inside a Promise combinator array — awaiting here settles the call before the combinator sees it'
    } else if (/=>\s*$/.test(before)) {
      fixable = false
      reason = 'concise arrow body — the enclosing function must become async first'
    }

    // Does something consume the result directly? Then `await` must wrap the
    // whole call, not bind looser than the member access.
    let wrapTo: number | undefined
    if (callEnd > 0 && /^\s*[.[]/.test(after.slice(callEnd))) {
      const endIdx = idx + callEnd
      const endPos = positionOf(src, endIdx)
      // Only when the call starts and ends on the same line — a multi-line call
      // is reported for a human rather than rewritten blind.
      if (endPos.line === pos.line) wrapTo = endPos.column
      else { fixable = false; reason = 'result is consumed by a multi-line call — needs `(await ...)` by hand' }
    }

    out.push({ file, line: pos.line, column: pos.column, method: m[2], text: pos.text, fixable, reason, wrapTo })
  }
  return out
}

function matchParen(s: string, open: number): number {
  if (open < 0) return -1
  let d = 0
  for (let i = open; i < s.length; i++) {
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
