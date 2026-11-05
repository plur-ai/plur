/**
 * Read-only JSONC support (comments and trailing commas, as opencode accepts). Parsing
 * discards comments; writers must apply offset edits to the source (see
 * writeOpencodeConfig). String-aware: `//`, `/*` and `,}` inside strings are content.
 * Line comments are deleted up to their line break and block comments blanked with
 * line breaks kept, so JSON.parse errors keep their line. Block comments do not nest.
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

/**
 * Drop a `,` whose next non-whitespace character closes an object or array —
 * but only when a value precedes it. `{,}`, `[,]` and `[1,,]` keep their comma
 * so JSON.parse rejects them, as opencode's own parser does.
 */
function removeTrailingCommas(text: string): string {
  let out = ''
  let i = 0
  const n = text.length
  // Last significant (non-whitespace) character emitted; '' at the start.
  let prev = ''
  while (i < n) {
    const ch = text[i]
    if (ch === '"') {
      let j = i + 1
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      prev = '"'
      i = j + 1
      continue
    }
    if (ch === ',') {
      let j = i + 1
      while (j < n && /\s/.test(text[j])) j++
      const followsValue = prev !== '' && prev !== '{' && prev !== '[' && prev !== ','
      if ((text[j] === '}' || text[j] === ']') && followsValue) { i++; continue }
    }
    out += ch
    if (!/\s/.test(ch)) prev = ch
    i++
  }
  return out
}

/**
 * Parse JSONC. Throws (like JSON.parse) when the result is not valid JSON.
 * A leading UTF-8 byte-order mark is accepted, as editors on Windows write one.
 */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonc(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text))
}
