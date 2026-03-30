export interface SecretMatch {
  pattern: string
  match: string
}

const SECRET_PATTERNS: { name: string; regex: RegExp }[] = [
  { name: 'aws_access_key', regex: /AKIA[0-9A-Z]{16}/ },
  { name: 'aws_secret_key', regex: /(?:aws_secret_access_key|secret_access_key)\s*[=:]\s*[A-Za-z0-9/+=]{40}/i },
  { name: 'generic_api_key', regex: /(?:^|[^a-z])(sk|pk)[-_][a-z0-9]{20,}/i },
  { name: 'api_key_assignment', regex: /(?:api[_-]?key|api[_-]?secret|secret[_-]?key)\s*[=:]\s*\S{20,}/i },
  { name: 'password_assignment', regex: /password\s*[=:]\s*\S{8,}/i },
  { name: 'connection_string', regex: /(?:postgres|mysql|mongodb|redis):\/\/\S+/ },
  { name: 'jwt', regex: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}/ },
  { name: 'private_key', regex: /-----BEGIN\s+\S+\s+PRIVATE KEY-----/ },
  { name: 'bearer_token', regex: /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/ },
]

/** Scan text for potential secrets. Returns empty array if clean. */
export function detectSecrets(text: string): SecretMatch[] {
  const matches: SecretMatch[] = []
  for (const { name, regex } of SECRET_PATTERNS) {
    const m = text.match(regex)
    if (m) {
      matches.push({ pattern: name, match: m[0].slice(0, 20) + '...' })
    }
  }
  return matches
}
