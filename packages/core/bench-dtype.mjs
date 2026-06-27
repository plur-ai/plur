// BGE-small dtype benchmark (fp32 vs fp16 vs q8) — reusable harness.
// Reproduces the "Raw embed() — 50 warm iterations" table from
// quantized-embed-decision-2026-06-18. Mirrors the production embed path:
// pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5', {dtype}),
// pooling 'cls', normalize true.
//
// RUN FROM packages/core/ (bare '@huggingface/transformers' import resolves
// via packages/core/node_modules). Reports min/median/p95 — prefer `min` as
// the pure-compute proxy on a loaded host. Created 2026-06-27 because the
// original 2026-06-18 bench committed no reusable script.
//   node bench-dtype.mjs

process.env.HF_HUB_DISABLE_XET ??= '1'
process.env.TRANSFORMERS_OFFLINE ??= '1' // use cached models only
process.env.HF_HUB_OFFLINE ??= '1'

const { pipeline } = await import('@huggingface/transformers')

const MODEL = 'Xenova/bge-small-en-v1.5'
const TEXT =
  'The quick brown fox jumps over the lazy dog near the riverbank at dawn.'
const WARM = 5
const ITERS = 50

function median(xs) {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
function pct(xs, p) {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}
function cosine(a, b) {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot // both L2-normalized already
}

async function benchDtype(dtype, baselineVec) {
  const pipe = await pipeline('feature-extraction', MODEL, { dtype })
  const run = async () => {
    const r = await pipe(TEXT, { pooling: 'cls', normalize: true })
    return r.data instanceof Float32Array ? r.data : new Float32Array(r.data)
  }
  for (let i = 0; i < WARM; i++) await run() // warm cache/allocator
  let vec
  const times = []
  for (let i = 0; i < ITERS; i++) {
    const t0 = performance.now()
    vec = await run()
    times.push(performance.now() - t0)
  }
  const sim = baselineVec ? cosine(vec, baselineVec) : cosine(vec, vec)
  return { dtype, min: Math.min(...times), median: median(times), p95: pct(times, 95), sim, vec, dim: vec.length }
}

const out = []
// fp32 first to establish baseline vector for cosine comparison
const fp32 = await benchDtype('fp32', null)
out.push(fp32)
out.push(await benchDtype('fp16', fp32.vec))
out.push(await benchDtype('q8', fp32.vec))

console.log('\n=== Raw embed() — %d warm iterations (BGE-small, host x86) ===', ITERS)
console.log('dtype | min ms | median ms | p95 ms | cosine sim | vs fp32 (by min)')
for (const r of out) {
  const ratio = r.min / fp32.min
  const vs =
    r.dtype === 'fp32'
      ? 'baseline'
      : ratio >= 1.05
        ? `${Math.round((ratio - 1) * 100)}% slower`
        : ratio <= 0.95
          ? `${Math.round((1 - ratio) * 100)}% faster`
          : `tie (${(Math.abs(ratio - 1) * 100).toFixed(1)}%)`
  console.log(
    `${r.dtype.padEnd(5)} | ${r.min.toFixed(2).padStart(6)} | ${r.median
      .toFixed(2)
      .padStart(9)} | ${r.p95.toFixed(2).padStart(6)} | ${r.sim
      .toFixed(3)
      .padStart(10)} | ${vs}`,
  )
}
console.log(
  '\nJSON:',
  JSON.stringify(
    out.map(({ dtype, median, p95, sim, dim }) => ({ dtype, median, p95, sim, dim })),
  ),
)
