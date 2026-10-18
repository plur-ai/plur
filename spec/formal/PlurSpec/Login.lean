/-!
# PlurSpec.Login — `plur login <host>`: device sign-in and the one config write

Models of `packages/cli/src/commands/login.ts` (`pollForToken`,
`deviceSignIn`, `runSignIn`), `packages/cli/src/enterprise/legacy-login.ts`
and `packages/cli/src/enterprise/device-name.ts` (epic "enterprise first
install", plan C task 3, plur-ai/plur #1638), 2026-10-18. Findings, replays
and mutation checks: `spec/formal/findings/login.md`.

What is abstract: the config (`Cfg`, any type), registration (an oracle that
either returns the whole new config — one locked atomic write — or refuses),
the `/me` answer (a Bool: it named a user and org), and the time between
polls (`budget`: the polls left before the code expires). The HTTP shapes,
the key format check and the 429/slow_down arithmetic are folded into the
answer kinds below. Every theorem holds for all configs and oracles.

Left out: the device name and headless rules (`device-name.ts`, string
formatting only), printing, and the backup copy `--remove-stale` makes.
-/

namespace PlurSpec.Login

/-! ## 1. The poll and the one write (`pollForToken`, `deviceSignIn`, `runSignIn`)

`Answer` is one `/api/v1/auth/token` answer. `ok v` is a `200` carrying a key;
`v` is `deviceSignIn`'s check (token_type Bearer, a `plur_sk_` key, the C3
fields). `busy` is a `429`, `transient` a network error or a `5xx`.
`poll` mirrors the loop: waiting answers continue, more than three transient
answers in a row refuse, every RFC error refuses, and the budget running out
is the code's expiry. A ctrl-C ends the run where it is: modelled as the
answer list ending there (`[]` reads as expiry: nothing more arrives). -/
namespace Poll

inductive Answer
  | ok (valid : Bool)
  | pending | slowDown
  | busy
  | transient
  | denied | expired | invalidGrant | otherError
  deriving DecidableEq, Repr

inductive Outcome | key | refused | timedOut
  deriving DecidableEq, Repr

/-- The answers after which the poll asks again. -/
def waiting : Answer → Bool
  | .pending | .slowDown | .busy | .transient => true
  | _ => false

/-- `pollForToken` then `deviceSignIn`'s check. `tr`: transient answers in a
row (a 429 neither counts nor resets them; any other answer resets). -/
def poll : Nat → Nat → List Answer → Outcome
  | 0, _, _ => .timedOut
  | _ + 1, _, [] => .timedOut
  | b + 1, tr, a :: as =>
    match a with
    | .ok v => if v then .key else .refused
    | .pending | .slowDown => poll b 0 as
    | .busy => poll b tr as
    | .transient => if tr + 1 > 3 then .refused else poll b (tr + 1) as
    | .denied | .expired | .invalidGrant | .otherError => .refused

variable {Cfg : Type}

/-- `runSignIn`: the configs written, in order. Only a checked key, a `/me`
that named the user (`meOk`), and a registration that did not refuse write;
registration is one write of the whole config. -/
def login (budget : Nat) (as : List Answer) (meOk : Bool) (register : Cfg → Option Cfg) (cfg : Cfg) : List Cfg :=
  match poll budget 0 as with
  | .key => if meOk then (match register cfg with | some c => [c] | none => []) else []
  | _ => []

/-- The key is written at most once. -/
theorem at_most_one_write (b : Nat) (as : List Answer) (meOk : Bool) (register : Cfg → Option Cfg) (cfg : Cfg) :
    (login b as meOk register cfg).length ≤ 1 := by
  unfold login
  cases poll b 0 as <;> simp
  cases meOk <;> simp
  cases register cfg <;> simp

/-- A key comes only from an `ok` answer that passed the check, after
waiting answers only. -/
theorem poll_key_after_ok (b tr : Nat) (as : List Answer) :
    poll b tr as = .key → ∃ pre rest, as = pre ++ .ok true :: rest ∧ ∀ a ∈ pre, waiting a = true := by
  induction b generalizing tr as with
  | zero => simp [poll]
  | succ b ih =>
    cases as with
    | nil => simp [poll]
    | cons a as =>
      cases a with
      | ok v =>
        intro h
        cases v
        · simp [poll] at h
        · exact ⟨[], as, rfl, by simp⟩
      | pending =>
        intro h; obtain ⟨pre, rest, h1, h2⟩ := ih 0 as (by simpa [poll] using h)
        exact ⟨.pending :: pre, rest, by simp [h1], by simp [waiting]; exact h2⟩
      | slowDown =>
        intro h; obtain ⟨pre, rest, h1, h2⟩ := ih 0 as (by simpa [poll] using h)
        exact ⟨.slowDown :: pre, rest, by simp [h1], by simp [waiting]; exact h2⟩
      | busy =>
        intro h; obtain ⟨pre, rest, h1, h2⟩ := ih tr as (by simpa [poll] using h)
        exact ⟨.busy :: pre, rest, by simp [h1], by simp [waiting]; exact h2⟩
      | transient =>
        intro h
        by_cases ht : tr + 1 > 3
        · simp [poll, ht] at h
        · obtain ⟨pre, rest, h1, h2⟩ := ih (tr + 1) as (by simpa [poll, ht] using h)
          exact ⟨.transient :: pre, rest, by simp [h1], by simp [waiting]; exact h2⟩
      | denied => simp [poll]
      | expired => simp [poll]
      | invalidGrant => simp [poll]
      | otherError => simp [poll]

/-- Config is written only after an `ok` token answer that passed the check. -/
theorem write_only_after_ok (b : Nat) (as : List Answer) (meOk : Bool) (register : Cfg → Option Cfg) (cfg : Cfg) :
    login b as meOk register cfg ≠ [] →
      (∃ pre rest, as = pre ++ .ok true :: rest ∧ ∀ a ∈ pre, waiting a = true) ∧ meOk = true := by
  unfold login
  intro h
  cases hp : poll b 0 as <;> simp [hp] at h
  refine ⟨poll_key_after_ok b 0 as hp, ?_⟩
  cases meOk <;> simp_all

/-- The answers that end a run with a refusal: every RFC error, and a `200`
that failed the check. -/
def refusing : Answer → Bool
  | .denied | .expired | .invalidGrant | .otherError | .ok false => true
  | _ => false

/-- A refusing answer after waiting answers never yields a key. -/
theorem refusing_no_key (b tr : Nat) (pre rest : List Answer) (e : Answer)
    (hpre : ∀ a ∈ pre, waiting a = true) (he : refusing e = true) :
    poll b tr (pre ++ e :: rest) ≠ .key := by
  induction pre generalizing b tr with
  | nil =>
    cases b with
    | zero => simp [poll]
    | succ b =>
      cases e with
      | ok v => cases v <;> simp_all [refusing, poll]
      | _ => simp_all [refusing, poll]
  | cons a pre ih =>
    cases b with
    | zero => simp [poll]
    | succ b =>
      have ha : waiting a = true := hpre a (by simp)
      have hp : ∀ x ∈ pre, waiting x = true := fun x hx => hpre x (by simp [hx])
      cases a <;> simp [waiting] at ha
      · simpa [poll] using ih b 0 hp
      · simpa [poll] using ih b 0 hp
      · simpa [poll] using ih b tr hp
      · by_cases ht : tr + 1 > 3
        · simp [poll, ht]
        · simpa [poll, ht] using ih b (tr + 1) hp

/-- Every RFC error (and an `ok` answer that fails the check) leaves the
config unchanged: nothing is written. -/
theorem rfc_error_no_write (b : Nat) (pre rest : List Answer) (e : Answer) (meOk : Bool)
    (register : Cfg → Option Cfg) (cfg : Cfg)
    (hpre : ∀ a ∈ pre, waiting a = true) (he : refusing e = true) :
    login b (pre ++ e :: rest) meOk register cfg = [] := by
  unfold login
  have := refusing_no_key b 0 pre rest e hpre he
  cases hp : poll b 0 (pre ++ e :: rest) <;> simp_all

/-- Waiting answers alone never yield a key. -/
theorem waiting_no_key (b tr : Nat) (pre : List Answer) (hpre : ∀ a ∈ pre, waiting a = true) :
    poll b tr pre ≠ .key := by
  induction pre generalizing b tr with
  | nil => cases b <;> simp [poll]
  | cons a pre ih =>
    cases b with
    | zero => simp [poll]
    | succ b =>
      have ha : waiting a = true := hpre a (by simp)
      have hp : ∀ x ∈ pre, waiting x = true := fun x hx => hpre x (by simp [hx])
      cases a <;> simp [waiting] at ha
      · simpa [poll] using ih b 0 hp
      · simpa [poll] using ih b 0 hp
      · simpa [poll] using ih b tr hp
      · by_cases ht : tr + 1 > 3
        · simp [poll, ht]
        · simpa [poll, ht] using ih b (tr + 1) hp

/-- ctrl-C before the key arrives (the run ends after waiting answers only)
leaves the config unchanged. -/
theorem interrupt_no_write (b : Nat) (pre : List Answer) (meOk : Bool) (register : Cfg → Option Cfg) (cfg : Cfg)
    (hpre : ∀ a ∈ pre, waiting a = true) :
    login b pre meOk register cfg = [] := by
  unfold login
  have := waiting_no_key b 0 pre hpre
  cases hp : poll b 0 pre <;> simp_all

/-- Without a `/me` answer naming the user, nothing is written. -/
theorem no_write_without_me (b : Nat) (as : List Answer) (register : Cfg → Option Cfg) (cfg : Cfg) :
    login b as false register cfg = [] := by
  unfold login; cases poll b 0 as <;> simp

/-- A refused registration writes nothing. -/
theorem refused_registration_no_write (b : Nat) (as : List Answer) (meOk : Bool) (register : Cfg → Option Cfg)
    (cfg : Cfg) (h : register cfg = none) : login b as meOk register cfg = [] := by
  unfold login; cases poll b 0 as <;> simp [h]

/-- Reachable: pending, slow_down, a 429, then the key — one write. -/
theorem write_reachable :
    login (Cfg := Nat) 5 [.pending, .slowDown, .busy, .ok true] true (fun c => some (c + 1)) 0 = [1] := by decide

/-- Three transient answers are waited out; a fourth in a row refuses. -/
theorem transient_bounded :
    poll 9 0 [.transient, .transient, .transient, .ok true] = .key ∧
    poll 9 0 [.transient, .transient, .transient, .transient, .ok true] = .refused := by decide

/-! ### Counterexample: the old flow (before #1638)

The gated code wrote `~/.plur/config.json` from any `200` that carried an
`access_token` (no token_type or key-format check), and it wrote even when
`/me` failed (username `(unknown)`, no scopes). -/

def oldPoll : Nat → List Answer → Bool
  | 0, _ => false
  | _ + 1, [] => false
  | b + 1, a :: as =>
    match a with
    | .ok _ => true
    | .pending | .slowDown | .busy | .transient => oldPoll b as
    | _ => false

def oldLogin (b : Nat) (as : List Answer) (_meOk : Bool) (write : Cfg → Cfg) (cfg : Cfg) : List Cfg :=
  if oldPoll b as then [write cfg] else []

/-- Counterexample (replayed: enterprise-device-login.test.ts, "a token_type
other than Bearer is refused" and "a key that is not a PLUR device key is
refused"): an `ok` answer that fails the check is written. -/
theorem old_writes_unchecked_key :
    oldLogin (Cfg := Nat) 1 [.ok false] true (· + 1) 0 = [1] ∧ login (Cfg := Nat) 1 [.ok false] true (fun c => some (c + 1)) 0 = [] := by
  decide

/-- Counterexample: the old flow wrote when `/me` named nobody, so no
personal scope could be set. -/
theorem old_writes_without_me :
    oldLogin (Cfg := Nat) 1 [.ok true] false (· + 1) 0 = [1] ∧ login (Cfg := Nat) 1 [.ok true] false (fun c => some (c + 1)) 0 = [] := by
  decide

end Poll

/-! ## 2. Removing the stale entry (`--remove-stale`; core `registerServerEntry`)

Registration names the entries that hold the personal scope (`holder`;
registration's own verdict — a path entry serving it exactly is not one, it
keeps the writes either way). Without `removeStale`, a holder refuses the
whole registration. With it, and when every holder can be removed, exactly the
holders are dropped before the server entry is written, in the same write. -/
namespace Stale

structure Entry where
  id : Nat
  serves : Bool    -- serves the personal scope (any spelling)
  holder : Bool    -- registration names it as holding the scope's writes
  deriving DecidableEq, Repr

/-- The entries registration keeps (then adds or updates the server entry),
or `none`: refused, nothing written. -/
def kept (removeStale removable : Bool) (es : List Entry) : Option (List Entry) :=
  if es.any (·.holder) then
    if removeStale && removable then some (es.filter (fun e => !e.holder)) else none
  else some es

/-- Without the flag nothing is ever removed. -/
theorem no_flag_no_removal (removable : Bool) (es ks : List Entry) :
    kept false removable es = some ks → ks = es := by
  unfold kept
  split <;> simp_all

/-- Only holders are removed: every other entry is kept. -/
theorem non_holders_kept (f r : Bool) (es ks : List Entry) (h : kept f r es = some ks) :
    ∀ e ∈ es, e.holder = false → e ∈ ks := by
  unfold kept at h
  intro e he hn
  split at h
  · split at h
    · simp at h; subst h; simp [List.mem_filter, he, hn]
    · simp at h
  · simp at h; subst h; exact he

/-- After a removal no holder is left, so the registration that follows does
not take over anyone's writes. -/
theorem no_holder_left (f r : Bool) (es ks : List Entry) (h : kept f r es = some ks) :
    ∀ e ∈ ks, e.holder = false := by
  unfold kept at h
  split at h
  · split at h
    · simp at h; subst h; intro e he; simp at he; simpa using he.2
    · simp at h
  · rename_i hany; simp at h; subst h; intro e he
    simp at hany
    cases hh : e.holder
    · rfl
    · exact absurd hh (by simpa using hany e he)

/-- Reachable: a holder is removed and the rest kept. -/
theorem removal_reachable :
    kept true true [⟨1, true, true⟩, ⟨2, false, false⟩] = some [⟨2, false, false⟩] := by decide

/-- Counterexample for removing by scope instead of by registration's verdict:
a path entry that serves the scope exactly (not a holder) would be deleted. -/
def byScope (es : List Entry) : List Entry := es.filter (fun e => !e.serves)

theorem byScope_drops_non_holder :
    (⟨1, true, false⟩ : Entry) ∉ byScope [⟨1, true, false⟩, ⟨2, true, true⟩] ∧
    (⟨1, true, false⟩ : Entry) ∈ (kept true true [⟨1, true, false⟩, ⟨2, true, true⟩]).getD [] := by decide

end Stale

end PlurSpec.Login
