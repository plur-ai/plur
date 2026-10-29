# Memory you can prove — explainer storyboard

The script for the 0.23 explainer video. Every scene is a promise the release
makes, and every promise is checked end to end, against the real provenance
gateway, by `scripts/smoke-provenance.ts` (scene numbers match). If a scene's
check fails, the scene does not go in the video.

Run it: `pnpm -r build && npx tsx scripts/smoke-provenance.ts`
(`PLUR_SMOKE_GATEWAY` to point at another gateway, `PLUR_SMOKE_STAMP` to use a
bought postage stamp).

| # | Scene | What the viewer sees | What it promises | Checked by |
|---|-------|----------------------|------------------|------------|
| 1 | An agent works with its memory | A session starts with memories given to the agent; it looks something up; it saves a new memory with its reason | PLUR records which memories were in play, by session | session id, recall, saved id |
| 2 | The session ends; its list is stored on Swarm | `plur_session_end` returns a Swarm reference, the notary's signature, and how long the proof stays stored | The list is stored on a public, write-once network, signed with a timestamp — fingerprints only, never the text | reference returned, notary present, stored bytes name every id and contain no memory text |
| 3 | Anyone with the reference can check it | On another machine with the same memories: `plur verify --manifest <ref>` → OK | Given / looked up / saved, each memory still matches; the notary signature checks out locally | exit 0, signature valid, roles injected / recalled / written, all MATCH |
| 4 | What happened with one memory | `plur provenance <id>` | Where a memory came from: the session that saved it, and its history since | output names the session |
| 5 | A quiet edit is caught | Someone changes only the reason behind one memory; verify again | The check names exactly the memory that changed | exit 1, one CHANGED, the edited one |
| 6 | Rewriting history is caught | Someone edits PLUR's history file; `plur verify` | History is a hash chain; an edit is found and located | exit 1 with the break named |
| 7 | Off by default | Storage left off; a session ends | Nothing leaves the machine unless you turn it on | no upload, no receipt |
| 8 | A stranger cannot vouch | A machine without the memories checks the reference | Checking needs the memories; the reference alone proves only that it was signed | exit 2, never OK |

## What the video must not say

- That a list proves the memories **caused** what the agent did. It proves they
  were in the agent's context.
- That a free-tier upload is permanent. It lasts about a day; proofs meant to
  stay checkable use a bought stamp (`receipts.stamp_id`).
- That PLUR stores anything on Swarm itself. PLUR sends the list to the
  provenance gateway over HTTPS; the gateway stores it on Swarm and signs it.
  The gateway address is a setting; PLUR's default is
  `provenance-gateway.datafund.io`.
