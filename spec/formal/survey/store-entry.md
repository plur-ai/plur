# Survey: server store entries — expand at load, collapse on writeback, key rotation (#1631)

Slice: `packages/core/src/store-expand.ts`, `packages/core/src/sensitivity-writeback.ts`,
`packages/core/src/config.ts` (loadConfig, storeEntryForDisk; read-only here),
`packages/core/src/index.ts` (persistStores 12768–12862, mergeStoresForWriteback 12880–12947,
addStore rotation 13035–13069, persistScopeMetadata 14349–14408). Surveyed 2026-10-18 on
branch formal/epic-1797 (5a0dedc3). Leads, not findings.

1. **Load never falls back to defaults because of a server entry's metadata (S)** —
   store-expand.ts:97 `legacy = metadataOnly(entry)` copies the passthrough (unvalidated) top
   level into the compat scope's expanded entry; config.ts:53–55 pushes expanded entries
   without the per-entry `StoreEntrySchema.safeParse` the comment at config.ts:37–38 implies.
   `description` has no `.catch` (schemas/config.ts:41), so `description:` left empty (YAML
   null) or a number fails `PlurConfigSchema.parse` (config.ts:72) → whole config = defaults.
   Claim config.ts:20–23 "loses at most the malformed entries, never the whole file".
   Risk: every store hidden; the next addStore writes stores = [new] and drops per-scope
   entries from disk (index.ts:12838–12852). Tests: none for a malformed top level.
2. **Round trip (M)** — expandServerEntry 70–119, collapseExpandedStores 165–232. Claim 149–150
   "every other field … is left byte-identical". Structure: per scope s, typed = settings[s] ⊕
   legacy (compat only), identity fields last; collapse writes each defined meta key to
   top level (compat, already there, not in settings) or scope_settings[s]. Tests:
   server-entry-writeback-identity.test.ts, multi-scope-store-entry.test.ts.
3. **Legacy metadata + precedence (S)** — store-expand.ts:92–97 and 210–211. Claim 95–96
   "An explicit scope_settings[scope] value takes precedence". Tests:
   server-entry-legacy-metadata.test.ts.
4. **Stable identity under concurrent insert/reorder (S)** — serverEntryIdentities 44–53, used
   at config.ts:42 and index.ts:12812–12814, 12839–12848. Claim 40–42 "an inserted entry never
   matches". Suspicion: identity = base + occurrence index; token excluded (34), so an entry
   with the same url/scopes/pinned/readonly/token_env inserted *before* ours takes `#0`.
5. **Rotation touches one entry; ambiguity refused (S)** — index.ts:13048–13061 (pre-lock
   listing check), 12804–12820 (under-lock base match, throw before atomicWrite). Claim
   12784–12787 "No match, or more than one, is refused and nothing is written".
6. **Sensitivity writeback (S)** — sensitivity-writeback.ts:19–34; claims 12–17. Tests:
   server-entry-writeback-identity.test.ts 143–185, scope-metadata-trust.test.ts.
7. **scope_settings cannot set identity/credentials (S)** — store-expand.ts:88–110, reserved
   set 130–133. Claim 88–90 "can never redirect a scope or swap its token".
8. **persistStores lock vs. lost update (S, outside the candidate list)** — the stores list is
   computed outside the lock (addStore 13001 loadConfig; persistScopeMetadata 14352), and
   persistStores writes exactly that list for per-scope entries (12838–12852). Claim
   12776–12781 says the lock prevents last-writer-wins between e.g. session_start metadata
   sync and `plur stores add`. Server entries written since load are kept (12850–12852);
   per-scope ones are not.
