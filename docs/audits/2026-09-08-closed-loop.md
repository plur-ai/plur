# Public PLUR closed-loop audit — 2026-09-08/09

## 1. Final verdict

**BLOCKED — MANUAL/EXTERNAL VERIFICATION REQUIRED**

All actionable public-source remediations are implemented and verified. Of 42 findings/questions, 41 are resolved and F14 remains open only for the external remote-write guarantee. All nine BLOCKER findings in public source are resolved. The final fresh public-only review found no new substantive issue. No clean verdict is issued because the supported-server integration requirement remains unverified for the supported server artifact.

Scope: only `plur-ai/plur`, baseline `d005139ee82eb124466472190302a9bc1770693b`, branch `audit/2026-09-08-closed-loop`. This report records verification before branch publication and PR review. No merge or production deployment is included in the audit.

The earlier ledger mixed another repository into this audit. That was a scope error. This corrected ledger retains stable finding and historical cycle IDs, excludes other-repository findings, and describes only the public client side of integration findings. Omitted IDs do not denote missing public findings. A separate private handoff holds the excluded material.

F14 remains an external integration requirement: stable request identity is implemented and verified here, but a server that ignores that identity can duplicate a remotely committed write after its response is lost. Passing against a disposable contract fixture does not establish that a supported server artifact enforces this requirement. No server-source remediation is included in this public verdict.

## 2. Number of audit cycles

18 in-scope audit cycles completed, retaining historical cycle IDs 1–12, 14, 15, 17 and 20–22. The final cycle found no new substantive issue; F14 remains an external dependency requirement. Historical cycles 13, 16, 18 and 19 were wholly outside the corrected scope and are excluded.

## System understanding and identified invariants

The TypeScript core is used by CLI, stdio MCP, Claw/DSH, the browser viewer and Python/Hermes/LangChain adapters. YAML is the default authoritative store; PostgreSQL can serve as primary. SQLite/PGLite and embeddings are derived indexes. Config, history, migration journals, ID reservations, outbox receipts, sessions, provenance, backups and telemetry are separate state with different recovery lifetimes.

Input flows through validation, sensitivity/scope policy, store ownership, persistence and acknowledgement. MCP trusts its stdio host; local filesystem scopes are visibility rules within an OS account, not OS tenant isolation. Remote services authenticate bearer credentials and must enforce their own authorization; the client validates scope/state at the response boundary. Viewer requests use loopback defaults, Host checks, origin checks for desktop actions and escaped HTML. Optional model providers, remote stores, Git sync, archive downloads and telemetry are network boundaries.

Write invariants: refusal preserves existing bytes; corrupt config/state cannot authorize defaults or replacement; lock ownership spans the relevant writes; acknowledgements follow durable state; retries retain identity; cache eviction does not erase authoritative receipts; IDs do not recycle; incomplete migrations reconcile without stale restore; private writes stay local; model output cannot select unoffered or stale targets. Import and source-migration tools must preserve the original input on failure. Startup, dependency loss and shutdown are covered by backend, subprocess, setup, collector and recovery tests.

## 3. Findings by cycle

42 in-scope findings/questions: severity counts appear below. The final status of each is authoritative; historical intermediate failures remain evidence, not passes.

| Historical cycle | In-scope cycle | New findings | New count | Fresh review focus |
| --- | ---: | --- | ---: | --- |
| 1 | 1 | F01, F02, F03, F04, F05, F06, F07, F08, F09, F10, F11, F12, F13, F14, F15 | 15 | Architecture, trust boundaries, persistence/recovery, privacy and adversarial input |
| 2 | 2 | F16, F17, F18 | 3 | PostgreSQL ownership, transaction boundaries, history and privileged CI |
| 3 | 3 | F19, F20 | 2 | Configuration refusal, routing defaults and verification scheduling |
| 4 | 4 | F21, F22, F23 | 3 | State lifetime, Git commit boundaries and identity allocation |
| 5 | 5 | F24, F25 | 2 | Parallel CLI configuration paths and disabled setup tests |
| 6 | 6 | None | 0 | Lost-response integration and the remote retry contract |
| 7 | 7 | F26 | 1 | Retry equivalence across local mutations and URL spellings |
| 8 | 8 | F27 | 1 | Content preservation across local and remote write interfaces |
| 9 | 9 | F28 | 1 | Authority of remote write acknowledgements and cache state |
| 10 | 10 | F29 | 1 | Explicit private routing and deduplication siblings |
| 11 | 11 | F30 | 1 | Adversarial model decisions, fresh state and mutation preconditions |
| 12 | 12 | None | 0 | Remaining wire-field and absent-default serialization variants |
| 14 | 13 | F32 | 1 | Runtime write shapes, batch preconditions and test isolation |
| 15 | 14 | F33 | 1 | Within-batch identity admission and retries |
| 17 | 15 | F35, F36, F37, F38, F40, F41, F44 | 7 | Public dependencies, adapters, telemetry, durability and process scheduling |
| 20 | 16 | F53, F54 | 2 | Public-only re-scope; import and codemod data-safety review |
| 21 | 17 | F55 | 1 | Packaged import execution, option ownership and default destination |
| 22 | 18 | None | 0 | Fresh public-only audit of final source, trust boundaries, persistence and failure paths |

Severity at classification: 9 BLOCKER, 31 IMPORTANT, 1 QUESTION, 1 HARDENING.

### Cycle 1

- **New findings:** F01, F02, F03, F04, F05, F06, F07, F08, F09, F10, F11, F12, F13, F14, F15.
- **Previously known findings still open:** None at entry.
- **Fresh audit:** Architecture, trust boundaries, persistence/recovery, privacy and adversarial input. Current paths, nearby callers, trust/data flows and the preceding diff were reviewed.
- **Bug classes discovered:** F01, F02, F03, F04, F05, F06, F07, F08, F09, F10, F11, F12, F13, F14, F15; root causes and invariants are in the registers below.
- **Missing tests discovered:** failure sequences and bypass variants identified for F01, F02, F03, F04, F05, F06, F07, F08, F09, F10, F11, F12, F13, F14, F15; see regression evidence per finding.
- **Fixes implemented:** public-source fixes and applicable siblings for F01, F02, F03, F04, F05, F06, F07, F08, F09, F10, F11, F12, F13, F14, F15; cycles without new findings attacked existing fixes or investigated the external contract.
- **Tests added:** named regression suites/cases in the register; no cosmetic coverage target.
- **Verification executed:** targeted failure reproduction and relevant regression suites; final executed command/results below supersede intermediate checkpoints.
- **New issues caused by remediation:** Background sending initially retried excess work; process teardown signalled too late; archive binary scanning lost its limit flag. All corrected and tested.
- **Remaining substantive findings:** F14/F15 required further evidence.


### Cycle 2

- **New findings:** F16, F17, F18.
- **Previously known findings still open:** F14 remote integration guarantee; F15 advisory coverage also remained open through cycle 15. Other findings proceeded through targeted then whole-tree verification.
- **Fresh audit:** PostgreSQL ownership, transaction boundaries, history and privileged CI. Current paths, nearby callers, trust/data flows and the preceding diff were reviewed.
- **Bug classes discovered:** F16, F17, F18; root causes and invariants are in the registers below.
- **Missing tests discovered:** failure sequences and bypass variants identified for F16, F17, F18; see regression evidence per finding.
- **Fixes implemented:** public-source fixes and applicable siblings for F16, F17, F18; cycles without new findings attacked existing fixes or investigated the external contract.
- **Tests added:** named regression suites/cases in the register; no cosmetic coverage target.
- **Verification executed:** targeted failure reproduction and relevant regression suites; final executed command/results below supersede intermediate checkpoints.
- **New issues caused by remediation:** Post-commit embedding inherited expired ownership and reused clients accumulated listeners. Fixed; caught SQL errors cannot turn ROLLBACK into success.
- **Remaining substantive findings:** F14/F15 required further evidence.


### Cycle 3

- **New findings:** F19, F20.
- **Previously known findings still open:** F14 remote integration guarantee; F15 advisory coverage also remained open through cycle 15. Other findings proceeded through targeted then whole-tree verification.
- **Fresh audit:** Configuration refusal, routing defaults and verification scheduling. Current paths, nearby callers, trust/data flows and the preceding diff were reviewed.
- **Bug classes discovered:** F19, F20; root causes and invariants are in the registers below.
- **Missing tests discovered:** failure sequences and bypass variants identified for F19, F20; see regression evidence per finding.
- **Fixes implemented:** public-source fixes and applicable siblings for F19, F20; cycles without new findings attacked existing fixes or investigated the external contract.
- **Tests added:** named regression suites/cases in the register; no cosmetic coverage target.
- **Verification executed:** targeted failure reproduction and relevant regression suites; final executed command/results below supersede intermediate checkpoints.
- **New issues caused by remediation:** A duplicated export in test config was caught and corrected; the failed run was retained.
- **Remaining substantive findings:** F14/F15 required further evidence.


### Cycle 4

- **New findings:** F21, F22, F23.
- **Previously known findings still open:** F14 remote integration guarantee; F15 advisory coverage also remained open through cycle 15. Other findings proceeded through targeted then whole-tree verification.
- **Fresh audit:** State lifetime, Git commit boundaries and identity allocation. Current paths, nearby callers, trust/data flows and the preceding diff were reviewed.
- **Bug classes discovered:** F21, F22, F23; root causes and invariants are in the registers below.
- **Missing tests discovered:** failure sequences and bypass variants identified for F21, F22, F23; see regression evidence per finding.
- **Fixes implemented:** public-source fixes and applicable siblings for F21, F22, F23; cycles without new findings attacked existing fixes or investigated the external contract.
- **Tests added:** named regression suites/cases in the register; no cosmetic coverage target.
- **Verification executed:** targeted failure reproduction and relevant regression suites; final executed command/results below supersede intermediate checkpoints.
- **New issues caused by remediation:** New fixtures had a schema omission and incorrect wire assertion; corrected without relaxing invariants.
- **Remaining substantive findings:** F14/F15 required further evidence.


### Cycle 5

- **New findings:** F24, F25.
- **Previously known findings still open:** F14 remote integration guarantee; F15 advisory coverage also remained open through cycle 15. Other findings proceeded through targeted then whole-tree verification.
- **Fresh audit:** Parallel CLI configuration paths and disabled setup tests. Current paths, nearby callers, trust/data flows and the preceding diff were reviewed.
- **Bug classes discovered:** F24, F25; root causes and invariants are in the registers below.
- **Missing tests discovered:** failure sequences and bypass variants identified for F24, F25; see regression evidence per finding.
- **Fixes implemented:** public-source fixes and applicable siblings for F24, F25; cycles without new findings attacked existing fixes or investigated the external contract.
- **Tests added:** named regression suites/cases in the register; no cosmetic coverage target.
- **Verification executed:** targeted failure reproduction and relevant regression suites; final executed command/results below supersede intermediate checkpoints.
- **New issues caused by remediation:** A test-helper flag and noncanonical path expectation were corrected.
- **Remaining substantive findings:** F14/F15 required further evidence.


### Cycle 6

- **New findings:** None.
- **Previously known findings still open:** F14 remote integration guarantee; F15 advisory coverage also remained open through cycle 15. Other findings proceeded through targeted then whole-tree verification.
- **Fresh audit:** Lost-response integration and the remote retry contract. Current paths, nearby callers, trust/data flows and the preceding diff were reviewed.
- **Bug classes discovered:** F14; root causes and invariants are in the registers below.
- **Missing tests discovered:** failure sequences and bypass variants identified for F14; see regression evidence per finding.
- **Fixes implemented:** public-source fixes and applicable siblings for F14; cycles without new findings attacked existing fixes or investigated the external contract.
- **Tests added:** named regression suites/cases in the register; no cosmetic coverage target.
- **Verification executed:** targeted failure reproduction and relevant regression suites; final executed command/results below supersede intermediate checkpoints.
- **New issues caused by remediation:** None known beyond the variants consolidated into the referenced findings.
- **Remaining substantive findings:** F14/F15 required further evidence.


### Cycle 7

- **New findings:** F26.
- **Previously known findings still open:** F14 remote integration guarantee; F15 advisory coverage also remained open through cycle 15. Other findings proceeded through targeted then whole-tree verification.
- **Fresh audit:** Retry equivalence across local mutations and URL spellings. Current paths, nearby callers, trust/data flows and the preceding diff were reviewed.
- **Bug classes discovered:** F26; root causes and invariants are in the registers below.
- **Missing tests discovered:** failure sequences and bypass variants identified for F26; see regression evidence per finding.
- **Fixes implemented:** public-source fixes and applicable siblings for F26; cycles without new findings attacked existing fixes or investigated the external contract.
- **Tests added:** named regression suites/cases in the register; no cosmetic coverage target.
- **Verification executed:** targeted failure reproduction and relevant regression suites; final executed command/results below supersede intermediate checkpoints.
- **New issues caused by remediation:** None known beyond the variants consolidated into the referenced findings.
- **Remaining substantive findings:** F14/F15 required further evidence.


### Cycle 8

- **New findings:** F27.
- **Previously known findings still open:** F14 remote integration guarantee; F15 advisory coverage also remained open through cycle 15. Other findings proceeded through targeted then whole-tree verification.
- **Fresh audit:** Content preservation across local and remote write interfaces. Current paths, nearby callers, trust/data flows and the preceding diff were reviewed.
- **Bug classes discovered:** F27; root causes and invariants are in the registers below.
- **Missing tests discovered:** failure sequences and bypass variants identified for F27; see regression evidence per finding.
- **Fixes implemented:** public-source fixes and applicable siblings for F27; cycles without new findings attacked existing fixes or investigated the external contract.
- **Tests added:** named regression suites/cases in the register; no cosmetic coverage target.
- **Verification executed:** targeted failure reproduction and relevant regression suites; final executed command/results below supersede intermediate checkpoints.
- **New issues caused by remediation:** None known beyond the variants consolidated into the referenced findings.
- **Remaining substantive findings:** F14/F15 required further evidence.


### Cycle 9

- **New findings:** F28.
- **Previously known findings still open:** F14 remote integration guarantee; F15 advisory coverage also remained open through cycle 15. Other findings proceeded through targeted then whole-tree verification.
- **Fresh audit:** Authority of remote write acknowledgements and cache state. Current paths, nearby callers, trust/data flows and the preceding diff were reviewed.
- **Bug classes discovered:** F28; root causes and invariants are in the registers below.
- **Missing tests discovered:** failure sequences and bypass variants identified for F28; see regression evidence per finding.
- **Fixes implemented:** public-source fixes and applicable siblings for F28; cycles without new findings attacked existing fixes or investigated the external contract.
- **Tests added:** named regression suites/cases in the register; no cosmetic coverage target.
- **Verification executed:** targeted failure reproduction and relevant regression suites; final executed command/results below supersede intermediate checkpoints.
- **New issues caused by remediation:** None known beyond the variants consolidated into the referenced findings.
- **Remaining substantive findings:** F14/F15 required further evidence.


### Cycle 10

- **New findings:** F29.
- **Previously known findings still open:** F14 remote integration guarantee; F15 advisory coverage also remained open through cycle 15. Other findings proceeded through targeted then whole-tree verification.
- **Fresh audit:** Explicit private routing and deduplication siblings. Current paths, nearby callers, trust/data flows and the preceding diff were reviewed.
- **Bug classes discovered:** F29; root causes and invariants are in the registers below.
- **Missing tests discovered:** failure sequences and bypass variants identified for F29; see regression evidence per finding.
- **Fixes implemented:** public-source fixes and applicable siblings for F29; cycles without new findings attacked existing fixes or investigated the external contract.
- **Tests added:** named regression suites/cases in the register; no cosmetic coverage target.
- **Verification executed:** targeted failure reproduction and relevant regression suites; final executed command/results below supersede intermediate checkpoints.
- **New issues caused by remediation:** None known beyond the variants consolidated into the referenced findings.
- **Remaining substantive findings:** F14/F15 required further evidence.


### Cycle 11

- **New findings:** F30.
- **Previously known findings still open:** F14 remote integration guarantee; F15 advisory coverage also remained open through cycle 15. Other findings proceeded through targeted then whole-tree verification.
- **Fresh audit:** Adversarial model decisions, fresh state and mutation preconditions. Current paths, nearby callers, trust/data flows and the preceding diff were reviewed.
- **Bug classes discovered:** F30; root causes and invariants are in the registers below.
- **Missing tests discovered:** failure sequences and bypass variants identified for F30; see regression evidence per finding.
- **Fixes implemented:** public-source fixes and applicable siblings for F30; cycles without new findings attacked existing fixes or investigated the external contract.
- **Tests added:** named regression suites/cases in the register; no cosmetic coverage target.
- **Verification executed:** targeted failure reproduction and relevant regression suites; final executed command/results below supersede intermediate checkpoints.
- **New issues caused by remediation:** None known beyond the variants consolidated into the referenced findings.
- **Remaining substantive findings:** F14/F15 required further evidence.


### Cycle 12

- **New findings:** None.
- **Previously known findings still open:** F14 remote integration guarantee; F15 advisory coverage also remained open through cycle 15. Other findings proceeded through targeted then whole-tree verification.
- **Fresh audit:** Remaining wire-field and absent-default serialization variants. Current paths, nearby callers, trust/data flows and the preceding diff were reviewed.
- **Bug classes discovered:** F27; root causes and invariants are in the registers below.
- **Missing tests discovered:** failure sequences and bypass variants identified for F27; see regression evidence per finding.
- **Fixes implemented:** public-source fixes and applicable siblings for F27; cycles without new findings attacked existing fixes or investigated the external contract.
- **Tests added:** named regression suites/cases in the register; no cosmetic coverage target.
- **Verification executed:** targeted failure reproduction and relevant regression suites; final executed command/results below supersede intermediate checkpoints.
- **New issues caused by remediation:** None known beyond the variants consolidated into the referenced findings.
- **Remaining substantive findings:** F14/F15 required further evidence.


### Cycle 14

- **New findings:** F32.
- **Previously known findings still open:** F14 remote integration guarantee; F15 advisory coverage also remained open through cycle 15. Other findings proceeded through targeted then whole-tree verification.
- **Fresh audit:** Runtime write shapes, batch preconditions and test isolation. Current paths, nearby callers, trust/data flows and the preceding diff were reviewed.
- **Bug classes discovered:** F32; root causes and invariants are in the registers below.
- **Missing tests discovered:** failure sequences and bypass variants identified for F32; see regression evidence per finding.
- **Fixes implemented:** public-source fixes and applicable siblings for F32; cycles without new findings attacked existing fixes or investigated the external contract.
- **Tests added:** named regression suites/cases in the register; no cosmetic coverage target.
- **Verification executed:** targeted failure reproduction and relevant regression suites; final executed command/results below supersede intermediate checkpoints.
- **New issues caused by remediation:** None known beyond the variants consolidated into the referenced findings.
- **Remaining substantive findings:** F14/F15 required further evidence.


### Cycle 15

- **New findings:** F33.
- **Previously known findings still open:** F14 remote integration guarantee; F15 advisory coverage also remained open through cycle 15. Other findings proceeded through targeted then whole-tree verification.
- **Fresh audit:** Within-batch identity admission and retries. Current paths, nearby callers, trust/data flows and the preceding diff were reviewed.
- **Bug classes discovered:** F33; root causes and invariants are in the registers below.
- **Missing tests discovered:** failure sequences and bypass variants identified for F33; see regression evidence per finding.
- **Fixes implemented:** public-source fixes and applicable siblings for F33; cycles without new findings attacked existing fixes or investigated the external contract.
- **Tests added:** named regression suites/cases in the register; no cosmetic coverage target.
- **Verification executed:** targeted failure reproduction and relevant regression suites; final executed command/results below supersede intermediate checkpoints.
- **New issues caused by remediation:** None known beyond the variants consolidated into the referenced findings.
- **Remaining substantive findings:** F14/F15 required further evidence.


### Cycle 17

- **New findings:** F35, F36, F37, F38, F40, F41, F44.
- **Previously known findings still open:** F14 external server compatibility.
- **Fresh audit:** Public dependencies, adapters, telemetry, durability and process scheduling. Current paths, nearby callers, trust/data flows and the preceding diff were reviewed.
- **Bug classes discovered:** F35, F36, F37, F38, F40, F41, F44; root causes and invariants are in the registers below.
- **Missing tests discovered:** failure sequences and bypass variants identified for F35, F36, F37, F38, F40, F41, F44; see regression evidence per finding.
- **Fixes implemented:** public-source fixes and applicable siblings for F35, F36, F37, F38, F40, F41, F44; cycles without new findings attacked existing fixes or investigated the external contract.
- **Tests added:** named regression suites/cases in the register; no cosmetic coverage target.
- **Verification executed:** targeted failure reproduction and relevant regression suites; final executed command/results below supersede intermediate checkpoints.
- **New issues caused by remediation:** Process-heavy suites needed the derived serial lane; no timeout or assertion was weakened.
- **Remaining substantive findings:** F14 external compatibility. All applicable public-source checks have now passed.


### Cycle 20

- **New findings:** F53, F54.
- **Previously known findings still open:** F14 external server compatibility.
- **Fresh audit:** Public-only re-scope; import and codemod data-safety review. Current paths, nearby callers, trust/data flows and the preceding diff were reviewed.
- **Bug classes discovered:** F53, F54; root causes and invariants are in the registers below.
- **Missing tests discovered:** failure sequences and bypass variants identified for F53, F54; see regression evidence per finding.
- **Fixes implemented:** public-source fixes and applicable siblings for F53, F54; cycles without new findings attacked existing fixes or investigated the external contract.
- **Tests added:** named regression suites/cases in the register; no cosmetic coverage target.
- **Verification executed:** targeted failure reproduction and relevant regression suites; final executed command/results below supersede intermediate checkpoints.
- **New issues caused by remediation:** Initial import tests used an unsupported constructor option and cleanup method; corrected. Final adversarial review added invalid-UTF-8 preservation to F53.
- **Remaining substantive findings:** F14 external compatibility. All applicable public-source checks have now passed.


### Cycle 21

- **New findings:** F55.
- **Previously known findings still open:** F14 external server compatibility.
- **Fresh audit:** Packaged import execution, option ownership and default destination. Current paths, nearby callers, trust/data flows and the preceding diff were reviewed.
- **Bug classes discovered:** F55; root causes and invariants are in the registers below.
- **Missing tests discovered:** failure sequences and bypass variants identified for F55; see regression evidence per finding.
- **Fixes implemented:** public-source fixes and applicable siblings for F55; cycles without new findings attacked existing fixes or investigated the external contract.
- **Tests added:** named regression suites/cases in the register; no cosmetic coverage target.
- **Verification executed:** targeted failure reproduction and relevant regression suites; final executed command/results below supersede intermediate checkpoints.
- **New issues caused by remediation:** None known beyond the variants consolidated into the referenced findings.
- **Remaining substantive findings:** F14 external compatibility. All applicable public-source checks have now passed.


### Cycle 22 — complete final fresh public-only review

- **New findings:** none; zero new BLOCKER, IMPORTANT, actionable security, privacy, data-loss or correctness findings.
- **Previously known findings still open:** F14 external server idempotency contract. Client changes are verified; compatible server behavior remains an independent requirement.
- **Fresh audit:** re-read final import/learn and source-rewrite execution paths, inspect the final delta and maintenance siblings, reconsider store ownership, config/routing authority, UI/process boundaries, migration journals, remote acknowledgement/retry, PostgreSQL transactions, adapter transcripts, telemetry and dependency exposure. Explicitly challenged interruption, simultaneous import, stale editor/memory snapshots, malformed bytes, unexpected dependency responses and privileged model targets.
- **Bug classes discovered:** none new. Every substantive public-source class is closed; the external portion of F14 remains OPEN.
- **Missing tests discovered:** none new for the identified public-source invariants. The actual supported-server fault/replay qualification remains the material external test gap.
- **Fixes implemented:** none in this cycle; it reviews the final system, including F53–F55, rather than confirming only the original finding list.
- **Tests added:** none in this cycle; prior cycle regressions were exercised along with broad verification and actual packaged flows.
- **Verification executed:** 5,810 full-suite passes/37 evaluated skips; final CLI delta independently rebuilt and tested (12 import cases), type-checked and included in corrected Python and packaged smoke execution. Final input hashes show only the two expected CLI files changed after the broad suite. See exact commands/results below.
- **New issues caused by remediation:** none known. Verification-script/fixture errors are retained as failed attempts and corrected, not reclassified as passes.
- **Remaining substantive findings:** F14 only. Stop under the explicit external-verification rule, not a claim of complete integration convergence.

## 4. Complete remediation register

Each row states the original finding/root cause, invariant, root-cause fix and sibling search, regression/bypass evidence, and status. Tests exercise behavior and disposable state. Runtime-dependent guarantees are qualified explicitly.

| ID / severity | Original failure and root cause | Bug class / invariant | Fix and siblings searched/fixed | Regression and adversarial verification | Status |
| --- | --- | --- | --- | --- | --- |
| F01 BLOCKER | A transform throws before live persistence; failure recovery copies an old version backup over newer live rows. A second failure point writes migrated corpus before config version. | Recovery must preserve unrelated successful writes and reconcile interrupted multi-file commits. | Removed stale restore in both up/down. Validate config versions/mappings before mutation. Stage bytes with quarantined rows preserved; durable before/after hashes and target-version journal; retry completes config stamp, refuses changed live bytes. Backup uses atomic durable writes. Searched migration registry, config writers, rollback, serializer quarantine and lock order. | `audit-migration-preservation`: stale 1-row backup vs 2 live rows; up/down interruption; replay trap; intervening write refusal; invalid versions. Existing migrations pass. | RESOLVED |
| F02 IMPORTANT | Nonexclusive predictable temp paths can follow symlinks; bytes initially have broad modes; async replacement changes file mode; directory fsync swallowed real errors. | First byte and acknowledged replacement must preserve confidentiality and report I/O failure. | Shared semantics in sync/async atomic writers: UUID, exclusive 0600 creation, explicit/preserved mode before bytes, fsync+rename, only owned temp cleanup; unsupported directory fsync distinguished from I/O failure. Searched backup/config/store callers. | `audit-atomic-write`: mode observed at first write, destination-mode preservation, planted temp symlink, victim bytes preserved; both writers reject directory EIO but tolerate unsupported EINVAL. | RESOLVED |
| F03 BLOCKER | A stale-lock reclaimer can move a newly replaced live lock, temporarily permitting a second writer; remote-host age treated as death. | Exactly one cooperating writer enters; age is not proof of owner death. | One shared transition guard for sync/async acquisition and reclamation. Confirm local dead PID; fail closed for live/foreign owners and abandoned guard. Release checks ownership. Searched every filesystem lock implementation. | `audit-lock-recovery`, existing async contention/keys/write-concurrency tests. Guard blocks both APIs, foreign old lock retained; four independent sync/async child processes preserve all 80 increments and never overlap their critical-section sentinel. | RESOLVED |
| F04 BLOCKER | Backup validates one read but copies another; restore verifies then rereads; state loss overwrites same-day history; superseded filenames collide. | Validation, checksum, acknowledgement and retained history describe immutable exact bytes. | Capture once, validate and write same buffer; retain existing daily snapshot; unique superseded names; atomic snapshot/state/sidecar writes. Searched backup creation, planning, restore, rotation, migration backups. | `audit-backup-snapshot`: swap path between reads, lost state hint, repeated restores at one timestamp; 28 targeted backup tests passed. | RESOLVED |
| F05 IMPORTANT | Pack download/external tar execution lacks download/decompression/work bounds and archive-entry controls. | Untrusted archives cannot escape extraction or cause unbounded work. | Bounded streaming+timeout; bounded gunzip; pinned tar parser; reject links/special files, traversal, deep/oversized/excess entries before extraction; cleanup on failure. Searched URL/local preview/install paths. | `audit-pack-download`: oversized response, gzip bomb, link archive, signed URL error privacy; existing URL/pack tests. | RESOLVED |
| F06 BLOCKER | An in-flight outbox success removes a later local edit; failure resurrects canceled metadata. Simultaneous/background flush paths duplicate sends; ID mapping was best-effort and saved after deletion. | Remote responses cannot overwrite newer local state; acknowledged local cleanup must have a durable receipt. | Compare canonical original snapshots under corpus lock; serialize upload workers across instances/processes; one protocol for background/explicit sends; atomic retained receipts before removal; retry consumes matching receipt; invalid receipt file fails closed. Searched learn, learnRouted, flush, rescope, forget, supersession mapping. | `audit-outbox-stale`: success/edit, failure/cancel, simultaneous instances, restart after failed local cleanup sends once. Existing outbox, cooldown and supersession suites. | RESOLVED locally; external retry guarantee tracked separately in F14 |
| F07 IMPORTANT | Malformed UI URL throws outside async error boundary; optional desktop spawn errors are asynchronous and unhandled. | Untrusted requests/optional launch failures cannot terminate host. | Malformed targets return 400; both desktop launchers handle asynchronous spawn errors. Searched HTTP request and subprocess launch boundaries in CLI/UI. | Malformed HTTP target followed by a successful request; asynchronous ENOENT does not terminate the viewer. | RESOLVED |
| F08 IMPORTANT | Heartbeat length/type/UTF-8 validation can throw or read unboundedly. Invalid nginx `limit_except` prevents TLS config loading; request log stores caller URLs. | Public ingress parsing is total and bounded; storage failure cannot be acknowledged; declared privacy config is deployable. | Strict length/media-type/type/calendar validation, UTF-8/recursion handling, private fsynced append with 503 on I/O failure; valid Nginx method rejection, URL-free access logs on TLS/redirect/bootstrap, strip Forwarded. Searched backend, both proxy configs, deployment/unit scripts. | 13 new real HTTP/fault cases, existing validation suite; isolated Nginx TLS and HTTP `-t` passed. | RESOLVED in repository; live deployment not certified |
| F09 IMPORTANT | Provenance file name existence check races across processes; non-atomic writes; same-ms names sort wrongly; reference getter reads arbitrary JSON path. | Every distinct history snapshot survives, newest ordering is consistent, and references stay in store. | Per-engram lock+private atomic files; numerical collision order shared by dedup/list; real-path reference confinement; reject symlink directories before descending. Searched generation/export/history consumers. | `audit-provenance-safety`: 15 simultaneous versions across instances at frozen time, dedup latest, modes, outside JSON and configured symlink. Existing provenance tests. | RESOLVED |
| F10 IMPORTANT | Timeout cleanup returns when parent dies, leaving descendants that ignore TERM or retain output pipes; a later unbounded communicate can hang. | Timeout is bounded and kills the owned process group before reaping its leader. | Both Python bridges signal TERM/KILL for full group, defer reaping to avoid PID reuse, bound draining. Searched subprocess/Popen/communicate siblings. | Real parent/grandchild tests with parent alive/exited and TERM-ignoring pipe owner; 284 Python tests passed; dedicated real process-tree tests include macOS zombie-group behavior. | RESOLVED |
| F11 IMPORTANT | Hermes entrypoint registration test invoked the installed CLI with developer configuration. | Tests cannot contact configured real services or use personal stores accidentally. | Temporary PLUR_PATH and a status stub at the registration boundary; broad Python verification explicitly isolates PLUR_PATH and disables auto-discovery. | Entry-point tests pass. Initial run consulted developer configuration and made read requests before isolation; no destructive action was intentional. | RESOLVED |
| F12 IMPORTANT | Expected-failure test: explicit email attribution makes otherwise safe memory unexportable due JSON punctuation/PII scan. | Chosen exported identity is allowed while every credential-bearing sibling remains scanned. | Mask only entire <=254-character valid email in declared asserted_by for privacy scanning, after its exact bytes pass all sensitive detectors. No whole attribution exemption. Searched export/preview/install/provenance. | Former expected failure now normal test; email export+preview; token-as-email, appended credential and adjacent field checks. | RESOLVED |
| F13 IMPORTANT | Binary-ish NUL branch truncates input before detectors, hiding the over-limit signal and certifying an unseen tail. | Any unscanned region blocks installation. | Pass original NUL-normalized length to bounded detector; retain secret and truncation findings, preserve bounded injection scan. Search both text/binary/engram branches. | NUL + >1MiB benign prefix + trailing credential must block preview/install. | RESOLVED |
| F14 IMPORTANT | Remote commit followed by response loss or failed local receipt persistence duplicates retried writes. | A logical retry must retain one durable request identity; acknowledgement must follow the data/receipt commit. | Public client persists intent before POST and retains its operation key through direct fallback, queue flush and explicit move. Client fix is complete; deduplication of a committed request requires a compatible server. | Client loss-of-response/restart/receipt-failure regressions pass. Complete deduplication additionally requires server-side enforcement qualified against the supported artifact; client or contract-fixture tests cannot establish that property. | OPEN — external server compatibility; public client remediation verified |
| F15 QUESTION | Advisory coverage unavailable because the inventory-upload command was rejected. | Evaluate the public dependency inventory against a pinned advisory snapshot without an inventory upload. | Pinned public advisory snapshot; local matching of public pnpm lock entries and isolated Python dependencies. | 602 npm entries: zero matches/unknowns; 42 Python entries: two assessed optional-API matches, zero unknowns; 12 matcher self-tests. See F35 and verification. | RESOLVED |
| F16 BLOCKER | Lock session can die while later writes use another pool connection; another writer commits, then stale save deletes its rows. Protected multi-step writes also partially commit. | Ownership loss must terminate the same transaction that owns writes. | One transaction/connection for advisory lock, reads and mutations; inner operations join it; aborted COMMIT rejected; detached contexts fenced; optional work queued after commit. Searched every getPool/acquire/BEGIN/COMMIT/ROLLBACK and core background caller. | `audit-postgres-lock-loss`: dropped owned backend preserves other writer, mid-operation rollback, caught SQL error, post-commit callback ordering, detached stale write refusal. All 125 real PG tests pass. | RESOLVED |
| F17 HARDENING | Workflow actions use mutable tags; OIDC publisher downloads the current latest binary without checking bytes. | Privileged CI executes reviewed immutable code/artifacts. | Pin all external action refs to resolved full commits; pin MCP publisher v1.8.1 and verified SHA-256; CI guard rejects mutable refs. Searched all 11 workflows, permissions and PR triggers. | Public ref resolution; downloaded artifact SHA-256 matches release digest; guard rejects mutable fixture/accepts SHA+local; YAML and shell validation. Publication itself not executed. | RESOLVED |
| F18 IMPORTANT | A short/crashed history append leaves a fragment that consumes the next event; fsync errors return true; file defaults expose private event content. | History acknowledgements reflect persistence and later valid events survive partial writes. | Monthly lock, private files, handle all short writes, delimit interrupted tail, reject unsafe month, propagate I/O failure into existing false+warning contract. Searched history readers, restore loss accounting and ID allocation. | `audit-history-preservation`: Unicode in 5-byte writes after broken tail; private mode; failed fsync returns false; unsafe month contained. Existing history suites retained. | RESOLVED |
| F19 IMPORTANT | Existing corrupt/invalid config becomes defaults, potentially enabling capture or changing persistence/routing; YAML errors can include source secrets. | Unknown configuration cannot grant permission or replace explicit privacy settings. | Only a missing config permits defaults. Other read/parse/top-level failures refuse with source-free errors; public migration readers/writers use the same refusal policy. Searched config reload, backend/consent defaults, migration stamping and CLI writers. | `audit-config-fail-closed`: eight malformed/nonmapping/privacy cases including both migration entry points, unchanged file; compatibility and attribution tests, 55 total pass. | RESOLVED |
| F20 IMPORTANT | New real CLI subprocess suites bypass manually duplicated serial lists; one timed out under full-suite load despite isolated pass. | Every integration suite remains included once and uses the intended process budget. | Derive subprocess membership from its import boundary and share one list between root/package configs; share PGLite membership too. Searched direct spawn and built-cli-helper siblings. | Core process lane: 155 pass / two existing skips; full client suite: 5,795 pass / 37 evaluated skips. Internal contention, assertions, retry budgets and test timeouts unchanged. | RESOLVED |
| F21 IMPORTANT | Upload receipts and local-to-server relationships are authoritative, but their path is inside the disposable cache. Cache cleanup removes retry/relationship evidence. | Durable identity evidence outlives cache eviction. | Move to private state/outbox-id-map.json; under the flush lock validate/promote legacy cache before any send; retain legacy bytes, never fall back from corrupt/new state to stale cache. Ignore state/cache in generated Git configuration; retain the sync allowlist. Searched cache cleanup, receipts, relationship remapping and backups. | Five new cases in audit-outbox-stale: deletion/restart retains edge and private mode; corrupt legacy map; failed migration before POST; corrupt new map refuses stale fallback. | RESOLVED |
| F22 BLOCKER | Git commit includes the complete index, so files staged before sync bypass the input allowlist and can leak secrets/private backup content. | Every committed non-deletion belongs to the allowed store surface. | Check all staged additions/changes with raw NUL-delimited names before and after canonical staging; refuse without discarding caller files/index. Apply at all init/normal/merge commit paths. Searched git add/commit and shared-scope filtering. | Six sync cases: .env, backups, state, pack extras, newline and leading-space filenames; refusal preserves HEAD, bytes and staging. Five reproductions failed before fix; targeted sync suites pass. | RESOLVED |
| F23 BLOCKER | Per-process allocation cache is stale after another client creates/compacts an ID. Restart after diagnostic history loss also recycles a compacted ID, retargeting relationships/history/receipts to a new record. | A published identity is never released by corpus deletion, process restart or diagnostic-log failure. | Reserve local IDs atomically in private daily state before row publication; PostgreSQL reserves atomically in a persistent database table shared across clients; both learn and routed fallback use canonical allocation. Remove mutable cache; bound numeric sequence; readonly guard rejects the new mutation. Searched all generator/reservation callers and compaction/remote cleanup. | Stale-instance and restart reproductions failed; corruption/write-failure preservation cases; real PostgreSQL independent roots, 20 concurrent reservations and readonly refusal. PG suite: 127 pass. | RESOLVED |
| F24 IMPORTANT | Parallel configuration paths bypassed safe core persistence: init overwrote remote/unknown keys, line parsing promoted nested text into routing authority, raw scalar interpolation broke token roundtrips, direct writes risked truncation and broad permissions, Cursor merge discarded unknown keys, login parse failure defaulted to empty state. Ignore failure could leave credentials published before protection. | Configuration mutations preserve unrelated values and secrecy; only validated top-level fields authorize routing. | Canonical full-document YAML parsing and locked partial updates for both init commands; malformed routing/login state refuses without source excerpts; shared private atomic writers for login, MCP/harness JSON, settings, telemetry and checkpoint state; explicit modes tighten only. Persist final effective Git ignore rule before token publication; preserve unknown Cursor settings. Searched every CLI file writer, reader and merge boundary. | Project-config nested/block-scalar and partial-update cases; quoted token/verify roundtrip, malformed-file preservation, ignore failure and real Git negation bypass; login corruption; Cursor extra keys; both atomic writers tighten 0644 to 0600 without broadening 0400. | RESOLVED |
| F25 IMPORTANT | Four remote-setup integration cases were skipped as flaky; newline test accepted either exit status. Harness also leaked response state/timers and compared noncanonical macOS paths. | Important setup success/refusal paths execute with strict behavioral assertions in isolated environments. | Restore all four cases; use true argv arrays for control-character input; reset HTTP state; clear child timer and handle spawn failure; use canonical path expectation and isolated parent fixture. Reviewed all other skipped suites; remote update skips have active replacement coverage in remote-integration/set-pinned-remote. | Restored cases plus strict no-config/no-HTTP newline assertion; complete CLI and full-suite verification below. No new skips or increased timeouts. | RESOLVED |
| F26 IMPORTANT | Local bookkeeping and equivalent endpoint spellings changed retry identity. | Same destination and transmitted content means the same operation. | Central wire fingerprint, canonical URL comparison, durable key reuse. | Counter, nested key-order, endpoint and absent-licence variants; exact request bytes survive restart and actual response loss. | RESOLVED |
| F27 IMPORTANT | Supported context was omitted from the public wire body or swallowed by local/delegated/asynchronous deduplication. | Preserve supported supplied meaning through local persistence and serialization; refuse unsupported remote content before sending. | Canonical context comparison across public learn interfaces, source-history aggregation, complete supported wire fields, and explicit refusal of unsupported structured content. Reviewed local, routed, queued and move paths. | Context/dedup/serialization regressions, malformed/unsupported-field cases, exact retry body, no-send and source-preservation tests; local test dependency verifies the public request contract. | RESOLVED |
| F28 IMPORTANT | Submitted state populated the remote cache despite a different server response. | Validated server state controls cache visibility and routed acknowledgements. | Validate returned state/scope, replace duplicate cache IDs, invalidate incomplete replies, propagate confirmed fields. | Held/foreign/malformed/ID-only acknowledgements, duplicate cache IDs and actual built-client review-state checks. | RESOLVED |
| F29 BLOCKER | Explicitly private content took the remote branch of the routed writer. | Explicit private writes stay local and never enter the upload queue. | Route through the existing local writer when privacy is explicitly requested; related dedup checks preserve distinct privacy/context. | Before-fix network-call regression failed; after-fix checks no POST, durable local retrieval and no outbox marker. | RESOLVED |
| F30 BLOCKER | Model-assisted dedup trusted arbitrary targets and stale state, bypassed canonical validation, and discarded differing context. | Model decisions act only on offered, eligible, unchanged candidates after validation. | Shared validation/context predicate; canonical ADD routing and selected-scope mutation guards; candidate binding; fresh scope/content/version/state checks inside mutation locks. | Foreign NOOP/UPDATE/MERGE targets, changed context, concurrent locks, stale pre-lock reads, malformed input before model call, valid update; 13 regression tests. | RESOLVED |
| F32 IMPORTANT | Runtime callers could persist malformed context/replacement fields that schema readers later quarantine, and a meta batch could persist its valid prefix. | A successful local write remains readable; refusal preserves existing bytes and whole-batch preconditions. | Shared schema-derived context validation without default mutation; validate local replacements and full meta batches; explicit pin/feedback guards. Searched all learn, update, meta, pin and feedback entry points. | Runtime validation and preservation regressions across learn, replacement, meta batch, pin and feedback; full public verification. | RESOLVED |
| F33 IMPORTANT | The meta-batch duplicate set contained only pre-existing IDs; two new records with one ID were both acknowledged as saved. | The persisted corpus has one accepted record per ID, including within a batch and across concurrent retries. | Reserve accepted IDs immediately in the locked batch set. Searched import, learn, batch and allocation siblings; import already updates its set, learn allocates under ownership. | A failing original reproduction now checks first-content preservation, accurate saved/skipped counts, retry, concurrent callers and reload. | RESOLVED |
| F35 IMPORTANT | Old dependency bounds and lock entries retained vulnerable serialization and parsers. | Metadata stays data; parser bounds/destinations are preserved; supported versions include security fixes. | Updated public lockfile dependency selections and Python adapter minimums; inspected public manifests, deserialization paths, parser use and action references. | Four before/after serialization failures; adapter minimum/latest compatibility; bounded ID generation and parser regressions. Two unused optional Python APIs remain explicitly assessed, not claimed patched. | RESOLVED |
| F36 IMPORTANT | Adapters assumed string content and passed multimodal lists/reprs to recall/extraction. | Valid text reaches memory unchanged; non-text blocks do not become memory inputs. | Shared message text conversion for chat history and legacy inputs/outputs. | Three failing-before multimodal recall/learning/legacy cases; positive plain-text and runnable tests retained. | RESOLVED |
| F37 IMPORTANT | Broad catches hid failed recall and learning; malformed responses escaped validation. | Unavailable memory differs from empty memory; failed persistence is visible without leaking source details. | Shared learning/recall boundary raises exported `PlurMemoryError` with a fixed message; validates recall sections. | Six failing-before read/write/malformed-response tests; recovery and source-detail exclusion. | RESOLVED |
| F38 IMPORTANT | Transcript and derived last-input state were read/changed separately across slow work; batch updates committed valid prefixes before later failure. | Recall uses one snapshot; failed batches leave transcript unchanged; concurrent completion cannot overwrite newer human state. | Materialize/validate batches, perform fallible learning before a locked transcript commit, snapshot reads and clear under the same lock. Individual durable learn calls remain deduplicated on retry. | Two failing-before batch retry/snapshot races and a concurrent delayed-AI/new-human test; 34 adapter tests pass at minimum/latest. | RESOLVED |
| F40 IMPORTANT | A partial heartbeat append consumed the next valid record; directory creation was not covered by durable acknowledgement. | Later accepted records survive an interrupted append, and 204 follows durable bytes and directory entries. | POSIX file lock covers tail framing, append and fsync; preserve partial bytes, delimit the next record, report short writes and directory-sync failure. Searched history/provenance/collector append siblings. | Two failing-before HTTP tests; short return, exception after bytes, unterminated valid row, concurrent split writes and directory EIO cases. | RESOLVED |
| F41 IMPORTANT | Separate counter/queue operations lacked ownership, interruption receipts, stable in-flight state and retry-aware accounting. | Every recorded increment survives; each accepted immutable delivery counts once; corruption never authorizes replacement/deletion. | Shared mutation/drain locks, private canonical persistence, rollover receipts, frozen delivery prefix/identity, acknowledgement subtraction, explicit corruption refusal; collector deduplication, quality flags and UTC activity windows. Searched counter hooks, exit/rollover flushes, collectors and all metric queries. | Four-process 120-increment case; rollover interruption; malformed-state preservation; concurrent drains; upgrade/lost-response/new-arrival retry; stale acknowledgement; real built-client/collector wire test; partial-input, backlog and UTC-boundary tests. | RESOLVED |
| F44 IMPORTANT | Syncing a leaf directory did not establish durability of newly created ancestors; retries assumed existing directories were already durable. | A durable acknowledgement covers every directory entry on which the file depends, even after interrupted creation. | Shared ancestry traversal for sync/async durable writes; collector syncs ancestry on every append; canonical telemetry directory preparation. Searched atomic writers, append/history, backup, provenance, configuration, reservations and pending queue creation. Existing unsupported-filesystem limits remain explicit. | Two failing-before writer cases inject ancestor EIO on first write and retry, preserve visible bytes and verify bottom-up successful retry; collector interrupted-creation retry also failed before fix; telemetry first-directory failure preserves legacy counters and sends nothing. | RESOLVED |
| F53 IMPORTANT | Source codemod followed file symlinks, swallowed scan/read errors and truncated files in place. Partial writes could destroy source; incomplete scans could report clean. | Source rewrites preserve original bytes on pre-replacement failure; unknown input is not a clean scan. | Exclusive staged write, original mode, fsync/rename, regular-file/hard-link checks, unchanged byte/inode check and explicit nonzero failure. Six sibling maintenance scripts share the helper. | Ten file-safety tests: symlinks, hard links, unreadable file/directory, partial write, rename failure, changed source, mode/fsync ordering, retry, invalid UTF-8. Six initial regressions failed before fix. | RESOLVED |
| F54 IMPORTANT | Import first committed an incomplete row, then replaced it using an old snapshot. Interruption lost metadata; a concurrent edit could be overwritten; pre-read ID sets miscounted simultaneous imports. | Imported metadata is present in the initial acknowledged row; importing cannot replace a newer row with an earlier snapshot. | One canonical learn path with metadata initialization/validation before the first write; existing duplicates retain metadata. Creation result is captured under the write lock. Removed importer post-write replacement and stale creation-count set. | Five import preservation cases: initial bytes, concurrent edit, second-write failure/retry, malformed metadata before publication, simultaneous imports and restart. Original incomplete-row and stale-edit failures reproduced. | RESOLVED |
| F55 IMPORTANT | The import command reused the input --path as the destination store when --store was absent, overriding PLUR_PATH. Tests always supplied --store and hid the documented default failure. | Input files never select persistence destinations; explicit store overrides otherwise use normal configured defaults. | Pass only --store into createPlur destination selection; otherwise let PLUR_PATH/default resolution apply. Reviewed sibling command flag handling. | Packaged command reproduces ENOTDIR before fix; environment-selected destination, explicit override precedence, input-byte preservation and import reload regressions. | RESOLVED |

## 5. Bug-class register

Instance counts are the minimum distinct implementation sites/interfaces identified, not a count of failing inputs. The complete register describes applicable variants and sibling searches.

| Bug class | Instances found | Invariant | Remediation | Tests | Status |
| --- | ---: | --- | --- | --- | --- |
| Unsafe migration recovery (F01) | 2 | Recovery must preserve unrelated successful writes and reconcile interrupted multi-file commits. | F01: Removed stale restore in both up/down. Validate config versions/mappings before mutation. Stage bytes with quarantined rows preserved; durable before/after hashes and target-version journal; retry completes config stamp, refuses changed live bytes. Backup uses atomic durable writes. Searched migration registry, config writers, rollback, serializer quarantine and lock order. | `audit-migration-preservation`: stale 1-row backup vs 2 live rows; up/down interruption; replay trap; intervening write refusal; invalid versions. Existing migrations pass. | CLOSED |
| Unsafe atomic replacement (F02) | 2 | First byte and acknowledged replacement must preserve confidentiality and report I/O failure. | F02: Shared semantics in sync/async atomic writers: UUID, exclusive 0600 creation, explicit/preserved mode before bytes, fsync+rename, only owned temp cleanup; unsupported directory fsync distinguished from I/O failure. Searched backup/config/store callers. | `audit-atomic-write`: mode observed at first write, destination-mode preservation, planted temp symlink, victim bytes preserved; both writers reject directory EIO but tolerate unsupported EINVAL. | CLOSED |
| Lock reclamation race (F03) | 2 | Exactly one cooperating writer enters; age is not proof of owner death. | F03: One shared transition guard for sync/async acquisition and reclamation. Confirm local dead PID; fail closed for live/foreign owners and abandoned guard. Release checks ownership. Searched every filesystem lock implementation. | `audit-lock-recovery`, existing async contention/keys/write-concurrency tests. Guard blocks both APIs, foreign old lock retained; four independent sync/async child processes preserve all 80 increments and never overlap their critical-section sentinel. | CLOSED |
| Backup snapshot drift (F04) | 3 | Validation, checksum, acknowledgement and retained history describe immutable exact bytes. | F04: Capture once, validate and write same buffer; retain existing daily snapshot; unique superseded names; atomic snapshot/state/sidecar writes. Searched backup creation, planning, restore, rotation, migration backups. | `audit-backup-snapshot`: swap path between reads, lost state hint, repeated restores at one timestamp; 28 targeted backup tests passed. | CLOSED |
| Unbounded archive input (F05) | 3 | Untrusted archives cannot escape extraction or cause unbounded work. | F05: Bounded streaming+timeout; bounded gunzip; pinned tar parser; reject links/special files, traversal, deep/oversized/excess entries before extraction; cleanup on failure. Searched URL/local preview/install paths. | `audit-pack-download`: oversized response, gzip bomb, link archive, signed URL error privacy; existing URL/pack tests. | CLOSED |
| Stale outbox acknowledgements (F06) | 3 | Remote responses cannot overwrite newer local state; acknowledged local cleanup must have a durable receipt. | F06: Compare canonical original snapshots under corpus lock; serialize upload workers across instances/processes; one protocol for background/explicit sends; atomic retained receipts before removal; retry consumes matching receipt; invalid receipt file fails closed. Searched learn, learnRouted, flush, rescope, forget, supersession mapping. | `audit-outbox-stale`: success/edit, failure/cancel, simultaneous instances, restart after failed local cleanup sends once. Existing outbox, cooldown and supersession suites. | CLOSED |
| Unhandled boundary errors (F07) | 3 | Untrusted requests/optional launch failures cannot terminate host. | F07: Malformed targets return 400; both desktop launchers handle asynchronous spawn errors. Searched HTTP request and subprocess launch boundaries in CLI/UI. | Malformed HTTP target followed by a successful request; asynchronous ENOENT does not terminate the viewer. | CLOSED |
| Ingress/privacy configuration (F08) | 3 | Public ingress parsing is total and bounded; storage failure cannot be acknowledged; declared privacy config is deployable. | F08: Strict length/media-type/type/calendar validation, UTF-8/recursion handling, private fsynced append with 503 on I/O failure; valid Nginx method rejection, URL-free access logs on TLS/redirect/bootstrap, strip Forwarded. Searched backend, both proxy configs, deployment/unit scripts. | 13 new real HTTP/fault cases, existing validation suite; isolated Nginx TLS and HTTP `-t` passed. | CLOSED |
| Provenance ordering/confinement (F09) | 1 | Every distinct history snapshot survives, newest ordering is consistent, and references stay in store. | F09: Per-engram lock+private atomic files; numerical collision order shared by dedup/list; real-path reference confinement; reject symlink directories before descending. Searched generation/export/history consumers. | `audit-provenance-safety`: 15 simultaneous versions across instances at frozen time, dedup latest, modes, outside JSON and configured symlink. Existing provenance tests. | CLOSED |
| Incomplete process teardown (F10) | 2 | Timeout is bounded and kills the owned process group before reaping its leader. | F10: Both Python bridges signal TERM/KILL for full group, defer reaping to avoid PID reuse, bound draining. Searched subprocess/Popen/communicate siblings. | Real parent/grandchild tests with parent alive/exited and TERM-ignoring pipe owner; 284 Python tests passed; dedicated real process-tree tests include macOS zombie-group behavior. | CLOSED |
| Test environment escape (F11) | 1 | Tests cannot contact configured real services or use personal stores accidentally. | F11: Temporary PLUR_PATH and a status stub at the registration boundary; broad Python verification explicitly isolates PLUR_PATH and disables auto-discovery. | Entry-point tests pass. Initial run consulted developer configuration and made read requests before isolation; no destructive action was intentional. | CLOSED |
| Attribution scan false positives (F12) | 2 | Chosen exported identity is allowed while every credential-bearing sibling remains scanned. | F12: Mask only entire <=254-character valid email in declared asserted_by for privacy scanning, after its exact bytes pass all sensitive detectors. No whole attribution exemption. Searched export/preview/install/provenance. | Former expected failure now normal test; email export+preview; token-as-email, appended credential and adjacent field checks. | CLOSED |
| Unscanned-tail bypass (F13) | 1 | Any unscanned region blocks installation. | F13: Pass original NUL-normalized length to bounded detector; retain secret and truncation findings, preserve bounded injection scan. Search both text/binary/engram branches. | NUL + >1MiB benign prefix + trailing credential must block preview/install. | CLOSED |
| Ambiguous remote acknowledgement (F14) | 3 | A logical retry must retain one durable request identity; acknowledgement must follow the data/receipt commit. | F14: Public client persists intent before POST and retains its operation key through direct fallback, queue flush and explicit move. Client fix is complete; deduplication of a committed request requires a compatible server. | Client loss-of-response/restart/receipt-failure regressions pass. Complete deduplication additionally requires server-side enforcement qualified against the supported artifact; client or contract-fixture tests cannot establish that property. | OPEN — external contract; client fixed |
| Advisory coverage gap (F15) | 2 | Evaluate the public dependency inventory against a pinned advisory snapshot without an inventory upload. | F15: Pinned public advisory snapshot; local matching of public pnpm lock entries and isolated Python dependencies. | 602 npm entries: zero matches/unknowns; 42 Python entries: two assessed optional-API matches, zero unknowns; 12 matcher self-tests. See F35 and verification. | CLOSED |
| Database ownership/transaction drift (F16) | 2 | Ownership loss must terminate the same transaction that owns writes. | F16: One transaction/connection for advisory lock, reads and mutations; inner operations join it; aborted COMMIT rejected; detached contexts fenced; optional work queued after commit. Searched every getPool/acquire/BEGIN/COMMIT/ROLLBACK and core background caller. | `audit-postgres-lock-loss`: dropped owned backend preserves other writer, mid-operation rollback, caught SQL error, post-commit callback ordering, detached stale write refusal. All 125 real PG tests pass. | CLOSED |
| Mutable CI executable inputs (F17) | 7 | Privileged CI executes reviewed immutable code/artifacts. | F17: Pin all external action refs to resolved full commits; pin MCP publisher v1.8.1 and verified SHA-256; CI guard rejects mutable refs. Searched all 11 workflows, permissions and PR triggers. | Public ref resolution; downloaded artifact SHA-256 matches release digest; guard rejects mutable fixture/accepts SHA+local; YAML and shell validation. Publication itself not executed. | CLOSED |
| Partial history append (F18) | 1 | History acknowledgements reflect persistence and later valid events survive partial writes. | F18: Monthly lock, private files, handle all short writes, delimit interrupted tail, reject unsafe month, propagate I/O failure into existing false+warning contract. Searched history readers, restore loss accounting and ID allocation. | `audit-history-preservation`: Unicode in 5-byte writes after broken tail; private mode; failed fsync returns false; unsafe month contained. Existing history suites retained. | CLOSED |
| Configuration fail-open (F19) | 4 | Unknown configuration cannot grant permission or replace explicit privacy settings. | F19: Only a missing config permits defaults. Other read/parse/top-level failures refuse with source-free errors; public migration readers/writers use the same refusal policy. Searched config reload, backend/consent defaults, migration stamping and CLI writers. | `audit-config-fail-closed`: eight malformed/nonmapping/privacy cases including both migration entry points, unchanged file; compatibility and attribution tests, 55 total pass. | CLOSED |
| Test scheduling drift (F20) | 3 | Every integration suite remains included once and uses the intended process budget. | F20: Derive subprocess membership from its import boundary and share one list between root/package configs; share PGLite membership too. Searched direct spawn and built-cli-helper siblings. | Core process lane: 155 pass / two existing skips; full client suite: 5,795 pass / 37 evaluated skips. Internal contention, assertions, retry budgets and test timeouts unchanged. | CLOSED |
| Authoritative state under cache (F21) | 1 | Durable identity evidence outlives cache eviction. | F21: Move to private state/outbox-id-map.json; under the flush lock validate/promote legacy cache before any send; retain legacy bytes, never fall back from corrupt/new state to stale cache. Ignore state/cache in generated Git configuration; retain the sync allowlist. Searched cache cleanup, receipts, relationship remapping and backups. | Five new cases in audit-outbox-stale: deletion/restart retains edge and private mode; corrupt legacy map; failed migration before POST; corrupt new map refuses stale fallback. | CLOSED |
| Pre-staged commit bypass (F22) | 3 | Every committed non-deletion belongs to the allowed store surface. | F22: Check all staged additions/changes with raw NUL-delimited names before and after canonical staging; refuse without discarding caller files/index. Apply at all init/normal/merge commit paths. Searched git add/commit and shared-scope filtering. | Six sync cases: .env, backups, state, pack extras, newline and leading-space filenames; refusal preserves HEAD, bytes and staging. Five reproductions failed before fix; targeted sync suites pass. | CLOSED |
| Non-durable ID allocation (F23) | 2 | A published identity is never released by corpus deletion, process restart or diagnostic-log failure. | F23: Reserve local IDs atomically in private daily state before row publication; PostgreSQL reserves atomically in a persistent database table shared across clients; both learn and routed fallback use canonical allocation. Remove mutable cache; bound numeric sequence; readonly guard rejects the new mutation. Searched all generator/reservation callers and compaction/remote cleanup. | Stale-instance and restart reproductions failed; corruption/write-failure preservation cases; real PostgreSQL independent roots, 20 concurrent reservations and readonly refusal. PG suite: 127 pass. | CLOSED |
| Divergent configuration paths (F24) | 11 | Configuration mutations preserve unrelated values and secrecy; only validated top-level fields authorize routing. | F24: Canonical full-document YAML parsing and locked partial updates for both init commands; malformed routing/login state refuses without source excerpts; shared private atomic writers for login, MCP/harness JSON, settings, telemetry and checkpoint state; explicit modes tighten only. Persist final effective Git ignore rule before token publication; preserve unknown Cursor settings. Searched every CLI file writer, reader and merge boundary. | Project-config nested/block-scalar and partial-update cases; quoted token/verify roundtrip, malformed-file preservation, ignore failure and real Git negation bypass; login corruption; Cursor extra keys; both atomic writers tighten 0644 to 0600 without broadening 0400. | CLOSED |
| Disabled/ineffective setup tests (F25) | 5 | Important setup success/refusal paths execute with strict behavioral assertions in isolated environments. | F25: Restore all four cases; use true argv arrays for control-character input; reset HTTP state; clear child timer and handle spawn failure; use canonical path expectation and isolated parent fixture. Reviewed all other skipped suites; remote update skips have active replacement coverage in remote-integration/set-pinned-remote. | Restored cases plus strict no-config/no-HTTP newline assertion; complete CLI and full-suite verification below. No new skips or increased timeouts. | CLOSED |
| Retry identity normalization (F26) | 4 | Same destination and transmitted content means the same operation. | F26: Central wire fingerprint, canonical URL comparison, durable key reuse. | Counter, nested key-order, endpoint and absent-licence variants; exact request bytes survive restart and actual response loss. | CLOSED |
| Accepted-content loss (F27) | 5 | Preserve supported supplied meaning through local persistence and serialization; refuse unsupported remote content before sending. | F27: Canonical context comparison across public learn interfaces, source-history aggregation, complete supported wire fields, and explicit refusal of unsupported structured content. Reviewed local, routed, queued and move paths. | Context/dedup/serialization regressions, malformed/unsupported-field cases, exact retry body, no-send and source-preservation tests; local test dependency verifies the public request contract. | CLOSED |
| Optimistic remote authority (F28) | 3 | Validated server state controls cache visibility and routed acknowledgements. | F28: Validate returned state/scope, replace duplicate cache IDs, invalidate incomplete replies, propagate confirmed fields. | Held/foreign/malformed/ID-only acknowledgements, duplicate cache IDs and actual built-client review-state checks. | CLOSED |
| Private routing/dedup drift (F29) | 3 | Explicit private writes stay local and never enter the upload queue. | F29: Route through the existing local writer when privacy is explicitly requested; related dedup checks preserve distinct privacy/context. | Before-fix network-call regression failed; after-fix checks no POST, durable local retrieval and no outbox marker. | CLOSED |
| Untrusted semantic decisions (F30) | 5 | Model decisions act only on offered, eligible, unchanged candidates after validation. | F30: Shared validation/context predicate; canonical ADD routing and selected-scope mutation guards; candidate binding; fresh scope/content/version/state checks inside mutation locks. | Foreign NOOP/UPDATE/MERGE targets, changed context, concurrent locks, stale pre-lock reads, malformed input before model call, valid update; 13 regression tests. | CLOSED |
| Unchecked runtime write shapes (F32) | 9 | A successful local write remains readable; refusal preserves existing bytes and whole-batch preconditions. | F32: Shared schema-derived context validation without default mutation; validate local replacements and full meta batches; explicit pin/feedback guards. Searched all learn, update, meta, pin and feedback entry points. | Runtime validation and preservation regressions across learn, replacement, meta batch, pin and feedback; full public verification. | CLOSED |
| Within-batch identity duplication (F33) | 1 | The persisted corpus has one accepted record per ID, including within a batch and across concurrent retries. | F33: Reserve accepted IDs immediately in the locked batch set. Searched import, learn, batch and allocation siblings; import already updates its set, learn allocates under ownership. | A failing original reproduction now checks first-content preservation, accurate saved/skipped counts, retry, concurrent callers and reload. | CLOSED |
| Vulnerable dependency selection (F35) | 7 | Metadata stays data; parser bounds/destinations are preserved; supported versions include security fixes. | F35: Updated public lockfile dependency selections and Python adapter minimums; inspected public manifests, deserialization paths, parser use and action references. | Four before/after serialization failures; adapter minimum/latest compatibility; bounded ID generation and parser regressions. Two unused optional Python APIs remain explicitly assessed, not claimed patched. | CLOSED |
| Message representation drift (F36) | 2 | Valid text reaches memory unchanged; non-text blocks do not become memory inputs. | F36: Shared message text conversion for chat history and legacy inputs/outputs. | Three failing-before multimodal recall/learning/legacy cases; positive plain-text and runnable tests retained. | CLOSED |
| Hidden adapter failure (F37) | 3 | Unavailable memory differs from empty memory; failed persistence is visible without leaking source details. | F37: Shared learning/recall boundary raises exported `PlurMemoryError` with a fixed message; validates recall sections. | Six failing-before read/write/malformed-response tests; recovery and source-detail exclusion. | CLOSED |
| Partial/concurrent transcripts (F38) | 3 | Recall uses one snapshot; failed batches leave transcript unchanged; concurrent completion cannot overwrite newer human state. | F38: Materialize/validate batches, perform fallible learning before a locked transcript commit, snapshot reads and clear under the same lock. Individual durable learn calls remain deduplicated on retry. | Two failing-before batch retry/snapshot races and a concurrent delayed-AI/new-human test; 34 adapter tests pass at minimum/latest. | CLOSED |
| Interrupted collector append (F40) | 1 | Later accepted records survive an interrupted append, and 204 follows durable bytes and directory entries. | F40: POSIX file lock covers tail framing, append and fsync; preserve partial bytes, delimit the next record, report short writes and directory-sync failure. Searched history/provenance/collector append siblings. | Two failing-before HTTP tests; short return, exception after bytes, unterminated valid row, concurrent split writes and directory EIO cases. | CLOSED |
| Telemetry ownership/accounting (F41) | 6 | Every recorded increment survives; each accepted immutable delivery counts once; corruption never authorizes replacement/deletion. | F41: Shared mutation/drain locks, private canonical persistence, rollover receipts, frozen delivery prefix/identity, acknowledgement subtraction, explicit corruption refusal; collector deduplication, quality flags and UTC activity windows. Searched counter hooks, exit/rollover flushes, collectors and all metric queries. | Four-process 120-increment case; rollover interruption; malformed-state preservation; concurrent drains; upgrade/lost-response/new-arrival retry; stale acknowledgement; real built-client/collector wire test; partial-input, backlog and UTC-boundary tests. | CLOSED |
| Directory ancestry durability (F44) | 4 | A durable acknowledgement covers every directory entry on which the file depends, even after interrupted creation. | F44: Shared ancestry traversal for sync/async durable writes; collector syncs ancestry on every append; canonical telemetry directory preparation. Searched atomic writers, append/history, backup, provenance, configuration, reservations and pending queue creation. Existing unsupported-filesystem limits remain explicit. | Two failing-before writer cases inject ancestor EIO on first write and retry, preserve visible bytes and verify bottom-up successful retry; collector interrupted-creation retry also failed before fix; telemetry first-directory failure preserves legacy counters and sends nothing. | CLOSED |
| Unsafe source maintenance I/O (F53) | 7 | Source rewrites preserve original bytes on pre-replacement failure; unknown input is not a clean scan. | F53: Exclusive staged write, original mode, fsync/rename, regular-file/hard-link checks, unchanged byte/inode check and explicit nonzero failure. Six sibling maintenance scripts share the helper. | Ten file-safety tests: symlinks, hard links, unreadable file/directory, partial write, rename failure, changed source, mode/fsync ordering, retry, invalid UTF-8. Six initial regressions failed before fix. | CLOSED |
| Split import publication/stale replacement (F54) | 1 | Imported metadata is present in the initial acknowledged row; importing cannot replace a newer row with an earlier snapshot. | F54: One canonical learn path with metadata initialization/validation before the first write; existing duplicates retain metadata. Creation result is captured under the write lock. Removed importer post-write replacement and stale creation-count set. | Five import preservation cases: initial bytes, concurrent edit, second-write failure/retry, malformed metadata before publication, simultaneous imports and restart. Original incomplete-row and stale-edit failures reproduced. | CLOSED |
| Input/destination option confusion (F55) | 1 | Input files never select persistence destinations; explicit store overrides otherwise use normal configured defaults. | F55: Pass only --store into createPlur destination selection; otherwise let PLUR_PATH/default resolution apply. Reviewed sibling command flag handling. | Packaged command reproduces ENOTDIR before fix; environment-selected destination, explicit override precedence, input-byte preservation and import reload regressions. | CLOSED |

## 6. Data-loss assessment

Examined creation/update/retirement/import, backup/restore, up/down migration, serialization quarantine, receipt/cache lifetime, concurrent ID allocation, PostgreSQL ownership loss/rollback, short writes, crash points, queue replay, stale responses, telemetry rollover and source codemods. Concrete failures included stale backup overwriting newer rows, lock loss allowing stale corpus replacement, interrupted history/collector append consuming the next record, late remote responses deleting newer edits, recycled IDs retargeting relationships, split import metadata publication, and in-place source truncation.

Preservation tests inject I/O errors, kill database ownership, split appends, lose HTTP responses, interleave writers, interrupt migrations/rollover and restart clients. Fixed paths retain valid bytes/rows, durable identities and pending work or refuse rather than acknowledge uncertainty. F14 is the remaining external ambiguity: a committed remote operation may duplicate if the server does not honor the retained key. Local source data remains available for retry, but the public client cannot guarantee a remote database transaction.

## 7. Security assessment

Public protections now include bounded archive handling, fail-closed scan limits/configuration, private exclusive persistence, whole-index Git checks, confined provenance references, explicit-private routing, validated server acknowledgement authority, model-candidate/current-state checks, bounded ingress, private heartbeat logging and immutable CI action/artifact inputs. No production service or unrelated system was deliberately targeted. Live deployment and server authorization are not certified by this repository audit.

Public dependency matching uses advisory snapshot `581f5c3232c22ad1873da770735ca668d2b17f35`, archive SHA-256 `8135fe6ea6644cd96aa39396ed0d2e4cde99ffcadf9c4cda117a6f7b0467f168`. Local matching found zero affected npm versions in 602 locked entries and two Python matches in 42 entries. The Python matches concern optional image-token URL fetching ([GHSA-2g6r-c272-w58r](https://github.com/advisories/GHSA-2g6r-c272-w58r)) and legacy prompt-file loading ([GHSA-qh6h-p6c9-ff54](https://github.com/advisories/GHSA-qh6h-p6c9-ff54)). The adapter does not call these APIs; multimodal input is reduced to text. This reachability assessment is not a claim those dependency versions contain the upstream patches, and host applications using those optional APIs need their own assessment.

## 8. Missing-test assessment

Added substantive invariant coverage for interruption/recovery, concurrent ownership, data preservation, stale acknowledgements, durable receipts/IDs, malformed input, scope/privacy, model decisions, migration rollback, source rewrite failures, import atomicity, configuration merge/permissions, actual HTTP faults and process-group teardown. Restored four skipped setup scenarios and replaced a permissive negative assertion. Existing live-provider/remote-deployment gates remain skipped without credentials; their skipped status is explicit. No new skip or relaxed assertion/timeout was introduced to make verification pass.

The material remaining integration gap is proving the supported server's durable idempotency contract (F14) using response-loss, restart and concurrent-request cases against the actual distributable. A modified test dependency cannot fill that gap. OS/cloud/provider behavior not available here remains outside executed evidence.

## 9. Verification performed

Commands below were actually executed in the public repository. Sustained verification used process-scoped `caffeinate -i`. PostgreSQL tests used only the disposable local test database via `PLUR_TEST_POSTGRES_URL`; smoke used the same destination through `PLUR_SMOKE_POSTGRES_URL`. Python used an isolated `PLUR_PATH`, `PLUR_AUTO_DISCOVER=0`, package `PYTHONPATH` and `PLUR_CLI="node <repo>/packages/cli/dist/index.js"`.

| Exact command/check | Result | Evidence log |
| --- | --- | --- |
| `pnpm build` | PASS | `build-public.log` |
| `pnpm test --maxWorkers=4` | 5,810 passed, 37 skipped; 411 files passed, 5 skipped; 515.76 seconds | `full-public.log` |
| `pnpm --filter @plur-ai/cli build` | PASS after F55 | `cli-build-final.log` |
| `pnpm exec vitest run packages/cli/test/import.test.ts --maxWorkers=1` | 12 passed, including three new F55 cases | `cli-import-final.log` |
| `pnpm typecheck:tests` | PASS on final source | `test-types-final.log` |
| `pnpm --filter @plur-ai/core exec tsc --noEmit` | PASS | `core-types.log` |
| `pnpm --filter @plur-ai/migrate exec tsc --noEmit` | PASS | `migrate-types.log` |
| `pnpm --filter @plur-ai/cli exec tsc --noEmit` | PASS on final source | `cli-types-final.log` |
| `/tmp/plur-audit-python-clean/bin/python -m pytest packages/python packages/hermes packages/langchain infra/heartbeat -q --import-mode=importlib` | 312 passed, 7 warnings, 33.31 seconds | `python-public-corrected.log` |
| `bash scripts/smoke-release.sh` | 19 passed, zero failed, including packaged migration and actual PostgreSQL end-to-end flow | `smoke-public.log` |
| `python3 scripts/check-workflow-pins.py` | PASS | `workflow-pins.log` |
| `python3 spec/vectors/build.py --check` | PASS | `vectors-build.log` |
| `python3 spec/vectors/build_capsules.py --check` | PASS | `vectors-capsules.log` |
| `python3 spec/vectors/verify.py --index spec/vectors/index.json --capsules spec/vectors/capsules.json` | PASS: 26 fixtures, zero failures, 8 expected notes | `vectors-verify.log` |
| `git diff --check` | PASS | `diff-check.log` |
| Python `yaml.safe_load` over all 11 public workflow YAML files | PASS | `static.json` |
| `node --check` on six modified maintenance scripts and `packages/migrate/src/files.js` | PASS | `static.json` lists exact files |
| `node packages/migrate/dist/index.js <disposable-source> --write` | PASS: rewrite, mode preservation, retry contract; symlink invocation deliberately exits 1 and preserves target | `packaged-codemod.json` records exact argv |
| Isolated Python `inventory.py`, `node offline-match.cjs`, isolated Python `offline-pypi.py` | 602 npm entries/1,275 comparisons: zero matches/unknowns; 42 Python entries/94 comparisons: two assessed optional-API matches, zero unknowns; 12 matcher self-tests | Local matching scripts and JSON results |

The broad suite ran before the final one-line CLI destination fix and its three added cases. SHA-256 comparison of 901 non-document inputs confirms that only `packages/cli/src/commands/import.ts` and its test changed afterward. The final CLI build, 12 integration tests, type checks, Python bridge tests and packaged smoke cover that delta. No second broad pass is claimed.

Earlier real-wire evidence remains applicable to unchanged paths: built public client → fault proxy → disposable contract fixture passed exact request identity/content and authoritative review-state checks (`client-integration-security9.log`); built public telemetry → actual Python collector passed lost-response/retry/new-arrival accounting (`telemetry-wire-final2.log`). Contract fixtures do not certify supported-server compatibility. Public nginx HTTP/TLS configuration syntax was checked with isolated Nginx `-t` earlier. A 50-iteration public micro-benchmark completed (`micro-durability.log`); no model-backed dedup benchmark or controlled before/after performance claim is made.

Failure evidence is retained: six initial source-codemod regressions failed; import tests demonstrated incomplete first publication and stale replacement (an invalid test cleanup method was also corrected). A type check caught unsupported constructor options in the new fixture. One Python run failed five tests because the audit runner selected a nonexistent CLI entry point; the corrected command passed all 312 tests. The initial manual CLI probe also used the wrong filename; the corrected probe reproduced the actual ENOTDIR destination bug. No failed attempt is counted as a pass or hidden by skipping a test.

Existing 37 skips are evaluated live-provider/deployment gates and legacy remote-update cases with active replacement coverage. No new skip or relaxed timeout/assertion was introduced. The repository declares no dedicated lint command; no unexecuted linter is claimed.

Exact command arrays/exits, input hashes, source delta, scripts and logs are retained in the local audit evidence bundle. The report contains no other-repository source findings.

## 10. Residual risk and required external action

To close F14, supply a supported server artifact that commits the record and idempotency receipt together and enforces replay authorization/payload consistency. Run the public client against that exact artifact with lost-response, restart and simultaneous retry probes; prove one logical record with preserved content and truthful state. Until then the whole integration cannot receive an unqualified clean verdict.

Physical power-loss, filesystem/controller behavior, hostile same-account filesystem mutation, Windows/NFS semantics, live model providers and hosted CI matrices were not fully exercised. Source codemods require a quiet working tree: their pre-replacement change detection cannot synchronize with an arbitrary editor that ignores ownership conventions. A fsync failure after rename is reported as ambiguous rather than a successful durable acknowledgement. Dependency findings are limited by snapshot and reachability evidence. No guarantee of vulnerability freedom is made.

## Workspace and cleanup

Verification was performed on the isolated audit branch before publication for review. The eight disposable containers selected by label `plur.audit=2026-09-08-resume` were stopped after verification; no Docker volumes were removed and pre-existing containers were not targeted. Exact cleanup targets/results are in private local evidence. The audit did not merge changes or perform a production deployment.
