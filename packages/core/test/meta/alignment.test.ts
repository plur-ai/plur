// packages/core/test/meta/alignment.test.ts
import { describe, it, expect } from 'vitest'
import { alignCluster, type AlignmentResult } from '../../src/meta/alignment.js'
import type { EngramCluster } from '../../src/meta/clustering.js'
import type { LlmFunction } from '../../src/types.js'

const mockLlm: LlmFunction = async (prompt: string) => {
  if (prompt.includes('assumes-independence-of')) {
    return JSON.stringify({
      common_structure: {
        goal_type: 'risk-assessment',
        constraint_type: 'assumed-independence-of-correlated-variables',
        outcome_type: 'systematically-understated-risk',
        template: '[risk-assessment] + [assumed-independence-of-correlated-variables] → [systematically-understated-risk]',
      },
      structural_depth: 3,
      member_alignments: [
        { engram_id: 'ENG-1', alignment_score: 0.92, mapping_rationale: 'Liquidation price assumes collateral independence' },
        { engram_id: 'ENG-2', alignment_score: 0.87, mapping_rationale: 'Health check assumes app independence from host' },
      ],
      candidate_inferences: ['Medical dosage calculations with shared metabolic pathways'],
    })
  }
  // Platitude case
  if (prompt.includes('applies') && prompt.includes('technique')) {
    return 'null'
  }
  return 'null'
}

describe('alignCluster', () => {
  it('extracts common structural template from cross-domain cluster', async () => {
    const cluster: EngramCluster = {
      cluster_id: 'cluster-0',
      members: [
        { engram_id: 'ENG-1', domain: 'trading', triples: [{ subject: { role: 'safety-metric', domain_instance: 'liquidation-price' }, predicate: 'assumes-independence-of', object: { role: 'correlated-variables', domain_instance: 'collateral' }, outcome: 'underestimated-risk' }], goal_context: 'risk assessment', is_failure_driven: true, polarity: 'dont' },
        { engram_id: 'ENG-2', domain: 'infrastructure', triples: [{ subject: { role: 'health-monitor', domain_instance: 'healthcheck' }, predicate: 'assumes-independence-of', object: { role: 'correlated-components', domain_instance: 'host-services' }, outcome: 'missed-failure' }], goal_context: 'monitoring', is_failure_driven: true, polarity: 'dont' },
      ],
      domains: ['trading', 'infrastructure'],
      is_cross_domain: true,
      cohesion: 0.8,
    }
    const result = await alignCluster(cluster, mockLlm)
    expect(result).not.toBeNull()
    expect(result!.common_structure.goal_type).toBe('risk-assessment')
    expect(result!.structural_depth).toBe(3)
    expect(result!.candidate_inferences.length).toBeGreaterThan(0)
  })

  it('returns null for clusters with no genuine common structure', async () => {
    const cluster: EngramCluster = {
      cluster_id: 'cluster-1',
      members: [
        { engram_id: 'ENG-3', domain: 'cooking', triples: [{ subject: { role: 'agent', domain_instance: 'chef' }, predicate: 'applies', object: { role: 'technique', domain_instance: 'sauteing' } }], goal_context: 'cook food', is_failure_driven: false, polarity: 'do' },
        { engram_id: 'ENG-4', domain: 'music', triples: [{ subject: { role: 'agent', domain_instance: 'musician' }, predicate: 'applies', object: { role: 'technique', domain_instance: 'fingerpicking' } }], goal_context: 'play music', is_failure_driven: false, polarity: 'do' },
      ],
      domains: ['cooking', 'music'],
      is_cross_domain: true,
      cohesion: 0.5,
    }
    const result = await alignCluster(cluster, mockLlm)
    expect(result).toBeNull()
  })
})
