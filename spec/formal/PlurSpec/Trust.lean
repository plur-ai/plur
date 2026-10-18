/-!
# PlurSpec.Trust — the company CA, the proxy, and the tool launch env

Models of `packages/cli/src/enterprise/{ca,launch-env,exec}.ts` (epic
"enterprise first install", plan C task 2, plur-ai/plur #1638), 2026-10-18,
and of `wire.ts` (plan C task 5, section 4), 2026-10-18.
Findings, verdicts, replays and mutation checks: `spec/formal/findings/trust.md`.

What is abstract: certificates and fingerprints (`fp` is any function — the
real one is SHA-256 of the DER), the certificate sources (any lists), and the
string predicates "carries credentials" and "has a line break" (oracles).
Every theorem holds for all of them.

Node's `NODE_EXTRA_CA_CERTS` is modelled by what it does: the trust Node
uses is its default roots followed by the certificates in that file.

Left out: PEM/DER parsing, the platform store commands themselves (their
output is just another source list), and what the editor does with the env.
-/

namespace PlurSpec.Trust

/-! ## 1. The trust anchor (`ca.ts`)

`find` is `findCompanyCa`: the first certificate in the sources whose
fingerprint equals the pin, returned alone. `install` is `installCompanyCa`:
an invalid pin is refused before anything is read; a `caFile` is searched and
nothing else (unreadable → not found, no match → mismatch); otherwise the
system sources are searched. The found certificate is written only when the
file can be made owner-only first (`protectable`; 0600, or a verified
owner-only icacls list on Windows) — else `unprotected`. A success writes
exactly `[c]`; a refusal writes nothing, so an earlier file stays as it was.
PEM splitting is left out: the sources are already lists of certificates
here. (Review 2026-10-18: the code's scanner keeps only complete blocks,
restarts at each BEGIN, and runs in linear time; the icacls step runs
`<SystemRoot>\System32\icacls.exe` by absolute path, else `unprotected`.)

Checked against #1631 (B1b gate, 2026-10-18): still holds. `writeOwnerOnly` now calls
core's `protectOwnerOnly` (owner-only.ts: the account by SID, the list read back as SDDL),
and the SystemRoot rule (`<drive>:\Windows`) is core's `windowsSystemRoot`; icacls and
whoami run only by absolute path from it. `protectable` is still "owner-only established
and verified before the file is filled". -/
namespace Anchor

variable {Cert Fp : Type} [DecidableEq Fp]

def find (fp : Cert → Fp) (pin : Fp) : List Cert → Option Cert
  | [] => none
  | c :: cs => if fp c = pin then some c else find fp pin cs

inductive Reason | notFound | mismatch | invalidFingerprint | unprotected
  deriving DecidableEq, Repr

structure Input (Cert : Type) where
  pinValid : Bool                       -- /^[0-9a-f]{64}$/ (served-installer rule)
  caFile   : Option (Option (List Cert)) -- none: no caFile; some none: unreadable
  system   : List Cert
  protectable : Bool                    -- the file can be made owner-only before it is filled

/-- The search: which certificate, if any, would be written. -/
def select (fp : Cert → Fp) (pin : Fp) (i : Input Cert) : Except Reason (List Cert) :=
  if i.pinValid = false then .error .invalidFingerprint
  else match i.caFile with
    | some none => .error .notFound
    | some (some cs) =>
      match find fp pin cs with
      | some c => .ok [c]
      | none => .error .mismatch
    | none =>
      match find fp pin i.system with
      | some c => .ok [c]
      | none => .error .notFound

def install (fp : Cert → Fp) (pin : Fp) (i : Input Cert) : Except Reason (List Cert) :=
  match select fp pin i with
  | .ok f => if i.protectable then .ok f else .error .unprotected
  | .error e => .error e

/-- What Node trusts after the install: default roots, then the extra file.
On a refusal the file is the one an earlier run left (`prev`). -/
def effective (defaults prev : List Cert) : Except Reason (List Cert) → List Cert
  | .ok f => defaults ++ f
  | .error _ => defaults ++ prev

theorem find_sound (fp : Cert → Fp) (pin : Fp) :
    ∀ (cs : List Cert) (c : Cert), find fp pin cs = some c → fp c = pin ∧ c ∈ cs
  | [], c, h => by simp [find] at h
  | d :: ds, c, h => by
    simp only [find] at h
    split at h
    · rename_i hd; simp at h; subst h; exact ⟨hd, List.mem_cons_self⟩
    · have := find_sound fp pin ds c h
      exact ⟨this.1, List.mem_cons_of_mem _ this.2⟩

theorem select_only_pinned (fp : Cert → Fp) (pin : Fp) (i : Input Cert) (f : List Cert) :
    select fp pin i = .ok f → ∃ c, f = [c] ∧ fp c = pin := by
  unfold select
  split
  · simp
  · split
    · simp
    · rename_i cs _
      split
      · rename_i c hc; intro h; cases h; exact ⟨c, rfl, (find_sound fp pin cs c hc).1⟩
      · simp
    · split
      · rename_i c hc; intro h; cases h; exact ⟨c, rfl, (find_sound fp pin i.system c hc).1⟩
      · simp

/-- Whatever is written is exactly one certificate, and it carries the pin. -/
theorem install_only_pinned (fp : Cert → Fp) (pin : Fp) (i : Input Cert) (f : List Cert) :
    install fp pin i = .ok f → ∃ c, f = [c] ∧ fp c = pin := by
  unfold install
  cases h : select fp pin i with
  | error e => simp
  | ok g =>
    cases hp : i.protectable <;> simp
    intro hg; subst hg; exact select_only_pinned fp pin i g h

/-- A file that cannot be made owner-only first is never written. -/
theorem unprotected_writes_nothing (fp : Cert → Fp) (pin : Fp) (i : Input Cert) (h : i.protectable = false)
    (f : List Cert) : install fp pin i ≠ .ok f := by
  unfold install
  cases select fp pin i <;> simp [h]

/-- The default trust is never replaced: every default root stays trusted. -/
theorem defaults_kept (defaults prev : List Cert) (r : Except Reason (List Cert)) :
    ∀ c ∈ defaults, c ∈ effective defaults prev r := by
  intro c hc; cases r <;> simp [effective, hc]

/-- Trust grows only by the pinned CA: anything trusted after the run was a
default root, was already in the earlier file, or carries the pin. -/
theorem growth_only_pinned (fp : Cert → Fp) (pin : Fp) (i : Input Cert) (defaults prev : List Cert)
    (c : Cert) :
    c ∈ effective defaults prev (install fp pin i) → c ∈ defaults ∨ c ∈ prev ∨ fp c = pin := by
  cases h : install fp pin i with
  | error e => simp [effective]; intro hc; rcases hc with hc | hc <;> simp [hc]
  | ok f =>
    obtain ⟨d, rfl, hd⟩ := install_only_pinned fp pin i f h
    simp [effective]; intro hc; rcases hc with hc | hc
    · exact .inl hc
    · subst hc; exact .inr (.inr hd)

/-- A certificate whose fingerprint does not match is never trusted by this
run, wherever it came from (caFile, bundle neighbour, system store). -/
theorem mismatch_never_trusted (fp : Cert → Fp) (pin : Fp) (i : Input Cert) (defaults prev : List Cert)
    (c : Cert) (hfp : fp c ≠ pin) (hd : c ∉ defaults) (hp : c ∉ prev) :
    c ∉ effective defaults prev (install fp pin i) := by
  intro h
  rcases growth_only_pinned fp pin i defaults prev c h with h | h | h
  · exact hd h
  · exact hp h
  · exact hfp h

/-- A refusal changes nothing. -/
theorem refusal_writes_nothing (fp : Cert → Fp) (pin : Fp) (i : Input Cert) (e : Reason) (defaults prev : List Cert) :
    install fp pin i = .error e → effective defaults prev (install fp pin i) = defaults ++ prev := by
  intro h; rw [h]; rfl

/-- An invalid pin is refused whatever the sources hold. -/
theorem invalid_pin_refused (fp : Cert → Fp) (pin : Fp) (i : Input Cert) (h : i.pinValid = false) :
    install fp pin i = .error .invalidFingerprint := by
  simp [install, select, h]

/-- The caFile is checked again and never bypassed: when it holds no match,
the run refuses even if a system store holds the pinned CA. -/
theorem caFile_not_bypassed (fp : Cert → Fp) (pin : Fp) (cs sys : List Cert) (p : Bool)
    (hm : find fp pin cs = none) :
    install fp pin ⟨true, some (some cs), sys, p⟩ = .error .mismatch := by
  simp [install, select, hm]

/-- Non-vacuity: the pinned CA, found in a bundle next to another, is
installed alone. (`Cert := Nat`, `fp := id`, pin 1.) -/
theorem install_reachable :
    install (Cert := Nat) id 1 ⟨true, some (some [2, 1]), [], true⟩ = .ok [1] := by
  simp [install, select, find]

/-- Counterexample for the bug `find`'s single-certificate result prevents
(replayed: enterprise-ca.test.ts "a bundle caFile installs ONLY the pinned
certificate"): writing the whole bundle once any block matches. -/
def installBundle (fp : Cert → Fp) (pin : Fp) (cs : List Cert) : Except Reason (List Cert) :=
  match find fp pin cs with
  | some _ => .ok cs
  | none => .error .mismatch

theorem bundle_trusts_neighbour :
    2 ∈ effective (Cert := Nat) [] [] (installBundle id 1 [2, 1]) ∧ (id 2 : Nat) ≠ 1 := by decide

/-- Counterexample for a replacing trust file (SSL_CERT_FILE-style, or
`ca:` instead of NODE_EXTRA_CA_CERTS): the default roots are lost. -/
def effectiveReplace (defaults prev : List Cert) : Except Reason (List Cert) → List Cert
  | .ok f => f
  | .error _ => if prev = [] then defaults else prev

theorem replace_loses_defaults :
    (7 : Nat) ∉ effectiveReplace [7] [] (install (Cert := Nat) id 1 ⟨true, none, [1], true⟩) := by decide

end Anchor

/-! ## 2. The tool launch env (`launch-env.ts`)

`build` is `buildToolMcpEnv`. Keys are the closed type `Key`; the env is a
list of (key, value). `creds` and `bad` are oracles for "has a user name or
password" and "has a line break or NUL". -/
namespace LaunchEnv

inductive Key
  | extraCa | httpsProxy | httpProxy | noProxy | useEnvProxy
  | tlsRejectUnauthorized | sslCertFile | token
  deriving DecidableEq, Repr

/-- `TOOL_ENV_KEYS`. -/
def allowed : Key → Bool
  | .extraCa | .httpsProxy | .httpProxy | .noProxy | .useEnvProxy => true
  | _ => false

structure Proxy where
  https   : Option String
  http    : Option String
  noProxy : Option String

def opt (k : Key) : Option String → List (Key × String)
  | some v => [(k, v)]
  | none => []

def anyOf (p : String → Bool) : Option String → Bool
  | some v => p v
  | none => false

def build (creds bad : String → Bool) (ca : Option String) (px : Proxy) : Option (List (Key × String)) :=
  if anyOf creds px.https || anyOf creds px.http then none
  else if anyOf bad ca || anyOf bad px.https || anyOf bad px.http || anyOf bad px.noProxy then none
  else some (opt .extraCa ca ++ opt .httpsProxy px.https ++ opt .httpProxy px.http ++ opt .noProxy px.noProxy ++
    (if px.https.isSome || px.http.isSome then [(.useEnvProxy, "1")] else []))

theorem opt_keys (k : Key) (o : Option String) : ∀ p ∈ opt k o, p.1 = k := by
  cases o <;> simp [opt]

/-- Every key written is in the allowlist. -/
theorem keys_allowed (creds bad : String → Bool) (ca : Option String) (px : Proxy) (env : List (Key × String)) :
    build creds bad ca px = some env → ∀ p ∈ env, allowed p.1 = true := by
  unfold build
  split
  · simp
  · split
    · simp
    · intro h; cases h; intro p hp
      simp only [List.mem_append] at hp
      rcases hp with ((((hp | hp) | hp) | hp) | hp)
      · rw [opt_keys _ _ p hp]; rfl
      · rw [opt_keys _ _ p hp]; rfl
      · rw [opt_keys _ _ p hp]; rfl
      · rw [opt_keys _ _ p hp]; rfl
      · split at hp
        · simp at hp; rw [hp]; rfl
        · simp at hp

/-- Verification is never turned off and the default trust never replaced:
neither switch can be in the env. -/
theorem no_tls_switch (creds bad : String → Bool) (ca : Option String) (px : Proxy) (env : List (Key × String)) :
    build creds bad ca px = some env →
    (∀ v, (Key.tlsRejectUnauthorized, v) ∉ env) ∧ (∀ v, (Key.sslCertFile, v) ∉ env) ∧ (∀ v, (Key.token, v) ∉ env) := by
  intro h
  have ka := keys_allowed creds bad ca px env h
  refine ⟨fun v hv => ?_, fun v hv => ?_, fun v hv => ?_⟩ <;>
    · have := ka _ hv; simp [allowed] at this

/-- No proxy value that carries credentials is ever written. -/
theorem no_credentials (creds bad : String → Bool) (ca : Option String) (px : Proxy) (env : List (Key × String)) :
    build creds bad ca px = some env → anyOf creds px.https = false ∧ anyOf creds px.http = false := by
  unfold build
  split
  · simp
  · rename_i hc; intro _; simp_all

/-- Non-vacuity: the plan's example. -/
theorem build_reachable :
    build (fun _ => false) (fun _ => false) (some "ca") ⟨some "p", none, some "localhost"⟩ =
      some [(.extraCa, "ca"), (.httpsProxy, "p"), (.noProxy, "localhost"), (.useEnvProxy, "1")] := by decide

/-- Counterexample for the bug the credential check prevents: copying the
proxy address as it is writes a password into every editor config. -/
def buildNoCheck (ca : Option String) (px : Proxy) : List (Key × String) :=
  opt .extraCa ca ++ opt .httpsProxy px.https ++ opt .httpProxy px.http ++ opt .noProxy px.noProxy

theorem nocheck_writes_credentials :
    (Key.httpsProxy, "http://alice:pw@proxy") ∈ buildNoCheck none ⟨some "http://alice:pw@proxy", none, none⟩ := by decide

end LaunchEnv

/-! ## 3. The real exec adapter (`exec.ts`)

`spawnSync` reports a timeout as `status: null` with error ETIMEDOUT. A
spawnSync that throws before starting (a NUL in an argument) is caught and
is `startFailed` with pid 0. The timeout kills with SIGKILL (a child cannot
ignore it), so `timedOut` always ends the wait. The adapter maps every outcome to a number; the property is that only a real
exit 0 reads as 0. -/
namespace Exec

inductive Err | timedOut | startFailed | other
  deriving DecidableEq

structure Spawn where
  status : Option Nat
  error  : Option Err
  pid    : Nat

def adapt (batchOnWin : Bool) (r : Spawn) : Nat :=
  if batchOnWin then 126
  else match r.error with
    | some .timedOut => 124
    | some .startFailed => 127
    | some .other => if r.pid = 0 then 127 else 128
    | none => match r.status with
      | none => 128
      | some s => s

/-- A status of 0 means the process ran, was not killed, and exited 0. -/
theorem zero_means_exit_zero (b : Bool) (r : Spawn) :
    adapt b r = 0 → b = false ∧ r.error = none ∧ r.status = some 0 := by
  unfold adapt
  cases b <;> simp
  cases he : r.error with
  | some e => cases e <;> simp <;> split <;> simp
  | none => cases hs : r.status <;> simp

theorem timeout_nonzero (r : Spawn) (h : r.error = some .timedOut) : adapt false r ≠ 0 := by
  simp [adapt, h]

theorem exit_reachable : adapt false ⟨some 0, none, 42⟩ = 0 := rfl

/-- Counterexample for the naive adapter (`r.status ?? 0`): a killed
command reads as success (replayed: enterprise-exec.test.ts "a timeout is a
non-zero status, not null"). -/
def naive (r : Spawn) : Nat := r.status.getD 0

theorem naive_timeout_is_success : naive ⟨none, some .timedOut, 42⟩ = 0 := rfl

end Exec

/-! ## 4. Wiring each tool (`wire.ts`, plan C task 5), 2026-10-18

Four rules, each with the bug it prevents:

- `apply` is `applyMcpEnv`'s env rule. `plur` is `PLUR_ENV_KEYS`. A key
  outside it in the new env is refused; otherwise PLUR keys take the new
  value (absent = removed) and every other key keeps its value.
- `forProof` is the launch `wireTools` hands to the version check and the
  hello: only a direct launch. Through npx, cmd.exe or a shell the process the
  proof kills is not the server.
- `probeRun` is the one program `probeWsl` runs: on Windows only, only when
  Codex is not here, and only `<root>\System32\wsl.exe` for a root that passed
  `validRoot` (the real check is `<drive>:\Windows`). WSL itself is read from
  the kernel release; no env value takes part (`wslFromKernel`).
- `sideText` is the "other side" wording (owner decision O10): the side is
  carried, so the text differs by side.

What is abstract: key names and values (strings), `plur` and `validRoot`
(any predicates), the kernel test. Left out: the file formats (JSON, JSONC,
TOML) and their byte-level edits; `wire.ts` re-parses every edit and refuses
one whose result differs from `apply` anywhere, which is what makes the
format code answer to this model. -/
namespace Wire

/-- An MCP entry's env: a value per name, or none. -/
abbrev Env := String → Option String

def lookup (l : List (String × String)) (k : String) : Option String :=
  (l.find? (fun p => p.1 = k)).map (·.2)

/-- `mergeEnv`: PLUR keys from `next`, every other key from `cur`. -/
def merge (plur : String → Bool) (cur : Env) (next : List (String × String)) : Env :=
  fun k => if plur k then lookup next k else cur k

/-- `applyMcpEnv`'s env rule: a foreign key in `next` is refused (none). -/
def apply (plur : String → Bool) (cur : Env) (next : List (String × String)) : Option Env :=
  if next.all (fun p => plur p.1) then some (merge plur cur next) else none

/-- Only PLUR keys ever change: a user's own key (PLUR_PATH, say) keeps its value. -/
theorem user_keys_kept (plur : String → Bool) (cur e : Env) (next : List (String × String)) (k : String)
    (h : apply plur cur next = some e) (hk : plur k = false) : e k = cur k := by
  unfold apply at h
  split at h
  · cases h; simp [merge, hk]
  · cases h

/-- Every PLUR key ends up exactly as asked: set when given, removed when not. -/
theorem plur_keys_set (plur : String → Bool) (cur e : Env) (next : List (String × String)) (k : String)
    (h : apply plur cur next = some e) (hk : plur k = true) : e k = lookup next k := by
  unfold apply at h
  split at h
  · cases h; simp [merge, hk]
  · cases h

/-- A key outside the PLUR set (a token, say) is never written. -/
theorem foreign_refused (plur : String → Bool) (cur : Env) (next : List (String × String)) (p : String × String)
    (hp : p ∈ next) (hf : plur p.1 = false) : apply plur cur next = none := by
  unfold apply
  have : next.all (fun p => plur p.1) = false := by
    simp only [List.all_eq_false]; exact ⟨p, hp, by simp [hf]⟩
  simp [this]

/-- A re-run with the same env changes nothing (`unchanged`). -/
theorem rerun_unchanged (plur : String → Bool) (cur e : Env) (next : List (String × String))
    (h : apply plur cur next = some e) : apply plur e next = some e := by
  unfold apply at *
  split at h
  · rename_i hall; cases h; simp only [hall, ite_true]; congr 1; funext k; simp only [merge]; split <;> simp_all
  · cases h

/-- Non-vacuity: the user's PLUR_PATH stays, the proxy is set, the old CA is removed. -/
def plurKey (k : String) : Bool := k == "HTTPS_PROXY" || k == "NODE_EXTRA_CA_CERTS"
def userEnv : Env := fun k => if k = "PLUR_PATH" then some "/data" else if k = "NODE_EXTRA_CA_CERTS" then some "/old" else none

theorem apply_reachable :
    (apply plurKey userEnv [("HTTPS_PROXY", "http://p")]).map (fun e => (e "PLUR_PATH", e "HTTPS_PROXY", e "NODE_EXTRA_CA_CERTS")) =
      some (some "/data", some "http://p", none) := by decide

/-- Counterexample for the bug the merge prevents: writing the new env as the
whole env (one `env = {…}` value) drops the user's own PLUR_PATH, which
silently moves their memory to the default store. -/
def replaceAll (next : List (String × String)) : Env := lookup next

theorem replace_drops_user_key : replaceAll [("HTTPS_PROXY", "http://p")] "PLUR_PATH" = none ∧ userEnv "PLUR_PATH" = some "/data" := by
  decide

/-- How a tool's entry starts PLUR. -/
inductive Launcher | direct | npx | shell | cmdShim
  deriving DecidableEq

/-- `wireTools`: the launch the proof gets, only when `launchProblem` is null. -/
def forProof : Launcher → Option Launcher
  | .direct => some .direct
  | _ => none

/-- Whether killing the started process ends the server (a wrapper's child outlives it). -/
def killEndsServer : Launcher → Bool
  | .direct => true
  | _ => false

theorem proof_kill_ends_server (l l' : Launcher) (h : forProof l = some l') : killEndsServer l' = true := by
  cases l <;> simp [forProof] at h <;> subst h <;> rfl

/-- Counterexample: handing every launch to the proof (the review's "cmd.exe /c" and npx case) can orphan the server. -/
def forProofNaive (l : Launcher) : Option Launcher := some l
theorem naive_orphans : ∃ l, forProofNaive l = some l ∧ killEndsServer l = false := ⟨.npx, rfl, rfl⟩

inductive Plat | win32 | linux | darwin
  deriving DecidableEq

/-- The one program `probeWsl` may run. -/
def probeRun (validRoot : String → Bool) (p : Plat) (codexHere : Bool) (root : Option String) : Option String :=
  match p, codexHere, root with
  | .win32, false, some r => if validRoot r then some (r ++ "\\System32\\wsl.exe") else none
  | _, _, _ => none

/-- Whatever runs is `<root>\System32\wsl.exe` for a validated root, never a name from PATH or the cwd. -/
theorem runs_only_system32 (validRoot : String → Bool) (p : Plat) (c : Bool) (root : Option String) (cmd : String)
    (h : probeRun validRoot p c root = some cmd) :
    ∃ r, root = some r ∧ validRoot r = true ∧ cmd = r ++ "\\System32\\wsl.exe" := by
  unfold probeRun at h
  split at h
  · rename_i r; split at h
    · rename_i hv; cases h; exact ⟨r, rfl, hv, rfl⟩
    · cases h
  · cases h

/-- Outside Windows (inside WSL included) nothing is run. -/
theorem off_windows_runs_nothing (validRoot : String → Bool) (p : Plat) (c : Bool) (root : Option String)
    (hp : p ≠ .win32) : probeRun validRoot p c root = none := by
  unfold probeRun; split
  · exact absurd rfl hp
  · rfl

theorem probe_reachable : probeRun (fun _ => true) .win32 false (some "C:\\Windows") = some "C:\\Windows\\System32\\wsl.exe" := rfl

/-- Counterexample: trusting SystemRoot as found runs a program on a share someone else controls. -/
def probeRunNaive (p : Plat) (codexHere : Bool) (root : Option String) : Option String :=
  match p, codexHere, root with
  | .win32, false, some r => some (r ++ "\\System32\\wsl.exe")
  | _, _, _ => none

theorem naive_runs_planted :
    probeRunNaive .win32 false (some "\\\\evil\\share") = some "\\\\evil\\share\\System32\\wsl.exe" := rfl

/-- WSL from the kernel release only: no env value (WSL_DISTRO_NAME, WSL_INTEROP) changes the answer. -/
def wslFromKernel (kernel : String → Bool) (release : String) (_env : String → Option String) : Bool := kernel release

theorem wsl_env_irrelevant (kernel : String → Bool) (release : String) (e₁ e₂ : String → Option String) :
    wslFromKernel kernel release e₁ = wslFromKernel kernel release e₂ := rfl

inductive Side | here | wsl | windows | absent
  deriving DecidableEq

/-- `wslSide`. -/
def side (p : Plat) (codexOnPath codexInWsl isWsl codexOnWindows : Bool) : Side :=
  if codexOnPath then .here
  else match p with
    | .win32 => if codexInWsl then .wsl else .absent
    | .linux => if isWsl && codexOnWindows then .windows else .absent
    | .darwin => .absent

/-- The other side is reported only when Codex is not here. -/
theorem other_side_only_when_absent_here (p : Plat) (a b c d : Bool) (h : side p a b c d = .wsl ∨ side p a b c d = .windows) :
    a = false := by
  cases a <;> simp [side] at h ⊢

/-- The wording carries the side (O10). -/
def sideText : Side → String
  | .wsl => "runs in WSL — run the installer inside WSL"
  | .windows => "runs on Windows — run the installer in PowerShell"
  | _ => ""

theorem side_text_distinct : sideText .wsl ≠ sideText .windows := by decide

/-- Counterexample: one fixed text tells a user inside WSL to "run the installer inside WSL". -/
def oldText (_ : Side) : String := "runs in WSL — run the installer inside WSL"
theorem old_text_wrong_inside_wsl : oldText .windows = oldText .wsl := rfl

end Wire

end PlurSpec.Trust
