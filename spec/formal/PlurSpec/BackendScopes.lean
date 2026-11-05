/-
  Backend scope filters and the remote-only store guard.

  Part A: the read-side scope filter of every backend agrees with the
  in-memory predicate `makeVisibilityPredicate` (scope-util.ts).
    * in-memory  : within ∨ personal ∨ granted   (isSharedScope case-folds the
                   family prefix; isScopeWithin compares exactly)
    * PGLite and Postgres share one SQL clause (storage-pglite.ts
      buildFilterClause, storage-postgres.ts buildFilterClause); Postgres LIKE
      is case-sensitive, `ESCAPE '\'` with escapeLikePattern.
    * SQLite (storage-indexed.ts loadFiltered): `personal` column written from
      isPersonalScope; SQLite LIKE case-folds ASCII.
  LIKE is modelled as a pattern matcher over `%`, `_`, literals and one escape
  character; `lower` as `Char.toLower` (ASCII, which is what both JS
  toLowerCase and Postgres lower() do on the family prefixes). SQLite
  `instr(s, p) = 1` is modelled as "p is a prefix of s".

  Part B: RemoteOnlyStoreGuard (store/remote-only-store-guard.ts). Rows are
  abstract; `vis` is the guard's `_visible` (a well-formed queued save of this
  folder in the primary store, never when blocked). Proved: a successful
  save / append / updateMany leaves every hidden row exactly where and as it
  was, writes only visible rows, and reads return only visible rows.
-/
namespace PlurSpec.BackendScopes

abbrev Str := List Char

/-! ## A. LIKE -/

inductive Tok where
  | lit (c : Char)
  | one
  | many
deriving DecidableEq

/-- Parse a LIKE pattern with escape character `\`. -/
def compile : Str → List Tok
  | [] => []
  | '\\' :: c :: rest => .lit c :: compile rest
  | '%' :: rest => .many :: compile rest
  | '_' :: rest => .one :: compile rest
  | c :: rest => .lit c :: compile rest

def eqc (ci : Bool) (a b : Char) : Bool :=
  if ci then a.toLower == b.toLower else a == b

/-- Remaining-pattern matcher, structural on the pattern so it evaluates. -/
def manyAux (m : Str → Bool) : Str → Bool
  | [] => m []
  | x :: xs => m (x :: xs) || manyAux m xs

def matchT (ci : Bool) : List Tok → Str → Bool
  | [] => fun s => s.isEmpty
  | .lit c :: ps => fun s => match s with
    | x :: xs => eqc ci c x && matchT ci ps xs
    | [] => false
  | .one :: ps => fun s => match s with
    | _ :: xs => matchT ci ps xs
    | [] => false
  | .many :: ps => manyAux (matchT ci ps)

/-- `s LIKE pat ESCAPE '\'`; `ci` is SQLite's case-insensitive LIKE. -/
def like (ci : Bool) (pat s : Str) : Bool := matchT ci (compile pat) s

/-- escapeLikePattern (storage-adapter.ts): backslash before `\`, `%`, `_`. -/
def esc : Str → Str
  | [] => []
  | c :: rest => (if c = '\\' ∨ c = '%' ∨ c = '_' then ['\\', c] else [c]) ++ esc rest

theorem compile_esc (f rest : Str) :
    compile (esc f ++ rest) = f.map Tok.lit ++ compile rest := by
  induction f with
  | nil => rfl
  | cons c cs ih =>
    simp only [esc]
    by_cases h : c = '\\' ∨ c = '%' ∨ c = '_'
    · simp only [h, ite_true, List.cons_append, List.nil_append, List.map_cons]
      rw [compile, ih]
    · simp only [h, ite_false, List.cons_append, List.nil_append, List.map_cons]
      have h1 : c ≠ '\\' := fun e => h (Or.inl e)
      have h2 : c ≠ '%' := fun e => h (Or.inr (Or.inl e))
      have h3 : c ≠ '_' := fun e => h (Or.inr (Or.inr e))
      rw [← ih]
      cases hs : (esc cs ++ rest) with
      | nil => simp [compile, h1, h2, h3]
      | cons d ds => simp [compile, h1, h2, h3]

theorem many_all (ci : Bool) (s : Str) : matchT ci [.many] s = true := by
  induction s with
  | nil => rfl
  | cons x xs ih => simp only [matchT, manyAux] at ih ⊢; simp [ih]

/-- Case-sensitive `lit ++ %` is exactly "lit is a prefix". -/
theorem match_prefix (p s : Str) :
    matchT false (p.map Tok.lit ++ [.many]) s = p.isPrefixOf s := by
  induction p generalizing s with
  | nil => simp [many_all, List.isPrefixOf]
  | cons c cs ih =>
    cases s with
    | nil => simp [matchT, List.isPrefixOf]
    | cons x xs => simp [matchT, eqc, List.isPrefixOf, ih]

/-- The containment arm `scope LIKE esc(q) || ':%' ESCAPE '\'` (Postgres). -/
theorem like_esc_prefix (q s : Str) (d : Char) (hd : d ≠ '\\' ∧ d ≠ '%' ∧ d ≠ '_') :
    like false (esc q ++ [d, '%']) s = (q ++ [d]).isPrefixOf s := by
  unfold like
  rw [compile_esc]
  have : compile [d, '%'] = [.lit d, .many] := by
    cases d; simp_all [compile]
  rw [this, ← match_prefix]; simp

/-! ## A. Scope families -/

def lower (s : Str) : Str := s.map Char.toLower

def famPrefixes : List Str := ["group:".toList, "project:".toList, "space:".toList, "team:".toList, "org:".toList]

/-- isSharedScope (scope-util.ts). -/
def isShared (s : Str) : Bool :=
  let t := lower s
  famPrefixes.any (·.isPrefixOf t) || t == "public".toList
    || "public:".toList.isPrefixOf t || "public/".toList.isPrefixOf t

/-- isScopeWithin. -/
def within (s q : Str) : Bool :=
  s == q || (q ++ [':']).isPrefixOf s || (q ++ ['/']).isPrefixOf s

/-- makeVisibilityPredicate. -/
def memVisible (q : Str) (gs : List Str) (s : Str) : Bool :=
  within s q || !isShared s || gs.any (within s ·)

/-- The SQL personal-family arm `NOT (x LIKE 'group:%' OR ... )`, with `x`
    being `lower(scope)` when `fold`, else `scope`. -/
def sqlShared (fold : Bool) (s : Str) : Bool :=
  let t := if fold then lower s else s
  famPrefixes.any (fun p => like false (p ++ ['%']) t) || t == "public".toList
    || like false ("public:".toList ++ ['%']) t || like false ("public/".toList ++ ['%']) t

/-- The Postgres containment triple. -/
def pgWithin (s q : Str) : Bool :=
  s == q || like false (esc q ++ [':', '%']) s || like false (esc q ++ ['/', '%']) s

/-- PGLite / Postgres buildFilterClause scope arm; `fold` is the fix. -/
def pgVisible (fold : Bool) (q : Str) (gs : List Str) (s : Str) : Bool :=
  !sqlShared fold s || pgWithin s q || gs.any (pgWithin s ·)

/-- SQLite containment: before the fix case-insensitive LIKE, after it `instr(...) = 1`. -/
def sqliteWithin (fixed : Bool) (s q : Str) : Bool :=
  if fixed then s == q || (q ++ [':']).isPrefixOf s || (q ++ ['/']).isPrefixOf s
  else s == q || like true (esc q ++ [':', '%']) s || like true (esc q ++ ['/', '%']) s

/-- SQLite loadFiltered scope arm; `personal = 1` is `!isShared` written at index time. -/
def sqliteVisible (fixed : Bool) (q : Str) (gs : List Str) (s : Str) : Bool :=
  !isShared s || sqliteWithin fixed s q || gs.any (sqliteWithin fixed s ·)

theorem lit_pat (p : Str) (hp : ∀ c ∈ p, c ≠ '\\' ∧ c ≠ '%' ∧ c ≠ '_') :
    compile (p ++ ['%']) = p.map Tok.lit ++ [.many] := by
  induction p with
  | nil => rfl
  | cons c cs ih =>
    have hc := hp c (List.mem_cons_self ..)
    have ih' := ih (fun d hd => hp d (List.mem_cons_of_mem _ hd))
    simp only [List.cons_append, List.map_cons]
    rw [← ih']
    cases hs : (cs ++ ['%']) with
    | nil => simp at hs
    | cons d ds => simp [compile, hc.1, hc.2.1, hc.2.2]

theorem like_lit (p s : Str) (hp : ∀ c ∈ p, c ≠ '\\' ∧ c ≠ '%' ∧ c ≠ '_') :
    like false (p ++ ['%']) s = p.isPrefixOf s := by
  unfold like; rw [lit_pat p hp, match_prefix]

theorem sqlShared_fold (s : Str) : sqlShared true s = isShared s := by
  simp only [sqlShared, isShared, ite_true, famPrefixes, List.any_cons, List.any_nil]
  rw [like_lit _ _ (by decide), like_lit _ _ (by decide), like_lit _ _ (by decide),
      like_lit _ _ (by decide), like_lit _ _ (by decide), like_lit _ _ (by decide),
      like_lit _ _ (by decide)]

theorem pgWithin_eq (s q : Str) : pgWithin s q = within s q := by
  simp only [pgWithin, within]
  rw [like_esc_prefix _ _ _ (by decide), like_esc_prefix _ _ _ (by decide)]

/-- After the fix, PGLite and Postgres return exactly what the in-memory path returns. -/
theorem pg_agrees (q : Str) (gs : List Str) (s : Str) :
    pgVisible true q gs s = memVisible q gs s := by
  simp only [pgVisible, memVisible, sqlShared_fold, pgWithin_eq]
  cases within s q <;> cases isShared s <;> simp

/-- After the fix, the SQLite index returns exactly what the in-memory path returns. -/
theorem sqlite_agrees (q : Str) (gs : List Str) (s : Str) :
    sqliteVisible true q gs s = memVisible q gs s := by
  simp only [sqliteVisible, memVisible, sqliteWithin, ite_true, within]
  cases (s == q || (q ++ [':']).isPrefixOf s || (q ++ ['/']).isPrefixOf s) <;> cases isShared s <;> simp

/-- Before the fix: `Group:other` passed a `project:plur` filter on PGLite/Postgres
    as a personal scope, while the in-memory path hides it. -/
theorem pg_unfolded_leaks :
    pgVisible false "project:plur".toList [] "Group:other".toList = true
    ∧ memVisible "project:plur".toList [] "Group:other".toList = false := by
  decide +kernel

/-- Before the fix: SQLite admitted `Project:plur:sub` under `project:plur`. -/
theorem sqlite_ci_leaks :
    sqliteVisible false "project:plur".toList [] "Project:plur:sub".toList = true
    ∧ memVisible "project:plur".toList [] "Project:plur:sub".toList = false := by
  decide +kernel

/-- Before the fix: SQLite's unescaped case-insensitive domain prefix
    `domain LIKE ? || '%'` let `plur_core` match `plurXcore`; startsWith does not. -/
theorem sqlite_domain_wildcard :
    like true ("plur_core".toList ++ ['%']) "plurXcore".toList = true
    ∧ "plur_core".toList.isPrefixOf "plurXcore".toList = false := by
  decide +kernel

/-- Non-vacuity: personal scopes pass, foreign shared scopes do not, descendants
    pass, string-prefix siblings do not. -/
theorem mem_cases :
    memVisible "project:plur".toList [] "user:alice".toList = true
    ∧ memVisible "project:plur".toList [] "Group:other".toList = false
    ∧ memVisible "project:plur".toList [] "project:plur/x".toList = true
    ∧ memVisible "project:plur".toList [] "project:plurality".toList = false
    ∧ memVisible "project:plur".toList ["group:acme".toList] "group:acme/eng".toList = true := by
  decide +kernel

/-! ## B. RemoteOnlyStoreGuard -/

section Guard
variable {Row : Type} (idOf : Row → Nat) (vis : Row → Bool)

/-- What a read returns: `load`, `loadCached`, `loadByIds` and
    `findActiveByContentHash` all filter by `_visible`. -/
def guardRead (store : List Row) : List Row := store.filter vis

def hidden (store : List Row) : List Row := store.filter (fun e => !vis e)

/-- The merge loop of `save`: hidden rows are kept in place, a visible row is
    replaced by the incoming row with its id or dropped; the second component
    is the incoming rows not yet placed (appended at the end). -/
def mergeWalk (incoming : List Row) : List Row → List Row × List Row
  | [] => ([], incoming)
  | e :: rest =>
    let r := mergeWalk incoming rest
    if vis e then
      match r.2.find? (fun n => idOf n == idOf e) with
      | some n => (n :: r.1, r.2.filter (fun m => idOf m != idOf e))
      | none => r
    else (e :: r.1, r.2)

/-- `save`'s refusal test: every incoming row is visible and none has a hidden row's id. -/
def saveOk (store incoming : List Row) : Bool :=
  incoming.all (fun e => vis e && !((hidden vis store).map idOf).contains (idOf e))

def guardSave (store incoming : List Row) : Option (List Row) :=
  if saveOk idOf vis store incoming then
    some ((mergeWalk idOf vis incoming store).1 ++ (mergeWalk idOf vis incoming store).2)
  else none

/-- `append`: the row must be visible and its id must not exist yet. -/
def guardAppend (store : List Row) (e : Row) : Option (List Row) :=
  if vis e && !(store.map idOf).contains (idOf e) then some (store ++ [e]) else none

def repl (es : List Row) (s : Row) : Row :=
  match es.find? (fun e => idOf e == idOf s) with
  | some e => e
  | none => s

/-- `updateMany`'s refusal test: no target id is stored as a hidden row, every new row is visible. -/
def updOk (store es : List Row) : Bool :=
  es.all (fun e => vis e && !store.any (fun s => idOf s == idOf e && !vis s))

def guardUpdate (store es : List Row) : Option (List Row) :=
  if updOk idOf vis store es then some (store.map (repl idOf es)) else none

theorem mergeWalk_inv (incoming store : List Row) (hin : ∀ n ∈ incoming, vis n = true) :
    hidden vis (mergeWalk idOf vis incoming store).1 = hidden vis store
    ∧ ∀ n ∈ (mergeWalk idOf vis incoming store).2, n ∈ incoming := by
  induction store with
  | nil => exact ⟨rfl, fun n h => h⟩
  | cons e rest ih =>
    obtain ⟨ih1, ih2⟩ := ih
    cases hv : vis e
    · simp only [mergeWalk, hv, Bool.false_eq_true, ite_false]
      refine ⟨?_, ih2⟩
      simp only [hidden, List.filter_cons, hv, Bool.not_false, ite_true] at ih1 ⊢
      rw [ih1]
    · simp only [mergeWalk, hv, ite_true]
      cases hf : (mergeWalk idOf vis incoming rest).2.find? (fun n => idOf n == idOf e) with
      | none =>
        refine ⟨?_, ih2⟩
        simp only [hidden, List.filter_cons, hv, Bool.not_true, Bool.false_eq_true, ite_false] at ih1 ⊢
        exact ih1
      | some n =>
        have hvn : vis n = true := hin n (ih2 n (List.mem_of_find?_eq_some hf))
        refine ⟨?_, fun m hm => ih2 m (List.mem_filter.mp hm).1⟩
        simp only [hidden, List.filter_cons, hv, hvn, Bool.not_true, Bool.false_eq_true, ite_false] at ih1 ⊢
        exact ih1

theorem hidden_of_visible (l : List Row) (h : ∀ n ∈ l, vis n = true) : hidden vis l = [] :=
  List.filter_eq_nil_iff.mpr (fun n hn => by simp [h n hn])

/-- A successful save leaves every hidden (personal) row exactly as and where it was. -/
theorem save_keeps_hidden (store incoming out : List Row)
    (h : guardSave idOf vis store incoming = some out) :
    hidden vis out = hidden vis store := by
  unfold guardSave at h
  by_cases hok : saveOk idOf vis store incoming = true
  · simp only [hok, ite_true, Option.some.injEq] at h
    subst h
    have hin : ∀ n ∈ incoming, vis n = true := fun n hn => by
      have := List.all_eq_true.mp hok n hn
      simp only [Bool.and_eq_true] at this
      exact this.1
    obtain ⟨h1, h2⟩ := mergeWalk_inv idOf vis incoming store hin
    rw [hidden, List.filter_append, ← hidden, ← hidden, h1,
      hidden_of_visible vis _ (fun n hn => hin n (h2 n hn)), List.append_nil]
  · simp [hok] at h

/-- A successful save writes only visible queued saves, plus hidden rows carried through. -/
theorem save_writes_only_visible (store incoming out : List Row)
    (h : guardSave idOf vis store incoming = some out) :
    ∀ e ∈ out, vis e = true ∨ e ∈ store := by
  intro e he
  cases hv : vis e
  · right
    have hh : e ∈ hidden vis out := List.mem_filter.mpr ⟨he, by simp [hv]⟩
    rw [save_keeps_hidden idOf vis store incoming out h] at hh
    exact (List.mem_filter.mp hh).1
  · left; rfl

/-- A successful append adds one visible row and changes no stored row. -/
theorem append_safe (store out : List Row) (e : Row)
    (h : guardAppend idOf vis store e = some out) :
    out = store ++ [e] ∧ vis e = true := by
  unfold guardAppend at h
  by_cases hok : (vis e && !(store.map idOf).contains (idOf e)) = true
  · simp only [hok, ite_true, Option.some.injEq] at h
    simp only [Bool.and_eq_true] at hok
    exact ⟨h.symm, hok.1⟩
  · rw [if_neg hok] at h; cases h

theorem map_hidden (f : Row → Row) (store : List Row)
    (hh : ∀ s ∈ store, vis s = false → f s = s)
    (hv : ∀ s ∈ store, vis s = true → vis (f s) = true) :
    hidden vis (store.map f) = hidden vis store := by
  induction store with
  | nil => rfl
  | cons s rest ih =>
    have ih' := ih (fun t ht => hh t (List.mem_cons_of_mem _ ht)) (fun t ht => hv t (List.mem_cons_of_mem _ ht))
    simp only [List.map_cons, hidden, List.filter_cons] at ih' ⊢
    cases hs : vis s
    · rw [hh s List.mem_cons_self hs]; simp [hs, ih']
    · simp [hs, hv s List.mem_cons_self hs, ih']

/-- A successful updateMany changes no hidden row and writes only visible rows. -/
theorem update_keeps_hidden (store es out : List Row)
    (h : guardUpdate idOf vis store es = some out) :
    hidden vis out = hidden vis store ∧ ∀ e ∈ out, vis e = true ∨ e ∈ store := by
  unfold guardUpdate at h
  by_cases hok : updOk idOf vis store es = true
  · simp only [hok, ite_true, Option.some.injEq] at h
    subst h
    have hall : ∀ e ∈ es, vis e = true ∧ ∀ s ∈ store, idOf s = idOf e → vis s = true := by
      intro e he
      have := List.all_eq_true.mp hok e he
      simp only [Bool.and_eq_true, Bool.not_eq_true', List.any_eq_false, Bool.and_eq_true,
        beq_iff_eq, Bool.not_eq_true', not_and, Bool.not_eq_false] at this
      exact this
    have hr : ∀ s, vis (repl idOf es s) = true ∨ repl idOf es s = s := by
      intro s
      unfold repl
      cases hf : es.find? (fun e => idOf e == idOf s) with
      | none => right; rfl
      | some e => left; exact (hall e (List.mem_of_find?_eq_some hf)).1
    have hhid : ∀ s ∈ store, vis s = false → repl idOf es s = s := by
      intro s hs hv
      unfold repl
      cases hf : es.find? (fun e => idOf e == idOf s) with
      | none => rfl
      | some e =>
        have hid : idOf e = idOf s := by simpa using List.find?_some hf
        have := (hall e (List.mem_of_find?_eq_some hf)).2 s hs hid.symm
        rw [hv] at this; cases this
    refine ⟨map_hidden vis _ store hhid (fun s _ hv => ?_), ?_⟩
    · rcases hr s with h | h
      · exact h
      · rw [h]; exact hv
    · intro e he
      obtain ⟨s, hs, rfl⟩ := List.mem_map.mp he
      rcases hr s with h | h
      · left; exact h
      · right; rw [h]; exact hs
  · simp [hok] at h

/-- Reads never return a hidden row. -/
theorem read_only_visible (store : List Row) : ∀ e ∈ guardRead vis store, vis e = true :=
  fun e he => by simpa using (List.mem_filter.mp he).2

end Guard

/-- `_visible`: false whenever the store is secondary or the binding is
    blocked, so every write is refused there. -/
def visibleG (primary blocked queuedWellFormed : Bool) : Bool :=
  primary && !blocked && queuedWellFormed

theorem blocked_refuses_append {Row : Type} (idOf : Row → Nat) (q : Row → Bool) (store : List Row) (e : Row) :
    guardAppend idOf (fun r => visibleG true true (q r)) store e = none := by
  simp [guardAppend, visibleG]

theorem secondary_refuses_save {Row : Type} (idOf : Row → Nat) (q : Row → Bool) (store : List Row) (e : Row) :
    guardSave idOf (fun r => visibleG false false (q r)) store [e] = none := by
  simp [guardSave, saveOk, visibleG]

/-- Non-vacuity: a visible queued save is accepted and the hidden row survives in place. -/
theorem save_reachable :
    guardSave (Row := Nat × Bool) Prod.fst Prod.snd [(1, false), (2, true)] [(2, true), (3, true)]
      = some [(1, false), (2, true), (3, true)] := by decide +kernel

/-- Overwriting a hidden row's id is refused. -/
theorem save_refuses_hidden :
    guardSave (Row := Nat × Bool) Prod.fst Prod.snd [(1, false)] [(1, true)] = none := by decide +kernel

end PlurSpec.BackendScopes
