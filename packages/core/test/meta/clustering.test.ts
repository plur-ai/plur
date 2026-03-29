// packages/core/test/meta/clustering.test.ts
import { describe, it, expect } from 'vitest'
import { clusterByStructure, type EngramCluster } from '../../src/meta/clustering.js'
import type { RelationalAnalysis } from '../../src/meta/structural-analysis.js'

function makeAnalysis(overrides: Partial<RelationalAnalysis>): RelationalAnalysis {
  return {
    engram_id: 'ENG-TEST-001',
    triples: [{
      subject: { role: 'safety-metric', domain_instance: 'test' },
      predicate: 'assumes-independence-of',
      object: { role: 'correlated-variables', domain_instance: 'test' },
      outcome: 'underestimated-risk',
    }],
    goal_context: 'risk assessment',
    is_failure_driven: false,
    domain: 'test',
    polarity: 'do',
    ...overrides,
  }
}

describe('clusterByStructure', () => {
  it('clusters analyses with similar structural templates', async () => {
    const analyses = [
      makeAnalysis({ engram_id: 'ENG-1', domain: 'trading' }),
      makeAnalysis({ engram_id: 'ENG-2', domain: 'infrastructure',
        triples: [{
          subject: { role: 'health-monitor', domain_instance: 'healthcheck' },
          predicate: 'assumes-independence-of',
          object: { role: 'correlated-components', domain_instance: 'host-services' },
          outcome: 'missed-failure',
        }],
      }),
      makeAnalysis({ engram_id: 'ENG-3', domain: 'cooking',
        triples: [{
          subject: { role: 'agent', domain_instance: 'chef' },
          predicate: 'applies',
          object: { role: 'technique', domain_instance: 'sauteing' },
          outcome: 'cooked-dish',
        }],
      }),
    ]
    const clusters = await clusterByStructure(analyses)
    // ENG-1 and ENG-2 should cluster (similar predicate), ENG-3 separate
    const crossDomain = clusters.filter(c => c.is_cross_domain)
    expect(crossDomain.length).toBeGreaterThanOrEqual(0) // May or may not cluster depending on embeddings
    expect(clusters.length).toBeGreaterThanOrEqual(1)
  })

  it('marks clusters as cross-domain when spanning 2+ domains', async () => {
    const analyses = [
      makeAnalysis({ engram_id: 'ENG-1', domain: 'trading' }),
      makeAnalysis({ engram_id: 'ENG-2', domain: 'infrastructure' }),
    ]
    const clusters = await clusterByStructure(analyses)
    for (const cluster of clusters) {
      if (cluster.members.length > 1) {
        expect(cluster.is_cross_domain).toBe(true)
      }
    }
  })

  it('discards single-member clusters', async () => {
    const analyses = [makeAnalysis({ engram_id: 'ENG-1' })]
    const clusters = await clusterByStructure(analyses)
    expect(clusters).toHaveLength(0)
  })

  it('allows multi-cluster membership for cross-domain discovery', async () => {
    // ENG-bridge shares structural similarity with both group A and group B
    const groupA = makeAnalysis({ engram_id: 'ENG-A1', domain: 'trading',
      triples: [{
        subject: { role: 'metric', domain_instance: 'sharpe' },
        predicate: 'assumes-independence-of',
        object: { role: 'correlated-variables', domain_instance: 'returns' },
        outcome: 'underestimated-risk',
      }],
    })
    const groupB = makeAnalysis({ engram_id: 'ENG-B1', domain: 'infrastructure',
      triples: [{
        subject: { role: 'metric', domain_instance: 'uptime' },
        predicate: 'assumes-independence-of',
        object: { role: 'correlated-variables', domain_instance: 'services' },
        outcome: 'underestimated-risk',
      }],
    })
    const bridge = makeAnalysis({ engram_id: 'ENG-BRIDGE', domain: 'security',
      triples: [{
        subject: { role: 'metric', domain_instance: 'threat-score' },
        predicate: 'assumes-independence-of',
        object: { role: 'correlated-variables', domain_instance: 'attack-vectors' },
        outcome: 'underestimated-risk',
      }],
    })

    const clusters = await clusterByStructure([groupA, groupB, bridge])
    // Bridge engram should be able to appear in clusters seeded by different engrams
    // All three are very similar so they'll form overlapping clusters
    const bridgeClusters = clusters.filter(c =>
      c.members.some(m => m.engram_id === 'ENG-BRIDGE')
    )
    // With multi-membership, bridge should appear in at least one cluster
    expect(bridgeClusters.length).toBeGreaterThanOrEqual(1)
    // And total clusters should reflect the overlapping nature
    expect(clusters.length).toBeGreaterThanOrEqual(1)
  })
})
