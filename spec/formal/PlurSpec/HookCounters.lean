/-!
# PlurSpec.HookCounters — hook counters and the auto-rate worker lock

Models of `packages/cli/src/lib/{codex,cursor,agy}-hook-io.ts` (the per-session
counters), `packages/cli/src/lib/auto-rate.ts` (`acquireWorkerLock` with
core's `takeOverLockSync`, the `runWorker` wait) and the counter callers
(`hook-codex-guard`, `hook-agy-guard`: deny while the count is at most 1).
Findings and replays: `spec/formal/findings/hook-counters.md`.

Process liveness, file contents and clocks are parameters; every theorem holds
for all of them.
-/

namespace PlurSpec.HookCounters

def upd {β : Type} (f : Nat → β) (p : Nat) (v : β) : Nat → β :=
  fun q => if q = p then v else f q

/-! ## 1. Counters

### Read-then-write (the Codex and Antigravity counters before they moved to `ticketCounter`)

Each caller reads the integer in the file, then writes read+1 and returns it.
The two steps of different callers interleave. No counter uses this any more;
it is kept as the counterexample `ticketCounter` answers. -/
namespace RMW

structure S where
  file : Nat
  seen : Nat → Option Nat    -- what a caller read
  ret  : Nat → Option Nat    -- what it returned

inductive Ev where | read (p : Nat) | write (p : Nat)

def step (s : S) : Ev → S
  | .read p => { s with seen := upd s.seen p (some s.file) }
  | .write p => match s.seen p with
    | some n => { s with file := n + 1, ret := upd s.ret p (some (n + 1)) }
    | none => s

def run (s : S) : List Ev → S
  | [] => s
  | e :: es => run (step s e) es

def init : S := ⟨0, fun _ => none, fun _ => none⟩

/-- **Counterexample (replayed with 12 concurrent processes: every one got 1).**
Two guard hooks read 0, then both write: both get 1, so both deny. -/
theorem rmw_duplicate :
    let s := run init [.read 0, .read 1, .write 0, .write 1]
    s.ret 0 = some 1 ∧ s.ret 1 = some 1 ∧ s.file = 1 := by decide

end RMW

/-! ### `ticketCounter` under any interleaving

Every caller appends its unique token (atomic `O_APPEND`), later reads the file
and returns the position of its own token + 1. Whatever was appended in
between, the file a caller reads is a prefix of the final file `F` that already
contains its token. -/
namespace Ticket

def pos [DecidableEq α] : List α → α → Nat
  | [], _ => 0
  | x :: xs, y => if x = y then 0 else pos xs y + 1

/-- What a caller returns when it reads `l`. -/
def value [DecidableEq α] (l : List α) (p : α) : Nat := pos l p + 1

theorem pos_prefix [DecidableEq α] (l m : List α) (p : α) (h : p ∈ l) :
    pos (l ++ m) p = pos l p := by
  induction l with
  | nil => simp at h
  | cons x xs ih =>
    simp only [List.cons_append, pos]
    by_cases hx : x = p
    · simp [hx]
    · have : p ∈ xs := by
        rcases List.mem_cons.mp h with h' | h'
        · exact absurd h'.symm hx
        · exact h'
      simp [hx, ih this]

theorem pos_inj [DecidableEq α] (l : List α) (p q : α) (hp : p ∈ l) (hq : q ∈ l)
    (e : pos l p = pos l q) : p = q := by
  induction l with
  | nil => simp at hp
  | cons x xs ih =>
    simp only [pos] at e
    by_cases hxp : x = p <;> by_cases hxq : x = q
    · exact hxp.symm.trans hxq
    · rw [ite_eq_left hxp, ite_eq_right hxq] at e; omega
    · rw [ite_eq_right hxp, ite_eq_left hxq] at e; omega
    · rw [ite_eq_right hxp, ite_eq_right hxq] at e
      have hp' : p ∈ xs := by
        rcases List.mem_cons.mp hp with h' | h'
        · exact absurd h'.symm hxp
        · exact h'
      have hq' : q ∈ xs := by
        rcases List.mem_cons.mp hq with h' | h'
        · exact absurd h'.symm hxq
        · exact h'
      exact ih hp' hq' (by omega)

/-- **Distinct values under any interleaving.** Two callers that read the file
at different moments (prefixes `lp`, `lq` of the final file, each holding its
own token) get different values. -/
theorem ticket_distinct_any_schedule [DecidableEq α] (F lp lq mp mq : List α) (p q : α)
    (hp : F = lp ++ mp) (hq : F = lq ++ mq) (hpin : p ∈ lp) (hqin : q ∈ lq) (hne : p ≠ q) :
    value lp p ≠ value lq q := by
  intro e
  have e' : pos lp p = pos lq q := by simp [value] at e; exact e
  rw [← pos_prefix lp mp p hpin, ← hp, ← pos_prefix lq mq q hqin, ← hq] at e'
  exact hne (pos_inj F p q (hp ▸ List.mem_append_left _ hpin) (hq ▸ List.mem_append_left _ hqin) e')

/-- The guards deny while the count is at most `MAX_BLOCKS_BEFORE_FALLBACK = 1`. -/
def denies (n : Nat) : Bool := n ≤ 1

/-- **The guard nudges once:** of any two racing guard hooks, at most one denies. -/
theorem guard_denies_at_most_once [DecidableEq α] (F lp lq mp mq : List α) (p q : α)
    (hp : F = lp ++ mp) (hq : F = lq ++ mq) (hpin : p ∈ lp) (hqin : q ∈ lq) (hne : p ≠ q) :
    ¬ (denies (value lp p) = true ∧ denies (value lq q) = true) := by
  rintro ⟨h1, h2⟩
  have d := ticket_distinct_any_schedule F lp lq mp mq p q hp hq hpin hqin hne
  simp [denies, value] at h1 h2 d
  omega

/-- Non-vacuity: the first racer is denied, the second is not. -/
theorem guard_first_denied : denies (value [0, 1] 0) = true ∧ denies (value [0, 1] 1) = false := by
  decide

end Ticket

/-! ### Fail-open

Codex `incrementCounter` (after the fix): an untrusted dir, or any I/O failure of
`ticketCounter`, reports the counter as exceeded. -/
namespace FailOpen

def MAX : Nat := 9007199254740991

def codexIncr (dirOk : Bool) (ticket : Option Nat) : Nat :=
  if dirOk then ticket.getD MAX else MAX

/-- A counter that cannot be persisted never makes the guard deny. -/
theorem fail_open (dirOk : Bool) (ticket : Option Nat) (h : dirOk = false ∨ ticket = none) :
    Ticket.denies (codexIncr dirOk ticket) = false := by
  rcases h with h | h
  · subst h; simp [codexIncr, Ticket.denies, MAX]
  · subst h; cases dirOk <;> simp [codexIncr, Ticket.denies, MAX]

theorem counts_when_ok (n : Nat) : codexIncr true (some n) = n := rfl

end FailOpen

/-! ## 2. The auto-rate worker lock (`acquireWorkerLock`, core's `takeOverLockSync`)

The lock file holds a token or nothing. A contender that judged token `e` stale
takes it over in two steps: a rename (moves whatever is at the path now into
its private claim), then `check` (claim = `e`: unlink it and report a takeover;
otherwise put it back with an exclusive create, which fails if the path is
taken). A plain acquire is an exclusive create. `held` records who believes it
holds the lock.

`grename p e` is the rename core's takeover performs: under the steal guard for
`e` it re-inspects the lock and renames only while the path still holds `e`.
The guard admits one contender per judged token (`R2Persist.ladder_mutex`), a
dead holder never releases, and a create fails while the path is taken, so the
path cannot change between that re-inspection and the rename; the model makes
the two one step. `rename p` is the unguarded rename, kept for the counterexample
`orig_live_holder_displaced`. -/
namespace WorkerLock

structure S where
  lock   : Option Nat
  claims : Nat → Option Nat
  won    : Nat → Option Nat   -- the token a contender's takeover removed
  held   : List Nat

inductive Ev where
  | create (t : Nat)            -- `openSync(path, 'wx')` by the worker with token t
  | rename (p : Nat)            -- contender p: unguarded `renameSync(path, claim)`
  | grename (p : Nat) (e : Nat) -- contender p: guarded rename, only while the path holds e
  | check (p : Nat) (e : Nat)   -- contender p: compare with the judged token e

def renameStep (s : S) (p : Nat) : S :=
  match s.claims p, s.lock with
  | none, some c => { s with lock := none, claims := upd s.claims p (some c) }
  | _, _ => s

def step (s : S) : Ev → S
  | .create t => if s.lock = none then { s with lock := some t, held := t :: s.held } else s
  | .rename p => renameStep s p
  | .grename p e => if s.lock = some e then renameStep s p else s
  | .check p e => match s.claims p with
    | some c =>
      let s1 := { s with claims := upd s.claims p none }
      if c = e then { s1 with won := upd s.won p (some c) }
      else if s.lock = none then { s1 with lock := some c } else s1
    | none => s

def run (s : S) : List Ev → S
  | [] => s
  | e :: es => run (step s e) es

/-- A dead worker's lock `e`; nobody holds anything. -/
def init (e : Nat) : S := ⟨some e, fun _ => none, fun _ => none, []⟩

/-- Tokens are unique per acquisition: nobody creates the judged token again. -/
def fresh (e : Nat) : List Ev → Prop
  | [] => True
  | .create t :: es => t ≠ e ∧ fresh e es
  | _ :: es => fresh e es

/-- The judged token `e` is in at most one place: the lock, one claim, or one
win (a takeover that reported success). -/
def Inv (e : Nat) (s : S) : Prop :=
  (s.lock = some e → ∀ p, s.claims p ≠ some e ∧ s.won p ≠ some e) ∧
  (∀ p, s.claims p = some e → s.won p ≠ some e) ∧
  (∀ p q, p ≠ q → s.claims p = some e → s.claims q ≠ some e ∧ s.won q ≠ some e) ∧
  (∀ p q, p ≠ q → s.won p = some e → s.won q ≠ some e)

-- Instantiate the invariant's clauses at the processes in play, then close by `simp_all`.
set_option hygiene false in
macro "inst_close" : tactic => `(tactic| (
  try have := fun h => hap (Eq.symm h)
  try have := fun h => hbp (Eq.symm h)
  try have := fun h => hab (Eq.symm h)
  try have := j2 a
  try have := j2 b
  try have := j2 p
  try have := j3 a b
  try have := j3 b a
  try have := j3 a p
  try have := j3 p a
  try have := j3 b p
  try have := j3 p b
  try have := j4 a b
  try have := j4 b a
  try have := j4 a p
  try have := j4 p a
  try have := j4 b p
  try have := j4 p b
  simp_all [upd]))

theorem inv_renameStep (e : Nat) (s : S) (p : Nat) (h : Inv e s) : Inv e (renameStep s p) := by
  obtain ⟨j1, j2, j3, j4⟩ := h
  cases hc : s.claims p with
  | some c => simp only [renameStep, hc]; exact ⟨j1, j2, j3, j4⟩
  | none =>
    cases hl : s.lock with
    | none => simp only [renameStep, hc, hl]; exact ⟨j1, j2, j3, j4⟩
    | some c =>
      simp only [renameStep, hc, hl]
      refine ⟨fun h => by simp at h, fun a ha => ?_, fun a b hab ha => ?_, fun a b hab ha => ?_⟩
      · by_cases hap : a = p <;> by_cases hce : c = e <;> inst_close
      · by_cases hap : a = p <;> by_cases hbp : b = p <;> by_cases hce : c = e <;> inst_close
      · by_cases hap : a = p <;> by_cases hbp : b = p <;> by_cases hce : c = e <;> inst_close

set_option maxHeartbeats 2000000 in
theorem inv_step (e : Nat) (s : S) (ev : Ev) (hf : ∀ t, ev = .create t → t ≠ e)
    (h : Inv e s) : Inv e (step s ev) := by
  obtain ⟨j1, j2, j3, j4⟩ := h
  cases ev with
  | create t =>
    have ht := hf t rfl
    by_cases hl : s.lock = none
    · simp only [step, hl, if_true]
      exact ⟨fun h => by simp at h; exact absurd h ht, j2, j3, j4⟩
    · simp only [step, hl, if_false]; exact ⟨j1, j2, j3, j4⟩
  | rename p => exact inv_renameStep e s p ⟨j1, j2, j3, j4⟩
  | grename p e' =>
    by_cases hl : s.lock = some e'
    · simp only [step, hl, if_true]; exact inv_renameStep e s p ⟨j1, j2, j3, j4⟩
    · simp only [step, hl, if_false]; exact ⟨j1, j2, j3, j4⟩
  | check p e' =>
    cases hc : s.claims p with
    | none => simp only [step, hc]; exact ⟨j1, j2, j3, j4⟩
    | some c =>
      by_cases hce' : c = e'
      · simp only [step, hc, hce', if_true]
        refine ⟨fun hl a => ?_, fun a ha => ?_, fun a b hab ha => ?_, fun a b hab ha => ?_⟩
        · by_cases hap : a = p <;> by_cases hce : c = e <;> inst_close
        · by_cases hap : a = p <;> by_cases hce : c = e <;> inst_close
        · by_cases hap : a = p <;> by_cases hbp : b = p <;> by_cases hce : c = e <;> inst_close
        · by_cases hap : a = p <;> by_cases hbp : b = p <;> by_cases hce : c = e <;> inst_close
      · by_cases hl : s.lock = none
        · simp only [step, hc, hce', hl, if_false, if_true]
          refine ⟨fun hl' a => ?_, fun a ha => ?_, fun a b hab ha => ?_, fun a b hab ha => ?_⟩
          · by_cases hap : a = p <;> by_cases hce : c = e <;> inst_close
          · by_cases hap : a = p <;> by_cases hce : c = e <;> inst_close
          · by_cases hap : a = p <;> by_cases hbp : b = p <;> by_cases hce : c = e <;> inst_close
          · by_cases hap : a = p <;> by_cases hbp : b = p <;> by_cases hce : c = e <;> inst_close
        · simp only [step, hc, hce', hl, if_false]
          refine ⟨fun hl' a => ?_, fun a ha => ?_, fun a b hab ha => ?_, fun a b hab ha => ?_⟩
          · by_cases hap : a = p <;> by_cases hce : c = e <;> inst_close
          · by_cases hap : a = p <;> by_cases hce : c = e <;> inst_close
          · by_cases hap : a = p <;> by_cases hbp : b = p <;> by_cases hce : c = e <;> inst_close
          · by_cases hap : a = p <;> by_cases hbp : b = p <;> by_cases hce : c = e <;> inst_close

theorem inv_run (e : Nat) (s : S) (es : List Ev) (hf : fresh e es) (h : Inv e s) :
    Inv e (run s es) := by
  induction es generalizing s with
  | nil => exact h
  | cons ev es ih =>
    have hev : ∀ t, ev = .create t → t ≠ e := by
      intro t ht; subst ht; exact hf.1
    have hrest : fresh e es := by
      cases ev with
      | create t => exact hf.2
      | rename _ => exact hf
      | grename _ _ => exact hf
      | check _ _ => exact hf
    exact ih (step s ev) hrest (inv_step e s ev hev h)

theorem inv_init (e : Nat) : Inv e (init e) := by
  refine ⟨fun _ p => ?_, fun p h => ?_, fun p q _ h => ?_, fun p q _ h => ?_⟩ <;> simp_all [init]

/-- **A stale lock is taken over by at most one contender**, under every
interleaving of any number of contenders and acquirers. -/
theorem stale_taken_over_at_most_once (e : Nat) (es : List Ev) (hf : fresh e es) (p q : Nat)
    (hpq : p ≠ q) (hp : (run (init e) es).won p = some e) : (run (init e) es).won q ≠ some e :=
  (inv_run e (init e) es hf (inv_init e)).2.2.2 p q hpq hp

/-- Non-vacuity: a lone contender does take the stale lock over, and then acquires. -/
theorem lone_contender_takes_over :
    let s := run (init 9) [.grename 1 9, .check 1 9, .create 1]
    s.won 1 = some 9 ∧ s.lock = some 1 := by decide

/-- Two contenders that judged the same dead lock: only the first rename wins;
the second claims nothing. -/
theorem second_contender_loses :
    (run (init 9) [.grename 1 9, .grename 2 9, .check 1 9, .check 2 9]).won 2 = none := by decide

/-- A live holder, put aside by a late contender, is put back when nobody
acquires inside that window. -/
theorem live_holder_restored (e a p : Nat) (hae : a ≠ e) (s : S)
    (hl : s.lock = some a) (hc : s.claims p = none) :
    (run s [.rename p, .check p e]).lock = some a := by
  simp [run, step, renameStep, hl, hc, upd, hae]

/-- **Counterexample for the unguarded rename (replayed against the cli's own
takeover before it moved to core's): a live holder IS displaced.** A takes over
dead lock 9 and holds it; B, acting on its outdated read of 9, renames A's lock
aside; C acquires in that window; B's put-back fails. A and C both believe they
hold the lock and the file names only C. -/
theorem orig_live_holder_displaced :
    let s := run (init 9) [.rename 1, .check 1 9, .create 1, .rename 2, .create 3, .check 2 9]
    s.held = [3, 1] ∧ s.lock = some 3 := by decide

/-- No contender claims anything but the judged token. -/
def GInv (e : Nat) (s : S) : Prop := ∀ p, s.claims p = none ∨ s.claims p = some e

/-- The events of `acquireWorkerLock` on core's takeover: creates, guarded
renames of the judged token `e`, and checks. -/
def guarded (e : Nat) : List Ev → Prop
  | [] => True
  | .create _ :: es => guarded e es
  | .grename _ e' :: es => e' = e ∧ guarded e es
  | .check _ _ :: es => guarded e es
  | .rename _ :: _ => False

theorem ginv_step (e : Nat) (s : S) (ev : Ev) (hg : ∀ p e', ev = .grename p e' → e' = e)
    (hr : ∀ p, ev ≠ .rename p) (h : GInv e s) : GInv e (step s ev) := by
  intro q
  cases ev with
  | create t =>
    by_cases hl : s.lock = none
    · simp only [step, hl, if_true]; exact h q
    · simp only [step, hl, if_false]; exact h q
  | rename p => exact absurd rfl (hr p)
  | grename p e' =>
    have he : e' = e := hg p e' rfl
    subst he
    by_cases hl : s.lock = some e'
    · simp only [step, hl, if_true, renameStep]
      cases hc : s.claims p with
      | some c => simp only []; exact h q
      | none =>
        simp only []
        by_cases hqp : q = p
        · subst hqp; simp [upd]
        · simp [upd, hqp]; exact h q
    · simp only [step, hl, if_false]; exact h q
  | check p e' =>
    cases hc : s.claims p with
    | none => simp only [step, hc]; exact h q
    | some c =>
      by_cases hce : c = e'
      · simp only [step, hc, hce, if_true]
        by_cases hqp : q = p
        · subst hqp; simp [upd]
        · simp [upd, hqp]; exact h q
      · by_cases hl : s.lock = none
        · simp only [step, hc, hce, hl, if_false, if_true]
          by_cases hqp : q = p
          · subst hqp; simp [upd]
          · simp [upd, hqp]; exact h q
        · simp only [step, hc, hce, hl, if_false]
          by_cases hqp : q = p
          · subst hqp; simp [upd]
          · simp [upd, hqp]; exact h q

/-- One step never moves a live holder's token `t ≠ e` off the path. -/
theorem kept_step (e t : Nat) (s : S) (ev : Ev) (hte : t ≠ e)
    (hg : ∀ p e', ev = .grename p e' → e' = e) (hr : ∀ p, ev ≠ .rename p)
    (h : GInv e s) (hl : s.lock = some t) : (step s ev).lock = some t := by
  cases ev with
  | create t' => simp [step, hl]
  | rename p => exact absurd rfl (hr p)
  | grename p e' =>
    have he : e' = e := hg p e' rfl
    subst he
    have : ¬ s.lock = some e' := by rw [hl]; simp [hte]
    simp only [step, this, if_false]; exact hl
  | check p e' =>
    cases hc : s.claims p with
    | none => simp only [step, hc]; exact hl
    | some c =>
      by_cases hce : c = e'
      · simp only [step, hc, hce, if_true]; exact hl
      · have hn : ¬ s.lock = none := by rw [hl]; simp
        simp only [step, hc, hce, hn, if_false]; exact hl

/-- **A live worker is never displaced.** Once the path holds a live token
`t ≠ e`, every schedule of creates, guarded takeovers of `e` and checks leaves
it there. -/
theorem live_holder_never_displaced (e t : Nat) (es : List Ev) (hg : guarded e es)
    (s : S) (h : GInv e s) (hte : t ≠ e) (hl : s.lock = some t) :
    (run s es).lock = some t := by
  induction es generalizing s with
  | nil => exact hl
  | cons ev es ih =>
    have hev : (∀ p e', ev = .grename p e' → e' = e) ∧ (∀ p, ev ≠ .rename p) ∧ guarded e es := by
      cases ev with
      | create _ => exact ⟨(fun _ _ h => by cases h), (fun _ h => by cases h), hg⟩
      | rename _ => exact absurd hg (by simp [guarded])
      | grename _ e' =>
        exact ⟨(fun _ _ h => by cases h; exact hg.1), (fun _ h => by cases h), hg.2⟩
      | check _ _ => exact ⟨(fun _ _ h => by cases h), (fun _ h => by cases h), hg⟩
    exact ih hev.2.2 (step s ev) (ginv_step e s ev hev.1 hev.2.1 h)
      (kept_step e t s ev hte hev.1 hev.2.1 h hl)

theorem ginv_init (e : Nat) : GInv e (init e) := fun _ => Or.inl rfl

/-- Non-vacuity: the counterexample's schedule on core's takeover. B's guarded
rename finds A's live token, not 9, and moves nothing; C's create fails. -/
theorem live_holder_kept_replay :
    let s := run (init 9) [.grename 1 9, .check 1 9, .create 1, .grename 2 9, .create 3, .check 2 9]
    s.held = [1] ∧ s.lock = some 1 := by decide

end WorkerLock

/-! ## 3. The worker's bounded wait (`runWorker`'s `acquire`)

Each round: try the lock; on failure, wait 250 ms only while a `.queue-ws` turn
is pending, the holder is a live worker of an older version
(`heldByOlderWorker`), and `waitUntil` has not passed. `env t` gives
(acquired, queueWs pending, held by an older worker) at time `t`. -/
namespace Wait

def loop (env : Nat → Bool × Bool × Bool) (waitUntil : Nat) : Nat → Nat → Bool × Nat
  | 0, t => (false, t)
  | n + 1, t =>
    match env t with
    | (true, _, _) => (true, t)
    | (false, qws, older) =>
      if !qws || !older || t ≥ waitUntil then (false, t)
      else loop env waitUntil n (t + 250)

/-- The wait is bounded by `waitUntil` plus one sleep, whatever the holder does. -/
theorem wait_bounded (env : Nat → Bool × Bool × Bool) (w n t : Nat) :
    (loop env w n t).2 ≤ max t (w + 250) := by
  induction n generalizing t with
  | zero => simp [loop]; omega
  | succ n ih =>
    simp only [loop]
    rcases henv : env t with ⟨acq, qws, older⟩
    cases acq
    · simp only []
      by_cases hs : (!qws || !older || decide (t ≥ w)) = true
      · rw [if_pos hs]; simp; omega
      · rw [if_neg hs]
        have hlt : t < w := by
          cases qws <;> cases older <;> simp_all
        have := ih (t + 250)
        omega
    · simp; omega

/-- The inline fallback (`waitForLockMs: 0`, so `waitUntil` is the start time)
never waits on another worker's lock. -/
theorem inline_never_waits (env : Nat → Bool × Bool × Bool) (n t : Nat) :
    (loop env t (n + 1) t).2 = t := by
  simp only [loop]
  rcases env t with ⟨acq, qws, older⟩
  cases acq <;> simp

/-- A current-version holder is never waited for: it drains `.queue-ws` itself. -/
theorem current_holder_not_waited (env : Nat → Bool × Bool × Bool) (w n t : Nat)
    (h : (env t).2.2 = false) : (loop env w (n + 1) t).2 = t := by
  simp only [loop]
  rcases henv : env t with ⟨acq, qws, older⟩
  rw [henv] at h; simp at h; subst h
  cases acq <;> simp

/-- Non-vacuity: behind an older holder that lets go at t = 500, the worker
waits and then acquires. -/
theorem waits_then_acquires :
    loop (fun t => (decide (t ≥ 500), true, decide (t < 500))) 10000 10 0 = (true, 500) := by decide

end Wait


end PlurSpec.HookCounters
