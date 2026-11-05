/-!
# PlurSpec.RemoteHealth — remote host health, completeness of a recall answer

Models of `packages/core/src/remote-recall.ts`, `store/remote-store.ts`,
`plur/remote-results.ts` and `seen-on-server.ts`.
Findings, verdicts and replays: `spec/formal/findings/remote-health.md`.

Times are `Nat` milliseconds, `0` standing for an absent timestamp where the
code reads `?? 0`. Token keys and origins are opaque `Nat`s. Every theorem holds
for every claim oracle, retry header and body.
-/

namespace PlurSpec.RemoteHealth

/-! ## 1. RemoteStore's host-down breaker (`fetchBounded`, `load`)

A request either throws out of `fetch` (with or without the caller's own
signal aborted) or the host answers with a status, after which the body read
may succeed, yield a malformed payload or throw. -/
namespace StoreBreaker

inductive Consume where
  | ok | malformed | throws
  deriving DecidableEq

inductive Fetch where
  /-- `fetch` threw; `callerAborted` is `callerSignal?.aborted` at the catch. -/
  | threw (callerAborted : Bool)
  /-- `fetch` resolved: the host answered with some status. -/
  | answered (status : Nat) (c : Consume)
  deriving DecidableEq

inductive Act where
  | mark | clear | none
  deriving DecidableEq

/-- What `fetchBounded` does to the breaker, branch for branch. -/
def act : Fetch → Act
  | .threw true  => .none     -- RemoteAbortedError, no mark
  | .threw false => .mark     -- markRemoteHostDown
  | .answered _ _ => .clear   -- clearRemoteHostDown, before the body is read

/-- The variant without the caller-signal check (what the rule forbids). -/
def actNoCallerCheck : Fetch → Act
  | .threw _ => .mark
  | .answered _ _ => .clear

def COOLDOWN : Nat := 60000

/-- `downHosts`: origin ↦ time of the last mark. -/
abbrev Down := Nat → Option Nat

def apply (a : Fetch → Act) (s : Down) (o t : Nat) (f : Fetch) : Down :=
  fun o' => if o' = o then
      match a f with
      | .mark => some t
      | .clear => none
      | .none => s o'
    else s o'

/-- `remoteHostDownRemainingMs(url) > 0`. -/
def isDown (s : Down) (o now : Nat) : Bool :=
  match s o with
  | some at_ => decide (now - at_ < COOLDOWN)
  | none => false

theorem caller_abort_never_marks (s : Down) (o t : Nat) :
    apply act s o t (.threw true) o = s o := by simp [apply, act]

theorem answered_clears (s : Down) (o t st : Nat) (c : Consume) :
    apply act s o t (.answered st c) o = none := by simp [apply, act]

/-- Mutation witness: without the caller check a caller's abort marks the host. -/
theorem no_caller_check_marks :
    apply actNoCallerCheck (fun _ => none) 1 5 (.threw true) 1 = some 5 := by
  simp [apply, actNoCallerCheck]

/-- Events on one origin never change another origin's mark. -/
theorem other_origin_untouched (s : Down) (o o' t : Nat) (f : Fetch) (h : o' ≠ o) :
    apply act s o t f o' = s o' := by simp [apply, h]

/-- A trace of requests `(origin, time, outcome)`, NEWEST FIRST, from an empty breaker. -/
def runRev : List (Nat × Nat × Fetch) → Down
  | [] => fun _ => none
  | e :: es => apply act (runRev es) e.1 e.2.1 e.2.2

/-- The newest event that changed origin `o`'s mark. -/
def lastEffective (o : Nat) : List (Nat × Nat × Fetch) → Option (Nat × Fetch)
  | [] => none
  | e :: es => if e.1 = o ∧ act e.2.2 ≠ .none then some (e.2.1, e.2.2) else lastEffective o es

/-- **A host is marked iff the newest event that touched its mark was a network
failure the caller did not cause**, at exactly that time. An HTTP answer,
whatever its status or body, never leaves a host marked. -/
theorem marked_iff_last_net (evs : List (Nat × Nat × Fetch)) (o at_ : Nat) :
    runRev evs o = some at_ ↔ lastEffective o evs = some (at_, .threw false) := by
  induction evs with
  | nil => simp [runRev, lastEffective]
  | cons e es ih =>
    obtain ⟨eo, et, ef⟩ := e
    by_cases ho : eo = o
    · subst ho
      cases ef with
      | threw ca => cases ca <;> simp [runRev, lastEffective, apply, act, ih]
      | answered st c => simp [runRev, lastEffective, apply, act]
    · have : o ≠ eo := fun h => ho h.symm
      simp [runRev, lastEffective, apply, this, ho, ih]

/-- `load()`'s page loop, sequentially across several stores on one origin:
during the cooldown a marked origin is skipped without a fetch. Returns the
breaker and the number of fetches made. -/
def loadAll (s : Down) (o : Nat) (net : Fetch) : List Nat → Down × Nat
  | [] => (s, 0)
  | t :: ts =>
    if isDown s o t then loadAll s o net ts
    else let r := loadAll (apply act s o t net) o net ts; (r.1, r.2 + 1)

/-- **Offline costs one network attempt per cooldown, not one per store.** On a
dead origin (every fetch is a network failure), any number of loads inside one
cooldown window dial at most once. -/
theorem dead_host_dials_once (s : Down) (o t0 : Nat) (ts : List Nat)
    (hwin : ∀ t ∈ ts, t0 ≤ t ∧ t < t0 + COOLDOWN) :
    (loadAll s o (.threw false) ts).2 ≤ 1 := by
  induction ts generalizing s with
  | nil => simp [loadAll]
  | cons t ts ih =>
    have ht := hwin t (by simp)
    have hrest : ∀ t' ∈ ts, t0 ≤ t' ∧ t' < t0 + COOLDOWN := fun t' h => hwin t' (by simp [h])
    unfold loadAll
    split
    · exact ih s hrest
    · rename_i hnd
      -- First fetch marks the origin at time t; every later load in the window is skipped.
      have skipAll : ∀ (us : List Nat) (s' : Down), s' o = some t →
          (∀ u ∈ us, t0 ≤ u ∧ u < t0 + COOLDOWN) → t0 ≤ t → (loadAll s' o (.threw false) us).2 = 0 := by
        intro us
        induction us with
        | nil => intro _ _ _ _; simp [loadAll]
        | cons u us ihu =>
          intro s' hs' hu htt
          have hu1 := hu u (by simp)
          have hdown : isDown s' o u = true := by
            simp only [isDown, hs', decide_eq_true_eq]; unfold COOLDOWN at *; omega
          simp only [loadAll, hdown, ite_true]
          exact ihu s' hs' (fun u' h => hu u' (by simp [h])) htt
      have := skipAll ts (apply act s o t (.threw false)) (by simp [apply, act]) hrest ht.1
      simp [this]

/-- Non-vacuity: the first load on a dead origin does dial. -/
theorem dead_host_dials_first : (loadAll (fun _ => none) 1 (.threw false) [0, 10, 20]).2 = 1 := by
  decide

end StoreBreaker

/-! ## 2. The recall leg's per-host / per-token state (`remoteRecall.dialHost`)

`Host` is one entry of remote-health.json, `toks` its per-credential records
keyed by `tokenHealthKey`. A dial is a gate (skip, unsupported, or dial as a
plain or trial read) followed by the handling of what came back. -/
namespace Recall

inductive St where
  | ok | timeout | unreachable | authExpired | forbidden | rateLimited | unsupported
  | skippedCooldown | clientSlow
  deriving DecidableEq

structure Tok where
  /-- `forbidden_count`: consecutive 403s for this token. -/
  fc : Nat := 0
  /-- `rate_limited_until` (0 = none). -/
  rl : Nat := 0
  deriving DecidableEq

structure Host where
  failures : Nat := 0
  /-- `cooldown_until` (0 = none). -/
  cd : Nat := 0
  /-- `cooldown_opened_at`. -/
  opened : Option Nat := none
  /-- `half_open_trial_at`. -/
  trialAt : Option Nat := none
  /-- `unsupported_until` (0 = none). -/
  unsup : Nat := 0
  slow : Nat := 0
  last : Option St := none
  toks : Nat → Tok := fun _ => {}

def THRESHOLD : Nat := 3
def COOLDOWN : Nat := 300000
def HALF_OPEN : Nat := 60000
def UNSUP_TTL : Nat := 600000
def RL_DEFAULT : Nat := 30000
def RL_MAX : Nat := 3600000
def SLOW_LIMIT : Nat := 3

inductive Body where
  | valid | oversize | badJson | badEnvelope
  deriving DecidableEq

inductive Resp where
  /-- Headers arrived with `status`; `retry` is the parsed Retry-After in ms;
  `body` is what reading a 2xx body gave. -/
  | answer (status : Nat) (retry : Option Nat) (body : Body)
  /-- Aborted by the recall's deadline, not this host's budget. -/
  | abortDeadline
  /-- Aborted by the budget timer, `clientSlow` as `startBudgetTimer` judged it. -/
  | abortBudget (clientSlow : Bool)
  /-- Any other thrown fetch error. -/
  | netError
  deriving DecidableEq

def setTok (h : Host) (k : Nat) (f : Tok → Tok) : Host :=
  { h with toks := fun k' => if k' = k then f (h.toks k) else h.toks k' }

def openBreaker (h : Host) (t : Nat) : Host :=
  { h with cd := t + COOLDOWN, opened := some t, trialAt := none, failures := 0 }

def finish (h : Host) (s : St) : Host × St := ({ h with last := some s }, s)

/-- A failed trial, or the threshold reached, opens the breaker. -/
def failBump (h1 : Host) (t : Nat) (trial : Bool) : Host :=
  if trial || decide (THRESHOLD ≤ h1.failures) then openBreaker h1 t else h1

def networkFailure (h : Host) (k t : Nat) (trial : Bool) (s : St) : Host × St :=
  finish (failBump (setTok { h with failures := h.failures + 1 } k (fun x => { x with fc := 0 })) t trial) s

def closeIfTrial (h : Host) (trial : Bool) : Host :=
  if trial then { h with cd := 0, opened := none, trialAt := none } else h

@[simp] theorem closeIfTrial_toks (h : Host) (tr : Bool) : (closeIfTrial h tr).toks = h.toks := by
  cases tr <;> rfl
@[simp] theorem closeIfTrial_failures (h : Host) (tr : Bool) : (closeIfTrial h tr).failures = h.failures := by
  cases tr <;> rfl
@[simp] theorem closeIfTrial_slow (h : Host) (tr : Bool) : (closeIfTrial h tr).slow = h.slow := by
  cases tr <;> rfl
theorem closeIfTrial_cd_le (h : Host) (tr : Bool) : (closeIfTrial h tr).cd ≤ h.cd := by
  cases tr <;> simp [closeIfTrial]

@[simp] theorem setTok_toks (h : Host) (k k' : Nat) (f : Tok → Tok) :
    (setTok h k f).toks k' = if k' = k then f (h.toks k) else h.toks k' := rfl
@[simp] theorem setTok_failures (h : Host) (k : Nat) (f : Tok → Tok) : (setTok h k f).failures = h.failures := rfl
@[simp] theorem setTok_cd (h : Host) (k : Nat) (f : Tok → Tok) : (setTok h k f).cd = h.cd := rfl
@[simp] theorem setTok_opened (h : Host) (k : Nat) (f : Tok → Tok) : (setTok h k f).opened = h.opened := rfl
@[simp] theorem setTok_slow (h : Host) (k : Nat) (f : Tok → Tok) : (setTok h k f).slow = h.slow := rfl

def isOk (s : Nat) : Bool := decide (200 ≤ s ∧ s < 300)

/-- The status ladder of `dialHost`, in the code's order. -/
inductive Cls where
  | r401 | r403 | r404 | r422 | r429 | notOk | ok
  deriving DecidableEq

def classify (s : Nat) : Cls :=
  if s = 401 then .r401 else if s = 403 then .r403 else if s = 404 then .r404
  else if s = 422 then .r422 else if s = 429 then .r429 else if !isOk s then .notOk else .ok

/-- What `dialHost` does once headers arrived, branch for branch. `h0` is the
entry after `client_slow_streak = 0` and, below 500, the trial close. -/
def onAnswer (h0 : Host) (k t : Nat) (trial : Bool) (retry : Option Nat) (body : Body) : Cls → Host × St
  | .r401 => finish (setTok { h0 with failures := 0 } k (fun x => { x with fc := 0 })) .authExpired
  | .r403 =>
    let h1 := setTok { h0 with failures := 0 } k (fun x => { x with fc := x.fc + 1 })
    if 2 ≤ (h1.toks k).fc then finish h1 .forbidden else finish h1 .unreachable
  | .r404 => finish { setTok { h0 with failures := 0 } k (fun x => { x with fc := 0 }) with unsup := t + UNSUP_TTL } .unsupported
  | .r422 => finish (setTok h0 k (fun x => { x with fc := 0 })) .unreachable
  | .r429 => finish (setTok { h0 with failures := 0 } k
      (fun _ => { fc := 0, rl := t + min (retry.getD RL_DEFAULT) RL_MAX })) .rateLimited
  | .notOk => networkFailure h0 k t trial .unreachable
  | .ok => match body with
    | .valid => finish (setTok { h0 with failures := 0, cd := 0, opened := none, trialAt := none } k
        (fun x => { x with fc := 0 })) .ok
    | _ => networkFailure h0 k t trial .unreachable

def respond (h : Host) (k t : Nat) (trial : Bool) : Resp → Host × St
  | .answer s retry body =>
    let h0 := { h with slow := 0 }
    onAnswer (if s < 500 then closeIfTrial h0 trial else h0) k t trial retry body (classify s)
  | .abortDeadline =>
    finish (if trial then { h with trialAt := none } else h) .timeout
  | .abortBudget true =>
    let h1 := { h with slow := h.slow + 1 }
    if SLOW_LIMIT < h1.slow then networkFailure h1 k t trial .timeout
    else finish (if trial then { h1 with trialAt := none } else h1) .clientSlow
  | .abortBudget false => networkFailure { h with slow := 0 } k t trial .timeout
  | .netError => networkFailure { h with slow := 0 } k t trial .unreachable

/-! ### 2a. Token isolation: one token's answers never touch another token's record -/

theorem networkFailure_other (h : Host) (k k' t : Nat) (tr : Bool) (s : St) (hk : k' ≠ k) :
    (networkFailure h k t tr s).1.toks k' = h.toks k' := by
  unfold networkFailure finish failBump
  split <;> simp [openBreaker, hk]

theorem onAnswer_other (h0 : Host) (k k' t : Nat) (tr : Bool) (r : Option Nat) (b : Body) (c : Cls)
    (hk : k' ≠ k) : (onAnswer h0 k t tr r b c).1.toks k' = h0.toks k' := by
  cases c with
  | r403 => simp only [onAnswer]; split <;> simp [finish, hk]
  | notOk => exact networkFailure_other _ _ _ _ _ _ hk
  | ok => cases b <;> simp [onAnswer, finish, hk, networkFailure_other _ _ _ _ _ _ hk]
  | _ => simp [onAnswer, finish, hk]

theorem respond_token_isolation (h : Host) (k k' t : Nat) (trial : Bool) (r : Resp) (hk : k' ≠ k) :
    (respond h k t trial r).1.toks k' = h.toks k' := by
  cases r with
  | answer s retry body =>
    simp only [respond]; rw [onAnswer_other _ _ _ _ _ _ _ _ hk]; split <;> simp
  | abortDeadline => simp only [respond, finish]; split <;> rfl
  | abortBudget cs =>
    cases cs <;> simp only [respond]
    · rw [networkFailure_other _ _ _ _ _ _ hk]
    · split
      · rw [networkFailure_other _ _ _ _ _ _ hk]
      · simp only [finish]; split <;> rfl
  | netError => simp only [respond]; rw [networkFailure_other _ _ _ _ _ _ hk]

/-- Any interleaving of other tokens' answers on one host leaves token `k'`
exactly as it was. -/
def respondAll (h : Host) (evs : List (Nat × Nat × Bool × Resp)) : Host :=
  evs.foldl (fun h e => (respond h e.1 e.2.1 e.2.2.1 e.2.2.2).1) h

theorem others_never_touch (h : Host) (evs : List (Nat × Nat × Bool × Resp)) (k' : Nat)
    (hk : ∀ e ∈ evs, e.1 ≠ k') : (respondAll h evs).toks k' = h.toks k' := by
  induction evs generalizing h with
  | nil => rfl
  | cons e es ih =>
    simp only [respondAll, List.foldl_cons] at ih ⊢
    rw [ih _ (fun e' he' => hk e' (by simp [he']))]
    exact respond_token_isolation _ _ _ _ _ _ (fun h' => hk e (by simp) h'.symm)
/-! ### 2b. Refusals and caller-side cuts never count toward the breaker -/

def refusal (s : Nat) : Bool := s == 401 || s == 403 || s == 404 || s == 422 || s == 429

/-- An HTTP refusal never raises the failure count and never opens or extends
the cooldown (a trial read that got one closes it). -/
theorem refusal_never_counts (h : Host) (k t : Nat) (trial : Bool) (s : Nat) (r : Option Nat) (b : Body)
    (hs : refusal s = true) :
    let h' := (respond h k t trial (.answer s r b)).1
    h'.failures ≤ h.failures ∧ h'.cd ≤ h.cd := by
  simp only [refusal, Bool.or_eq_true, beq_iff_eq] at hs
  have hlt : s < 500 := by omega
  have hcd := closeIfTrial_cd_le { h with slow := 0 } trial
  rcases hs with (((h1 | h1) | h1) | h1) | h1 <;> subst h1 <;>
    simp [respond, classify, onAnswer, finish] <;> (try split) <;> simp_all <;> omega

/-- The recall's own deadline is no evidence about the host: failures, cooldown
and its opening time are unchanged, and a trial claim is released. -/
theorem deadline_neutral (h : Host) (k t : Nat) (trial : Bool) :
    let h' := (respond h k t trial .abortDeadline).1
    h'.failures = h.failures ∧ h'.cd = h.cd ∧ h'.opened = h.opened ∧ h'.toks = h.toks ∧
    (trial = true → h'.trialAt = none) := by
  cases trial <;> simp [respond, finish]

/-- A client-slow cut within the streak limit is neutral too. -/
theorem client_slow_neutral (h : Host) (k t : Nat) (trial : Bool) (hlim : h.slow + 1 ≤ SLOW_LIMIT) :
    let h' := (respond h k t trial (.abortBudget true)).1
    h'.failures = h.failures ∧ h'.cd = h.cd ∧ (respond h k t trial (.abortBudget true)).2 = .clientSlow := by
  have : ¬ SLOW_LIMIT < h.slow + 1 := by omega
  cases trial <;> simp [respond, finish, this]

/-- Past the streak limit it counts as a host timeout (non-vacuity for the limit). -/
theorem client_slow_streak_counts :
    (respond { slow := 3, failures := 2 } 0 7 false (.abortBudget true)).1.cd = 7 + COOLDOWN := by
  decide

/-- By design (BREAKER_FAILURE_THRESHOLD's comment), an unreadable 2xx body
counts as a network-class failure on the recall leg; RemoteStore's breaker (§1)
never counts one. -/
theorem bad_body_counts (h : Host) (k t : Nat) (b : Body) (hb : b ≠ .valid) (hf : h.failures + 1 < THRESHOLD) :
    (respond h k t false (.answer 200 none b)).1.failures = h.failures + 1 := by
  have h3 : ¬ (THRESHOLD ≤ h.failures + 1) := by omega
  cases b
  · exact absurd rfl hb
  all_goals simp [respond, classify, isOk, onAnswer, networkFailure, finish, failBump, h3]

/-- **A server's Retry-After is honoured for at most one hour.** -/
theorem rate_limit_capped (h : Host) (k t : Nat) (trial : Bool) (r : Option Nat) (b : Body) :
    ((respond h k t trial (.answer 429 r b)).1.toks k).rl ≤ t + RL_MAX := by
  simp [respond, classify, onAnswer, finish]; omega

/-- Three network failures in a row open the breaker for the full cooldown. -/
theorem three_failures_open :
    (respondAll {} [(0, 1000, false, .netError), (0, 1000, false, .netError), (0, 1000, false, .netError)]).cd
      = 1000 + COOLDOWN := by
  decide

/-! ### 2c. The legacy-429 discriminator

The host-wide `cooldown_until` is the network breaker. Older files may carry a
429 cooldown there, recognised by `last_state = rate_limited`. Another token's
429 answered after the breaker opened also leaves `rate_limited` in `last`, so
the old discriminator read that breaker as a 429: no trial read, and a save
could not end it. The fix also requires `cooldown_opened_at` to be absent,
which the breaker always sets. -/

/-- `cooldownOpenedAt`. -/
def openedAt (h : Host) : Nat := h.opened.getD (h.cd - COOLDOWN)

/-- This cooldown's one trial was already claimed. -/
def trialTaken (h : Host) : Bool :=
  match h.trialAt with
  | some a => decide (openedAt h ≤ a)
  | none => false

def legacyOld (h : Host) : Bool := h.last == some .rateLimited
def legacy (h : Host) : Bool := h.last == some .rateLimited && h.opened.isNone

inductive Claim where
  | trial | free | denied
  deriving DecidableEq

/-- The gate before a dial: `none` = skipped (no fetch), `some trial` = dial.
`claim` is the oracle for `claimHalfOpenTrial` (another process's view). -/
def gate (leg : Host → Bool) (h : Host) (k t : Nat) (claim : Claim) : Option Bool :=
  if t < (h.toks k).rl then none
  else if t < h.cd then
    if leg h then none
    else if t < h.unsup then none
    else if t - openedAt h < HALF_OPEN then none
    else if trialTaken h then none
    else match claim with
      | .denied => none
      | .free => some false
      | .trial => some true
  else if t < h.unsup then none
  else some false

/-- `recordWriteOutcome(url, ok = true)`. -/
def writeOkAux (leg : Host → Bool) (h1 : Host) (t : Nat) : Host :=
  if leg h1 && decide (t < h1.cd) then h1 else { h1 with cd := 0, opened := none, trialAt := none, last := some .ok }

def writeOk (leg : Host → Bool) (h : Host) (t : Nat) : Host :=
  writeOkAux leg { h with failures := 0, slow := 0 } t

/-- `recordWriteOutcome(url, ok = false)`. -/
def writeFailAux (h1 : Host) (t : Nat) : Host :=
  if THRESHOLD ≤ h1.failures then { h1 with cd := t + COOLDOWN, opened := some t, trialAt := none } else h1

def writeFail (h : Host) (t : Nat) : Host :=
  writeFailAux { h with failures := h.failures + 1, last := some .unreachable } t

/-- Every breaker cooldown the code opens records when it opened. -/
def Inv (h : Host) : Prop := h.cd ≠ 0 → h.opened.isSome

theorem openBreaker_inv (h : Host) (t : Nat) : Inv (openBreaker h t) := by
  simp [Inv, openBreaker]

theorem networkFailure_inv (h : Host) (k t : Nat) (tr : Bool) (s : St) (hi : Inv h) :
    Inv (networkFailure h k t tr s).1 := by
  unfold networkFailure finish failBump
  split
  · simp [Inv, openBreaker]
  · simpa [Inv] using hi

theorem onAnswer_inv (h0 : Host) (k t : Nat) (tr : Bool) (r : Option Nat) (b : Body) (c : Cls)
    (hi : Inv h0) : Inv (onAnswer h0 k t tr r b c).1 := by
  cases c with
  | r403 => simp only [onAnswer]; split <;> simpa [Inv, finish] using hi
  | notOk => exact networkFailure_inv _ _ _ _ _ hi
  | ok => cases b <;> first | exact networkFailure_inv _ _ _ _ _ hi | simp [onAnswer, finish, Inv]
  | _ => simpa [onAnswer, finish, Inv] using hi

theorem respond_inv (h : Host) (k t : Nat) (trial : Bool) (r : Resp) (hi : Inv h) :
    Inv (respond h k t trial r).1 := by
  cases r with
  | answer s retry body =>
    apply onAnswer_inv
    have h0 : Inv { h with slow := 0 } := by simpa [Inv] using hi
    split
    · cases trial
      · exact h0
      · simp [Inv, closeIfTrial]
    · exact h0
  | abortDeadline =>
    simp only [respond, finish]; split <;> simpa [Inv] using hi
  | abortBudget cs =>
    cases cs
    · exact networkFailure_inv _ _ _ _ _ (by simpa [Inv] using hi)
    · simp only [respond]
      split
      · exact networkFailure_inv _ _ _ _ _ (by simpa [Inv] using hi)
      · simp only [finish]; split <;> simpa [Inv] using hi
  | netError => exact networkFailure_inv _ _ _ _ _ (by simpa [Inv] using hi)

theorem writeOk_inv (h : Host) (t : Nat) (hi : Inv h) : Inv (writeOk legacy h t) := by
  unfold writeOk writeOkAux; split
  · simpa [Inv] using hi
  · simp [Inv]

theorem writeFail_inv (h : Host) (t : Nat) (hi : Inv h) : Inv (writeFail h t) := by
  unfold writeFail writeFailAux; split
  · simp [Inv]
  · simpa [Inv] using hi

/-- In every state the code produces, an open cooldown is never mistaken for a
legacy 429. -/
theorem breaker_never_legacy (h : Host) (t : Nat) (hi : Inv h) (hcd : t < h.cd) : legacy h = false := by
  have : h.opened.isSome := hi (by omega)
  simp [legacy]
  intro _; cases ho : h.opened <;> simp_all

/-- **A breaker cooldown always gets its trial read once due**, whatever other
tokens' answers put into `last_state`. -/
theorem breaker_trial_reachable (h : Host) (k t : Nat) (hi : Inv h) (hcd : t < h.cd)
    (hrl : (h.toks k).rl ≤ t) (hun : h.unsup ≤ t)
    (hdue : HALF_OPEN ≤ t - openedAt h)
    (hfresh : h.trialAt = none) :
    gate legacy h k t .trial = some true := by
  have hl := breaker_never_legacy h t hi hcd
  have h1 : ¬ t < (h.toks k).rl := by omega
  have h2 : ¬ t < h.unsup := by omega
  have h3 : ¬ t - openedAt h < HALF_OPEN := by omega
  simp [gate, h1, hcd, hl, h2, h3, trialTaken, hfresh]

/-- **A save ends a breaker cooldown** in every state the code produces. -/
theorem save_clears_breaker (h : Host) (t : Nat) (hi : Inv h) : (writeOk legacy h t).cd = 0 := by
  unfold writeOk writeOkAux
  by_cases hcd : t < h.cd
  · have := breaker_never_legacy { h with failures := 0, slow := 0 } t (by simpa [Inv] using hi) hcd
    simp [this]
  · simp [hcd]

/-- The replayed trace: token 1's third network failure opens the breaker,
token 2's 429 answers after it in the same call. -/
def afterRace (t : Nat) : Host :=
  respondAll { failures := 2 } [(1, t, false, .netError), (2, t, false, .answer 429 (some 0) .valid)]

theorem race_reaches_rate_limited : (afterRace 1000).last = some .rateLimited ∧ (afterRace 1000).cd = 1000 + COOLDOWN := by
  decide

/-- Counterexample to the old discriminator: no trial read, and a save cannot end it. -/
theorem old_race_parks_breaker :
    gate legacyOld (afterRace 1000) 1 (1000 + HALF_OPEN + 1) .trial = none ∧
    (writeOk legacyOld (afterRace 1000) 2000).cd = 1000 + COOLDOWN := by
  decide

theorem new_race_trial_and_save :
    gate legacy (afterRace 1000) 1 (1000 + HALF_OPEN + 1) .trial = some true ∧
    (writeOk legacy (afterRace 1000) 2000).cd = 0 := by
  decide

/-- An older file's 429 cooldown (no `cooldown_opened_at`) is still honoured. -/
theorem legacy_still_honoured (t : Nat) :
    gate legacy { cd := t + 120000, last := some .rateLimited } 1 (t + HALF_OPEN + 1) .trial = none ∧
    (writeOk legacy { cd := t + 120000, last := some .rateLimited } t).cd = t + 120000 := by
  simp [gate, legacy, writeOk, writeOkAux, HALF_OPEN]

/-! ### 2d. At most one trial read per cooldown (`claimHalfOpenTrial`)

Claims are serialised under the health-file lock and re-read the file. -/

def claimStep (h : Host) (t : Nat) : Host × Bool :=
  if ¬ t < h.cd then (h, false)
  else if legacy h then (h, false)
  else if t - openedAt h < HALF_OPEN then (h, false)
  else if trialTaken h then (h, false)
  else ({ h with trialAt := some t }, true)

def claims (h : Host) : List Nat → Nat
  | [] => 0
  | t :: ts => (if (claimStep h t).2 then 1 else 0) + claims (claimStep h t).1 ts

theorem claimStep_denied (h : Host) (t : Nat) : (claimStep h t).2 = false → (claimStep h t).1 = h := by
  unfold claimStep; repeat' split
  all_goals simp

theorem claimStep_granted (h : Host) (t : Nat) :
    (claimStep h t).2 = true → (claimStep h t).1 = { h with trialAt := some t } ∧ HALF_OPEN ≤ t - openedAt h := by
  unfold claimStep; repeat' split
  all_goals simp_all
  all_goals omega

/-- Once claimed, every later claim on the same cooldown is denied. -/
theorem denied_after_claim (h : Host) (t : Nat) (hdue : HALF_OPEN ≤ t - openedAt h) (us : List Nat) :
    claims { h with trialAt := some t } us = 0 := by
  induction us with
  | nil => rfl
  | cons u us ihu =>
    have hle : openedAt h ≤ t := by unfold HALF_OPEN at hdue; omega
    have hd : (claimStep { h with trialAt := some t } u).2 = false := by
      unfold claimStep
      have ht : trialTaken { h with trialAt := some t } = true := by
        show trialTaken _ = true
        simp only [trialTaken, openedAt]; exact decide_eq_true hle
      repeat' split
      all_goals simp_all
    simp only [claims, hd, claimStep_denied _ _ hd]
    simpa using ihu

/-- **One trial per cooldown**: claims are serialised under the lock and
re-read the file, so any sequence of processes claims at most once. -/
theorem at_most_one_trial (h : Host) (ts : List Nat) : claims h ts ≤ 1 := by
  induction ts generalizing h with
  | nil => simp [claims]
  | cons t ts ih =>
    simp only [claims]
    cases hc : (claimStep h t).2
    · rw [claimStep_denied _ _ hc]; simpa using ih h
    · obtain ⟨h1, hdue⟩ := claimStep_granted _ _ hc
      rw [h1, denied_after_claim _ _ hdue]; simp

/-- Non-vacuity: a due cooldown grants its trial. -/
theorem trial_granted_when_due :
    claims { cd := 1000 + COOLDOWN, opened := some 1000 } [1000 + HALF_OPEN, 1000 + HALF_OPEN + 5] = 1 := by
  decide

end Recall

/-! ## 3. Saving health: `persistHostChanges` / `applyFieldChanges`

A record is a map from fields to optional values. A call carries the entry as
it read it (`before`) and as it left it (`after`); the merge applies the
difference onto the CURRENT file (`target`) under the lock. Counters apply as
deltas, a reset to 0 as 0; `forced` fields write what the call observed;
`skip` fields (printed_state/printed_at, tokens) are never written here. -/
namespace Persist

variable {F : Type}

abbrev Rec (F : Type) := F → Option Int

def applyField (isC skip forced : F → Bool) (target before after : Rec F) (k : F) : Option Int :=
  if skip k then target k
  else if forced k then after k
  else if before k = after k then target k
  else match after k with
    | none => none
    | some a =>
      if isC k && a != 0 then some (max 0 ((target k).getD 0 + a - (before k).getD 0)) else some a

/-- Another process's update to a field this call neither changed nor observed
survives the merge. -/
theorem untouched_survives (isC skip forced : F → Bool) (target before after : Rec F) (k : F)
    (hf : forced k = false) (hsame : before k = after k) :
    applyField isC skip forced target before after k = target k := by
  simp [applyField, hf, hsame]

/-- The header bookkeeping is never written by a recall. -/
theorem skip_never_written (isC skip forced : F → Bool) (target before after : Rec F) (k : F)
    (hs : skip k = true) : applyField isC skip forced target before after k = target k := by
  simp [applyField, hs]

/-- Two processes' increments of one counter both count. -/
theorem increments_add [DecidableEq F] (isC skip forced : F → Bool) (k : F) (base b1 b2 d1 d2 : Int)
    (hc : isC k = true) (hs : skip k = false) (hf : forced k = false)
    (h0 : 0 ≤ base) (hd1 : 0 < d1) (hd2 : 0 < d2) (hb1 : 0 ≤ b1) (hb2 : 0 ≤ b2) :
    let r1 : Rec F := fun j => if j = k then applyField isC skip forced (fun _ => some base)
      (fun _ => some b1) (fun _ => some (b1 + d1)) k else none
    applyField isC skip forced r1 (fun _ => some b2) (fun _ => some (b2 + d2)) k = some (base + d1 + d2) := by
  simp only
  have n1 : (b1 + d1 != 0) = true := by simp; omega
  have n2 : (b2 + d2 != 0) = true := by simp; omega
  have e1 : (some b1 = some (b1 + d1)) = False := by simp; omega
  have e2 : (some b2 = some (b2 + d2)) = False := by simp; omega
  simp [applyField, hc, hs, hf, n1, n2, e1, e2]
  omega

/-- Contrast: a whole-value write (no delta) loses the other process's increment. -/
def applyWhole (target before after : Rec F) (k : F) : Option Int :=
  if before k = after k then target k else after k

theorem whole_loses_increment :
    applyWhole (F := Unit) (fun _ => some 1) (fun _ => some 0) (fun _ => some 1) () = some 1 ∧
    applyField (F := Unit) (fun _ => true) (fun _ => false) (fun _ => false)
      (fun _ => some 1) (fun _ => some 0) (fun _ => some 1) () = some 2 := by decide

/-- The token loop: a token whose record this call did not change keeps the
file's record, whatever another process wrote there. -/
def mergeTokens (isC : F → Bool) (cur before after : Nat → Rec F) : Nat → Rec F :=
  fun tk f => applyField isC (fun _ => false) (fun _ => false) (cur tk) (before tk) (after tk) f

theorem other_token_survives (isC : F → Bool) (cur before after : Nat → Rec F) (tk : Nat)
    (h : ∀ f, before tk f = after tk f) : mergeTokens isC cur before after tk = cur tk := by
  funext f; exact untouched_survives _ _ _ _ _ _ f rfl (h f)

/-- `readApplyWrite`'s time fix-up. `fileT` is the file's `updated_at`, `curT`
the merged one; the entry is written only when `changed`. -/
def savedTime (changed : Bool) (fileT curT : Option Int) : Option Int :=
  if changed then
    match fileT, curT with
    | some f, some c => if c < f then some f else some c
    | _, c => c
  else fileT

/-- **A server's health record time never moves backwards** (when the merged
record carries a time, which every dial's `finish` sets). -/
theorem time_never_backwards (changed : Bool) (f c : Int) :
    ∃ r, savedTime changed (some f) (some c) = some r ∧ f ≤ r := by
  cases changed <;> simp [savedTime] <;> split <;> simp <;> omega

end Persist

/-! ## 4. Completeness of a recall answer (`_startRemoteRecall`, `_awaitRemote`)

`results_complete = local && (remote.state = ok || remote.state = not_dialed)`
(recall.ts, injection.ts). The report is `not_dialed` iff it lists no host. -/
namespace Completeness

inductive HS where
  | ok | notOk
  deriving DecidableEq

inductive RS where
  | ok | notOk | notDialed
  deriving DecidableEq

/-- `buildRecallRemoteReport`. -/
def report (outs : List HS) : RS :=
  if outs = [] then .notDialed else if outs.all (· == .ok) then .ok else .notOk

def complete (localDone : Bool) (r : RS) : Bool := localDone && (r == .ok || r == .notDialed)

/-- What the remote leg resolves to: `some outs` from `remoteRecall` (one
outcome per host), `none` when it rejected and the `.catch` ran. -/
def legOld (_hosts : List Nat) : Option (List HS) → List HS
  | some outs => outs
  | none => []

def legNew (hosts : List Nat) : Option (List HS) → List HS
  | some outs => outs
  | none => hosts.map (fun _ => .notOk)

/-- `_awaitRemote`: no promise when no host was implicated; a leg that did not
settle by the deadline reports every dialed host as timed out. -/
def await (leg : List Nat → Option (List HS) → List HS) (hosts : List Nat)
    (settled : Option (Option (List HS))) : RS :=
  if hosts = [] then .notDialed
  else match settled with
    | none => report (hosts.map (fun _ => .notOk))
    | some res => report (leg hosts res)

theorem report_ok_all (outs : List HS) (h : report outs = .ok) : ∀ o ∈ outs, o = .ok := by
  unfold report at h
  split at h; · cases h
  split at h
  · rename_i hall; intro o ho; have := List.all_eq_true.mp hall o ho; simpa using this
  · cases h

/-- **An answer is complete only when no host was implicated or every host
answered `ok`.** `remoteRecall` returns one outcome per host. -/
theorem complete_means_reached (hosts : List Nat) (settled : Option (Option (List HS)))
    (hlen : ∀ outs, settled = some (some outs) → outs.length = hosts.length)
    (hc : complete true (await legNew hosts settled) = true) :
    hosts = [] ∨ ∃ outs, settled = some (some outs) ∧ outs ≠ [] ∧ ∀ o ∈ outs, o = .ok := by
  by_cases hh : hosts = []
  · exact Or.inl hh
  · right
    have hne : hosts.map (fun _ => HS.notOk) ≠ [] := by simpa using hh
    have hbad : report (hosts.map (fun _ => HS.notOk)) = .notOk := by
      unfold report
      rw [if_neg hne]
      obtain ⟨x, xs, rfl⟩ := List.exists_cons_of_ne_nil hh
      simp
    cases settled with
    | none => simp [complete, await, hh, hbad] at hc
    | some res =>
      cases res with
      | none => simp [complete, await, legNew, hh, hbad] at hc
      | some outs =>
        have hl := hlen outs rfl
        have hne' : outs ≠ [] := by
          intro e; subst e; cases hosts with
          | nil => exact hh rfl
          | cons _ _ => simp at hl
        have hrep : report outs = .ok := by
          simp [complete, await, legNew, hh] at hc
          unfold report at hc ⊢
          rw [if_neg hne'] at hc ⊢
          split at hc <;> simp_all
          all_goals assumption
        exact ⟨outs, rfl, hne', report_ok_all outs hrep⟩

/-- Counterexample to the old `.catch`: a rejected leg on an implicated host
read as `not_dialed`, so the answer claimed completeness. -/
theorem old_catch_claims_complete : complete true (await legOld [7] (some none)) = true := by decide

theorem new_catch_incomplete : complete true (await legNew [7] (some none)) = false := by decide

/-- Non-vacuity: all hosts answering makes the answer complete. -/
theorem all_ok_complete : complete true (await legNew [7, 8] (some (some [.ok, .ok]))) = true := by decide

end Completeness

/-! ## 5. The seen-on-server record (`recordSeenOnServer`, `rotate`, `seenOnServer`)

Files are inodes. An append opens the live file, then writes to that inode.
`rotate` renames the live file over the previous generation (whose inode is
dropped) and the next append creates a fresh live file. Lookups read the
previous generation, then the live one. -/
namespace Seen

structure FS where
  data : Nat → List Nat
  live : Nat
  prev : Option Nat
  fresh : Nat

def visible (fs : FS) : List Nat :=
  (match fs.prev with | some p => fs.data p | none => []) ++ fs.data fs.live

def write (fs : FS) (ino x : Nat) : FS :=
  { fs with data := fun i => if i = ino then fs.data i ++ [x] else fs.data i }

def rotate (fs : FS) : FS :=
  { fs with prev := some fs.live, live := fs.fresh, fresh := fs.fresh + 1,
            data := fun i => if i = fs.fresh then [] else fs.data i }

/-- A line already visible stays visible across any append. -/
theorem append_keeps (fs : FS) (ino x y : Nat) (hy : y ∈ visible fs) : y ∈ visible (write fs ino x) := by
  unfold visible write at *
  cases hp : fs.prev <;> simp [hp] at hy ⊢ <;>
    (try split) <;> (try split) <;> simp_all <;> (try (rcases hy with hy | hy)) <;>
    (try split at *) <;> simp_all

/-- **An append survives a rotation between its open and its write**: the
line lands in the previous generation, which lookups still read. -/
theorem append_survives_one_rotation (fs : FS) (x : Nat) (hf : fs.fresh ≠ fs.live) :
    x ∈ visible (write (rotate fs) fs.live x) := by
  simp [visible, write, rotate, Ne.symm hf]

theorem append_without_rotation (fs : FS) (x : Nat) : x ∈ visible (write fs fs.live x) := by
  unfold visible write; cases fs.prev <;> simp

/-- The limit of the rule: two rotations inside one append's open→write window
drop the inode it holds, and the line is lost. Each rotation needs the live
file to grow past SEEN_ON_SERVER_GENERATION_BYTES (8 MiB) in that window. -/
theorem two_rotations_lose :
    let fs : FS := { data := fun _ => [], live := 0, prev := none, fresh := 1 }
    42 ∉ visible (write (rotate (rotate fs)) fs.live 42) := by
  decide

end Seen

end PlurSpec.RemoteHealth
