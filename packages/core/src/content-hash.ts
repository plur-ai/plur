import { createHash } from 'crypto'

/**
 * Normalize a statement for hash comparison:
 * - lowercase
 * - strip punctuation
 * - collapse whitespace
 *
 * ## Why the character class is Unicode and not `\w` (#896)
 *
 * This used ASCII `\w` (`[A-Za-z0-9_]`), so `[^\w\s]` stripped every letter
 * that is not an unaccented Latin one. The consequence was not a cosmetic
 * difference in a hash — it destroyed memory. Measured on the shipped build:
 *
 *     'データベースの設定を確認'  → ''  → e3b0c44298fc… (SHA-256 of the empty string)
 *     '도커를 사용해야 한다'       → ''  → e3b0c44298fc…
 *     'развертывание должно'    → ''  → e3b0c44298fc…
 *
 * Every statement written in a non-Latin script normalized to the SAME empty
 * string, so `findActiveByContentHash` matched them to each other and the
 * dedup path absorbed them into one engram. Four unrelated facts in, one row
 * out, `write_count: 4`, reported as four successful writes. Accented Latin
 * degraded more quietly but in the same direction: `déploiement` →
 * `dploiement`, which is merely wrong rather than catastrophic — and which is
 * what made a Python cross-check of this function disagree with the real one,
 * since Python's `\w` IS Unicode-aware and JavaScript's is not.
 *
 * `\p{L}\p{N}\p{M}` is letters, numbers and combining marks in any script.
 * `\p{M}` matters on its own: without it, Devanagari and Thai vowel signs are
 * stripped from words whose consonants survive, silently merging distinct
 * words. `_` is kept explicitly because `\w` included it and dropping it would
 * change `snake_case` identifiers, which are common in these statements.
 *
 * ## Effect on stored hashes
 *
 * For a statement of ASCII letters, digits, `_` and punctuation the output is
 * byte-identical to the old one, so the overwhelming majority of stored hashes
 * are unaffected. A statement containing any other letter now hashes
 * DIFFERENTLY, which makes its stored `content_hash` stale — the condition
 * `plur reindex-hashes` exists to repair. Run it after upgrading; that is the
 * intended migration, and it is why the two shipped together.
 */
/**
 * Version of the `normalizeStatement` output contract.
 *
 * v1 — ASCII `\w`; stripped diacritics and every non-Latin script before
 *      hashing (the collapse documented above).
 * v2 — `\p{L}\p{N}\p{M}_`; preserves them.
 *
 * Bump this on any change that alters normalized output for a statement that
 * previously normalized to something non-empty, and add a migration alongside
 * it: every stored `content_hash` written under the old contract becomes stale
 * at that moment, and nothing else in the store records which contract it was
 * written under. Migration `20260813-006` is the one that carries v1 → v2.
 */
export const HASH_NORMALIZER_VERSION = 2

const NON_WORD = /[^\p{L}\p{N}\p{M}_\s]/gu

export function normalizeStatement(statement: string): string {
  return statement
    .toLowerCase()
    .replace(NON_WORD, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Compute SHA256 content hash of a normalized statement.
 * Used for fast exact-duplicate detection (Idea 29).
 *
 * A statement that normalizes to the empty string (all punctuation, all emoji)
 * hashes to the SHA-256 of `''`, which every other such statement also hashes
 * to. That is not a bug in the hash — there is genuinely no content to key on
 * — but it does mean the value is not usable for dedup. Callers that write or
 * match on hashes must treat "normalizes to empty" as "no hash"; see
 * {@link isHashable} and `Plur.repairContentHashes`.
 */
export function computeContentHash(statement: string): string {
  const normalized = normalizeStatement(statement)
  return createHash('sha256').update(normalized).digest('hex')
}

/**
 * Whether a statement has enough content for its hash to identify it.
 *
 * False only for statements that normalize away entirely. Before #896 this was
 * true of every non-Latin statement in the store, which is how the collapse
 * happened; now it is the narrow case it was always meant to be.
 */
export function isHashable(statement: string): boolean {
  return normalizeStatement(statement).length > 0
}
