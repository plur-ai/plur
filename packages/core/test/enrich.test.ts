/**
 * Overhaul W10 (b): enrichment. A host model labels each engram's kind, task
 * family, outcome and when it applies; the label is stored in
 * `structured_data.enrichment` only; `knowledge_type` is never touched.
 *
 * The safety contract (capture report, C4): statements are never touched, so
 * statement hashes stay the same; a second run changes nothing; undo through
 * the change journal is byte-exact. The model is called while planning, never
 * inside the store lock.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import {
  buildEnrichPrompt, parseEnrichReply, KIND_TO_MEMORY_CLASS, ENRICHER_VERSION, ENRICH_KINDS,
} from '../src/enrich.js'
import type { LlmFunction } from '../src/types.js'

/** A fake host model: labels by keyword, echoes ids, counts calls. */
function fakeModel() {
  let calls = 0
  const llm: LlmFunction = async (prompt: string) => {
    calls++
    const items = JSON.parse(prompt.slice(prompt.indexOf('Items:') + 'Items:'.length)) as Array<{ id: string; text: string }>
    return '```json\n' + JSON.stringify(items.map(i => ({
      id: i.id,
      kind: /failed|broke/i.test(i.text) ? 'failure_lesson' : /always|never/i.test(i.text) ? 'rule' : /run `/.test(i.text) ? 'tool' : 'fact',
      task_family: 'code',
      outcome: /failed|broke/i.test(i.text) ? 'failure' : 'none',
      applies_when: 'when working in the repository',
    }))) + '\n```'
  }
  return { llm, calls: () => calls }
}

describe('enrichment prompt and reply parsing', () => {
  it('the prompt lists every kind and carries the items as JSON', () => {
    const p = buildEnrichPrompt([{ id: 'ENG-1', statement: 'Always lint', rationale: undefined }])
    for (const k of ENRICH_KINDS) expect(p).toContain(k)
    expect(p).toContain('"id":"ENG-1"')
  })

  it('keeps only labels for asked ids with a valid kind; first label per id wins', () => {
    const reply = JSON.stringify([
      { id: 'ENG-1', kind: 'rule', task_family: 'code', outcome: 'none', applies_when: 'x' },
      { id: 'ENG-1', kind: 'fact' },
      { id: 'ENG-2', kind: 'opinion' },
      { id: 'ENG-9', kind: 'fact' },
      { id: 'ENG-3', kind: 'experience', task_family: 'weird', outcome: 'success', applies_when: 'a '.repeat(40) },
    ])
    const labels = parseEnrichReply(reply, ['ENG-1', 'ENG-2', 'ENG-3'])
    expect([...labels.keys()]).toEqual(['ENG-1', 'ENG-3'])
    expect(labels.get('ENG-1')!.kind).toBe('rule')
    expect(labels.get('ENG-1')!.outcome).toBeNull()
    expect(labels.get('ENG-3')!.task_family).toBe('other')
    expect(labels.get('ENG-3')!.outcome).toBe('success')
    expect(labels.get('ENG-3')!.applies_when!.split(/\s+/).length).toBeLessThanOrEqual(15)
  })

  it('maps kinds to memory classes', () => {
    expect(KIND_TO_MEMORY_CLASS).toEqual({
      experience: 'episodic', failure_lesson: 'episodic', rule: 'procedural', tool: 'procedural', fact: 'semantic', preference: 'semantic',
    })
  })

  it('tolerates prose around the JSON and garbage replies', () => {
    expect(parseEnrichReply('Here you go:\n[{"id":"A","kind":"tool"}]\nDone.', ['A']).get('A')!.kind).toBe('tool')
    expect(parseEnrichReply('no json here', ['A']).size).toBe(0)
  })
})

describe('plur enrich plan / apply / undo', () => {
  let dir: string
  let plur: Plur
  const storeBytes = () => readFileSync(join(dir, 'engrams.yaml'), 'utf8')

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'plur-enrich-'))
    plur = new Plur({ path: dir, autoDiscover: false })
    await plur.learn('Always run the linter before pushing', { scope: 'global', type: 'behavioral' })
    await plur.learn('The staging deploy failed because the cache was warm', { scope: 'global', type: 'behavioral' })
    await plur.learn('Run `pnpm bench:micro` to measure learn latency', { scope: 'global', type: 'procedural' })
    const last = await plur.learn('The API server listens on port 8080', { scope: 'global', type: 'architectural' })
    // One whole-corpus write so key order is the loader's, as in the journal tests.
    await plur.updateEngramAsync((await plur.getById(last.id))!)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('plan calls the model and changes nothing', async () => {
    const model = fakeModel()
    const before = storeBytes()
    const plan = await plur.planEnrichment({ llm: model.llm, model: 'test-model', batchSize: 2 })
    expect(model.calls()).toBe(2)
    expect(plan.items).toHaveLength(4)
    expect(plan.enricher).toEqual({ model: 'test-model', version: ENRICHER_VERSION })
    expect(storeBytes()).toBe(before)
  })

  it('apply adds enrichment and leaves statements, their hashes and knowledge_type alone', async () => {
    const before = await plur.list()
    const plan = await plur.planEnrichment({ llm: fakeModel().llm, model: 'test-model' })
    const result = await plur.applyEnrichmentPlan(plan)
    expect(result.applied).toHaveLength(4)
    expect(result.change!.kind).toBe('enrich.apply')
    const after = await plur.list()
    for (const b of before) {
      const a = after.find(x => x.id === b.id)!
      expect(a.statement).toBe(b.statement)
      expect((a as any).content_hash).toBe((b as any).content_hash)
      const en = (a as any).structured_data.enrichment
      expect(ENRICH_KINDS).toContain(en.kind)
      expect(en.enricher).toMatchObject({ model: 'test-model', version: ENRICHER_VERSION })
      expect(a.knowledge_type).toEqual(b.knowledge_type)
    }
    const lesson = after.find(e => e.statement.startsWith('The staging deploy failed'))!
    expect((lesson as any).structured_data.enrichment).toMatchObject({ kind: 'failure_lesson', outcome: 'failure' })
  })

  it('enrichment never moves a rule between injection sections (knowledge_type untouched), both modes', async () => {
    const learned = await plur.learn('Never print secrets in logs or terminal output', { scope: 'global', domain: 'security' })
    // Older and imported rows carry no knowledge_type at all.
    const { knowledge_type: _kt, ...bare } = (await plur.getById(learned.id))! as any
    await plur.updateEngramAsync(bare)
    const rule = (await plur.getById(learned.id))!
    expect(rule.knowledge_type).toBeUndefined()
    const task = 'print the secrets in the terminal logs'
    const sectionOf = (r: { directives: string; constraints: string; consider: string }) =>
      r.constraints.includes(rule.id) ? 'constraints' : r.directives.includes(rule.id) ? 'directives' : r.consider.includes(rule.id) ? 'consider' : 'absent'
    const before = {
      legacy: sectionOf(await plur.inject(task, { mode: 'legacy' })),
      unified: sectionOf(await plur.inject(task, { mode: 'unified' })),
    }
    expect(before).toEqual({ legacy: 'constraints', unified: 'constraints' })
    const ktBefore = (await plur.getById(rule.id))!.knowledge_type
    const plan = await plur.planEnrichment({ llm: fakeModel().llm, model: 'test-model' })
    await plur.applyEnrichmentPlan(plan)
    const enriched = (await plur.getById(rule.id))!
    expect((enriched as any).structured_data.enrichment.kind).toBe('rule')
    const after = {
      legacy: sectionOf(await plur.inject(task, { mode: 'legacy' })),
      unified: sectionOf(await plur.inject(task, { mode: 'unified' })),
    }
    expect(after).toEqual(before)
    expect(enriched.knowledge_type).toEqual(ktBefore)
  })

  it('apply re-checks the plan: bounds as the reply parser sets them, and secrets refused (S7)', async () => {
    const plan = await plur.planEnrichment({ llm: fakeModel().llm, model: 'test-model' })
    const [first, second, third] = plan.items
    const tampered = {
      ...plan,
      items: [
        { ...first, applies_when: 'word '.repeat(200).trim(), task_family: 'evil' as any, outcome: 'pwned' as any },
        { ...second, applies_when: 'when deploying with key AKIAIOSFODNN7EXAMPLE' },
        { ...third, kind: 'opinion' as any },
      ],
    }
    const res = await plur.applyEnrichmentPlan(tampered)
    const one = (await plur.getById(first.id))! as any
    expect(one.structured_data.enrichment.applies_when.split(/\s+/).length).toBeLessThanOrEqual(15)
    expect(one.structured_data.enrichment.task_family).toBe('other')
    expect(one.structured_data.enrichment.outcome).toBeNull()
    expect(res.skipped).toEqual(expect.arrayContaining([expect.objectContaining({ id: second.id, reason: expect.stringMatching(/secret|sensitive/i) })]))
    expect(((await plur.getById(second.id))! as any).structured_data?.enrichment).toBeUndefined()
    expect(res.skipped.some(s => s.id === third.id)).toBe(true)
    expect(JSON.stringify(await plur.list())).not.toContain('AKIAIOSFODNN7EXAMPLE')
  })

  it('a second run changes nothing', async () => {
    const model = fakeModel()
    const plan = await plur.planEnrichment({ llm: model.llm, model: 'test-model' })
    await plur.applyEnrichmentPlan(plan)
    const after = storeBytes()
    const changes = plur.listChanges().length

    // Re-applying the same plan: every row is already enriched.
    const again = await plur.applyEnrichmentPlan(plan)
    expect(again.applied).toHaveLength(0)
    expect(again.change).toBeNull()
    // Re-planning: nothing is left to label, and the model is not called.
    const callsBefore = model.calls()
    const plan2 = await plur.planEnrichment({ llm: model.llm, model: 'test-model' })
    expect(plan2.items).toHaveLength(0)
    expect(model.calls()).toBe(callsBefore)
    expect(storeBytes()).toBe(after)
    expect(plur.listChanges()).toHaveLength(changes)
  })

  it('apply --limit 1 enriches one engram; undo is byte-exact', async () => {
    const before = storeBytes()
    const plan = await plur.planEnrichment({ llm: fakeModel().llm, model: 'test-model' })
    const one = await plur.applyEnrichmentPlan(plan, { limit: 1 })
    expect(one.applied).toHaveLength(1)
    expect(storeBytes()).not.toBe(before)
    await plur.undoChange(one.change!.id)
    expect(storeBytes()).toBe(before)

    const all = await plur.applyEnrichmentPlan(plan)
    expect(all.applied).toHaveLength(4)
    await plur.undoChange(all.change!.id)
    expect(storeBytes()).toBe(before)
  })

  it('skips a row whose statement changed after the plan', async () => {
    const plan = await plur.planEnrichment({ llm: fakeModel().llm, model: 'test-model' })
    const target = plan.items[0]
    const row = (await plur.getById(target.id))!
    await plur.updateEngramAsync({ ...row, statement: row.statement + ' (edited)', content_hash: undefined } as any)
    const result = await plur.applyEnrichmentPlan(plan)
    expect(result.skipped.find(s => s.id === target.id)?.reason).toMatch(/statement changed/)
    expect(result.applied).toHaveLength(3)
  })
})
