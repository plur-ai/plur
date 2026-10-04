/-!
# Pack integrity v2 and the directory-keyed registry (PRs #1229, #1230)

Owner decisions of 2026-09-26, implemented in separate PRs stacked on `main`:

* **#1229** — `sha256:v2:` hashes SKILL.md, manifest.yaml and engrams.yaml, each
  framed as name, byte length and bytes, with an absent part spelled `-`
  (`computePackIntegrity` in packages/core/src/packs.ts).
* **#1230** — registry rows are keyed by install directory (`dir`), with a legacy
  fallback to the manifest name; the integrity migration uses the same key.

The v1 counterexamples (`Persistence.Packs.hash_boundary_collision`,
`hash_missing_eq_empty`, `registry_shared_row`) stay in Persistence.lean as the
record of what v1 got wrong.

**Abstraction.** The byte stream is modelled at the token level: a name token, then
either an absent marker or a length token followed by that many byte tokens. The
decimal length and zero separators in the real encoding exist precisely so the byte
stream parses back into these tokens; that parse is not modelled. SHA-256 is an
oracle `H`; injectivity of the hash input is what the model proves, and the hash is
assumed collision-resistant as usual.
-/

namespace PlurSpec.PacksV2

/-- One token of the framed stream. -/
inductive Tok where
  | name (s : String)
  | absent
  | len (n : Nat)
  | byte (b : UInt8)
  deriving DecidableEq, Repr

/-- A part: its file name and its content, `none` when the file is absent. -/
abbrev Part := String × Option (List UInt8)

def frameBytes (bs : List UInt8) : List Tok := bs.map Tok.byte

def framePart : Part → List Tok
  | (n, none)    => [Tok.name n, Tok.absent]
  | (n, some bs) => Tok.name n :: Tok.len bs.length :: frameBytes bs

def frame : List Part → List Tok
  | []      => []
  | p :: ps => framePart p ++ frame ps

/-- Read `k` byte tokens. -/
def takeBytes : Nat → List Tok → Option (List UInt8 × List Tok)
  | 0,     ts              => some ([], ts)
  | k + 1, Tok.byte b :: ts =>
      (takeBytes k ts).map (fun r => (b :: r.1, r.2))
  | _ + 1, _               => none

/-- Decoder for the framed stream, by fuel (one unit per part). -/
def decode : Nat → List Tok → Option (List Part)
  | _,     []                                => some []
  | 0,     _ :: _                            => none
  | f + 1, Tok.name n :: Tok.absent :: ts    =>
      (decode f ts).map (fun ps => (n, none) :: ps)
  | f + 1, Tok.name n :: Tok.len k :: ts     =>
      match takeBytes k ts with
      | some (bs, rest) => (decode f rest).map (fun ps => (n, some bs) :: ps)
      | none            => none
  | _ + 1, _                                 => none

theorem takeBytes_frame (bs : List UInt8) (rest : List Tok) :
    takeBytes bs.length (frameBytes bs ++ rest) = some (bs, rest) := by
  induction bs with
  | nil => rfl
  | cons b bs ih => simp [frameBytes, takeBytes] at *; simp [ih]

/-- **The framed input decodes back exactly** — so it is injective. -/
theorem decode_frame (ps : List Part) : decode ps.length (frame ps) = some ps := by
  induction ps with
  | nil => rfl
  | cons p ps ih =>
    obtain ⟨n, c⟩ := p
    cases c with
    | none => simp [frame, framePart, decode, ih]
    | some bs =>
      simp only [frame, framePart, List.length_cons, List.cons_append, decode]
      rw [takeBytes_frame]
      simp [ih]

/-- **v2 input is injective** (for a fixed number of parts, as the code always has three). -/
theorem frame_injective (ps qs : List Part) (hl : ps.length = qs.length)
    (h : frame ps = frame qs) : ps = qs := by
  have a := decode_frame ps
  have b := decode_frame qs
  rw [h, hl] at a
  rw [a] at b
  exact Option.some.inj b

/-- The integrity value: the oracle over the framed parts, in a fixed order. -/
def integrityV2 {δ : Type} (H : List Tok → δ) (skill manifest engrams : Option (List UInt8)) : δ :=
  H (frame [("SKILL.md", skill), ("manifest.yaml", manifest), ("engrams.yaml", engrams)])

/-- The v1 boundary shift no longer collides: the hash inputs differ. -/
theorem v2_boundary_distinct :
    frame [("SKILL.md", some [1, 2]), ("manifest.yaml", none), ("engrams.yaml", some [3])] ≠
    frame [("SKILL.md", some [1]), ("manifest.yaml", none), ("engrams.yaml", some [2, 3])] := by
  decide

/-- A missing SKILL.md is no longer the same input as an empty one. -/
theorem v2_missing_ne_empty (m e : Option (List UInt8)) :
    frame [("SKILL.md", none), ("manifest.yaml", m), ("engrams.yaml", e)] ≠
    frame [("SKILL.md", some []), ("manifest.yaml", m), ("engrams.yaml", e)] := by
  simp [frame, framePart]

/-- manifest.yaml is inside the check: changing only it changes the input. -/
theorem v2_covers_manifest (s e : Option (List UInt8)) (m m' : Option (List UInt8)) (h : m ≠ m') :
    frame [("SKILL.md", s), ("manifest.yaml", m), ("engrams.yaml", e)] ≠
    frame [("SKILL.md", s), ("manifest.yaml", m'), ("engrams.yaml", e)] := by
  intro heq
  have := frame_injective
    [("SKILL.md", s), ("manifest.yaml", m), ("engrams.yaml", e)]
    [("SKILL.md", s), ("manifest.yaml", m'), ("engrams.yaml", e)] rfl heq
  simp at this
  exact h this

/-! ## Registry keyed by directory (#1230) -/

structure Row where
  dir   : String
  name  : String
  integ : Nat
  deriving DecidableEq, Repr

/-- Install writes (or replaces) the row for its directory. -/
def install (reg : List Row) (r : Row) : List Row :=
  if reg.any (fun x => x.dir == r.dir) then reg.map (fun x => if x.dir == r.dir then r else x)
  else reg ++ [r]

/-- Uninstall removes only the row for its directory. -/
def uninstall (reg : List Row) (d : String) : List Row := reg.filter (fun x => x.dir != d)

def lookup (reg : List Row) (d : String) : Option Row := reg.find? (fun x => x.dir == d)

theorem lookup_uninstall_other (reg : List Row) (d d' : String) (h : d ≠ d') :
    lookup (uninstall reg d) d' = lookup reg d' := by
  induction reg with
  | nil => rfl
  | cons x xs ih =>
    unfold uninstall lookup at *
    by_cases hx : x.dir = d
    · have hne : x.dir ≠ d' := by rw [hx]; exact h
      rw [List.filter_cons_of_neg (by simp [hx])]
      rw [List.find?_cons_of_neg (by simp [hne])]
      exact ih
    · rw [List.filter_cons_of_pos (by simp [hx])]
      by_cases hx' : x.dir = d'
      · rw [List.find?_cons_of_pos (by simp [hx']), List.find?_cons_of_pos (by simp [hx'])]
      · rw [List.find?_cons_of_neg (by simp [hx']), List.find?_cons_of_neg (by simp [hx'])]
        exact ih

/-- **Uninstalling one pack never removes or changes another pack's baseline.** -/
theorem uninstall_preserves_others (reg : List Row) (d d' : String) (h : d ≠ d') :
    lookup (uninstall reg d) d' = lookup reg d' := lookup_uninstall_other reg d d' h

/-- **Two directories sharing a manifest name keep separate baselines** (the v1
counterexample `registry_shared_row`, now distinct). -/
theorem shared_name_separate :
    let reg := install (install [] ⟨"pack-one", "shared-name", 1⟩) ⟨"pack-two", "shared-name", 2⟩
    (lookup reg "pack-one").map (·.integ) = some 1 ∧ (lookup reg "pack-two").map (·.integ) = some 2 := by
  decide

/-! ## The migration never blesses a modified pack -/

/-- One migration step for a row, given whether the pack verifies under its v1
value (`clean`) and its current v2 value. -/
def migrateRow (clean : Bool) (v2 : Nat) (r : Row) : Row :=
  if clean then { r with integ := v2 } else r

theorem migrate_modified_unchanged (v2 : Nat) (r : Row) : migrateRow false v2 r = r := rfl

theorem migrate_clean_rebaselined (v2 : Nat) (r : Row) : (migrateRow true v2 r).integ = v2 := rfl

/-- Idempotent: migrating a row already at its v2 value changes nothing. -/
theorem migrate_idempotent (c : Bool) (r : Row) : migrateRow c r.integ r = r := by
  cases c <;> simp [migrateRow]

end PlurSpec.PacksV2
