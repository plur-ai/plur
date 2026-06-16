/**
 * Minimal, dependency-free JWT inspection — we only ever READ the `exp`
 * claim to warn about token expiry. We do NOT verify the signature (the
 * server does that); this is purely for client-side "your token expires
 * in N days" / "your token has expired" observability (#295).
 *
 * Enterprise tokens are HS256 JWTs (`iss: plur-enterprise`) with a 30-day
 * TTL and no refresh, so silent expiry is a recurring failure mode. Opaque
 * API keys (e.g. `plur_sk_...`) are not JWTs — those return all-null and the
 * caller falls back to the live `/me` probe.
 */

export interface JwtExpiry {
  /** When the token expires, or null if not a decodable JWT with an `exp`. */
  expiresAt: Date | null
  /** True only when we could read `exp` AND it is in the past. */
  expired: boolean
  /** Whole days until expiry (negative if already expired), or null if unknown. */
  expiresInDays: number | null
}

const UNKNOWN: JwtExpiry = { expiresAt: null, expired: false, expiresInDays: null }

function base64UrlDecode(segment: string): string | null {
  try {
    const pad = segment.length % 4 === 0 ? '' : '='.repeat(4 - (segment.length % 4))
    const b64 = segment.replace(/-/g, '+').replace(/_/g, '/') + pad
    return Buffer.from(b64, 'base64').toString('utf8')
  } catch {
    return null
  }
}

/**
 * Read the `exp` claim from a JWT without verifying it. Returns all-null for
 * anything that is not a three-part JWT carrying a numeric `exp` (e.g. opaque
 * API keys), so callers can cleanly skip expiry reasoning for those.
 *
 * @param now epoch millis to compare against (injectable for tests; defaults to Date.now()).
 */
export function decodeJwtExpiry(token: string | undefined | null, now: number = Date.now()): JwtExpiry {
  if (!token || typeof token !== 'string') return UNKNOWN
  const parts = token.split('.')
  if (parts.length !== 3) return UNKNOWN
  const json = base64UrlDecode(parts[1])
  if (!json) return UNKNOWN
  let payload: { exp?: unknown }
  try {
    payload = JSON.parse(json)
  } catch {
    return UNKNOWN
  }
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return UNKNOWN
  const expiresAt = new Date(payload.exp * 1000)
  const msLeft = expiresAt.getTime() - now
  return {
    expiresAt,
    expired: msLeft <= 0,
    expiresInDays: Math.floor(msLeft / 86_400_000),
  }
}
