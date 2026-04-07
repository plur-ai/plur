import { z } from 'zod'

const RegisterSchema = z.object({
  name: z
    .string()
    .min(3, 'Name must be at least 3 characters')
    .max(32, 'Name must be at most 32 characters')
    .regex(/^[a-z0-9-]+$/, 'Name must be lowercase alphanumeric with hyphens only'),
  wallet: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'Wallet must be a valid Ethereum address (0x + 40 hex chars)'),
  hub: z.string().url('Hub must be a valid URL').default('https://api.plur.ai'),
  /**
   * Optional HTTP basic auth in `user:password` format.
   * Used for staging hubs gated by Caddy basic_auth.
   * Falls back to PLUR_HUB_AUTH env var if not set.
   */
  auth: z.string().optional(),
  domain: z.string().optional(),
  queryPrice: z.string().optional(),
  forwardTo: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  autoList: z.boolean().optional(),
  autoListDelay: z.string().optional(),
  autoListPrice: z.string().optional(),
})

/**
 * Build the Authorization header value from a `user:password` string.
 * Returns null if input is empty.
 */
export function buildAuthHeader(auth: string | undefined | null): string | null {
  if (!auth || !auth.includes(':')) return null
  const encoded = Buffer.from(auth, 'utf-8').toString('base64')
  return `Basic ${encoded}`
}

export type RegisterOptions = z.input<typeof RegisterSchema>

export interface RegisterResult {
  name: string
  url: string
  wallet: string
  domain?: string
  queryPrice: string
}

export async function register(opts: RegisterOptions): Promise<RegisterResult> {
  const parsed = RegisterSchema.parse(opts)

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const authHeader = buildAuthHeader(parsed.auth ?? process.env.PLUR_HUB_AUTH)
  if (authHeader) headers['Authorization'] = authHeader

  const response = await fetch(`${parsed.hub}/api/v1/agents/register`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: parsed.name,
      wallet: parsed.wallet,
      domain: parsed.domain,
      queryPrice: parsed.queryPrice,
      forwardTo: parsed.forwardTo,
      capabilities: parsed.capabilities,
      autoList: parsed.autoList,
      autoListDelay: parsed.autoListDelay,
      autoListPrice: parsed.autoListPrice,
    }),
  })

  if (!response.ok) {
    let message = `Registration failed: ${response.status} ${response.statusText}`
    try {
      const body = await response.json() as { error?: string; message?: string }
      if (body.error || body.message) {
        message = body.error ?? body.message ?? message
      }
    } catch {
      // ignore JSON parse errors
    }
    throw new Error(message)
  }

  return response.json() as Promise<RegisterResult>
}
