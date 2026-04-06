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
  domain: z.string().optional(),
  queryPrice: z.string().optional(),
  forwardTo: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  autoList: z.boolean().optional(),
  autoListDelay: z.string().optional(),
  autoListPrice: z.string().optional(),
})

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

  const response = await fetch(`${parsed.hub}/api/v1/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
