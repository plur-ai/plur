/**
 * Render a string constant the way the code builds it, for
 * scripts/extract-plur-section-history.mjs.
 *
 * The source is first lexed (code, comments, strings, template literals with
 * nested `${…}`, regex literals), so a `const` inside a comment or a string is
 * never taken for a definition, and a `/*` inside a string or `//` comment
 * hides nothing (#1520 third re-audit N4).
 *
 * Supported: a `+` concatenation of '…', "…" and `…` literals, where a
 * template literal's `${NAME}` parts name other constants in the same file,
 * ended by `;`, the end of the file, or a newline followed by the next
 * statement. Everything else returns { error } — a function call, a trailing
 * `.replace()`, `&&`/`||`, a ternary, a comment between the parts, two
 * definitions of the same name — so the generator exits non-zero rather than
 * record a text the code never installs (second re-audit L3).
 */

const cook = (raw, quote) => new Function(`return ${quote}${raw}${quote}`)()

/** Per character: 'code', 'comment', 'string', 'template' or 'regex'. */
export function lex(source) {
  const kind = new Array(source.length).fill('code')
  const stack = [] // brace depths of open `${` inside templates
  let depth = 0
  let lastCode = ''
  let i = 0
  const mark = (from, to, k) => { for (let x = from; x < to; x++) kind[x] = k }
  const regexCanStart = () => lastCode === '' || '(,=:[!&|?{};+-*%<>~^'.includes(lastCode)
  const scanTemplate = (from) => {
    // from: index just after the opening backtick (or after a closing `}`)
    let j = from
    while (j < source.length) {
      if (source[j] === '\\') { j += 2; continue }
      if (source[j] === '`') { mark(from, j + 1, 'template'); return { end: j + 1, open: false } }
      if (source[j] === '$' && source[j + 1] === '{') { mark(from, j + 2, 'template'); return { end: j + 2, open: true } }
      j++
    }
    mark(from, source.length, 'template')
    return { end: source.length, open: false }
  }
  while (i < source.length) {
    const c = source[i]
    const n = source[i + 1]
    if (c === '/' && n === '/') {
      const end = source.indexOf('\n', i)
      const stop = end < 0 ? source.length : end
      mark(i, stop, 'comment'); i = stop; continue
    }
    if (c === '/' && n === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end < 0 ? source.length : end + 2
      mark(i, stop, 'comment'); i = stop; continue
    }
    if (c === "'" || c === '"') {
      let j = i + 1
      while (j < source.length && source[j] !== c && source[j] !== '\n') { if (source[j] === '\\') j++; j++ }
      mark(i, j + 1, 'string'); i = j + 1; lastCode = c; continue
    }
    if (c === '`') {
      kind[i] = 'template'
      const t = scanTemplate(i + 1)
      i = t.end
      if (t.open) { stack.push(depth); depth = 0 } else lastCode = '`'
      continue
    }
    if (c === '/' && regexCanStart()) {
      let j = i + 1
      let inClass = false
      while (j < source.length && source[j] !== '\n') {
        if (source[j] === '\\') { j += 2; continue }
        if (source[j] === '[') inClass = true
        else if (source[j] === ']') inClass = false
        else if (source[j] === '/' && !inClass) break
        j++
      }
      while (/[a-z]/i.test(source[j + 1] ?? '')) j++
      mark(i, j + 1, 'regex'); i = j + 1; lastCode = '/'; continue
    }
    if (c === '{') depth++
    if (c === '}') {
      if (depth === 0 && stack.length) {
        depth = stack.pop()
        kind[i] = 'template'
        const t = scanTemplate(i + 1)
        i = t.end
        if (t.open) { stack.push(depth); depth = 0 } else lastCode = '`'
        continue
      }
      depth--
    }
    if (!/\s/.test(c)) lastCode = c
    i++
  }
  return kind
}

/** @returns {{text: string} | {missing: true} | {error: string}} */
export function evaluateConst(source, name, depth = 0, kind = lex(source)) {
  if (depth > 8) return { error: 'interpolation too deep' }
  const re = new RegExp(`\\bconst\\s+${name}\\b(?:\\s*:\\s*[\\w.<>\\[\\] |]+)?\\s*=(?!=)\\s*`, 'g')
  const defs = [...source.matchAll(re)].filter(m => {
    if (kind[m.index] !== 'code') return false
    const lineStart = source.lastIndexOf('\n', m.index - 1) + 1
    const before = [...source.slice(lineStart, m.index)].filter((_, k) => kind[lineStart + k] === 'code').join('')
    return /^\s*(?:export\s+)?$/.test(before)
  })
  if (defs.length === 0) return { missing: true }
  if (defs.length > 1) return { error: `${name} is defined ${defs.length} times` }

  let i = defs[0].index + defs[0][0].length
  if (kind[i] === 'comment') return { error: 'a comment inside the expression' }
  let out = ''
  for (;;) {
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
          const inner = evaluateConst(source, ref, depth + 1, kind)
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
    let sawComment = false
    let sawNewline = false
    while (i < source.length && (kind[i] === 'comment' || /\s/.test(source[i]))) {
      if (kind[i] === 'comment') sawComment = true
      if (source[i] === '\n') sawNewline = true
      i++
    }
    const c = source[i]
    if (c === undefined || c === ';') return { text: out }
    if (c === '+' && source[i + 1] !== '+' && source[i + 1] !== '=') {
      if (sawComment) return { error: 'a comment between the parts' }
      i++
      while (i < source.length && /\s/.test(source[i])) i++
      if (kind[i] === 'comment') return { error: 'a comment between the parts' }
      continue
    }
    // A newline ends the statement only when the next token cannot continue it.
    if (sawNewline && (/[A-Za-z_$'"}\])]/.test(c))) return { text: out }
    return { error: `unsupported after a string: ${JSON.stringify(source.slice(i, i + 12))}` }
  }
}
