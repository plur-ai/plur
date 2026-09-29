# Pack registry is keyed by manifest name, pack directories by source basename

Found by the formal verification run of 2026-09-23 (`spec/formal/findings/persistence.md`, candidate 11; theorem `Packs.registry_shared_row`).

Install writes `registry[manifest.name]`; the pack lives at `packs/<basename>`; uninstall removes the row by both the directory name and the manifest name (packs.ts ~1503–1504). Replayed:

- two directories whose manifests share a name share one registry row, so an untouched pack reports `modified`;
- uninstalling one pack leaves another `unverified` — the loss of baseline the registry lock (packs.ts:215-220) exists to prevent.

**Owner decision (2026-09-26):** separate change; it alters the registry's persisted format.

Options: (a) key by directory via an additive `dir` field with a legacy fallback to `name`; (b) key by manifest name and refuse a second install under the same name; (c) key by directory and warn on a duplicate manifest name.
