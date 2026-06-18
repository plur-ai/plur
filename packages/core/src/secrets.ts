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
  if (typeof text !== 'string') {
    throw new TypeError(`detectSecrets: expected string, got ${typeof text}`)
  }
  const matches: SecretMatch[] = []
  for (const { name, regex } of SECRET_PATTERNS) {
    const m = text.match(regex)
    if (m) {
      matches.push({ pattern: name, match: m[0].slice(0, 20) + '...' })
    }
  }
  return matches
}

/**
 * Prompt-injection / instruction-override patterns. Engram statements get
 * injected verbatim into future agent LLM contexts, so a third-party pack
 * carrying instruction-override text is a stored prompt-injection vector.
 * Curated for precision — this is a heuristic, not a guarantee; pattern lists
 * are inherently evadable, so it warns/blocks on the obvious, not the subtle.
 * (Security audit 2026-06-10, finding #2.)
 */
const INJECTION_PATTERNS: { name: string; regex: RegExp }[] = [
  { name: 'ignore_previous', regex: /\bignore\s+(?:all\s+|any\s+)?(?:previous|prior|earlier|the\s+above)\b/i },
  { name: 'disregard_above', regex: /\bdisregard\s+(?:all\s+|the\s+)?(?:previous|prior|earlier|above|instructions)\b/i },
  { name: 'forget_instructions', regex: /\bforget\s+(?:everything|all|your|the\s+(?:above|previous))\b/i },
  { name: 'override_instructions', regex: /\boverride\s+(?:your|the|all|previous|prior)\s+(?:instructions|rules|guidelines|safety|directives)\b/i },
  { name: 'reveal_system_prompt', regex: /\b(?:reveal|print|show|repeat|output)\s+(?:your|the)\s+system\s+prompt\b/i },
  { name: 'role_override', regex: /\byou\s+are\s+now\b|\bfrom\s+now\s+on,?\s+you\s+(?:are|will|must)\b/i },
  { name: 'bypass_safety', regex: /\b(?:bypass|disable|ignore|turn\s+off)\s+(?:the\s+)?(?:safety|guardrails?|restrictions?|guidelines|filters?)\b/i },
  { name: 'jailbreak_mode', regex: /\b(?:developer\s+mode|DAN\s+mode|jailbreak)\b/i },
  { name: 'system_tag_injection', regex: /<\/?system>|\[\/?system\]|^\s*system\s*:/im },
]

export interface InjectionMatch {
  pattern: string
  match: string
}

/** Scan text for prompt-injection / instruction-override patterns. Empty array if clean. */
export function detectPromptInjection(text: string): InjectionMatch[] {
  if (typeof text !== 'string') {
    throw new TypeError(`detectPromptInjection: expected string, got ${typeof text}`)
  }
  const matches: InjectionMatch[] = []
  for (const { name, regex } of INJECTION_PATTERNS) {
    const m = text.match(regex)
    if (m) {
      matches.push({ pattern: name, match: m[0].slice(0, 40) })
    }
  }
  return matches
}
