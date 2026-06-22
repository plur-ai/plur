# Runbook: Consolidating one engram store into another

**Status:** manual procedure (no first-class command yet — see [#378](https://github.com/plur-ai/plur/issues/378))
**Audience:** operators merging a legacy or per-project engram store into another store
**Frequency:** rare — typically a one-time event when an install's storage architecture changes

## When you need this

You have two engram stores and want to fold one into the other, for example:

- A project used to point at a dedicated store via `PLUR_PATH` (e.g. `~/.plur-myproject`) and has since moved to the global `~/.plur` store with **scope-based** separation. The old store is now orphaned but still holds engrams that were never copied over.
- You are decommissioning a store and want to preserve its still-relevant engrams in a surviving store.

This is **not** the same as:

- `plur stores add` — registers/attaches a store so it can be *read*; it does not copy contents.
- `plur migrate` — applies schema-version migrations within a store; unrelated to contents.

## Why you can't just copy the YAML

Two stores are independent. Naively concatenating one `engrams.yaml` into another will break in these ways:

| Hazard | What happens | Mitigation |
|---|---|---|
| **ID collisions** | Engram IDs are minted per-store by date sequence, so the source's `ENG-2026-0402-001` very often already exists in the destination as a *different* engram. | Re-ID every imported record to a free range before appending. |
| **Stale scope** | Source records keep their old `scope` (often `global`), polluting the destination's namespace. | Rewrite `scope` on import. |
| **Missing embeddings** | A raw YAML append is invisible to hybrid recall until the derived index re-embeds. | Run `plur sync --full` after appending. |
| **Tension recompute** | A full reindex recomputes contradiction relations across the *entire* destination store, which can resurface thousands of (mostly temporal) false positives. | Re-purge with `plur tensions purge` (or the `plur_tensions_purge` MCP tool) afterward if your store keeps tensions purged. |

ID matching is therefore **not** a safe way to decide what's already migrated — use **statement content** instead (see step 2).

## Procedure

### 0. Back up the destination

```bash
cp ~/.plur/engrams.yaml ~/.plur/engrams.backup-$(date +%Y%m%d)-premigrate.yaml
```

Keep this until you've verified the merge. It is your rollback.

### 1. Inventory the source

```bash
grep -c "^  - id:" ~/.plur-myproject/engrams.yaml      # how many records
grep "^  - id:" ~/.plur-myproject/engrams.yaml         # the IDs
```

### 2. Content-dedup check (decide what's actually un-migrated)

Compare **statements**, not IDs. A topic recurring in the destination under newer engrams does **not** mean the specific source statement was copied. A simple normalized prefix + token-overlap check is enough to flag genuine near-duplicates:

```python
import yaml, re

def norm(s):
    return re.sub(r'\s+', ' ', (s or '')).strip().lower()

src  = yaml.safe_load(open('/path/to/source/engrams.yaml'))['engrams']
dst  = yaml.safe_load(open('/path/to/dest/engrams.yaml'))['engrams']

dst_norm = [norm(e.get('statement', '')) for e in dst]
dst_blob = '\n'.join(dst_norm)

def present(stmt):
    n = norm(stmt)
    if not n:
        return True
    if n[:60] in dst_blob:                      # distinctive prefix already present
        return True
    toks = set(re.findall(r'[a-z0-9]{5,}', n))  # token-overlap fallback
    return any(toks and len(toks & set(re.findall(r'[a-z0-9]{5,}', d))) / len(toks) > 0.7
               for d in dst_norm)

missing = [e for e in src if not present(e.get('statement', ''))]
print(f"{len(missing)} of {len(src)} need migration")
```

If you want dedup handled *for* you instead of by this check, route each record through `plur learn` (step 3, Option B) — but that is lossy on metadata and impractical in bulk.

### 3. Import the un-migrated records

**Option A — bulk YAML append (faithful; preferred for many records).**
Preserves all fields (statement, domain, tags, feedback signals). Append-only, so existing destination records stay byte-for-byte intact.

```python
import yaml

src = yaml.safe_load(open('/path/to/source/engrams.yaml'))['engrams']
# ... filter to `missing` from step 2 ...

START = 101                      # a free ID range — verify it's unused in the destination first
migrated = []
for i, e in enumerate(missing, start=START):
    rec = dict(e)                                  # copy all fields
    rec['id'] = f"ENG-2026-0622-{i}"               # fresh, non-colliding
    rec['scope'] = 'project:myproject'             # corrected scope
    rec['status'] = 'active'
    src_note = rec.get('source') or ''
    rec['source'] = (src_note + ' ' if src_note else '') + f"[migrated from <source> {{date}}; orig id {e['id']}]"
    act = dict(rec.get('activation') or {})
    act['last_accessed'] = '2026-06-22'            # refresh so it isn't treated as ancient
    rec['activation'] = act
    migrated.append(rec)

block = yaml.safe_dump(migrated, sort_keys=False, allow_unicode=True, width=120)
indented = ''.join(('  ' + l if l.strip() else l) + '\n' for l in block.splitlines())
with open('/path/to/dest/engrams.yaml', 'a') as f:
    f.write(indented)
```

> Pick `START` after checking the destination has no IDs in that range for the date you use (`grep "id: ENG-2026-0622" ~/.plur/engrams.yaml`).

**Option B — per-record `plur learn` (handles embeddings + dedup natively).**
Use only for a handful of records. Lossy on original metadata (feedback signals, original dates, original IDs) and laborious at scale.

### 4. Validate the YAML and the count

```bash
python3 -c "import yaml; d=yaml.safe_load(open('/path/to/dest/engrams.yaml')); print('total:', len(d['engrams']))"
```

Confirm the total rose by exactly the number you imported.

### 5. Rebuild the index (regenerates embeddings)

```bash
plur sync --full
```

Or the `plur_sync` MCP tool with `full: true`. This drops and rebuilds the derived index from YAML (YAML itself is untouched) and is what makes the imported records searchable.

### 6. Verify recall

Query a fact that is **distinctive to the source store** and confirm it returns with a non-trivial retrieval strength:

```bash
plur recall "<a fact only the migrated store had>"
```

If it does not appear, the embeddings did not regenerate — re-run `plur sync --full`.

### 7. Re-purge tensions (if your store keeps them purged)

A full reindex recomputes contradiction relations across the whole store. For stores full of time-stamped, fast-evolving facts these are mostly temporal false positives.

```bash
plur tensions purge
```

Skip this if you actively use tension detection.

### 8. Retire the source store

Archive rather than hard-delete until you're satisfied:

```bash
mv ~/.plur-myproject ~/.plur-myproject.MIGRATED-$(date +%Y%m%d).bak
```

Drop a short README inside the archive noting the destination IDs and the destination's pre-migration backup path, so the trail is self-explanatory later.

## Rollback

If anything looks wrong before you've relied on the merge:

```bash
cp ~/.plur/engrams.backup-<date>-premigrate.yaml ~/.plur/engrams.yaml
plur sync --full
plur tensions purge   # if applicable
```

## Future work

A first-class `plur stores merge <src> <dst> --scope <s> --dedup` would collapse steps 2–7 into one command — reusing the existing similarity-dedup, minting non-colliding IDs, rewriting scope, and triggering the reindex. Tracked in [#378](https://github.com/plur-ai/plur/issues/378). Because store consolidation is roughly a once-per-architecture-change event, the command is lower priority than this runbook.
