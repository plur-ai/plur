/**
 * Vectors with chosen cosines, for the consolidation tests (overhaul W6).
 *
 * `fromGram(G, dim)` returns unit vectors whose pairwise dot products are the
 * entries of the (positive definite) matrix G, by Cholesky factorisation. That
 * lets a test say "A–B at 0.86, B–C at 0.86, A–C at 0.6" and get exactly that.
 */
export function fromGram(gram: number[][], dim = 32): Float32Array[] {
  const n = gram.length
  if (n > dim) throw new Error('fromGram: more vectors than dimensions')
  const L: number[][] = Array.from({ length: n }, () => new Array(n).fill(0))
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = gram[i][j]
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k]
      if (i === j) {
        if (s <= 0) throw new Error(`fromGram: matrix is not positive definite at ${i}`)
        L[i][i] = Math.sqrt(s)
      } else {
        L[i][j] = s / L[j][j]
      }
    }
  }
  return L.map(row => {
    const v = new Float32Array(dim)
    for (let k = 0; k < n; k++) v[k] = row[k]
    return v
  })
}

/** A unit vector along axis `i` of a `dim`-dimensional space. */
export function axis(i: number, dim = 32): Float32Array {
  const v = new Float32Array(dim)
  v[i] = 1
  return v
}

/** `cos` away from `base`, in the direction of axis `towards` (which must be orthogonal to `base`). */
export function near(base: Float32Array, towards: number, cos: number): Float32Array {
  const v = new Float32Array(base.length)
  const s = Math.sqrt(1 - cos * cos)
  for (let i = 0; i < base.length; i++) v[i] = cos * base[i]
  v[towards] += s
  return v
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/** Deterministic pseudo-random unit vectors (mulberry32). */
export function randomUnitVectors(n: number, dim: number, seed = 1): Float32Array[] {
  let a = seed >>> 0
  const rnd = () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const gauss = () => {
    const u = Math.max(rnd(), 1e-12)
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd())
  }
  const out: Float32Array[] = []
  for (let i = 0; i < n; i++) {
    const v = new Float32Array(dim)
    let norm = 0
    for (let k = 0; k < dim; k++) { v[k] = gauss(); norm += v[k] * v[k] }
    norm = Math.sqrt(norm)
    for (let k = 0; k < dim; k++) v[k] /= norm
    out.push(v)
  }
  return out
}
