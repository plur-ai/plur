/**
 * SemVer ordering for the launch pins PLUR writes into tool configs. Shared
 * by the Codex writer (codex-config.ts) and the JSON writers (mcp-config.ts,
 * opencode-config.ts), which apply the same rule: a PLUR pin older than or
 * equal to the running CLI is replaced, a newer pin is kept.
 */

/** Parse `x.y.z[-pre][+build]`; null for anything else (tags, ranges). */
export function version(v: string): { parts: number[]; pre?: string } | null {
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v)
  return m ? { parts: m.slice(1, 4).map(Number), pre: m[4] } : null
}

/** Is `a` older than or equal to `b`? False when either is not SemVer. */
export function olderOrEqual(a: string, b: string): boolean {
  const av = version(a), bv = version(b)
  if (!av || !bv) return false
  for (let i = 0; i < 3; i++) if (av.parts[i] !== bv.parts[i]) return av.parts[i] < bv.parts[i]
  if (av.pre === bv.pre) return true
  if (!av.pre) return false
  if (!bv.pre) return true
  const ap = av.pre.split('.'), bp = bv.pre.split('.')
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    if (ap[i] === undefined) return true
    if (bp[i] === undefined) return false
    if (ap[i] === bp[i]) continue
    const an = /^\d+$/.test(ap[i]), bn = /^\d+$/.test(bp[i])
    return an && bn ? Number(ap[i]) < Number(bp[i]) : an !== bn ? an : ap[i] < bp[i]
  }
  return true
}
