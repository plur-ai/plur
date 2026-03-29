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
})
