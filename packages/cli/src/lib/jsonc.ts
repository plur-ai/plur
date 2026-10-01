/**
 * Read-only JSONC support: JSON with `//` and `/* *\/` comments and trailing
 * commas, the syntax opencode accepts in its config file.
 *
 * READ PATHS ONLY. A JSONC file parsed here cannot be written back without
 * losing its comments, so writers (`writeOpencodeConfig`) keep refusing JSONC
 * rather than round-tripping it through this (#1059 class).
 *
 * String-aware: `//`, `/*` and `,}` inside a string literal are content — a
 * `$schema` URL or a glob must survive. Comments are replaced by whitespace
 * (newlines kept) so a JSON.parse error still points at the right line.
 */
export function stripJsonc(text: string): string {
  let out = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i]
    if (ch === '"') {
      // Copy the string literal verbatim, honouring backslash escapes. An
      // unterminated string is copied to the end; JSON.parse then rejects it.
      let j = i + 1
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n' && text[i] !== '\r') i++
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      // Unterminated block comment: leave it in so JSON.parse rejects the file.
      if (end === -1) { out += text.slice(i); break }
      out += text.slice(i, end + 2).replace(/[^\r\n]/g, ' ')
      i = end + 2
    } else {
      out += ch
      i++
    }
  }
  return removeTrailingCommas(out)
}

/** Drop a `,` whose next non-whitespace character closes an object or array. */
function removeTrailingCommas(text: string): string {
  let out = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i]
    if (ch === '"') {
      let j = i + 1
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
      continue
    }
    if (ch === ',') {
      let j = i + 1
      while (j < n && /\s/.test(text[j])) j++
      if (text[j] === '}' || text[j] === ']') { i++; continue }
    }
    out += ch
    i++
  }
  return out
}

/** Parse JSONC. Throws (like JSON.parse) when the result is not valid JSON. */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonc(text))
}
