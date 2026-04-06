export type ModelTier = 'fast' | 'balanced' | 'thorough'

export interface LlmTierConfig {
  dedup_tier?: ModelTier
  profile_tier?: ModelTier
  meta_tier?: ModelTier
}

const DEFAULT_MODEL_MAP: Record<ModelTier, string> = {
  fast: 'claude-haiku-4-0',
  balanced: 'claude-sonnet-4-20250514',
  thorough: 'claude-opus-4-20250514',
}

const DEFAULT_TIERS: Required<LlmTierConfig> = {
  dedup_tier: 'fast',
  profile_tier: 'balanced',
  meta_tier: 'thorough',
}

export function selectModel(tier: ModelTier, customMap?: Partial<Record<ModelTier, string>>): string {
  const map = { ...DEFAULT_MODEL_MAP, ...customMap }
  return map[tier]
}

export function resolveOperationTier(
  operation: 'dedup' | 'profile' | 'meta',
  config?: LlmTierConfig,
): ModelTier {
  const key = `${operation}_tier` as keyof LlmTierConfig
  return config?.[key] ?? DEFAULT_TIERS[key]
}

export function selectModelForOperation(
  operation: 'dedup' | 'profile' | 'meta',
  config?: LlmTierConfig,
  customMap?: Partial<Record<ModelTier, string>>,
): string {
  const tier = resolveOperationTier(operation, config)
  return selectModel(tier, customMap)
}
