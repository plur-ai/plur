/**
 * Remove a known secret from text that is about to be shown (#1265, audit of
 * #1272). A server that answers with an error body can hand the caller's own
 * token back, and not always verbatim: a URL-encoded query echo, a JSON-escaped
 * field, or a base64 Basic-auth style blob all carry it. An exact-string scrub
 * misses every one of those, so each encoding is removed too.
 *
 * Forms covered: raw; percent-encoded (encodeURIComponent and encodeURI,
 * either hex case); JSON-escaped; base64 with and without padding; base64url.
 * Not covered: a PREFIX or fragment of the token, or its base64 when it sits
 * at an offset inside a larger base64 blob — those do not have a fixed form.
 */
const REDACTED = '[redacted]'

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Every encoding of `token` this module removes, longest first. */
export function tokenForms(token: string): string[] {
  if (!token) return []
  const b64 = Buffer.from(token, 'utf8').toString('base64')
  const forms = new Set<string>([
    token,
    encodeURIComponent(token),
    encodeURI(token),
    JSON.stringify(token).slice(1, -1),
    b64,
    b64.replace(/=+$/, ''),
    Buffer.from(token, 'utf8').toString('base64url'),
  ])
  return [...forms].filter(f => f.length > 0).sort((a, b) => b.length - a.length)
}

/** `text` with every form of `token` replaced by `[redacted]`. */
export function redactToken(text: string, token: string): string {
  let out = String(text)
  for (const form of tokenForms(token)) {
    // Percent-escapes are case-insensitive in hex; everything else is exact.
    const pattern = /%[0-9A-F]{2}/.test(form)
      ? new RegExp(escapeRegExp(form).replace(/%([0-9A-F]{2})/g, (_m, h: string) =>
          `%[${h[0]}${h[0].toLowerCase()}][${h[1]}${h[1].toLowerCase()}]`), 'g')
      : new RegExp(escapeRegExp(form), 'g')
    out = out.replace(pattern, REDACTED)
  }
  return out
}

/** True when `text` carries any form of `token`. */
export function containsToken(text: string, token: string): boolean {
  return Boolean(token) && redactToken(text, token) !== String(text)
}

/** Deep copy of `value` with every string passed through {@link redactToken}. */
export function redactTokenDeep<T>(value: T, token: string): T {
  if (typeof value === 'string') return redactToken(value, token) as unknown as T
  if (Array.isArray(value)) return value.map(v => redactTokenDeep(v, token)) as unknown as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactTokenDeep(v, token)]),
    ) as T
  }
  return value
}
