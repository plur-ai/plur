/-!
# PlurSpec.SecretsInstall — instruction-section upgrade, internal-host scan loop

§1–§3 model `upsertInstructionSection` (`packages/core/src/instruction-section.ts`):
which installed section is PLUR's to replace, and what the rebuild keeps.
§4 models the `matchInternalHost` loop (`packages/core/src/secrets.ts`).
Findings: `spec/formal/findings/secrets-install.md`.

Lines are an abstract type `α`; `c : α → β` is the code's `cmp` (CR and trailing
whitespace dropped), `blank` its `isBlank`. Shipped texts are the `comparable`
forms of `opts.shipped`, kept only when non-empty (the code's `.filter(s => s.length > 0)`).

Simplifications, stated:
* The heading test and the "current marker before the next boundary" test are
  oracles (`isHead`, `cur`); a current section is never rewritten in either model.
* The code records a found section at every heading, even inside an earlier
  shipped match; the model resumes scanning after a shipped match. Overlapping
  matches only ever cover shipped lines, so what the code removes beyond the
  model is still shipped text.
* The blank separator the code inserts (only when text follows) is `sep`, inserted
  always; the code's choice of one blank line or none is whitespace only.
-/

namespace PlurSpec.SecretsInstall

/-! ## §1 matchShipped: which lines are PLUR's -/

section Match
variable {α β : Type} [DecidableEq β]

/-- `want` matches the lines starting here, line for line under `c`. -/
def prefixMatch (c : α → β) : List β → List α → Bool
  | [], _ => true
  | _ :: _, [] => false
  | w :: ws, l :: ls => decide (c l = w) && prefixMatch c ws ls

/-- The code's loop: the longest non-empty shipped text that matches wins. -/
def matchStep (c : α → β) (lines : List α) (best : Option Nat) (want : List β) : Option Nat :=
  if prefixMatch c want lines then
    match best with
    | none => some want.length
    | some b => if want.length > b then some want.length else some b
  else best

def matchShipped (c : α → β) (shipped : List (List β)) (lines : List α) : Option Nat :=
  ((shipped.filter (fun s => s.length > 0)).foldl (matchStep c lines) none)

theorem prefixMatch_iff (c : α → β) :
    ∀ (w : List β) (ls : List α),
      prefixMatch c w ls = true ↔ (w.length ≤ ls.length ∧ (ls.take w.length).map c = w)
  | [], ls => by simp [prefixMatch]
  | w :: ws, [] => by simp [prefixMatch]
  | w :: ws, l :: ls => by
    have ih := prefixMatch_iff c ws ls
    simp only [prefixMatch, Bool.and_eq_true, decide_eq_true_eq, ih, List.length_cons,
      List.take_succ_cons, List.map_cons, List.cons.injEq]
    constructor
    · rintro ⟨h1, h2, h3⟩; exact ⟨by omega, h1, h3⟩
    · rintro ⟨h1, h2, h3⟩; exact ⟨h2, by omega, h3⟩

/-- Invariant of the fold: the best so far is the length of a matching shipped text. -/
theorem foldl_match_inv (c : α → β) (lines : List α) :
    ∀ (ws : List (List β)) (best : Option Nat) (n : Nat),
      (∀ w ∈ ws, w.length > 0) →
      ws.foldl (matchStep c lines) best = some n →
      best = some n ∨ ∃ w ∈ ws, w.length = n ∧ 0 < n ∧ prefixMatch c w lines = true
  | [], best, n, _, h => by simp at h; exact Or.inl h
  | w :: ws, best, n, hpos, h => by
    simp only [List.foldl_cons] at h
    have hw : w.length > 0 := hpos w (by simp)
    rcases foldl_match_inv c lines ws _ n (fun x hx => hpos x (by simp [hx])) h with h1 | ⟨x, hx, hl, hn, hm⟩
    · unfold matchStep at h1
      by_cases hp : prefixMatch c w lines = true
      · simp only [hp, ite_true] at h1
        cases best with
        | none => simp at h1; exact Or.inr ⟨w, by simp, h1, by omega, hp⟩
        | some b =>
          by_cases hgt : w.length > b
          · simp [hgt] at h1; exact Or.inr ⟨w, by simp, h1, by omega, hp⟩
          · simp [hgt] at h1; exact Or.inl (by simp [h1])
      · simp [hp] at h1; exact Or.inl h1
    · exact Or.inr ⟨x, by simp [hx], hl, hn, hm⟩

/-- Only shipped text is ever taken as PLUR's: a match of length `n` means the first
    `n` lines are, line for line, one of the shipped texts. -/
theorem match_is_shipped (c : α → β) (shipped : List (List β)) (lines : List α) (n : Nat)
    (h : matchShipped c shipped lines = some n) :
    ∃ w ∈ shipped, w.length = n ∧ 0 < n ∧ n ≤ lines.length ∧ (lines.take n).map c = w := by
  unfold matchShipped at h
  rcases foldl_match_inv c lines _ none n (fun w hw => (List.mem_filter.mp hw).2 |> of_decide_eq_true) h
    with h1 | ⟨w, hw, hl, hn, hm⟩
  · cases h1
  · rw [prefixMatch_iff] at hm
    exact ⟨w, (List.mem_filter.mp hw).1, hl, hn, hl ▸ hm.1, hl ▸ hm.2⟩

/-- Monotonicity: once some match is found the fold never forgets it, and never shrinks. -/
theorem foldl_match_ge (c : α → β) (lines : List α) :
    ∀ (ws : List (List β)) (b : Nat), ∃ n, ws.foldl (matchStep c lines) (some b) = some n ∧ b ≤ n
  | [], b => ⟨b, rfl, Nat.le_refl _⟩
  | w :: ws, b => by
    simp only [List.foldl_cons]
    unfold matchStep
    by_cases hp : prefixMatch c w lines = true
    · simp only [hp, ite_true]
      by_cases hgt : w.length > b
      · simp only [hgt, ite_true]
        obtain ⟨n, h, hle⟩ := foldl_match_ge c lines ws w.length
        exact ⟨n, h, by omega⟩
      · simp only [hgt, ite_false]; exact foldl_match_ge c lines ws b
    · simp only [hp]; exact foldl_match_ge c lines ws b

theorem foldl_match_found (c : α → β) (lines : List α) :
    ∀ (ws : List (List β)) (best : Option Nat) (w : List β),
      w ∈ ws → prefixMatch c w lines = true →
      ∃ n, ws.foldl (matchStep c lines) best = some n ∧ w.length ≤ n
  | [], _, _, hw, _ => by simp at hw
  | x :: ws, best, w, hw, hm => by
    simp only [List.foldl_cons]
    rcases List.mem_cons.mp hw with rfl | hw'
    · -- the step on `w` itself yields at least `w.length`
      have hstep : ∃ b, matchStep c lines best w = some b ∧ w.length ≤ b := by
        unfold matchStep; simp only [hm, ite_true]
        cases best with
        | none => exact ⟨_, rfl, Nat.le_refl _⟩
        | some b =>
          by_cases hgt : w.length > b
          · simp only [hgt, ite_true]; exact ⟨_, rfl, Nat.le_refl _⟩
          · simp only [hgt, ite_false]; exact ⟨b, rfl, by omega⟩
      obtain ⟨b, hb, hle⟩ := hstep
      rw [hb]
      obtain ⟨n, hn, hle2⟩ := foldl_match_ge c lines ws b
      exact ⟨n, hn, by omega⟩
    · exact foldl_match_found c lines ws _ w hw' hm

/-- An unmodified shipped section is always recognised: when the lines start with a
    shipped text, a match is found, at least as long as that text. -/
theorem unmodified_shipped_matched (c : α → β) (shipped : List (List β)) (lines : List α)
    (w : List β) (hw : w ∈ shipped) (hpos : 0 < w.length)
    (hlen : w.length ≤ lines.length) (heq : (lines.take w.length).map c = w) :
    ∃ n, matchShipped c shipped lines = some n ∧ w.length ≤ n := by
  unfold matchShipped
  exact foldl_match_found c lines _ none w (List.mem_filter.mpr ⟨hw, decide_eq_true hpos⟩)
    ((prefixMatch_iff c w lines).mpr ⟨hlen, heq⟩)

/-- A user-edited section is never taken: if no shipped text equals the lines it would
    cover, there is no match. -/
theorem edited_not_matched (c : α → β) (shipped : List (List β)) (lines : List α)
    (hedit : ∀ w ∈ shipped, 0 < w.length → w.length ≤ lines.length → (lines.take w.length).map c ≠ w) :
    matchShipped c shipped lines = none := by
  cases h : matchShipped c shipped lines with
  | none => rfl
  | some n =>
    obtain ⟨w, hw, hl, hn, hle, heq⟩ := match_is_shipped c shipped lines n h
    exact absurd (hl ▸ heq) (hedit w hw (hl ▸ hn) (hl ▸ hle))

end Match

/-! ## §2 Segmentation: the file as plain lines and shipped spans -/

inductive Piece (α : Type) where
  | plain (l : α)
  | span (ls : List α)
  deriving DecidableEq

section Scan
variable {α β : Type} [DecidableEq β]

/-- Walk the lines; at a PLUR heading that is not current, a shipped match becomes a span.
    `fuel` is the line count (each step consumes at least one line). -/
def scanF (isHead : α → Bool) (cur : List α → Bool) (c : α → β) (S : List (List β)) :
    Nat → List α → List (Piece α)
  | 0, xs => xs.map Piece.plain
  | _ + 1, [] => []
  | f + 1, l :: ls =>
    if isHead l && !cur (l :: ls) then
      match matchShipped c S (l :: ls) with
      | some n => Piece.span ((l :: ls).take n) :: scanF isHead cur c S f ((l :: ls).drop n)
      | none => Piece.plain l :: scanF isHead cur c S f ls
    else Piece.plain l :: scanF isHead cur c S f ls

def scan (isHead : α → Bool) (cur : List α → Bool) (c : α → β) (S : List (List β)) (xs : List α) :
    List (Piece α) :=
  scanF isHead cur c S xs.length xs

/-- Every span the scan marks is one of the shipped texts, line for line. -/
theorem scanF_spans_shipped (isHead : α → Bool) (cur : List α → Bool) (c : α → β) (S : List (List β)) :
    ∀ (f : Nat) (xs : List α) (ls : List α), Piece.span ls ∈ scanF isHead cur c S f xs → ls.map c ∈ S
  | 0, xs, ls, h => by simp [scanF] at h
  | _ + 1, [], ls, h => by simp [scanF] at h
  | f + 1, l :: rest, ls, h => by
    simp only [scanF] at h
    split at h
    · split at h
      · rename_i n hm
        rcases List.mem_cons.mp h with h1 | h1
        · cases h1
          obtain ⟨w, hw, _, _, _, heq⟩ := match_is_shipped c S _ n hm
          exact heq ▸ hw
        · exact scanF_spans_shipped isHead cur c S f _ ls h1
      · rcases List.mem_cons.mp h with h1 | h1
        · cases h1
        · exact scanF_spans_shipped isHead cur c S f _ ls h1
    · rcases List.mem_cons.mp h with h1 | h1
      · cases h1
      · exact scanF_spans_shipped isHead cur c S f _ ls h1

theorem scan_spans_shipped (isHead : α → Bool) (cur : List α → Bool) (c : α → β) (S : List (List β))
    (xs ls : List α) (h : Piece.span ls ∈ scan isHead cur c S xs) : ls.map c ∈ S :=
  scanF_spans_shipped isHead cur c S _ xs ls h

def Piece.lines {α : Type} : Piece α → List α
  | .plain l => [l]
  | .span ls => ls

/-- The segmentation loses nothing: spans and plain lines together are the file. -/
theorem scanF_lossless (isHead : α → Bool) (cur : List α → Bool) (c : α → β) (S : List (List β)) :
    ∀ (f : Nat) (xs : List α), ((scanF isHead cur c S f xs).map Piece.lines).flatten = xs
  | 0, xs => by
    simp only [scanF, List.map_map]
    induction xs with
    | nil => rfl
    | cons x xs ih => simp [Piece.lines, ih] at *
  | _ + 1, [] => by simp [scanF]
  | f + 1, l :: rest => by
    simp only [scanF]
    split
    · split
      · simp only [List.map_cons, List.flatten_cons, Piece.lines, scanF_lossless isHead cur c S f]
        exact List.take_append_drop _ _
      · simp [Piece.lines, scanF_lossless isHead cur c S f]
    · simp [Piece.lines, scanF_lossless isHead cur c S f]

/-- `scanF_lossless` at the scan's own fuel. -/
theorem scan_lossless (isHead : α → Bool) (cur : List α → Bool) (c : α → β) (S : List (List β))
    (xs : List α) : ((scan isHead cur c S xs).map Piece.lines).flatten = xs :=
  scanF_lossless isHead cur c S _ xs

end Scan

/-! ## §3 Rebuild: what the upgrade keeps -/

section Rebuild
variable {α : Type}

/-- Drop trailing blank lines (the code's `while (before.length && isBlank(last)) before.pop()`). -/
def trimEnd (blank : α → Bool) (xs : List α) : List α :=
  (xs.reverse.dropWhile blank).reverse

structure St (α : Type) where
  out : List α
  pending : List α   -- the code's `before`: lines since the last span
  placed : Bool
  skipping : Bool    -- blank lines right after a span are dropped (`after` advances over them)

/-- One piece of the rebuild loop in `upsertInstructionSection`. -/
def step (blank : α → Bool) (section_ : List α) (sep : α) (s : St α) : Piece α → St α
  | .plain l =>
    if s.skipping && blank l then s
    else { s with pending := s.pending ++ [l], skipping := false }
  | .span _ =>
    if !s.placed then
      -- the first shipped section becomes the new one
      { out := s.out ++ s.pending ++ section_ ++ [sep], pending := [], placed := true, skipping := true }
    else
      -- a stale copy is removed; one blank line separates what remains
      let before := trimEnd blank s.pending
      { out := s.out ++ before ++ (if before.isEmpty then [] else [sep]),
        pending := [], placed := true, skipping := true }

def rebuild (blank : α → Bool) (section_ : List α) (sep : α) (hasCurrent : Bool) (ps : List (Piece α)) : List α :=
  let s := ps.foldl (step blank section_ sep) ⟨[], [], hasCurrent, false⟩
  s.out ++ s.pending

/-- The non-blank lines the user wrote: plain lines only. -/
def userText (blank : α → Bool) : List (Piece α) → List α
  | [] => []
  | .plain l :: ps => (if blank l then [] else [l]) ++ userText blank ps
  | .span _ :: ps => userText blank ps

theorem filter_dropWhile (p q : α → Bool) (h : ∀ x, q x = true → p x = false) :
    ∀ xs : List α, (xs.dropWhile q).filter p = xs.filter p
  | [] => rfl
  | x :: xs => by
    simp only [List.dropWhile_cons]
    by_cases hq : q x = true
    · simp only [hq, ite_true, List.filter_cons, h x hq]
      exact filter_dropWhile p q h xs
    · simp only [hq, Bool.false_eq_true, ite_false]

theorem filter_trimEnd (blank : α → Bool) (xs : List α) :
    (trimEnd blank xs).filter (fun x => !blank x) = xs.filter (fun x => !blank x) := by
  unfold trimEnd
  rw [List.filter_reverse, filter_dropWhile _ _ (by intro x hx; simp [hx]), ← List.filter_reverse,
    List.reverse_reverse]

theorem step_inv (blank : α → Bool) (section_ : List α) (sep : α) (done : List α) (s : St α) (p : Piece α)
    (h : done.Sublist ((s.out ++ s.pending).filter (fun x => !blank x))) :
    (done ++ userText blank [p]).Sublist
      (((step blank section_ sep s p).out ++ (step blank section_ sep s p).pending).filter (fun x => !blank x)) := by
  rw [List.filter_append] at h
  cases p with
  | plain l =>
    simp only [userText, List.append_nil]
    by_cases hb : blank l = true
    · simp only [hb, ite_true, List.append_nil]
      unfold step
      by_cases hs : s.skipping = true
      · simp only [hs, hb, Bool.and_self, ite_true, List.filter_append]; exact h
      · simp only [hs, hb, Bool.false_and, Bool.false_eq_true, ite_false]
        simp only [← List.append_assoc, List.filter_append]
        exact h.trans (List.sublist_append_left _ _)
    · have hb' : blank l = false := by simpa using hb
      simp only [hb', Bool.false_eq_true, ite_false]
      unfold step
      simp only [hb', Bool.and_false, Bool.false_eq_true, ite_false]
      simp only [← List.append_assoc, List.filter_append]
      simp only [List.filter_cons, hb', Bool.not_false, ite_true, List.filter_nil]
      exact h.append (List.Sublist.refl _)
  | span ls =>
    simp only [userText, List.append_nil]
    unfold step
    by_cases hp : s.placed = true
    · simp only [hp, Bool.not_true, Bool.false_eq_true, ite_false, List.append_nil, List.filter_append]
      rw [filter_trimEnd]
      exact h.trans (List.sublist_append_left _ _)
    · simp only [hp, Bool.not_false, ite_true, List.append_nil, List.filter_append]
      exact h.trans ((List.sublist_append_left _ _).trans (List.sublist_append_left _ _))

theorem userText_append (blank : α → Bool) (ps qs : List (Piece α)) :
    userText blank (ps ++ qs) = userText blank ps ++ userText blank qs := by
  induction ps with
  | nil => rfl
  | cons p ps ih =>
    cases p with
    | plain l => simp [userText, ih]
    | span _ => simp [userText, ih]

theorem fold_inv (blank : α → Bool) (section_ : List α) (sep : α) :
    ∀ (ps : List (Piece α)) (done : List α) (s : St α),
      done.Sublist ((s.out ++ s.pending).filter (fun x => !blank x)) →
      (done ++ userText blank ps).Sublist
        (((ps.foldl (step blank section_ sep) s).out ++ (ps.foldl (step blank section_ sep) s).pending).filter
          (fun x => !blank x))
  | [], done, s, h => by simpa [userText] using h
  | p :: ps, done, s, h => by
    simp only [List.foldl_cons]
    have h1 := step_inv blank section_ sep done s p h
    have h2 := fold_inv blank section_ sep ps _ _ h1
    have e : userText blank (p :: ps) = userText blank [p] ++ userText blank ps := by
      rw [← userText_append]; rfl
    rw [e, ← List.append_assoc]; exact h2

/-- Text PLUR did not write is never removed: every non-blank line outside a shipped
    span survives the upgrade, in order. -/
theorem user_text_kept (blank : α → Bool) (section_ : List α) (sep : α) (hasCurrent : Bool)
    (ps : List (Piece α)) :
    (userText blank ps).Sublist (rebuild blank section_ sep hasCurrent ps) := by
  have h := fold_inv blank section_ sep ps [] ⟨[], [], hasCurrent, false⟩ (by simp)
  simp only [List.nil_append] at h
  exact h.trans List.filter_sublist

/-- End to end: after scanning a file and rebuilding, every non-blank line the scan did
    not mark as a shipped span is still there, in order; and every span was shipped. -/
theorem upgrade_keeps_user_text {β : Type} [DecidableEq β]
    (isHead : α → Bool) (cur : List α → Bool) (c : α → β) (S : List (List β))
    (blank : α → Bool) (section_ : List α) (sep : α) (hasCurrent : Bool) (xs : List α) :
    (userText blank (scan isHead cur c S xs)).Sublist
      (rebuild blank section_ sep hasCurrent (scan isHead cur c S xs)) ∧
    (∀ ls, Piece.span ls ∈ scan isHead cur c S xs → ls.map c ∈ S) :=
  ⟨user_text_kept blank section_ sep hasCurrent _, fun ls h => scan_spans_shipped isHead cur c S xs ls h⟩

end Rebuild

/-! ### Reachability: both outcomes happen

Lines are naturals: 1 = the heading, 2/3 = shipped body, 7 = a user edit, 9 = the new
section, 0 = blank. `c = id`. -/

def exHead (n : Nat) : Bool := n == 1
def exCur (_ : List Nat) : Bool := false
def exS : List (List Nat) := [[1, 2, 3]]
def exBlank (n : Nat) : Bool := n == 0

/-- An unmodified shipped section is replaced by the new one. -/
theorem shipped_upgraded :
    rebuild exBlank [9] 0 false (scan exHead exCur id exS [5, 1, 2, 3, 6]) = [5, 9, 0, 6] := by decide

/-- One edited line and the section is the user's: nothing is removed, the scan marks no span. -/
theorem edited_kept :
    scan exHead exCur id exS [5, 1, 7, 3, 6] =
      [Piece.plain 5, Piece.plain 1, Piece.plain 7, Piece.plain 3, Piece.plain 6] := by
  decide

/-- A shipped section followed by user text the user appended: the shipped part is
    upgraded, the appended line is kept. -/
theorem appended_text_kept :
    rebuild exBlank [9] 0 false (scan exHead exCur id exS [1, 2, 3, 7]) = [9, 0, 7] := by decide

/-! ## §4 matchInternalHost: the scan loop always advances

`INTERNAL_HOST` is a global regex; `exec` from `lastIndex = li` returns a match
`(index, end)` with `li ≤ index ≤ end ≤ len` and sets `lastIndex := end`, or none.
The loop then bumps `lastIndex` when the match was zero-width. `accept` is the false-
positive gate plus the named-group check. -/

section Loop

/-- A valid exec oracle for a text of length `len`. -/
def ValidExec (len : Nat) (exec : Nat → Option (Nat × Nat)) : Prop :=
  ∀ li i e, exec li = some (i, e) → li ≤ i ∧ i ≤ e ∧ e ≤ len

/-- `lastIndex` after one iteration: the code's zero-width guard. -/
def nextIndex (i e : Nat) : Nat := if i = e then e + 1 else e

inductive Res where
  | found (i : Nat)
  | none
  | outOfFuel
  deriving DecidableEq

/-- JS: exec with `lastIndex > len` fails (and resets). -/
def loop (len : Nat) (exec : Nat → Option (Nat × Nat)) (accept : Nat → Bool) : Nat → Nat → Res
  | 0, _ => .outOfFuel
  | f + 1, li =>
    if li > len then .none
    else match exec li with
      | none => .none
      | some (i, e) => if accept i then .found i else loop len exec accept f (nextIndex i e)

/-- Every iteration strictly advances `lastIndex`. -/
theorem nextIndex_advances (len : Nat) (exec : Nat → Option (Nat × Nat)) (hv : ValidExec len exec)
    (li i e : Nat) (h : exec li = some (i, e)) : li < nextIndex i e := by
  have := hv li i e h
  unfold nextIndex
  split <;> omega

/-- So the loop ends within `len + 2` iterations from any start: it cannot spin. -/
theorem loop_terminates (len : Nat) (exec : Nat → Option (Nat × Nat)) (accept : Nat → Bool)
    (hv : ValidExec len exec) :
    ∀ (f li : Nat), li ≤ len + 1 → len + 2 ≤ f + li → loop len exec accept f li ≠ .outOfFuel
  | 0, li, h0, h => by omega
  | f + 1, li, h0, h => by
    unfold loop
    split
    · simp
    · split
      · simp
      · rename_i i e hex
        split
        · simp
        · have h1 := nextIndex_advances len exec hv li i e hex
          have h2 : nextIndex i e ≤ len + 1 := by
            have := hv li i e hex; unfold nextIndex; split <;> omega
          exact loop_terminates len exec accept hv f _ h2 (by omega)

/-- The loop with the zero-width guard removed (`lastIndex := end`). -/
def loopUnguarded (len : Nat) (exec : Nat → Option (Nat × Nat)) (accept : Nat → Bool) : Nat → Nat → Res
  | 0, _ => .outOfFuel
  | f + 1, li =>
    if li > len then .none
    else match exec li with
      | none => .none
      | some (i, e) => if accept i then .found i else loopUnguarded len exec accept f e

/-- An oracle that matches zero characters wherever it starts (valid for any text). -/
def zeroWidth (len : Nat) (li : Nat) : Option (Nat × Nat) := if li ≤ len then some (li, li) else none

theorem zeroWidth_valid (len : Nat) : ValidExec len (zeroWidth len) := by
  intro li i e h; unfold zeroWidth at h; split at h <;> simp at h; omega

/-- Counterexample: without the guard a zero-width match spins for any amount of fuel. -/
theorem unguarded_zero_width_spins (len : Nat) :
    ∀ f, loopUnguarded len (zeroWidth len) (fun _ => false) f 0 = .outOfFuel
  | 0 => rfl
  | f + 1 => by
    simp only [loopUnguarded, zeroWidth, Nat.not_lt_zero, ite_false, Nat.zero_le, ite_true]
    exact unguarded_zero_width_spins len f

/-- With the guard, the same oracle ends: nothing matched, the loop returns none. -/
theorem guarded_zero_width_ends (len : Nat) :
    loop len (zeroWidth len) (fun _ => false) (len + 2) 0 ≠ .outOfFuel :=
  loop_terminates len _ _ (zeroWidth_valid len) (len + 2) 0 (by omega) (by omega)

/-- The good case is reachable: a real host after a gated one is found. -/
theorem later_host_found :
    loop 10 (fun li => if li ≤ 2 then some (2, 5) else if li ≤ 6 then some (6, 9) else none)
      (fun i => i == 6) 12 0 = .found 6 := by decide

end Loop

end PlurSpec.SecretsInstall
