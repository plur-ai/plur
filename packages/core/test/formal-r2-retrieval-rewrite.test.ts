// Formal verification round 2, core-retrieval#8 (spec/formal/findings/r2-retrieval.md §2).
// The lexical rewrite must never drop a content word the BM25 tokenizer keeps —
// in particular non-ASCII words (CJK, accented Latin), which `ftsTokenize` has
// indexed since the Unicode fix. Model: PlurSpec.R2Retrieval.Rewrite.
import { describe, it, expect } from 'vitest'
import { rewriteLexicalQuery } from '../src/intent/rewrite.js'
import { ftsTokenize } from '../src/fts.js'

describe('formal R2 core-retrieval#8 — rewrite keeps non-ASCII content words', () => {
  it('keeps a CJK word in a question (replayed: 部署 was dropped)', () => {
    expect(rewriteLexicalQuery('What is the 部署 process for kubernetes?', 'general')).toBe(
      'is the process for kubernetes'.replace('the', 'the 部署'),
    )
  })

  it('keeps a CJK name next to accented Latin', () => {
    expect(rewriteLexicalQuery('what did 田中 say about déploiement?', 'general')).toBe('田中 say about déploiement')
  })

  it('every fts token of the original, minus scaffolding, survives the rewrite', () => {
    const qs = [
      'What is the 部署 process for kubernetes?',
      'Где находится конфигурация сервера?',
      'how do we handle नमस्ते greetings?',
      'Which ข้อมูล table did we pick?',
    ]
    for (const q of qs) {
      const kept = new Set(ftsTokenize(rewriteLexicalQuery(q, 'general')))
      const expected = ftsTokenize(q).filter((t) => !['what', 'which', 'how', 'do', 'did', 'does'].includes(t))
      for (const t of expected) expect(kept.has(t), `${q}: ${t}`).toBe(true)
    }
  })

  it('still strips ASCII scaffolding (non-vacuity)', () => {
    expect(rewriteLexicalQuery("What's the deploy process?", 'general')).toBe('the deploy process')
  })
})
