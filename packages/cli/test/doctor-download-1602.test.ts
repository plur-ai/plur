import { beforeEach, afterEach, it, expect, vi } from 'vitest'
const state=vi.hoisted(() => ({loaded:false, disabled:false, embed:vi.fn(), recall:vi.fn()}))
vi.mock('@plur-ai/core', () => ({embed:state.embed}))
vi.mock('../src/plur.js', () => ({createPlur:()=>({
  embedderStatus:()=>({available:state.loaded,loaded:state.loaded,disabled:state.disabled,lastError:null,disabledReason:state.disabled?'disabled':null}),
  resetEmbedder:()=>{},recallSemantic:state.recall,
})}))
import { run } from '../src/commands/embedder-probe.js'
beforeEach(() => {
  state.loaded=false;state.disabled=false
  state.embed.mockReset().mockImplementation(async()=>{state.loaded=true;return new Float32Array([1])})
  state.recall.mockReset().mockResolvedValue([])
  vi.stubEnv('PLUR_INTERNAL_PROBE','1')
  vi.spyOn(process,'exit').mockImplementation(()=>undefined as never)
  vi.spyOn(process.stdout,'write').mockReturnValue(true)
})
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs()})
it('waits for model loading even with an empty store and noninteractive stdout',async()=>{
  await run([],{json:true})
  expect(state.embed).toHaveBeenCalled()
  expect(state.recall).not.toHaveBeenCalled()
  const text=(process.stdout.write as any).mock.calls.map((c:any[])=>c[0]).join('')
  expect(JSON.parse(text).modelLoaded).toBe(true)
})
it('respects explicitly disabled embeddings',async()=>{
  state.disabled=true
  await run([],{json:true})
  expect(state.embed).not.toHaveBeenCalled()
})
