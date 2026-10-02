/**
 * Render a string constant the way the code builds it, for
 * scripts/extract-plur-section-history.mjs.
 *
 * Supported: a `+` concatenation of '…', "…" and `…` literals, where a
 * template literal's `${NAME}` parts name other constants in the same file.
 * Anything else — a function call, a trailing `.replace()` or
 * `.toUpperCase()`, a ternary, a comment between the parts, two definitions
 * of the same name — returns { error }, so the generator exits non-zero
 * rather than recording a text the code never installs (#1520 second
 * re-audit L3). Definitions in `//` or `/* … *\/` comments are ignored.
 */

const cook = (raw, quote) => new Function(`return ${quote}${raw}${quote}`)()

/** Start offsets of lines that sit inside a block comment. */
function commentedLineStarts(source) {
  const starts = new Set()
  let inBlock = false
  let offset = 0
  for (const line of source.split('\n')) {
    if (inBlock) starts.add(offset)
    let rest = line
    for (;;) {
      if (inBlock) {
        const end = rest.indexOf('*/')
        if (end < 0) break
        inBlock = false
        rest = rest.slice(end + 2)
      } else {
        const open = rest.indexOf('/*')
        if (open < 0) break
        inBlock = true
        rest = rest.slice(open + 2)
      }
    }
    offset += line.length + 1
  }
  return starts
}

/** @returns {{text: string} | {missing: true} | {error: string}} */
export function evaluateConst(source, name, depth = 0) {
  if (depth > 8) return { error: 'interpolation too deep' }
  const re = new RegExp(`^[ \\t]*(?:export\\s+)?const\\s+${name}(?:\\s*:\\s*[\\w.<>\\[\\] |]+)?\\s*=\\s*`, 'gm')
  const commented = commentedLineStarts(source)
  const defs = [...source.matchAll(re)].filter(m => !commented.has(m.index))
  if (defs.length === 0) return { missing: true }
  if (defs.length > 1) return { error: `${name} is defined ${defs.length} times` }
  let i = defs[0].index + defs[0][0].length
  let out = ''
  for (;;) {
    while (/\s/.test(source[i] ?? '')) i++
    const q = source[i]
    if (q === "'" || q === '"') {
      let j = i + 1
      while (source[j] !== q) {
        if (source[j] === '\\') j++
        j++
        if (j >= source.length || source[j] === '\n') return { error: 'unterminated string' }
      }
      out += cook(source.slice(i + 1, j), q)
      i = j + 1
    } else if (q === '`') {
      let j = i + 1
      let chunk = ''
      for (;;) {
        const c = source[j]
        if (c === undefined) return { error: 'unterminated template' }
        if (c === '\\') { chunk += c + source[j + 1]; j += 2; continue }
        if (c === '`') break
        if (c === '$' && source[j + 1] === '{') {
          const end = source.indexOf('}', j)
          const ref = source.slice(j + 2, end).trim()
          if (!/^[A-Za-z_$][\w$]*$/.test(ref)) return { error: `interpolates an expression: ${ref}` }
          const inner = evaluateConst(source, ref, depth + 1)
          if (inner.text === undefined) return { error: `cannot resolve \${${ref}}: ${inner.error ?? 'not defined'}` }
          out += cook(chunk, '`') + inner.text
          chunk = ''
          j = end + 1
          continue
        }
        chunk += c
        j++
      }
      out += cook(chunk, '`')
      i = j + 1
    } else {
      return { error: 'not a string expression' }
    }
    // What follows a literal: `+` and another part, or the end of the statement.
    while (source[i] === ' ' || source[i] === '\t') i++
    if (source[i] === '+') { i++; continue }
    if (source[i] === ';') i++
    while (source[i] === ' ' || source[i] === '\t') i++
    if (source[i] !== undefined && source[i] !== '\n' && source[i] !== '\r') {
      return { error: `unsupported after a string: ${JSON.stringify(source.slice(i, i + 12))}` }
    }
    // A continuation on the next line (`.replace(…)`, `+ '…'`, `? …`).
    let k = i
    while (/\s/.test(source[k] ?? '')) k++
    if (source[k] === '+') { i = k + 1; continue }
    if ('.?[(:'.includes(source[k] ?? '\0') && source[k] !== undefined) {
      return { error: `unsupported continuation: ${JSON.stringify(source.slice(k, k + 12))}` }
    }
    return { text: out }
  }
}
