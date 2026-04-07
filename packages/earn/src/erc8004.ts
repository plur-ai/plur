import type { Hex } from 'viem'

/**
 * Create an ERC-8004 on-chain agent identity.
 * Gracefully returns null if the registry isn't configured — this is optional.
 *
 * Requires:
 * - process.env.ERC8004_REGISTRY (contract address on Base)
 * - process.env.ERC8004_RELAYER_KEY (platform-funded relayer for gasless tx)
 *
 * Without these env vars, ERC-8004 is skipped and the agent only has its
 * keystore identity (still works for off-chain operations on the Hub).
 */
export async function createErc8004Identity(opts: {
  agentAddress: Hex
  name: string
  domain?: string
}): Promise<{ agentId: string; txHash: string } | null> {
  const registryAddress = process.env.ERC8004_REGISTRY
  const relayerKey = process.env.ERC8004_RELAYER_KEY

  if (!registryAddress || !relayerKey) {
    return null  // Gracefully skip if not configured
  }

  try {
    const { createPublicClient, createWalletClient, http, keccak256, toBytes } = await import('viem')
    const { privateKeyToAccount } = await import('viem/accounts')
    const { base, baseSepolia } = await import('viem/chains')

    const chain = process.env.PLUR_CHAIN === 'mainnet' ? base : baseSepolia

    const IDENTITY_REGISTRY_ABI = [
      {
        name: 'registerAgent',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [
          { name: 'agent', type: 'address' },
          { name: 'metadataHash', type: 'bytes32' },
        ],
        outputs: [{ name: 'agentId', type: 'uint256' }],
      },
    ] as const

    const account = privateKeyToAccount(relayerKey as Hex)
    const pub = createPublicClient({ chain, transport: http() })
    const wallet = createWalletClient({ chain, transport: http(), account })

    const metadataHash = keccak256(toBytes(JSON.stringify({ name: opts.name, domain: opts.domain })))

    const { request } = await pub.simulateContract({
      address: registryAddress as Hex,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: 'registerAgent',
      args: [opts.agentAddress, metadataHash],
      account,
    })

    const txHash = await wallet.writeContract(request)
    return { agentId: `erc8004-${opts.agentAddress.slice(2, 10)}`, txHash }
  } catch (err) {
    console.error(`[erc8004] Identity creation failed: ${(err as Error).message}`)
    return null
  }
}
