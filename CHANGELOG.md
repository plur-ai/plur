# Changelog

## Unreleased

### Cursor hooks decide for the workspace, not the folder the hook runs in; the folder question is once per session and folder (#1582)

Found by the 0.21.1 Codex/Cursor pre-release check (findings G1 and G2).

- Cursor tells every hook which workspace is open (`workspace_roots`); only the tool hooks also send the tool's folder (`cwd`). PLUR's Cursor hooks used the folder the hook process ran in. With the hooks loaded from a plugin, that was the plugin's folder: PLUR asked about the plugin folder, recorded the user's answer for it, and wrote `.cursor/rules/plur-context.mdc` there, while the workspace stayed undecided. A workspace the user had turned off could also get another folder's "on".
- Every Cursor hook now decides for the workspace, and they all reach the same decision for it: session start, the tool guard, the post-tool reminder, the stop nudge and the end-of-turn rating and capture. It is the MCP server's rule. If any root is off, memory is off. A root that is a link counts as off when either the link or the folder it points at is off. A root that is not there (an unmounted disk) counts as off when its entry is off, and so does an off `cwd`. A hook's `cwd` only picks which root its output belongs to. If a root is undecided, even one that is not there, the question is about the first such root in order, and memory stays off until it is answered; a missing folder is never created to show it. The home folder, a folder above it and a filesystem root are never asked about: a workspace that is only such a folder, undecided, gets memory on this machine, without a scope and without a question, as over MCP. A scope applies only when every root is on with that same scope, so end-of-turn capture with roots that disagree stays on this machine. A turn queued for capture carries that decision in a queue file that a capture worker of an older version does not read, so a worker still running across an upgrade cannot widen it. Rule files are written in the workspace.
- When Cursor's workspace roots are there but cannot be read (not a list, an empty list, a relative path, or an address that is not a local folder), memory stays off for that hook: no question and nothing loaded. The hook's own folder is used only when the payload names no roots and no `cwd`. `file://` roots are read as the folders they name. On Windows, `c:\…`, `c:/…`, `/c:/…` and `file:///c:/…` are all read as the same drive path (not yet checked against a real Cursor payload on Windows).
- `plur init --cursor` writes the hooks into `.cursor/hooks.json` of the folder it runs in. The folder the hook process runs in no longer matters, because the decision comes from the payload.
- The "asked once per session" record is now kept per session and folder. A second PLUR hook asking about a different folder in the same session is no longer silenced. A session already asked before this upgrade is not asked again. A resumed session is asked again about every folder, as before.

### A push claim that cannot be recorded no longer lets two processes push one engram (#1580)

Found by the 0.21.1 Windows pre-release check (finding B1).

- Before an engram queued for a team store is pushed, the process that pushes it records a claim, so only one process pushes it. To take over a claim left by a process that died, PLUR renames a new claim file over the old one. On Windows that rename can fail while another process has the file open. PLUR then pushed anyway without a recorded claim, so a second process could push the same engram too, and the team store could end up with it twice.
- Now, when a claim cannot be recorded for any reason, the engram is not pushed this time. It stays queued with its idempotency key and is tried again on a later flush. If the takeover fails, or the temporary file is only partly written (a full disk), its temporary file is removed.
- Once a claim is on disk it counts, even if tidying up afterwards fails (removing a temporary file or a takeover marker, which Windows can refuse while another process has the file open). Before, such a claim could be reported as not taken and then block the engram for up to 15 minutes.
- You can see why an engram is held. `plur outbox` shows "held: its push claim could not be recorded on this machine (…)" and what to check, and so do `plur status` and the session hooks. `plur outbox --flush` says the claim could not be recorded, rather than "another writer is pushing it". With writes queued, `plur doctor` checks that the claims folder (`cache/outbox-claims` in the PLUR store) can be written, and fails when it cannot.
- On a drive without hard links (FAT, exFAT, some network shares), a claim is created and then written in two steps. A second process could read it in between and take it for an abandoned claim. An empty or half-written claim younger than a minute now counts as taken.
- One trade-off: a cache folder that cannot be written now holds queued engrams back until it can be, where before they were pushed without a claim. Doctor and `plur outbox` say so.

### A team save no longer tells the agent to save it again; unscoped CLI recall and inject search the folder's team store (#1578)

Found by the third 0.21.1 pre-release check (findings L9 and L10).

- An unscoped `plur_learn` in a folder mapped to a team scope goes to that team's store, or is queued for it. Its reply still said "Stored at … because no scope was passed … re-learn it with an explicit scope so it reaches the shared store". The engram was already there, and an agent that followed the advice saved it twice. The hint (`scope_hint`) now appears only when the engram stayed on this machine, at a scope no team store holds, while team stores are configured. `plur_learn_batch` and `plur learn` never gave this hint and still do not.
- An unscoped `plur recall` or `plur inject` run in a folder mapped `plur: on` with a scope now searches that scope's store, as `plur_recall`, `plur_recall_hybrid` and `plur_inject_hybrid` do over MCP (#1566). The CLI uses the same rule as the MCP server, with one input: the folder it runs in. An explicit `--scope` still wins. The home folder and a folder with no scope behave as before. `plur inject --fast` never contacts a store, as before.
- `plur recall` and `plur inject` no longer contact any remote store (team or personal), not even one set to `dial: always`, from a folder mapped `plur: off` (even with `--scope`, as over MCP) or from a folder you have not decided about yet (unless you pass `--scope`). They still show the memory on this machine.
- With a broken `folders.yaml`, `plur recall` and `plur inject` said "PLUR memory is paused in every folder until the map is fixed" and then showed memory anyway. They now say that no team memory is used until the map is fixed and that only the memory on this machine was read, name the `plur folders repair` command, and contact no remote store.
- The editor hooks are unchanged here. Cursor's hooks use this same rule since #1582; the other editors' hooks take the folder's scope from the folder map, from their own check of the folder the editor sends.

### Each team store gets its own id prefix, so an engram id names one store (#1575)

Found by the 0.21.1 pre-release check (audit of #1570, finding H1). Older than 0.21.1; not caused by #1570.

- A store's engram ids are shown as `ENG-<PREFIX>-…`. The prefix was three letters from the scope, so every team store of one org had the same one (`group:plur/eng` and `group:plur/ops` were both `GPL`). Two servers numbering engrams on the same day then gave two different engrams one id: recall for one team could show the other team's engram, and forgetting one team's engram by its id retired the other team's, reporting success.
- The prefix is now the same three letters plus eight letters derived from the whole scope (`group:plur/eng` is now `GPLTBNXSCAW`). Save, recall and inject all give the new form. Different scopes get different prefixes; in the rare case two configured scopes still share one, PLUR says so when it loads its config, and refuses to forget, rate, pin or update by an id with that prefix (pass the store's scope instead).
- Forget, feedback, pin, update and promote by a namespaced id act only on the store that id names. A row in a readonly store is refused; it is no longer reached through a writable store of the same server, by its namespaced id or by its bare server id. A store that answers "I have it" and then fails to hand the row over counts as unreachable, so the action is refused rather than sent elsewhere.
- Ids in the old three-letter form (`ENG-GPL-2026-10-03-001`) still work where a store holds exactly one engram with that id. Only dated ids count: a pack engram such as `ENG-PFR-001` is never mistaken for one. Where they name engrams in two stores, the action is refused and nothing changes; the message gives each engram's new id. One scope configured on two stores (two servers, or a file store and a server store) is resolved the same way.
- Engram history, tensions and injection records written under the old form still match the engram under its new id. The local search index rebuilds itself once to pick up the new ids.
- Checked against the enterprise server's code and data: one server never gives two scopes the same id, so the duplicate ids need two servers. Acting through the wrong store entry could happen on one server.

### `plur doctor` fails when a team store's token variable is unset (#1572)

A team store added with `--token-env` takes its token from an environment variable. When that variable was unset or empty, `plur doctor` still said "Healthy", reported `overall: ok` and exited 0, and the only sign was one line on stderr. Saves to that store waited in the outbox and recalls skipped it. The MCP `plur_doctor` already said not ok for the same setup.

- `plur doctor` now reports such a store as a failed check, sets `overall: fail` and exits non-zero, as `plur_doctor` does. Both doctors give the same detail ("NO TOKEN — …") and the same fix.
- The fix says to set the variable where PLUR runs, then restart the editor or its MCP server so it picks the variable up (a running server keeps the environment it started with), and that queued engrams flush on the next session start or with `plur outbox --flush`.
- `plur doctor --json` lists the stores as `tokenEnvUnset` (scope, url, variable, detail, fix). No token is ever printed.
- The variable counts as set when it is in this shell or in the `env` of a PLUR MCP entry an editor launches the server with (Claude Code's `~/.claude.json` or project/local scope, Cursor, Codex and the others), since that is the environment the server runs in. `plur doctor` says where it found it (`tokenEnvFound` in `--json`), and notes when it is not in this shell, so `plur` commands run there queue that store's saves.
- The closing list of fixes repeats the token fix.

### `plur folders repair` works on a map with a team-scoped folder (#1567)

Found by the second 0.21.1 pre-release check. A broken `folders.yaml` that held one folder answered "Yes, with the team scope" could not be repaired, even for a one-character slip somewhere else in the file. The repair blamed that folder's line, which had no problem.

- The answer "Yes, with the team scope" and `plur folders set <folder> --scope <s>` now write `plur: on` next to the scope. The folder resolves exactly as before. Because its own lines now say `on`, a repair of the file may keep it on.
- A folder that an earlier version wrote with `scope:` (or `trusted: true`) and no `plur:` line is repaired too, when the repair leaves that folder's own lines exactly as written. The repair then writes `plur: on` beside them, so the folder is on, with the same scope, exactly as it was before the map broke. If a slip is on one of that folder's own lines, the repair still refuses and names the line to fix by hand. A repair still never switches memory on for any other folder.
- A folder with a scope (or `trusted:`) and its own `plur: on`, `off` or `ask` line never stopped a repair, and still does not. This is now tested, and the repair's fuzz test also runs over team-style maps.
- When the map cannot be repaired automatically, the warning on stderr says to fix the named line by hand, and that `plur folders repair` re-checks the file. It used to say to run `plur folders repair` to repair it.

### A folder's team scope reaches unscoped recalls over MCP without plur_session_start (#1566)

Found by the second 0.21.1 pre-release check. It is the read-side twin of the save fix below (#1562). In a folder mapped to a team scope (or answered "yes" with one), an unscoped save reached the team store without `plur_session_start`, but an unscoped recall searched only this machine. An agent could not find what it had just saved to the team unless it passed `scope` or started a session first.

- `plur_recall` (hybrid and keyword), `plur_recall_hybrid` and `plur_inject_hybrid` with no scope now search the workspace folder's team store whenever the session has no default of its own, exactly as a session started there would. They use the same rule as unscoped saves: only when every workspace folder gives the same scope. With folders that disagree, or a folder with no scope, nothing changes: no team store is dialed by default.
- An explicit scope still wins, and so does a session's own default. `off` and undecided folders are unchanged. (`plur_inject`, the keyword-only injection, never dials a team store.)
- An injection made with no session is still recorded with no session id.

### A team engram keeps the id its save returned, in recall too (#1568)

Found by the 0.21.1 pre-release check (finding F3, and low L1).

- Saving into a team store returns the engram's namespaced id, `ENG-<PREFIX>-YYYY-MM-DD-NNN`. `plur_recall`, `plur_recall_hybrid` and `plur recall` (json and text) returned the same engram under its bare server id, `ENG-YYYY-MM-DD-NNN`, so one engram had two ids. They now return the id the save returned, as `plur_inject` already did.
- The bare id was also the id of any local engram minted the same day, so acting on a recalled id could need a `scope` to say which one was meant. `plur forget`, `plur_forget`, `plur_feedback` and `plur_pin` take the recalled id and act on the team engram only. A bare id still works where it names one engram, and is still refused, changing nothing, where it names two.
- This reverses the id form of #1119, which showed the bare id because, at the time, forget refused the namespaced one. Forget, feedback and pin route a namespaced id to its store, so that reason is gone.
- The near-duplicate report of a team save no longer lists the engram just saved (similarity 1.0). With a local engram of the same bare id, it no longer leaves that engram out instead.

### A folder's team scope reaches unscoped saves over MCP without plur_session_start (#1562)

Found by the 0.21.1 pre-release check. The promise above (after a yes with a team scope, or in a folder mapped to a scope, an unscoped save goes to that scope) held over MCP only after `plur_session_start`. Without it, `plur_learn` with no scope was saved in `global` on this machine and never reached the team store.

- `plur_learn` and `plur_learn_batch` with no scope now use the workspace folder's scope (the folder map's, the one the yes answer recorded, else a trusted `.plur.yaml`'s) whenever the session has no default of its own. An explicit scope still wins, and so does a session's own default. `off` and undecided folders are unchanged.
- One rule decides the default scope of an unscoped save over MCP, for `plur_learn`, `plur_learn_batch`, `plur_episode_to_engram`, the learns of `plur_session_end`, `plur_session_start`'s default and `plur_session_scope clear`. (`plur_ingest` with no scope saves to `global`, as before.) The server no longer sets or reads a process-wide default scope, which used to outlive the session that set it. The inputs are every workspace folder (root) the editor sends, none left out, or the server's start folder when it sends none. Each is resolved through its real path (a link counts as the folder it points at) to its folder-map scope, else a trusted `.plur.yaml`'s for that folder. Only when every input gives the same scope is it used. Otherwise no scope is used and nothing falls back after that: not the start folder's `.plur.yaml`, and not a session slot. That covers one folder with no scope, two different teams, the home folder, a folder above it or `/`, and anything that cannot be resolved.
- The scope is resolved when the save is made, from the current roots. A default that `plur_session_start` gave is used only while the workspace is the one the session started in: the same roots, and the same answer from the rule above. After the roots change, or the folder map or a `.plur.yaml` changes that answer, saves follow the rule above until the workspace is as it was. A scope set with `plur_session_scope set` stays (the user's explicit choice), and an explicit scope on the call still wins. A `session_id` this server never started has no default.
- With several sessions open and none named, no session default applies (E7). The rule above then decides, so such a save goes to the workspace's scope when there is one.
- The broken-map warning on stderr said "treating it as empty (folders fall back to ask)". It now says that PLUR memory is paused in every folder until the map is fixed, and names `plur folders repair`.
- `plur folders set`, `plur folders rm` (every answer to the folder question) and `plur untrust` keep the comments, blank lines and untouched entries of `folders.yaml`, editing only the entry's own lines, as `plur folders repair` does. When the file cannot be edited that way safely, the whole map is written as before.
- For a repo whose `.plur.yaml` is not trusted, "Yes, without its settings" is now always `--on`. It used to carry the one other configured team scope, which the label did not say. Configured team scopes are listed below the answers instead, without the "use one with --scope" hint, which no answer's code would accept.
- In opencode, the PLUR MCP server shows the folder question the plugin already asked, with the same codes, instead of a second set. It adds a "not now" bound to the plugin's chat session, so it works in opencode's shell; after "not now" it stops asking for the rest of the session. It finds the plugin among its own parent processes by process id and start time, so a reused process id never matches. When it cannot tell (another host, Windows), it asks its own question, as before. Two chats in one opencode process share one MCP server: it shows the newest chat's codes, and an answer from the other chat's shell is refused and changes nothing.

### Team-store rows without tags or activation no longer break session start, inject and recall

A row a team store returned without `tags` made `plur_session_start`, `plur_inject` and `plur_inject_hybrid` fail with "engram.tags is not iterable" for everyone using that scope; one without `activation` made hybrid recall fail. Such rows now load with `tags: []` and a fresh activation record, as a local engram gets.

### `plur init` registers the MCP server where Claude Code reads it; `--token-env` stores only the variable name (#1561)

**Claude Code got PLUR's hooks but none of its tools.** `plur init` wrote the
MCP server into `~/.claude/settings.json`, and Claude Code does not read MCP
servers from that file. On a fresh machine `claude mcp list` showed no server,
while `plur doctor` said it was registered. This was also the case in 0.21.0.

- `plur init` now registers the server in `~/.claude.json`, at user scope. This
  is the file `claude mcp add --scope user` writes. It does not need the
  `claude` CLI, and it keeps everything else in that file.
- An entry an earlier init left in `~/.claude/settings.json` is moved over,
  with its env and any extra keys. If `~/.claude.json` already has a plur
  entry, that entry is kept and the old one is only removed. Both files are
  backed up before they change. Other servers and settings stay as they are.
  A second run writes nothing. An unreadable `~/.claude.json` is left alone,
  and init says so.
- `plur init --project` now also registers the server at user scope in
  `~/.claude.json`, so PLUR's tools appear in every project, not only this
  one. Its repo entry stays as the folder's PLUR marker. (Before, the server
  went only into the repo's settings.json, where Claude Code never read it.)
- `plur init` exits non-zero when the MCP server could not be registered, and
  says why: an unreadable or non-object `~/.claude.json`, an `mcpServers`
  that is not an object, a symlink to a missing file, or Claude Code writing
  `~/.claude.json` at that moment. If the file changes while init is writing,
  the edit is re-applied once to the new content; if it changes again, init
  stops and asks you to run it again. This narrows the window in which an
  update by Claude Code could be lost; it cannot close it, because Claude Code
  takes no lock PLUR could share. A byte-order mark is accepted. At most the last three PLUR backups
  of `~/.claude.json` are kept, each readable only by you.
- `plur-mcp init` follows the same rules. It used to write `<cwd>/.mcp.json`,
  or `~/.claude/mcp.json` when that file existed, and Claude Code never reads
  `~/.claude/mcp.json`. An old entry there is moved to `~/.claude.json`.
- `plur doctor` now checks where Claude Code actually looks, in Claude Code's
  own order: the local scope of this folder's git repository in
  `~/.claude.json`, then a `.mcp.json` in this folder or a parent folder, then
  user scope. It works from any subfolder of the repository. An entry in
  settings.json no longer counts. Doctor fails when Claude Code's
  hooks are installed but the server is not there, and names the fix.
- Cursor, Codex, Antigravity and Claude Desktop were checked the same way.
  Each already reads the server where init registers it.

**`plur stores add --token-env VAR` and `plur remote --token-env VAR` wrote the
token itself into `config.yaml`.** They now write `token_env: VAR`. The token
is read from the variable when the config loads, so the variable must be set
wherever PLUR runs. No later rewrite of the stores list writes the value back.
That includes scopes registered from the same server, which now carry the
same reference. When the variable is unset, PLUR sends nothing to that store
(no request without a token): a team save is kept locally and queued, and
`plur learn`, `plur_learn`, `plur remote`, `plur login --status` and
`plur_doctor` name the variable to set. Running `--token-env` against a store saved with a literal
token replaces the literal with the reference.

### CLI tests never touch the real home or PLUR store (tests only)

Every CLI, mcp and dsh test file now runs with a temp HOME, USERPROFILE and XDG_CONFIG_HOME and no inherited PLUR_PATH. The run checks whether the real `~/.plur` changed while it ran: in CI (`CI=true`) a change fails the run, locally it is reported as a warning (`PLUR_TEST_HOME_GUARD=fail|warn|off` overrides). In CI this check found mcp and dsh tests writing `server.pid`, `packs/` and `.tensions-purged` into the real home.

### Instruction upgrades respect lists, links, edits and look-alike learnings

These follow up #1520 from its third audit.

- **Markdown structure.** A code block inside a list item now ends where the
  item ends, as in CommonMark, so appending the PLUR section no longer opens a
  new code block or adds an empty one to your next list item; the same goes for
  an HTML comment in a list item and a fence on the item's own line. Raw HTML
  blocks such as `<pre>` are read as HTML. When PLUR cannot tell whether a block
  at the end of the file is still open (a tab-indented fence, for instance), it
  leaves the file alone and says so.
- **The file itself.** A file that shares its contents with another name (a
  hard link) is not rewritten: init says so and how to proceed, because
  rewriting it in place could empty every name on a full disk. A symlink to a
  missing file, a file that is not UTF-8, and a file that appeared after PLUR
  looked are also left as they are, with the reason. The new text is flushed to
  disk before it replaces the old. Backups are created exclusively, so two
  installers never share one. Owner and group are kept where the process may
  set them.
- **Your edits.** If the file changes between PLUR reading it and writing it,
  for instance because you saved it meanwhile, PLUR writes nothing and asks you
  to run again.
- **Learnings.** The memory line is matched on its whole shape, the same way in
  core and Hermes. "Memory: recalled 3 times faster…" is still saved as a
  learning, and "Memory — none recalled" is not.

### A team save is never lost while the server hangs, and a slow save is not reported as failed (#1531)

**Release blocker for 0.21.1.** `plur learn` raced the whole save against a
5-second timer and exited as soon as the timer won. Two things went wrong:

- **A team save could be lost.** With a team server that accepted the
  connection and never answered, the process exited before core's own
  fallback (save locally, queue in the outbox) could run. The engram was
  written nowhere: not on the server, not locally, not in the outbox.
- **A successful local save was reported as failed.** The timer covered local
  work too. A save into a large store (about 13,000 engrams, about 6 seconds
  of local work, no network) was reported as "remote store slow/unreachable",
  exited 1, and left `engrams.yaml.lock` behind.

Now only the request to the server has a deadline. It lives in core
(`learnRouted(statement, context, { remoteTimeoutMs })`; the CLI uses 5 s).
When it passes, the engram is saved on this machine and queued in the outbox.
The CLI waits for the save however long the local write takes, and exits 1
only when nothing was stored.

**Learn says where the save landed, and why when it was queued.**
`--json` always carries `delivery: "local" | "remote" | "outbox"`. When
queued, it adds `delivery_reason` and `delivery_reason_code`:

- `auth_rejected` (401/403): the token is expired, revoked or lacks access.
  The reason points to `plur login --status`, then `plur outbox --flush`.
- `unreachable`: no answer in time, or a network error.
- `server_error` or `no_store`.

Text output prints `Saved:` or `Queued in the outbox:` with the reason. The
queued line is never hidden by `--quiet`. The MCP `plur_learn` result
carries the same fields.

**Every routed save has a bounded server deadline.** `plur_learn` (MCP),
`plur_learn_batch`, and the Claw and opencode plugins now take the outbox after
10 seconds instead of waiting 30. Hook auto-capture gets 4 seconds for all the
statements of one hook run together (every turn it drains), so every save is queued before the hook's
9-second watchdog can exit. Before, that
watchdog could exit while the request was in flight, and the captured
statement was lost. A request that lands after its deadline is sent again
with the same idempotency key, so a server that honours the key (the team
server does) stores it once. A server that ignores the key and answers after
10 seconds can store it twice; under the old 30-second wait that only happened
past 30 seconds.

**`plur forget` is not blocked by an expired token, and never holds the store
lock while it waits.** Retiring a local engram first checks each team store
for another engram with the same id. A 401/403 used to refuse the retire.
Now it means this machine cannot touch that store anyway: the local engram
is retired, with a warning naming the store whose token was rejected
(`warnings` in `--json`). The check now runs before the store lock is taken,
with 5 seconds per store. Before, a hanging server held the lock for 30
seconds. A store that cannot be reached still refuses the retire, and the
message names `--scope primary`. A rejected token is not proof there is no other
engram with that id, though. If this machine has ever met that id on a server,
the retire is refused instead, naming `--scope primary`. "Met" means any of:

- `recall` or an injection returned it as a team engram;
- a save or an outbox delivery got it back from the server;
- its history or cached team rows show it.

Those ids are now kept in `seen-on-server.jsonl` in the PLUR directory,
outside `cache/`, so they are not pruned with the outbox id map. The record is
kept to about 16 MB by rotating it, never rewriting it: when the file passes
8 MB it replaces the previous generation, and lookups read both. So a line
another process appends at that moment is never lost, and a line cut short
by a killed writer does not swallow the next one. A `rescope --keep-local` no
longer marks the local engram's id as a server id, and a rescope that finds
the content already on the team server records that server's id. Looking up an id that is not stored
locally is also limited to 5 seconds per store (it was 30). `plur feedback` follows the same rule,
except that an unreachable store gives a warning instead of a refusal, as it
did before.

**Ids that collide across stores.** Every store, servers included, numbers
its ids from 001 each day, so one bare id can name two unrelated engrams:

- `plur learn` now prints the namespaced id for a team save (`ENG-XXX-…`, the
  form `recall` and the MCP tool use). A queued save keeps its local id.
- `plur feedback` takes `--scope primary|<team scope>`, and refuses unknown
  flags and stray extra arguments instead of dropping them. `--batch` honours
  `--scope` too, and each item may carry its own `scope`.
- Pinning (`setPinned`, MCP `plur_pin`, which now takes `scope`) refuses a
  bare id that exists both locally and in a team store, instead of pinning
  the local one.
- `updateEngram` refuses a team row whose bare id matches an unrelated local
  engram, instead of writing the team content over it. It refuses unless
  every team store positively answers that it has no engram with that id: a
  server that hangs or rejects the token refuses the move too. Moving a local
  engram into a team scope still works when the server confirms there is no
  twin; `rescope` remains the way to send it to the team store.
- `plur_pin` with a `scope` checks the pinned quota against the engram the pin
  will change (in the first writable store for that scope), not a local
  engram with the same bare id.
- `plur_learn_batch` reports `delivery` (and, when queued, the reason) for each
  item, as `plur_learn` does.

A store-unique id format is planned for 0.22.

**Hosts still on 0.19.x: upgrade.** Until you do:

- A `plur learn` that reports "timed out" for a local scope has usually been
  saved. Check with `plur list --json` before saving it again.
- A team save that reports "timed out" may be lost. Save it again once the
  server answers.
- Such an exit can leave `engrams.yaml.lock` behind. Current versions take
  over a lock whose process has died; on 0.19.x, if writes wait on it,
  delete the file once no `plur` process is running.
- `plur forget` ignores `--scope` on 0.19.x. To retire a local engram while a
  team store rejects the token, use the MCP `plur_forget` with
  `scope: "primary"`.

### A broken folders.yaml says what is wrong, and `plur folders repair` fixes it (#1526)

When `~/.plur/folders.yaml` is broken, PLUR pauses memory, which is the safe
direction. Until now the messages said only that the file was broken, or gave
the YAML parser's line, and nothing helped you fix it. Now every place that
reports a broken map names the line and column and says what is wrong in
plain words. That covers `plur doctor`, `plur folders list`, the editor hooks'
notice, the opencode plugin's notice, the MCP tools' answer, `plur_status` and
`plur_doctor`:

```
line 4: indentation — `plur:` is indented 5 spaces, expected 4 (in line with `path:` on line 3)
line 2: unknown key `folder:` — did you mean `folders:`?
line 5: `plur:` in entry 2 must be on, off or ask — it looks like `off` with the wrong case or a typo
```

A message quotes at most the key on that line. It never shows a path, a
scope or any other value from the file, nor a YAML alias or tag name. A
misspelled `plur:` or `path:` key (`plru: off`) is now reported like a
misspelled top-level key, because it, too, silently dropped that decision. Each place also offers the fix:

- **`plur folders repair`** fixes what is unambiguous, which covers:
  - list items and keys indented unevenly, and tabs in the indentation;
  - a misspelled top-level key (`folder` → `folders`, `verison` → `version`);
  - a `plur:` mode in the wrong case (`ON` → `on`), or one wrong letter of
    `off` or `ask` (`oof` → `off`). A typo never becomes `on`: `ok`, `in`,
    `onn` and `of` are left to you;
  - an empty or comments-only file, which becomes a minimal valid map.

  It also fixes a misspelled `plur:` or `path:` key (`plru:` → `plur:`,
  `pth:` → `path:`: swapped or missing letters) when the entry lacks the right
  key. Other hand-added keys (`paths:`, `score:`, `trust:`, `note:`, …) stay
  as they are and are not a problem.

  **A repair adds no `on` to the map.** After a repair, a map entry is `on`
  only if it had a literal `plur: on` line of its own (any case, no escapes),
  so an entry that would be on only through `scope:` or `trusted:` is not
  repaired either. Folders with their own trusted `.plur.yaml` or project MCP
  config are on again, as before the map broke (the same as after a fix by
  hand). Every entry, key and value stays the one written on
  its own line, and a commented-out mode (`plur: #on`) stays a comment. A file
  that uses any YAML beyond a plain map (a tag `!`, anchor `&`, alias `*` or
  block of text `|`/`>`), a key whose value may continue on the next lines,
  an old-Mac line break (a lone CR) or more than 2,000 lines is never
  repaired. PLUR names the line and leaves the file alone.

  It shows a unified diff and asks before writing. `--yes` skips the
  question. Without `--yes`, a run that is not in an interactive terminal is
  a dry run: it changes nothing and exits nonzero. Before writing it saves the
  original as `folders.yaml.plur-backup-<UTC time>` next to the file, writes
  the new file atomically (to the target, when the map is a symlink), and
  checks the result again. It keeps your comments. A problem it cannot fix is
  reported with its line, and the file is left exactly as it was.
- **Agents get the same offer.** The MCP answer (`repair_command` and
  `repair_summary`), the hooks' notice and the opencode notice say in one line
  what the repair changes ("line 4: indentation; line 2: `folder:` →
  `folders:`"), tell the agent to show that to you first, and give the exact
  command,
  `plur folders repair --yes` (with `--path` for a store other than
  `~/.plur`), and tell the agent to run it only after you agree. In opencode,
  the next turn carries the command once more, so a "yes" given there can
  still be acted on.

**Behaviour change in the editor hooks and the opencode plugin (the safe
direction).** They read an empty or comments-only `folders.yaml`, or one with
an unknown top-level key such as `folder:` (or, now, a misspelled entry key
such as `plru:`), as an empty map. That gave `ask`,
or memory ON in a folder with a project marker. The MCP server already refused
such a file. Now the hooks and the plugin refuse every file the MCP server
refuses: such a map gives `ask` with no memory, and `plur folders set` will not
write over it until it is repaired.

### The Claude Code memory check speaks up only after a correction, preference or decision

The Stop-hook memory check used to fire after every third response, forcing an
extra turn that usually ended in a bare "ok". It now reads the last message you
typed from the transcript and nudges only when it reads as a correction aimed
at the agent ("no, use pnpm", "that's wrong", "you edited the wrong file"), a
preference ("I prefer …", "I'd rather …") or a standing rule ("from now on
…", "never …", "remember that …"), or a decision-board answer. Slovenian and
German count in the same shapes ("ne, uporabi …", "to je narobe", "narobe si
…", "vedno uporabi …", "prosim, ne …", "pri nas …", "od zdaj naprej";
"nein, nimm …", "das ist falsch", "Füge niemals …", "bei uns gilt", "ab
jetzt"), with or without č/š/ž, and curly apostrophes match like straight
ones. Decisions count too ("we decided …", "odločili smo …", "Q1: yes"). Ordinary requests, bug reports and answers do not ("It should
return 200", "Nekaj je narobe s prijavo", "Immer wenn ich …", "No, keep
going"), nor do pasted logs, code blocks, quoted text, compaction summaries,
command output or task notifications. At most one nudge per message, and none
when the agent already called `plur_learn` in that reply. When nothing is
worth keeping, the forced turn asks for no "ok": the memory line the agent
ends every reply with is enough.
A fallback still checks every 10th response; set
`PLUR_LEARN_FALLBACK_INTERVAL` to change it, or `0` to turn it off.

### Agents now end each reply with the memories they recalled, used and wrote (#1520)

The instructions PLUR installs (the `plur init` section in CLAUDE.md and
AGENTS.md, the Cursor rule, the MCP server instructions, the `plur-mcp init`
section, the Claw system prompt and the plur-memory skill) now ask the agent to
end every reply with one short line such as
`Memory — recalled 4 · used: ENG-…, ENG-… · written: ENG-…`, or
`Memory — none`: a count of what was recalled and the ids used and written, no
statements, and only ids it actually saw that turn. Ask a follow-up for the
details. That line is never saved as a learning, in any form an agent writes
it: plain, in backticks or bold, as a bullet, numbered item or quote, after a
🧠 or inside an HTML tag, with an em dash, en dash, hyphen or colon, straight
after an "I learned" list or in place of one. A learning that merely starts
with "Memory", such as "Memory: used 4GB is too low", is still saved.

Re-running `plur init` or `plur-mcp init`, or reloading the Claw plugin, now
brings an existing install up to date. Before, `plur init` left an existing
section untouched, so changed instructions never reached an existing install.
It never removes text PLUR did not write. An old PLUR section is replaced only
when it is, line for line, a text PLUR shipped; only trailing spaces and line
endings may differ. A section you wrote or edited, including one you only
re-indented, stays exactly as it is, the new section is added beside it, and
init tells you so, so you can tidy up. A section inside a code block or an
HTML comment is left alone, and a file that ends inside one has it closed
before the new section is added, so a second run changes nothing. An edited
`.cursor/rules/plur-memory.mdc` is kept rather than overwritten. Every file
that is changed is first copied to a timestamped `*.plur-backup-*` file beside
it (an edited Cursor rule only once per version of its content). The new file
is written beside the old one and swapped in whole, so a write that fails
partway, on a full disk for instance, leaves your file exactly as it was.

### opencode follows the folder map (#1517)

**The opencode plugin now does what you decided for each folder**, like the
Claude Code, Codex, Cursor and Antigravity hooks have since #1347. Before, it
recalled and learned in every folder it was opened in, and the folder map
(`~/.plur/folders.yaml`) was not read at all. The decision is for the folder
opencode is open in, so an `off` subfolder of a repo that is `on` stays off.

- **off**: nothing happens in that folder — no recall, no memory block, no
  question, no learning.
- **ask** (any folder you have not decided about, including your home folder,
  and a repo whose `.plur.yaml` asks for settings you have not trusted): no
  memories. The session's first message carries the same question the hooks
  ask, with a single-use command per answer (yes, never here, and trust this
  repo's `.plur.yaml` when it has one). The next message of that session
  carries the same commands once more, without asking again, so the agent can
  still run your answer when you give it; after that the session carries
  nothing and the unanswered commands stop working, so a later "yes" to
  something else is never taken as consent. What the repo requests is shown only
  as quoted data, never its token. Without the `plur` CLI on `PATH`, the
  plugin says so and how to install it instead of offering commands.
- **on**: the session scope is the folder's scope from the map, else the scope
  of a trusted `.plur.yaml`, and recall reaches the team store for that scope.

The question's commands carry nonces issued the same way the hooks issue
them: one per answer, bound to that folder and that answer, ended when
opencode deletes the session or exits, and after 24 hours at most. The
plugin's nonces are also bound to their session: opencode tells the agent's
shell which session it is in (`PLUR_FOLDER_SESSION`), and `plur folders set`
refuses a nonce from another session. The editor hooks' nonces stay unbound,
because their hosts cannot tell the agent's shell its session.

**A folder map that cannot be read now fails safe, in every editor.** A
`folders.yaml` that does not parse was read as empty, after which a project
marker (`.plur.yaml`, a project MCP config) switched memory on, even in a
folder the map had switched off. Now the folder is treated like `ask` with no
memory, and the agent is told which file to fix and on which line. A folder
decision that cannot be resolved for any other reason does the same, and so
does a `folders.yaml` that exists but cannot be opened (a dangling symlink, a
folder that cannot be searched), which was read as "no map" — the same rule
the MCP server's folder gate applies.

The question itself moved from the CLI into core (`folderAskOnce`,
`sessionSettings`), so the hooks and the plugin share one implementation.

### The MCP server asks the folder question in a folder you have not decided about (#1525)

Most PLUR use is MCP calls, and until now the MCP server treated an undecided
folder (folder map `ask`) as `on`: an agent that called `plur_learn` or
`plur_recall` itself read and wrote memory in a folder you were never asked
about. Now the 33 memory tools (#1519's list), called directly or through
`plur_admin`, read and write no memory there and answer, without an error,
with the question the editor hooks ask: `{ "plur": "ask", "question",
"answers": [{ "label", "command" }] }` — yes (with the suggested team scope,
or without one), not now, never here, and trust for a repo whose `.plur.yaml`
asks for settings.

- Each answer's command carries its own nonce from core, bound to that folder,
  that answer and this MCP session. The command names the session
  (`plur folders set … --session mcp-…`, new), because the server cannot set the
  agent's shell environment; a nonce from another session, or a command that
  drops `--session`, is refused and nothing is written. If the shell also has
  `PLUR_FOLDER_SESSION` (the opencode plugin), the two must agree.
- Every memory call returns the same question with the same nonces until you
  answer; the next call after an answer follows it. Yes → memory on, and the
  answer's team scope becomes the session's default write scope. Never here →
  off.
- Not now has a command too (`plur folders set <folder> --not-now --nonce …
  --session …`, new), because the server cannot see the chat: it consumes its
  nonce and writes nothing to the folder map. Memory stays off for the rest of
  that MCP session, without the question; the folder stays undecided, so the
  next session asks again.
- `plur_session_start` now uses the folder map's scope for this workspace as
  its default when you pass no `default_scope` (`scope_source: "folder-map"`),
  ahead of a trusted `.plur.yaml`'s, as the editor hooks already do.
- **This also changes folders you had already turned on with a scope**
  (`plur folders set <folder> --scope <s>`): over MCP, an unscoped
  `plur_learn` there now goes to that scope — possibly a team store — where
  before it went to the `.plur.yaml` scope or to `global`.
- A broken `folders.yaml` keeps #1519's fail-safe answer: off, naming the file
  and the problem, no command, no nonce. The admin tools are unchanged; off wins
  over ask, and ask over on, across the workspace folders; a workspace that
  cannot be fetched stays off for that call.
- Which folder is asked about: never your home folder, a filesystem root or
  a folder above home — whether the client sends it as a root or started the
  server there — since an answer would cover every folder under it; memory
  there runs as before. Otherwise the client's MCP roots when it sends any
  (the server's start folder is still checked for `off`, but not asked
  about), and the start folder when it sends none or only such folders.
- The session's unanswered nonces are deleted as soon as the session closes
  (stdin ends, or SIGTERM / SIGINT). The stdio server then shuts down once
  the tool calls already running have sent their answers — after stdin ends,
  however long they take; on a signal, within 2 s. An unanswered question
  whose nonces expired is asked afresh.
- A folder-nonce file holding a null or malformed record (hand-edited or
  corrupted) no longer makes every folder answer fail with a TypeError: such
  records are ignored, a file with none left is swept by its age, and a wrong
  `session:` field no longer makes a session's new nonces unusable. Nonce
  files left by a session that never closed (killed outright, or a missed
  editor SessionEnd hook) are removed once their nonces have expired (24 h),
  whenever a nonce is issued and when the MCP server starts.

If you use PLUR through a global MCP config and have no folder decisions yet,
the first memory call in each project now asks once. The CLI hooks' question
and the opencode plugin are unchanged.

### The MCP server respects a folder you turned PLUR off for (#1519)

`plur folders set <folder> --off` silenced the editor hooks, but an agent that
called `plur_learn` or `plur_recall` itself still read and wrote memory in that
folder: the MCP server never read the folder map. Now, in an `off` folder, the
33 MCP tools that read or write engrams or episodes or return their text —
`plur_learn`, `plur_learn_batch`, `plur_recall`, `plur_recall_hybrid`,
`plur_inject`, `plur_inject_hybrid`, `plur_session_start`, `plur_session_end`,
`plur_capture`, `plur_feedback`, `plur_receipt` and the rest (the full list is
in the MCP README), called directly or through `plur_admin` — read and write no
store, local or remote (no outbox row either), and answer without an error
that PLUR is off for this folder, with the `plur folders set … --on` command
for each map entry that turns it off.

The admin and diagnostic tools (status, doctor, stores list and add, sync
status, packs list and preview, scope discovery) keep working; status, doctor
and stores list still read stores to count or probe them and return counts and
health, not engram text (a store that cannot be parsed is reported by the
error's first line only, by every MCP tool, never by the file's lines); `plur_packs_preview` still returns the statements of
any pack directory it is pointed at, an installed one included. The folder is the editor's workspace — the roots the client lists over
MCP, plus the folder the server was started in — checked on every call; if the
client's roots cannot be fetched or a root is not a folder on this machine, that
call does nothing and the next one asks again. A `folders.yaml` that exists but
cannot be read or parsed — a dangling symlink, an empty file, an unknown
top-level key included — now fails safe: the memory tools do nothing and name
the file and the problem. Server startup is
not gated yet (#1523). `on` and `ask` folders are unchanged (for `ask`, see
#1525 above).

### plur doctor reads an opencode config written with comments or trailing commas (#1516)

opencode accepts JSONC in `~/.config/opencode/opencode.jsonc`. `plur doctor`
read it with a plain JSON parser, so a config that declares both the
`@plur-ai/opencode` plugin and `mcp.plur` was reported as declaring neither,
and doctor failed a working install. Doctor now reads comments and trailing
commas, and leaves `//` and `/*` inside strings (such as the `$schema` URL)
alone. Reading never changes the file. `plur init` still refuses to rewrite a
JSONC config, because it cannot keep the comments.

### plur recall --scope and --domain filter the results (#1516)

`plur recall "<query>" --scope <scope>` accepted the flag and ignored it: the
recall ran across every scope, and a team store for that scope was never
asked. `--scope` and `--domain` now filter the same way as the `plur_recall`
MCP tool, and `--scope` dials the store configured for that scope.
`--tags` and `--type` were accepted and ignored the same way. There is no
filter behind them, so `plur recall` now refuses them with an error. `plur list` likewise refuses `--tags`, and now accepts
`--meta`, which it previously refused before reading it.

### plur inject --scope limits the injection to that scope (#1516)

`plur inject "<task>" --scope <scope>` ignored the flag the same way: the
injection drew on every scope, and a team store for that scope was never
asked. `--scope` now works as it does in the `plur_inject` MCP tool, and on
the default (hybrid) path it dials the store configured for that scope. The
MCP tool takes no domain, so `plur inject` refuses `--domain`, and any other
flag it does not know, with an error instead of ignoring it.

Because `plur inject` now checks its flags, a task that starts with a dash
and a letter (`-deploy …`, `--path=…`) must come after `--`:
`plur inject -- "-deploy the service"`. Without `--` it is read as an unknown
flag and the command exits 1. The current Python SDK and Hermes plugin already
pass such tasks after `--`; older builds that do not will get exit 1 for those
tasks (no memory injected for that turn) until they are updated.

### The opencode plugin loads again on opencode 1.18.33 (`@plur-ai/opencode` 0.1.3)

`@plur-ai/opencode` 0.1.2 exported a constant (`INJECT_TIMEOUT_MS`) from its
entry module. opencode loads every export of that module as a plugin and refuses
one that is not a function ("Plugin export is not a function"), so the whole
plugin failed to load. The constant now lives in its own module, and a test
keeps the entry module to functions only.

### A recall in your personal scope now reads your personal remote store (#1515)

**Personal remote memory is no longer write-only.** With a remote store
configured for a personal scope (for example `scope: user:acme:me`),
`plur_learn` to that scope saved the engram on the server, but `plur_recall`
or `plur_recall_hybrid` with the same scope never contacted the server and
returned only local results. The remote leg dialed a host only for a shared
(`group:`/`project:`) scope of the same org, an explicit `.plur.yaml` remote
project, or a store marked `dial: always`; a personal scope qualified for none
of them.

Now a recall or a hybrid injection whose personal `user:` scope was passed by
the caller, or registered by that session itself, dials the one store whose
own scope matches it, asking that host for that one scope.

- The match ignores case, the same way local-only scope targets do
  (`USER:Acme:Me` finds a store configured as `user:acme:me`). Exactly one
  configured store is chosen, local path-backed ones included. Stores whose
  scope matches exactly are preferred; only when none does are case-insensitive
  matches considered. Among those candidates the choice is fail-safe: a local
  store first, then a writable remote store, then a readonly one, with config
  order breaking ties. An exact remote match still beats a case-insensitive
  local match: `USER:ACME:ME` goes to a remote store configured as exactly
  `USER:ACME:ME` even when a local store is configured as `user:acme:me`. A
  new write leaves the machine only when no local store matches the same way
  (exactly, or, with no exact match, case-insensitively). A delivery already
  queued before a local store was added still goes, after the secret check,
  to the remote store it was queued for.
- That one choice decides the recall dial, where `learn`, `learnRouted`,
  `learnAsync` and `learnBatch` write, the "is this my own remote namespace"
  check, whether a cached remote copy counts as a duplicate of a learn or a
  `rescope` (when the choice is local, the local copy is kept), and where an
  update that moves a queued engram into the scope sends it. That update
  spells the scope as a fresh write would, so `user:acme:me` moves it to a
  remote store configured only as `USER:ACME:ME`; a local choice cancels the
  queued delivery. The writes make it before their
  duplicate check and read the current config first, so a store another
  process just added already counts. A write and a read with the same string
  therefore pick the same store, even when a remote store has the identical
  scope. One exception, as before: a readonly remote store is read but never
  written, so when it is the chosen store the write stays local.
- The secret check does not use the choice. Content headed for a scope that
  any remote store holds exactly is checked for secrets, whichever store is
  chosen, and so is an update to an engram already on the server and an
  outbox delivery. With a local store and a remote store on the identical
  scope, a sensitive write is kept local and private, as before this change.
- When the chosen store is local, or is set to `dial: never`, the
  personal-scope rule dials nothing. It never uses a remote store whose scope
  differs only in case instead.
- The personal-scope rule adds only that store. Other stores, a case twin
  included, can still be dialed by the existing rules: a store set to
  `dial: always`, a trusted `.plur.yaml` remote project, or an org context
  (a shared `group:`/`project:` scope of the same org), which also adds that
  host's personal stores. `dial: never` still wins.
- A session that never registered its own scope does not dial through the
  process-wide default; that default is some other caller's choice.
- When a core `recall`, `recallHybrid` or `injectHybrid` call passes a
  `scopes` allow-list, only stores that can hold an allowed scope are dialed:
  the store's scope equals an allowed scope or is a parent of one (a
  `group:acme/eng` store is dialed for `scopes: ['group:acme/eng/x']`; a
  `group:acme/eng/x` store is not dialed for `scopes: ['group:acme/eng']`).
  `scopes: []` dials nothing. Before, every store was dialed and the rows were
  filtered afterwards; that exact-membership filter on returned rows still
  runs. The MCP tools do not take a `scopes` argument.
- A session whose default scope is a personal store scope now makes one
  timeout-bounded remote call per hybrid injection, where it made none.

Shared-scope dialing is otherwise unchanged. The `plur_recall` tool description
(and its `plur_recall_hybrid` alias) now says a personal scope reads its own
matching remote store.

## 0.21.0

More control over what your agents remember, and where.

- A memory map per folder
- plur remote for team stores
- Hard and soft pins
- Smarter, self-correcting memory

### A corrected memory stops being injected, and a project's memories stay in that project (#1232)

**A correction no longer arrives beside the advice it corrected.** When an
engram is superseded (`plur learn --supersedes`, `plur_learn` with
`supersedes`) and the engram that replaced it is active, injection now leaves
the old one out entirely. Before, it was only ranked lower (×0.3), so whenever
the budget had room — which is most of the time — the model saw both the old
and the corrected claim, unmarked. A prompt that asks about the past
("previously", "used to", …) still reaches the old engram, and if the
replacement could not be injected here — retired, only in a remote store, a
draft awaiting approval, expired, or in an `on_request` pack — the old one is
kept, re-ranked as before, rather than lost. Engrams that supersede themselves
or each other in a loop are also kept at the old re-rank instead of all
disappearing. Only the engram's direct replacement counts: on a chain
A → B → C where B cannot be injected but C can, A is kept at the old re-rank
beside C. Recall is unchanged (#997 keeps that question open).

**Another project's engrams no longer reach a scoped session.** The prompt
hook reads the directory's `.plur.yaml` scope and passes it on, and the
keyword-only `inject()` honoured it — but `injectHybrid()`, which the hook
uses, let an out-of-scope engram back in whenever its embedding similarity was
high, and spreading activation could reach one through a co-access link. Both
now respect the scope; global and personal engrams still pass as before.

### Pack integrity values are now `sha256:v2:`, and a v1 value still verifies (#1229)

**The v1 pack hash could not tell some different packs apart** (ENGRAM-STANDARD-v1
§5.5; found by the formal verification run in #1228). It was
`SHA256(SKILL.md ‖ engrams.yaml)` with nothing between the two files, so bytes
moved across the boundary kept the same hash — a trailing line of SKILL.md could
move into engrams.yaml and the pack still reported `ok`. A missing SKILL.md
hashed the same as an empty one, and a deprecated `manifest.yaml` was not
covered at all.

**New packs carry `sha256:v2:<hex>`**: SHA-256 over `SKILL.md`, `manifest.yaml`
and `engrams.yaml`, each framed as its name, its byte length and its bytes, with
a missing file spelled differently from an empty one. Export writes it, install
records it, and `plur packs list` reports it.

**Nothing you already have breaks.** A pack that shipped a v1 `INTEGRITY` value,
and a registry row written by an earlier install, are checked in the form they
were recorded in, exactly as before.

**To move installed packs to v2**, run `plur packs migrate-integrity`. It is a
dry run until you add `--yes`, and the dry run writes nothing and takes no lock.
A pack that no longer matches its v1 value keeps it and keeps reporting
`modified`. For a pack that does still match, remember what v1 cannot see: a
v1 match is not proof the pack is unchanged. So:

- if the directory the pack was installed from is still on disk, the installed
  pack is re-checked against what installing that source produces today, and
  moves to v2 only if the two agree. If they differ it stays on v1 and is
  reported `skipped-modified`;
- otherwise the v2 value is **carried over from v1**, and marked as such.
  Re-baselining this way carries v1's trust forward; it does not certify the
  pack. `plur packs list` keeps saying `ok` for it but adds "baseline carried
  from v1", and the JSON and `plur_packs_list` output carry
  `baseline: "carried-from-v1"`. It will catch any change from now on, not an
  edit v1 could not see before the migration. Reinstall such a pack from a
  trusted source to get a verified baseline.

Running it twice changes nothing the second time. It never touches a pack's
shipped `INTEGRITY` file. It ignores the temporary directories an install leaves
while it runs (or after a crash), and an install finishing mid-run no longer
aborts it.

**Going back to an older PLUR after migrating** (or after installing anything
with this version): older versions only understand v1, so every registry row
written as v2 shows as `modified` in their `packs list`, and they refuse a pack
that ships a v2 `INTEGRITY` unless forced. Nothing is damaged — return to this
version and the rows verify again — but do not "fix" those packs from the older
version.

`plur packs list` now shows the form prefix plus 12 hex digits of a v2 value
(`sha256:v2:1a2b3c4d5e6f`), where it used to cut it to six.

The standard moves to 1.8. Producers SHOULD write v2, and receivers MUST accept
both forms. A consumer that only understands v1 will refuse v2 packs, so it
needs updating before its producers switch. Four conformance vectors were added
(`with-integrity-v2`, `boundary-shift-v2`, and `manifest-yaml-only-v2` and
`no-engrams-v2` for an absent `SKILL.md` and an absent `engrams.yaml`), and every
vector now declares its v2 value as well.

### Two packs with the same manifest name no longer share an integrity baseline (#1229)

**The pack registry was keyed by manifest name, while installed packs live in
directories named after their source** (found by the formal verification run in
#1228). Two directories whose manifests shared a name shared one registry row,
which caused two failures:

- the second install overwrote the first's baseline, so `plur packs list`
  reported the untouched first pack as `modified`;
- uninstalling either pack removed the row by name, leaving the other one
  `unverified`. Tamper detection was lost without any message.

**Registry rows now record the install directory in a new `dir` field**, and
install, uninstall and list all look rows up by it. Uninstalling one pack never
removes another pack's row.

**Older registry files still load unchanged.** A row without `dir` is matched by
manifest name, as before, and reinstalling that pack upgrades the row in place —
including when a newer pack with the same manifest name has been installed
beside it since. On a case-insensitive filesystem the row follows the
directory's real name, so `plur packs uninstall PACK-ONE` removes `pack-one`'s
row along with the directory.

**If you were hit by the original bug** — two installed packs with the same
manifest name — your registry may hold one row that both packs could own.
Nothing records which pack it belongs to, so `plur packs list` now reports both
as `UNVERIFIED` (it used to report one of them as `modified` when it was not),
`plur packs migrate-integrity` skips both as `skipped-ambiguous-legacy-row`, and
uninstalling one never removes the row. The pack left behind after such an
uninstall stays `UNVERIFIED`: the row is marked `ambiguous: true`, so it is not
checked against a value that may be the removed pack's. **Reinstall each
affected pack from a trusted source**; each then gets its own row.

**Do not share a packs directory between this version and an older one.** An
older PLUR matches rows by manifest name only: installing there replaces a
same-name pack's row (dropping its `dir`), and uninstalling there removes every
row with that name. If that has happened, run `plur packs list` with this
version and reinstall any pack it reports as `UNVERIFIED`.

### A downloaded pack is bounded and checked before anything is extracted (#1251)

**Installing a pack from a URL no longer trusts the archive.** Before, the whole
download was buffered with no size limit and handed to the system `tar`, so an
untrusted archive could cause unbounded download and decompression work, and
links or unusual file names reached the extractor unchecked. Now the download
stops after 30 seconds or 32 MiB, decompression stops at 64 MiB, and the
archive is listed before anything is written: symbolic and hard links, special
files, absolute or `..` paths, more than 10,000 entries, an entry over 16 MiB
and paths deeper than 64 folders are refused. Extraction runs in-process with
no shell, the temporary folder is removed on any failure, and errors never echo
the signed download URL.

### Migrations, backups and PostgreSQL writes no longer lose newer data (#1252)

**A failed migration could erase records written after its backup.** It
restored a version backup that could predate later writes. A failed migration
now leaves the live store untouched. If the process dies between writing the
migrated store and recording the new schema version, a recovery journal lets
the next start finish recording the version without running the migrations
again, and it refuses if other writes happened in between. A schema-version
write that fails while the process is still running puts the old store back
and keeps the old version. A malformed `config.yaml` is now refused instead of
being read as version 0, which would have re-run every migration over an
already-migrated store.

**Backups restore exactly the bytes they verified.** Validation, checksum and
snapshot share one read of the store. Two restores in the same millisecond no
longer overwrite each other's safety copy. A corrupt same-day snapshot is moved
aside and replaced with a fresh one, where before the day ended with no usable
backup.

**PostgreSQL: one write owner at a time.** The lock, the reads and the writes
run on one connection in one transaction, so losing the connection ends
ownership and aborts the writes together, and the lock cannot be left held. A
write from a stale session is refused, a rolled-back transaction is no longer
reported as committed, and background work (provenance, auto-embedding, the
push after a team write) starts only after the commit.

### The first prompt of a session no longer waits on a cold embedding cache (#1414)

**The first prompt of every session blocked for about 14 seconds**, because the
hooks never built the embedding cache: hybrid search missed its deadline, fell
back to keyword search, and nothing ever warmed the cache, so it never got
better. When that happens now, `plur hook-inject` starts one background build at
the lowest CPU priority, one per store, stopped after an hour, and the cache is
saved once the whole store is embedded.

### Forgetting an engram reaches the store that holds it (#1209, #1126)

**`plur forget` could stop at the wrong remote store.** Two different scopes can
share the same three-letter id prefix, so a store that could not be reached was
taken for the intended target and the walk stopped there with "Cannot reach …",
before it reached the store that held the engram. The walk now finishes, and
reports an unreachable store only if no store retired the engram.

### A push claim is released only by the writer that took it

The outbox's per-entry push claims (#1277, decision C3) are the one guard
against delivering a write twice. A release now removes a claim only when this
Plur instance took it (its token). Before, any instance in the same process
could remove another's claim if it held none of its own: two `Plur`s on one
store share a pid. `listOutbox()` reports `leased_until` for an entry whose
claim is live, read from the claim file alone: the entry is being pushed, not
stuck. (#1228's earlier on-disk row leases never shipped and are gone.)

### PGLite recall reports its fusion score

With `PLUR_BACKEND=pglite`, hybrid recall returned no top score, and the opt-in
miss signal read "results but no score" as *no results* — every recall that
found something was reported as a miss. It now reports the same RRF fusion
score the default backend does. (Decision I4.)

### A queued team write keeps the scope its queue entry names

Two paths changed the scope of an engram still waiting to be delivered to a
team store, leaving the queue entry naming the old store (the flush then held
it back with a warning, so the team never received it). Cross-scope recurrence
no longer widens such an engram to `global` — the recurrence is still recorded
(decision D3). `updateEngram` changing its scope now behaves like `rescope`:
to a local scope the pending delivery is cancelled; to a scope with a writable
remote store the delivery is retargeted there, after the leak guard ran against
the new scope; to anything else it is cancelled with a warning (decision D4).

### A remote copy that lands after you forgot it is now retired for you

If you forgot or locally rescoped an engram while its push to a team store was
on the wire, and the store accepted it anyway, the local record was kept and a
warning named the server id — but the remote copy stayed live. The server id is
now kept, and a durable "retire on remote" entry is queued on the local record;
the next `plur_sync` / outbox flush deletes that copy on the store, retrying
like any queued write (a 404 counts as done, it never re-sends the engram, and
it survives a restart and `compact`). (Decision D1.)

### Auto-route reaches a remote personal store only when it is yours

An unscoped write could still auto-route into a **url-backed personal scope**
(`user:*`, `agent:*`) whose `covers` the server declared — so the remote partly
decided where your unscoped writes went, and the copy left the machine. Now an
unscoped write routes into a remote-backed personal scope only when the
remote's `/me` identity says it is **your own namespace** (`user:<username>` or
`user:<org>:<username>`, or below it). Any other remote personal scope is
refused and reported exactly like a shared one; if `/me` has not answered in
this process (never fetched, offline, token rejected) it is refused too — fail
closed. Path-backed personal routing is unchanged, `allow_shared_auto_route`
still governs shared scopes only, and `plur_suggest_scope` reports the same
decision. (Decision E1 of the formal verification run.)

### `NO_SESSION`: a write that knows it has no session

`@plur-ai/core` exports `NO_SESSION`. Pass it as `session` (learn, learnRouted,
recall) or `session_id` (inject) and no session default applies — neither a
keyed registration nor the process-default slot — so an unscoped write takes the
genuinely unscoped path (auto-route / `unscoped_default`). Registering a scope
under it throws. (Decision E7.)

### Local-only scope targets: case-folded, and config-aware for `project:*`

`forget` / `feedback` with a local scope never reach a remote (#855). That test
now folds case like the shared-scope test (`GLOBAL`, `Project:x`), and a
`project:*` scope counts as local only when no configured url store's scope
equals or contains it (segment-aware) — so naming a project scope that a url
store covers reaches that store instead of being refused as "local".
(Decisions E4, E5.)

### Injection budget, miss telemetry, decay, locks and backups (formal verification, 2026-09)

Owner decisions from the formal-verification run, applied with a failing test first and a
Lean model (`spec/formal/PlurSpec/ScopeInject.lean`, `Persistence.lean`) for each.

- **Decay no longer raises a strength** (I6). Feedback can floor `retrieval_strength` at
  0.0, below decay's floor of 0.05, and decay then lifted it back toward 0.05 with time
  (0 → 0.039 after 30 days): an engram voted down to zero regained strength by being
  left alone. `decayedStrength` now returns a strength at or below the floor unchanged.
- **Removed `shouldInject`** (I7) from `packages/core/src/decay.ts`. It was exported from
  the module (not from the package entry point), had no caller, and matched scope by
  family prefix (`project:a` admitted `project:b`), contrary to `isScopeWithin` (#383).
- **The miss-signal `low_score` reason can now fire** (I3; opt-in telemetry only). The
  default floor was 0.015, below 1/61 ≈ 0.0164, the lowest top score any non-empty recall
  can have, so `low_score` was never produced. It is now 0.025: a top hit that only one
  retrieval leg found (BM25 or embeddings) counts as `low_score`; one both legs found is a
  hit. With embeddings off there is one leg, so every non-empty recall's top hit reports as
  `low_score`. `PLUR_MISS_SCORE_THRESHOLD` still overrides it.
- **The miss-signal sends only the first segment of `domain`** (I5; opt-in telemetry
  only): `trading.client-foo` is sent as `trading`. Domains are user-defined and can carry
  the same private project or client names that #312 removed from scopes.
- **The memory block respects its token budget** (I2). `renderMemoryBlock` (used by claw
  and opencode) appended a section whenever any budget remained, whatever its size
  (replayed: a 499-token budget rendered 5469 tokens). A section that does not fit what
  remains is now dropped whole; a later, smaller one can still be included. Without a
  budget nothing changes.
- **`injection_budget` now bounds the whole injection** (I1). The consider pool (up to
  200 tokens) and spreading activation (`spread_budget`, 480) were added on top of it, so
  `tokens_used` could exceed the budget (replayed: 823 at a budget of 500). Directives and
  constraints still take their share first; consider, then spreading, get what is left.
  `tokens_used` is the total and never exceeds the budget. At a tight budget you may see
  fewer "consider" entries than before.
- **Daily backups resume after a legitimate large removal** (P2). The backup refused any
  store more than 10% smaller than the last good snapshot, and only a snapshot could move
  that baseline — so after one deliberate forget of more than 10% of the store, backups
  stopped for good. PLUR now records how many engrams it last wrote
  (`backups/.last-written.json`, machine-local) and the gate compares against that: a
  removal PLUR made re-baselines automatically, while a file that shrank without PLUR
  writing it is still refused.
- **`plur restore` names fewer false losses** (P3). Its "history records N engram(s)
  created after this backup" warning counted every history event after the snapshot; it now
  counts only `engram_created` events, minus engrams retired since.
- **A lock held from another machine is no longer stolen mid-write** (P1). When
  `~/.plur` is shared between hosts, a waiter cannot check whether the holder's process
  is alive, so it steals a lock older than 60 seconds — and `plur sync` legitimately holds
  the store lock for up to ~90 seconds (three git commands with 30-second timeouts). The
  holder now re-touches its lock every 20 seconds (a third of the stale threshold), and
  before every git command, so only a holder that has stopped is judged stale. The
  heartbeat stops when the lock is released, including on error.

### `plur scopes register --json` exits 1 when the registration is refused

A refused registration already exited 1 in text mode but exited 0 with `--json`
(or when piped), so a script checking `$?` saw success. It now exits 1 in both
modes; the JSON body on stdout is unchanged (`success: false`, `error`).

### A single session-end suggestion containing a comma is no longer split

`plur_session_end` with `engram_suggestions: "Use pnpm, not npm"` (one plain
string instead of an array) stored two engrams, one of them the inverted
"not npm". A plain string sent for `engram_suggestions` is now one suggestion.
To send several as a string, send a JSON array string (`'["a", "b"]'`). Tag-like
lists such as `tags: "a, b"` are still split on commas.

### The `visibility` description no longer promises the default keeps a memory local

`plur_learn` described `visibility` as "whether this memory may leave this
machine", default `private`. For a write to a team scope that was not true: with
`visibility` omitted, the write still goes to the team store, and only an
explicit `visibility: "private"` keeps it local. Behaviour is unchanged; the
description (and `plur_learn_batch`'s, whose items take the default) now says
exactly this: the default excludes a memory from packs and shared git sync, and
an explicit `"private"` is what keeps a team-scope write on this machine.

### A statement that starts with `-` is stored as written

`plur learn -- "<statement>"` stored the literal `--` instead of the statement,
and global flags were still parsed after `--`, so a statement containing
`--path=…` could select, and create, a different store. `--` now ends option
parsing for every command: the token after it is the statement, verbatim, and
nothing after it is read as a global flag. Put global flags before `--`:
`plur learn --scope global -- "--dry-run is required for deploys"`.

The Python client (`plur-ai`) sends a statement that starts with `-` on stdin,
where the CLI reads it verbatim (the same rule as the Hermes bridge);
`run_json` gains an `input` parameter for this. `plur doctor` now recognises a
PLUR hook installed through the Windows shim (`…\.plur\bin\plur-hook.cmd`),
where it reported "no hooks" for a working install.

### dsh: a slow memory write no longer lets the next one overlap it

In `@plur-ai/dsh`, an auto-learn or episode-capture write that ran past
`timeoutMs` gave up its place in the write queue while it was still running,
so the next write started alongside it. A write now keeps its place until it
finishes, or until a hard cap of 60 seconds (or `timeoutMs`, if larger) passes;
then the queue moves on, logs a warning and counts it under `errors_swallowed`,
so one hung write cannot block every later write. A tool call still answers
"unavailable" at `timeoutMs`.

### A cloned repository's `.plur.yaml` no longer picks your scope until you trust it

A `.plur.yaml` can declare `scope:` and `domain:`. The MCP server, the Claude
Code / Codex / Cursor / Antigravity hooks and the DeepSeek Harness plugin adopted
them from any directory, so a repository you cloned could make its
`scope: group:acme/eng` your session default. An unscoped personal note then
landed in that scope and, if you had registered it, in that team's store.
Only the opencode plugin checked.

Every adapter now follows the opencode rule. A `.plur.yaml` scope or domain is
used only from a directory you have trusted with `plur trust <dir>` (trusting a
repository root covers everything below it). Otherwise it is ignored and the
default scope applies. In the Claude Code, Codex, Cursor and Antigravity hooks,
the folder-map question (#1418) asks once whether to trust it; its commands
name the store when the hook uses one other than `~/.plur`. `plur_session_start`
returns a warning as `project_config_warning` and puts it at the top of `guide`;
the values it quotes from the file are grammar-checked and escaped, never copied
as free text. Trusted directories behave as before. The DeepSeek Harness
plugin also never adopts `scope: global` from a workspace file.

**If your own projects use `.plur.yaml`**, run `plur trust <repo root>` once
per checkout, or their scope stops applying.

### With several sessions open, an MCP write without `session_id` no longer takes another session's scope

When several MCP sessions were open (often a stale one from a client that
restarted without `plur_session_end`), a `plur_learn`, `plur_learn_batch`,
`plur_session_end` or `plur_inject` call without `session_id` used the default
scope of whichever session had started last, which could be a team scope. It
now uses no session default at all, unless exactly one session is open. An
explicit `scope` still wins, and an unscoped write takes the ordinary unscoped
path (auto-route or the unscoped default). The same applies when no session is
open. `plur_session_scope` says so when it is used with no session open.
Pass `session_id` from `plur_session_start` to keep a session's default.

### Complete list of user-visible changes (verification audit, 2026-09-27)

The sections above describe the headline fixes. This list is every other behaviour a user, script or client can observe changing in this release, grouped by package, so nothing ships unannounced.

#### @plur-ai/core — write path, scopes, provenance

**Behaviour changes**

- **Your write is always stored (Decision A).** `learn()` no longer counts a write against a matching row it cannot persist — a pack engram, a readonly store's row, or another scope's remote-cache row. It stores a new row in the requested scope and records the match as history only. A match in the primary store, a writable secondary store, or the writable remote of that same scope still absorbs the write as before.
- **Re-import really skips (Decision R).** The importer checks `wouldDeduplicate()` before `learn()` and skips without writing when the record is a duplicate. A dry run now uses the same secret scan and the same dedup as the real run, so its counts predict the real run.
- **Readonly tension mutators throw.** On a readonly instance, the calls that change tensions (resolve, dismiss, purge and similar) now throw instead of silently doing nothing.
- **Private `learnRouted` writes stay local.** A `visibility: 'private'` engram routed through `learnRouted()` is never sent to a remote store, the same rule `learn()` already followed.
- **An unreadable tensions file blocks escalation to `locked`.** If the tensions file cannot be read, a contested engram is not escalated to `locked`: an unknown tension state is never read as "no tensions".
- **Secondary-store `write_count` persists.** A duplicate write that matches a row in a writable secondary (path) store now saves the incremented `write_count` and `sources` to that store, under its lock. Before, the increment existed only in memory, so a later `forget()` could retire a row another writer still referenced.
- **`outboxCount` counts retirements; `listOutbox()` entries carry `kind`.** Queued "retire on remote" entries count toward the total, and each listed entry is `kind: 'push'` or `kind: 'retire'`.
- **Own-namespace auto-route waits for `/me` (Decision E1).** Auto-routing a personal write to a URL-backed store is refused unless the scope is your own `/me` namespace. A fresh process refuses it until `/me` has been fetched, even for your own namespace. This fails closed by design: the first write in a new process may stay local. The identity is held in memory only and is filled by `discoverRemoteScopes()` and `checkRemoteHealth()`, which the MCP server calls at session start. A short-lived CLI or hook process that does not call them never learns its `/me` identity, so it never auto-routes to your own remote namespace; those writes stay local or go to `unscoped_default` (#1239).
- **Provenance answers "may it leave this machine?" more strictly (Decision E6).** A `global` or `user:*` engram that is not explicitly `public` and whose scope has no remote store now reports `may_leave_this_machine: false` (`engram:maySharePlainly: false` in the record). Before, only `scope: local` was withheld, so such an engram reported that it could leave. `summariseProvenance()` also defaults `may_leave_this_machine` to `false`: a record without an engram node now answers no, and an older record without `engram:maySharePlainly` is judged by the same rule from its scope and visibility, with remote backing treated as unknown. Consumers that read these fields will see more engrams reported as withheld.
- **A retarget during a push no longer loses the engram.** Before, an engram was lost when `updateEngram()` (or `rescope()`) moved it to another store while its push to the old store was in flight. The new store never got it, and the old store kept a copy under the old scope. Now the local row stays queued for the new store, and the copy the old store accepted is queued for retirement. The next `flushOutbox()` first retires that copy, then delivers the engram to the new store. The same fix applies to `learn()`'s immediate push and to `flushOutbox()`. A failed push can no longer point a row that was retargeted in the meantime back at the old store. A row that still has a pending remote retirement is not pushed until that retirement succeeds.
- **Path-store rows with prefixed ids are found again.** Some rows are stored with an id that already carries the store prefix, for example `ENG-GPL-…` in a `group:plur/eng` path store. Such rows come from another client or a sync. `forget()`, `feedback()` and the other id lookups now find them. Before, `forget()` failed with "Engram not found" for these rows, and a repeated `learn()` stored a duplicate.
- **Stores that share a prefix are told apart.** Store prefixes are three letters, so two stores can share one: `group:plur/eng` and `group:plur/ops` are both `GPL`. `updateEngram()` now checks the policy of, and PATCHes, only the store that holds the engram. It decides this from the row's `_storeScope`, or else from the store whose scope contains the row's scope. Before, it also checked the other store's policy and sent that store the PATCH. A repeated `learn()` of a path-store row now records the repeat on the matching row, not on another store's row with the same unprefixed id. An id-only call (`forget(id)`, `feedback(id)`) can still match either store when both hold that unprefixed id. The id alone does not say which store is meant.
- **The learner keeps every negation before always/never.** "You cannot always trust the cache", "doesn't always", "shouldn't always", "won't always", "isn't always" and the same forms written without an apostrophe are now stored with the negation. Before, they were stored as the reverse instruction "always …".

**New public APIs**

- `Plur.close()` stops this instance's subscription to id-rename reports from a shared primary store (owner decision P1). It does not close the store, which the caller owns. It is safe to call more than once.
- `Plur.wouldDeduplicate(statement, context?)` returns the id of the existing engram that `learn()` would resolve to, or `null`. It writes nothing. It uses the same scope guard and dedup as `learn()`, including Decision A.
- `Plur.dedupScopeFor(statement, context?)` returns `{ scope, acrossScopes }`: the scope `learn()` would write to, and whether its dedup there also matches rows of other scopes. It writes nothing.

#### @plur-ai/core — persistence, sync, telemetry

- **Duplicate engram ids are kept, not collapsed (owner decision P1).** When two different engrams carry one id (two synced machines minting on the same day), every reader — the YAML loader, the PGLite index and the Postgres writer — keeps both: the first copy keeps the id and a later, different copy gets `<id>-D<8 hex of its content hash>` (with `-2`, `-3`, … only if that is taken). An exact duplicate record is read once. The rename is recorded in history as a new `engram_rekeyed` event (`engram_id` = new id, `data.from` = old id), written by the next write of the store — loading a store no longer writes history.
- Quarantined (schema-invalid) entries that share an id with a valid engram are now kept under a fresh id instead of being dropped on the next write.
- Postgres `updateMany` now throws on a batch with duplicate ids; `validateStore` no longer reports `duplicate-ids`, because the loader resolves them.
- **`plur sync` now pulls while scope:local engrams exist** (it used to refuse every pull, and every later push failed non-fast-forward). The local engrams are set aside during the pull and put back afterwards; a local engram whose id a pulled engram also carries is given a fresh id (P1b), and local episode/tension references follow it.
- **An interrupted sync no longer loses scope:local engrams.** The set-aside records are written durably to `.git/plur-held.json` (inside `.git`, so never committed) before `engrams.yaml` is reset for the pull, and the file is deleted only once they are back. Every reader counts them as part of the store while the file exists; the next sync, or the next write of the store, puts them back into `engrams.yaml`. Before this, Ctrl-C, SIGTERM or SIGKILL during the pull deleted them.
- When a pulled `engrams.yaml` cannot be read (for example a bare list pushed by an older client), sync now keeps the remote's version instead of writing the pre-pull file back over it (which the next sync pushed as a silent revert). The scope:local engrams stay in `.git/plur-held.json`, the sync result says so, and they are restored by the first sync after the file is fixed.
- Sync refuses an `engrams.yaml` that is a bare top-level list (the loader's shape rule); it used to strip, commit and push a file PLUR itself cannot load.
- `saveEngrams` throws `EngramStoreUnreadableError` when the existing file is unreadable, instead of overwriting it.
- The shrink guard is cumulative: undeclared writes may remove at most 10% of the store counted from the last write that did not shrink it, not 10% per write.
- A failed migration no longer restores the `.bak` file over `engrams.yaml`; the live file is left untouched because nothing was written.
- `expandedSearch` results are capped at the requested `limit`.
- `recallAuto` reports `bm25` as the mode it used when hybrid search degraded to BM25.
- Telemetry: `getCounters` / `resetCounters` may return `null` when the counters lock is contended. Contended events are spilled to a file rather than dropped, and the next flush folds them in.
- Telemetry: folding spilled events now rolls a counters file from an earlier day into the pending queue first. Before, a spill dated today could be sent as its own heartbeat and then sent again at the next rollover.

#### Performance

- Loading a store with duplicate ids no longer scans the whole history once per renamed id: 2000 engrams, 300 duplicates and 28 MB of history went from about 175–250 s to 0.1–0.7 s, on par with main. Recording the renames takes a single history pass and a single fsync per month file.
- `resolveDuplicateIds` computes content hashes only for ids that actually repeat.
- Sync's merge fallback now passes `--no-rebase`, so a pull whose rebase conflicts but whose merge is clean now pulls on git 2.27+ (it reported "NOT pulled").

#### CLI, MCP and integrations

- **MCP lean profile** exposes 14 tools directly; every other `plur_*` operation is reached through `plur_admin`.
- **`plur_admin` refuses `plur_tensions` and `plur_validate_meta`** as actions.
- **`plur_session_start` is no longer marked `readOnlyHint`** (it writes session state), and **`plur_tensions` is no longer `idempotentHint`**.
- **`plur_session_scope` `op:"set"` with no open session now throws** instead of accepting a value no id-less call would read.
- **`plur_learn` reports `decision: "NOOP"` plus `existing_id`** when the write was absorbed by an existing engram (same shape as `plur_learn_batch`).
- **`plur_session_end` suggestions are written through the routed learn path** (`learnRouted`), so they route like any other unscoped write.
- **Refused auto-routes are described by kind**: `route_refused.kind` / `refused_kind` is `shared` or `remote-personal`.
- **`plur forget --json`** exits 1 on no match or an ambiguous match; **`plur feedback --batch`** exits 1 when any item fails.
- **An unwrapped session is recorded as an episode**, and a corrupt checkpoint is renamed aside instead of blocking.
- **`plur-migrate` dry run exits 2 when it finds fixable sites** — this can fail a CI step that ran the dry run expecting 0.
- **Hermes**: no global scope default (an omitted scope lets core route), an unscoped learn skips the bridge's dedup shortcut, and a timed-out learn returns `timed_out` / `warning` instead of an empty success.
- **opencode**: recall is capped at 10 s.
- **claw**: no longer takes over another plugin's memory slot, and refuses config parts that are not objects.
- **ui**: rejects a `Host` header of `:80` (no host name).

Changed in this fix round:

- **Trust notices name a command that works with a custom store.** When an adapter's store is not `~/.plur` (`PLUR_PATH`, `--path`, an MCP config's `env`, dsh's `path`, opencode's `PLUR_PATH`), the "not a trusted directory" and "Ignored remote memory settings" notices now print `plur --path <store> trust <dir>`. The bare `plur trust <dir>` they printed before wrote the grant to `~/.plur/trust.yaml`, which the adapter never read, so the notice repeated. Applies to the MCP server, the CLI hooks (Claude Code, Codex, Cursor, Antigravity), `plur init-remote`, dsh and opencode. (Core's exported `projectRemoteRefusalNotice(dir)` itself still returns the bare form. The CLI and opencode swap its closing command for the store-aware one.)
- **`plur_learn_batch` applies the pinned quota to each item.** Each admitted pinned item's estimated cost is subtracted before the next one is judged, so a batch can no longer admit five pinned items into room for one. Refused items fail with `pinned_quota_exceeded` and say how much room earlier items in the batch took. The rest of the batch is still written.
- **`--` works for every CLI command.** Commands that do not read `--` themselves (`trust`, `untrust`, `feedback`, `promote`, `stores`, …) drop it and keep the values after it as positionals. A value after `--` that begins with `-` is refused rather than read as a flag. `plur -- <command>` exits 1 with a message showing the right order (`plur <command> -- <value>`). **Correction to the existing CHANGELOG entry "A statement that starts with `-` is stored as written":** "for every command" was true only for `learn`, `recall`, `inject`, `forget`, `capture`, `ingest`, `timeline` and `similarity-search`. That is now true as written, and for other commands a value after `--` may not begin with `-`.
- **The Codex prompt hook shows the trust and remote-refusal notices once per session**, from session start, or from the first prompt of a session that had no SessionStart (resumed or forked). It used to show them on every prompt.
- **Hermes bridge and Python client**: an inject task (and, in Hermes, a capture summary) that begins with `-` is no longer read as a CLI flag. A message such as `--path=/x …` had selected another store, or made the CLI exit 1 so that turn had no memory. Inject sends such text after `--`. Capture sends it on stdin. Every other text uses the same argv as before. Hermes now puts `--path` right after `--json`. Before, it was inserted before the first `--` in the argv, which could split a flag from a value that was itself `--`. The Python client puts `--json` after the command when a separator is present, and last otherwise, as before.
- **Minimum CLI for `-`-prefixed queries in `plur-hermes` / `plur-ai`**: a recall query or inject task that begins with `-` needs the first `@plur-ai/cli` release after 0.20.1. The npx fallback pin (`_NPX_CLI_VERSION`) moves to that release at release time.
- **`plur_admin` no longer doubles a tool-name prefix** on errors: you now get `plur_session_scope: no session is open…`, not `plur_session_scope: plur_session_scope: …`.
- **dsh with a `@plur-ai/core` that cannot check trust** still ignores the workspace scope (fails closed). The warning now tells you to upgrade core instead of suggesting a `plur trust` that core would never read. If the engine did not load at all, the warning offers no trust command.

### `plur init` puts the prompt hooks in user settings, so every folder is asked (#1467)

**#1467.** Run anywhere but `$HOME`, `plur init` used to write the prompt
hooks (`hook-inject`, the compact rehydrate and the rest) and the MCP entry to
`<cwd>/.claude/settings.json`, so every folder outside that repo never got the
folder question and never got memory. Now that the folder map gates every
hook, a user-level hook is safe everywhere, and user settings
(`~/.claude/settings.json`) are the default from any folder. `--global` does
the same as the default. `plur init --project` keeps the old placement.

**`plur-mcp init` writes its hooks to user settings too.** It used to write
them to the project's `.claude/settings.json` whenever the folder had a
`.claude/` folder, which put a second set of PLUR hooks back into a repo that
`plur init` had just migrated. Now it always writes them to
`~/.claude/settings.json`, and a re-run adds no duplicates. Where it registers
the MCP server is unchanged. `plur-mcp init` has no `--project` option: for a
per-repo placement, use `plur init --project`.

**Upgrading, if you ran `plur init` inside a repo:** re-run `plur init` there.
It moves PLUR's hooks out of the repo's `.claude/settings.json` into user
settings and removes only PLUR's hooks from the repo file; the repo's MCP
entry, your own hooks and every other setting stay. It records the repo as
`on` in `folders.yaml`, with no scope, so the repo keeps working without being
asked and its `.plur.yaml` stays the scope hint. A repo whose `.plur.yaml`
asks for a scope but is not trusted gets no entry, so the folder question
asks once and can trust it, keeping the scope. `plur init --scope X` (or
`--domain`) in such a repo writes the new `.plur.yaml` first and decides on
it, as in a fresh repo: untrusted, it is asked about; in a trusted folder, the
new scope applies. If the migration fails, init reports `FAILED (…)`, says
whether the folder was already recorded in `folders.yaml`, and does the rest.
No hook runs twice, and a
second run changes nothing. A folder the map has `off` keeps that entry. After
the upgrade, **other folders get the folder question** on their first prompt:
answer it once per folder, or "never here" to silence one for good.
### `plur init-remote` is now `plur remote`, and the token stays out of the repo (#1413)

**One command connects a folder to a team store** (folder-map design r3).
`plur init-remote` wrote the URL and bearer token into the repo's
`.plur.yaml`, relying on `.gitignore` to keep the token out of git. `plur
remote` keeps both in your own config instead:

```
plur remote --url https://plur.example.test --token <t> --scope group:example/eng
plur remote --url https://plur.example.test --token <t> --scopes group:example/eng,group:example/ops
plur remote        # show this folder's connection and check it
```

- **Nothing is written until the server agrees.** Every scope is checked
  against the server's `/me` first (`Plur.verifyRemoteStore`, the checks of
  #1272's `addRemoteStore` without the write). A rejected token, an unreachable
  server, or one scope in `--scopes` the token is not authorised for exits 1
  and leaves every file as it was.
- **Then** each scope is registered as a url store in `config.yaml` (the token
  is kept there), and the current folder is recorded in `folders.yaml` with the
  scope: `--scope`, or the first of `--scopes`. **Nothing is written to
  `.plur.yaml` or `.gitignore`.** Running it again changes nothing. No trust
  grant is needed: the URL and token are yours, in your config.
- The token can also come from `--token-env <VAR>` or stdin (`--token -`). It
  is never printed: not in text, not in `--json`, not in an error.
- **It refuses `$HOME`, a filesystem root and any folder above `$HOME`**:
  an entry there would connect every folder under it. The check runs before
  the server is contacted and again when `folders.yaml` is written, under its
  lock, on the path actually recorded (`Plur.setFolder`'s new
  `refuseCoveringHome` option, error code `covers-home`). A folder replaced by
  a symlink to `$HOME` while the server answers is therefore still refused;
  the store stays registered in `config.yaml` and no folder is mapped.
- **The current folder is recorded literally**, so a folder named `proj?` does
  not also connect `projX`. A nonce for such a write is bound to the same key:
  `issueFolderNonce` and `verifyFolderNonce` take the write's `literal` option.
- **Text from outside this machine is printed only when it fits a grammar.**
  Bare `plur remote` shows an untrusted `.plur.yaml`'s requested scope and
  domain only when they are valid scope or domain names, and of its
  `remote_url` only the host (`requested.remote_host`); anything else is shown
  as `invalid`. A username returned by the server is shown only when it is a
  plain user name, otherwise as `invalid`.
- **`plur remote` with no flags** prints the folder's policy (`on`/`off`/`ask`,
  the scope, and where that came from) and checks each store serving the
  folder: the url stores for its scope, and a trusted `.plur.yaml` remote.
  Exit 0 when all are reachable, 2 when one is not, 1 when none serves it.
- **`plur init-remote` is a hidden alias.** The same flags give the same
  result, `--verify` is bare `plur remote`, and `--no-gitignore` is accepted
  and does nothing. **It no longer writes `.plur.yaml`** and no longer grants
  trust, and it now supports `--json`.
- **An existing `.plur.yaml` with `remote_url` / `remote_token` keeps working**
  under a trusted folder, exactly as before. Running `plur remote` there prints
  one line saying the connection now lives in your user config and the token
  can be removed from `.plur.yaml`. It never edits or deletes the file.
- **The hooks follow the folder entry.** The Claude Code, Codex, Cursor and
  Antigravity hooks read the folder map (see "Every editor's hooks follow the
  folder map" below), so the recorded scope is the session scope and the
  folder gets recall from that scope's store, with no `.plur.yaml`. The
  opencode plugin and the MCP server's `plur_session_start` do not read the
  map yet: there, core dials a url store only when the session's scope names
  that store's org, so a folder with no `.plur.yaml` scope gets the store
  registered but no remote recall.

### `plur trust` and `plur untrust` are hidden from `plur --help` (#1413)

Trust is now granted by `plur folders set <dir> --trusted`, by the automatic
import of `trust.yaml`, and by answering yes to the one-time question the
hooks ask in an undecided folder.
Both commands keep working. In a terminal they give the same output and exit
codes as before. Outside a terminal, `plur trust` now needs the nonce the ask
flow issued for that answer, and `plur untrust` needs none (see "A folder
nonce now authorises one answer" below). The trust check for a `.plur.yaml`
that names its own remote is unchanged.

### Every editor's hooks follow the folder map, and a folder with no decision asks once (#1347)

**Second half of #1347.** The Claude Code, Codex, Cursor and Antigravity hooks
no longer gate on a project marker. They ask the folder map
(`resolveFolderPolicy`, with the payload's `cwd` when the editor sends one)
what you decided about the folder:

- **off:** every hook is silent. No memories, no reminders, no guard, no
  learning nudge, no observation or session capture.
- **on:** memory works as before. A map `scope` (or a trusted `.plur.yaml`'s
  hint) is the session scope, which is also what makes core dial the team
  store that scope belongs to. A folder connected only through the map, with
  no `.plur.yaml`, now gets that store's recall.
- **ask** (no decision yet, including `$HOME`, or a `.plur.yaml` you have not
  trusted): the first prompt of a session loads no memories. It carries one
  instruction instead: ask you once whether to use PLUR in the folder, with a
  suggested scope from the stores you have configured, and the exact commands
  for **yes** (`plur folders set <folder> --scope <s> --nonce <n>`, or `--on`),
  **not now** (nothing) and **never here** (`--off --nonce <n>`). For an
  untrusted `.plur.yaml` it also offers `--trusted`, names the host the repo
  wants to send memories to (only a plain host name or IP address with an
  optional port; anything else is shown as "an invalid remote URL"), and
  never shows its token. What that file
  requests is shown on its own line, marked as quoted repository text, and
  only as values that fit the scope or domain grammar and the parsed host of
  a URL; anything else is named ("an invalid scope"), never copied, so the
  file cannot put an instruction into the question. Its "Yes, without its
  settings" answer never offers the scope the file requested, even when that
  scope is configured; the only way to it is `--trusted`. On macOS and Linux
  a folder path that needs quoting is printed in single quotes, so `$(...)`,
  backticks and `$VAR` in a folder name are not expanded when the command is
  run; Windows keeps double quotes. Each offered command carries its own
  nonce, issued for that session, that folder and that answer (#1477), and
  it works once: the "Yes, without its settings" nonce cannot grant
  `--trusted`, and `--trusted` is issued only where it is offered. Later prompts in the session say
  nothing; after a yes, the next prompt loads memory.

**What you will notice:**
- Folders with no `.plur.yaml` and no project MCP config, which got nothing
  before, now ask once per session. Answer "never here" to silence one for good.
- **A `.plur.yaml` you have not trusted stops applying its scope and domain**
  (decision D1). You are asked once instead of seeing the old "Ignored remote
  memory settings" line. To keep a repo working without the question, run
  `plur trust <repo>`, or answer yes and trust it.
- A trusted `.plur.yaml` and a project MCP config give byte-identical hook
  output to before. Golden tests hold every editor to that.
- Cursor gets the question through its rule file, as it gets memory. The file
  is removed again once the folder is not `on`, if it still holds the question.
- Antigravity without a workspace in the payload is unchanged: the install is
  the opt-in there, as before.
- The session-end hooks expire that session's unused nonces.
- **A resumed session is asked again.** `claude --resume` and Codex's resume
  keep the session id, and SessionEnd had already deleted its nonces, so the
  question was never repeated and a "yes" to the old one failed with
  nonce-unknown. On SessionStart with `source: "resume"` the session's
  asked-once record is cleared, and its first prompt asks again with a fresh
  nonce. A startup, clear or compact SessionStart does not re-ask. Nonces stay
  single-use and bound to one folder, and still die at SessionEnd. `plur init`
  and `plur-mcp init` register a `SessionStart` hook with matcher `resume`
  (`hook-session-resume`) next to SessionEnd; re-running either adds it to an
  older install. Codex's existing SessionStart hook handles `resume` itself.
  Cursor and Antigravity send no resume signal and delete no nonces at session
  end, so a resumed conversation there keeps its unexpired question.
- **Some folders cannot be answered from the question.** A folder rule reads
  `*` and `?` as a pattern, so a "yes" for a folder named `x*` would also
  cover its sibling `xyz` (#1493). A path with `*`, `?` or `[`, a control or
  line-break character, or a bidi or zero-width character (U+200B–U+200F,
  U+202A–U+202E, U+2066–U+2069, U+FEFF) gets a short notice instead, and so
  does a path with `$`, a backtick, `%`, `!`, `"` or a curly double quote
  (U+201C, U+201D, U+201E) on Windows, where the offered command
  double-quotes the folder and bash, PowerShell or cmd would still expand
  them (PowerShell ends a double-quoted string at a curly double quote). The
  path is shown JSON-escaped as quoted data (`$`, backticks, `'` and curly
  quotes escaped too), and no command or nonce is offered. The
  folder stays undecided and is asked about once per session. Set it by hand.
- Outside the commands, the question prints the folder only in that
  JSON-escaped form, and no line of it holds an apostrophe, so no printed
  line runs a command named in the folder (`x&touch CANARY`, `x$(...)`) when
  pasted into bash or PowerShell. The untrusted header now reads "the repo
  .plur.yaml is not trusted", and the trust answer "Yes, and trust the
  .plur.yaml in this repo". The values an untrusted `.plur.yaml` requests
  are printed the same escaped way. On Windows a folder whose path ends in
  a backslash (a drive or UNC root) also gets the notice: the backslash
  would escape the closing quote of the offered command.
- Asking changes nothing. The question no longer registers the folder's own
  `.plur/engrams.yaml` as a project store in config.yaml (the hooks build
  their scope ranker with store discovery off), so that store never reaches
  another folder's session and is never offered as a scope.

Not changed yet: the opencode plugin and the MCP server's `plur_session_start`
do not read the map.

### Editors now rate the memory they inject, from the reply

**No editor hook ever produced a feedback outcome** (#1310). plur-hermes rated
injected engrams after each reply; Claude Code, Codex, Cursor and Antigravity
did not, so ranking there learned only from explicit `plur_feedback` calls.

Now each editor's end-of-turn hook rates the engrams injected in that session
against the assistant's reply, and sends a verdict only when it is at least 0.6
confident:

- the engram's statement appears in the reply: positive;
- most of its word trigrams appear in the reply: positive. This rule applies
  only to statements of three words or more; shorter ones must appear verbatim;
- one sentence of the reply both corrects something and contains at least two
  of the engram's distinctive words: negative. The Python version looked at a
  window of 100 to 200 characters around any correction word, which marked
  unrelated engrams negative.

A quote or paraphrase is positive only when neither its sentence nor the next
one corrects it. "Your note says 'use npm for installs' — that is no longer
true" is rated negative, not positive. A match is also negative when the word
right before it negates it ("Do not use pnpm, use npm." against the engram "Use
pnpm"; also "no longer", "instead of", "rather than", "ignore") or the words
right after it reject it ('"use npm" is outdated', "does not apply", "was
dropped"). A "not" elsewhere in the sentence ("Use pnpm, not npm.", "Rather
than npm, use pnpm.") leaves it positive, and
"Why not use pnpm?" is not a negation. Each occurrence of the statement, and
each run of matching trigrams, is judged on its own: the reply is negative only
when every occurrence is rejected, and gets no verdict when it both rejects and
follows the engram. Curly apostrophes count as straight ones.
Correction phrases are ones aimed at a prior claim ("that is wrong", "is no
longer true"). A bare "is wrong" doesn't count, because ordinary prose ("check
what is wrong with the deploy") uses it all the time. A reply that merely opens
with "Actually," or "No," is not a correction either: "No, the tests passed
after the build" agrees with the memory. It counts only when the same sentence
also contradicts something ("not", "no longer", "instead", "removed", …).

The heuristic lives in `@plur-ai/core` (`detectInjectionSignal`,
`rateInjectedEngrams`), so it has one implementation.

**Automatic feedback changes ranking only.** It moves `retrieval_strength`
and the feedback counters, and never advances `commitment`. It is recorded
with `source: "auto"` on the `feedback_received` and `injection_outcome`
history events. Explicit `plur_feedback` works exactly as before.
`Plur.feedback()` takes an optional fourth argument `{ source: 'auto' }`, and
`applyFeedbackSignal()` takes `{ source }`.

**Remote stores get automatic feedback only if they say they can handle it.**
A server opts in by listing `feedback.source` in the `capabilities` array of
its `GET /api/v1/me` response. The client then sends
`{"signal": ..., "source": "auto"}` to `POST /api/v1/engrams/:id/feedback`, and
the server must treat it as ranking-only. A server that does not list the
capability receives no automatic feedback, only explicit feedback, whose
request body is unchanged. The capability is read from the `/me` call that
session start already makes, and is cached per server and token for the
process: at most one extra `/me`, never one per rating. `RemoteStore.me()`
now returns `capabilities` (`[]` for older servers). Contract:
`docs/specs/2026-09-29-feedback-source-contract.md`.

A hook runs in a fresh process, where the remote cache is empty. So the hook
fetches an injected remote engram by id, with one bounded request per id and at
most 20 per store. It asks only servers that list the capability; a server
without it is never asked for the engram. The new
`Plur.getByIds(ids, { remoteCapability })` does this. Without the option,
`getByIds` never touches the network.

Each injected engram gets at most one automatic verdict per session, and is
checked against at most three replies. After that it is settled with no
verdict, and later turns take the fast path without opening the store.

**The hook never does the store work itself.** It appends the turn to a
per-session queue, starts a detached background worker
(`plur hook-auto-rate --worker`), and exits. The worker loads, rates and writes
outside the editor's timeout, one worker per session at a time. On a large
store the store work takes seconds to tens of seconds; done inside the hook, it
overran the editor's budget and was killed part-way, sometimes while holding
the store lock. Each verdict is recorded as rated *before* it is applied, so a
worker killed between the two loses that one signal and never applies it twice.
If that record can't be written (full disk, quota, an unwritable file), the
verdict is skipped. Nothing else would stop the next turn from applying it
again. The next worker takes over a dead worker's lock and finishes its queued
turns. The takeover is atomic: it claims the lock by renaming it, the way the
core store lock does. A second worker that also judged the lock dead can
therefore never delete the lock the first one now holds. For Codex, the Stop
hook reads the session id from the same fields the inject hook records it
under (`session_id`, then `conversation_id`).

Measured under a heavy machine load (load average about 220):
- 20,000-engram store: the hook returns in 0.3–0.8 s. An earlier audit
  measured 12–30 s with the work done in the hook.
- 5,000-engram store, 10 injected engrams the reply never mentions: from the
  fourth turn on, the hook took about 100–340 ms. Without the three-reply cap
  it took 900–1,600 ms on every turn.

| Editor | End-of-turn event | Where the reply comes from |
|---|---|---|
| Claude Code | `Stop` (its own entry, next to the learning nudge) | `last_assistant_message` |
| Codex | `Stop` (new) | `last_assistant_message` |
| Cursor | `afterAgentResponse` (new; `stop` carries no reply) | `text` |
| Antigravity | `Stop` (new; prints nothing, so it never blocks the stop) | model responses in the transcript since the last user message |

The inject hooks record the ids they delivered, per editor session, in a
per-user temp directory (ids only, no engram text). When nothing was injected
in the session, the hook exits without opening the store. Every path is
fail-open, and the run is capped at 9s, below the 10s budget each editor gives
it. The Claude Code `Stop` hook is synchronous: in a real `claude -p` session an
async `Stop` hook was killed when the session exited and rated nothing. The
detached worker it starts does survive the session's exit (checked in a real
`claude -p` session).

Switches, both environment variables:

- `PLUR_AUTO_RATE=0` (or `false`, `off`) turns automatic rating off. It is on by default.
- `PLUR_AUTO_CAPTURE=1` (or `true`, `on`) turns on automatic capture of the reply's
  `🧠 I learned:` block, stored as `claim_class: inferred`. It is off by default and writes
  nothing unless you opt in. `auto_learn: false` in `config.yaml` still wins. Captured text
  goes to the local store unless you chose a scope: a folder-map entry's scope
  (`plur folders`), or a `.plur.yaml` scope in a trusted folder (`plur trust`). A cloned
  repository cannot choose to publish the agent's reply text to a team store. Captured text
  is never auto-routed into a shared scope, and a folder the map turns off captures nothing.

The end-of-turn hook follows the folder map like every other hook: it rates only
in a folder the map resolves to on, so a folder you said yes to is rated even
with no `.plur.yaml` or `.mcp.json`, and an off or undecided folder is left alone.

Run `plur init` again to install the new hook entries.

### A folder nonce now authorises one answer, and `plur trust` needs one outside a terminal

**A nonce issued for the folder question authorised any answer, `--trusted`
included, and `plur trust <dir>` needed no nonce at all from a script**
(#1378). Now:

- Each nonce is bound to the folder and to the exact answer it was issued
  for: the mode (on, off or ask), the scope if any, and whether it grants
  trusted. `plur folders set` refuses a nonce whose answer differs from the
  flags given (`nonce-answer`, exit 1) and leaves folders.yaml unchanged; the
  nonce stays valid for its own answer. `plur folders rm` needs a nonce issued
  for removing the entry. `--scope X` and `--scope X --on` are the same answer.
- The folder a nonce names is checked against the folder the write records.
  Before, a quoted `~/x` was checked as `<current directory>/~/x` but written
  as `$HOME/x`, so a nonce for one folder could write another (through a
  planted `./~/x` link), and a nonce for `$HOME/x` was refused for `'~/x'`.
  Both now use the same key: `~` expanded to the home, then canonicalised.
- **Scripted use changes:** `plur trust <dir>` now has the same gate as
  `plur folders set`. From an interactive terminal nothing changes. Without
  one (stdin or stdout is not a terminal: a script, CI, an agent's tool call)
  it exits 1 with `nonce-required` unless given `--nonce <n>` issued for that
  folder and `{ trusted: true }`. Output and exit codes are otherwise
  unchanged. `plur trust --list` needs no nonce. A script that granted trust
  can call core's `trustDirectory(dir, root)` directly.
- `plur untrust <dir>` is not gated and works from a script as before. A
  revocation only removes trust, the owner decision on #1378 gated only the
  grant, and the folder-map design keeps `plur trust` / `plur untrust` working
  as aliases so that existing scripts and runbooks keep running. Nothing
  issues a revocation nonce, so gating it would have left no way to revoke
  trust outside a terminal. A `--nonce` passed to `plur untrust` is accepted
  and ignored (neither checked nor consumed). `folders set --no-trusted` and
  `folders rm` keep the gate, like every other folder-map write.
- Core: `issueFolderNonce(root, sessionId, folder, answer)` now takes the
  answer (`FolderAnswer`), and `verifyFolderNonce` / `consumeFolderNonce` take
  the answer they check. The ask flow issues one nonce per answer it offers.
  A nonce written before this change, with no answer, authorises nothing.

What the gate does not stop: the terminal check is `isTTY` on stdin and
stdout, so a process that runs the CLI under a pseudo-terminal (Python's
`pty` module, `script`, `expect`) passes it as a person would. Anything that
can write files as this user can edit folders.yaml directly. `plur
init-remote` still records trust for the directory whose `.plur.yaml` it has
just written, after a live connectivity check. And a nonce shows that a
command matches an answer the question offered; it does not show that a
person chose that answer.

### A failed hook no longer prints an error document to the editor (#1422)

**When a `plur hook-*` command threw, the CLI printed `{"error": …}` on
stdout and exited 1**. Editors read a hook's stdout as its result and show
a non-zero exit as a hook error. So a hook-inject whose store would not load
showed the user a hook error instead of failing open. The same happened to a
run the watchdog had already stopped, if its injection then threw.

Hook commands now write the error to stderr as `[plur] <command> failed: …`
and exit 0. Every other command still prints its error document and exits 1.
That exit first waits, bounded at 5s, for any store write of the same process
still in flight, as the hooks' other forced exits do (#1349). Before, a hook
that threw while its abandoned hybrid search was recording its injection left
`engrams.yaml.lock` or its publish file behind for every later writer.

### `plur init` sets up opencode by default

**An enterprise deployment reported editors that were never set up** (#1311).
`plur init` wired opencode only with `--opencode`, on the grounds that
`@plur-ai/opencode` was not yet on npm. It is published now, so opencode is
auto-detected like Cursor, Codex and Antigravity: whenever `~/.config/opencode`
exists, init writes the `plugin` entry and the `mcp.plur` entry with no flag.
`--opencode` still forces it when the directory does not exist; `--no-opencode`
skips it. The success line says so: `(auto-detected; global, applies to every
opencode project; pass --no-opencode to skip)`, or `(global, applies to every
opencode project)` when `--opencode` forced it.

- **Windows:** `mcp.plur.command` is now built by the same builder as every
  other host since #1267 — `node.exe` plus `@plur-ai/mcp`'s js entry, or the
  pinned `cmd.exe /c npx` form when the entry cannot be resolved. It is never
  a bare `npx`. darwin/linux keep the pinned `npx -y @plur-ai/mcp@<version>`.
  Upgrading needs no manual step: re-running init on Windows replaces the
  `command` of the bare-`npx` entry older versions wrote (exactly
  `npx -y @plur-ai/mcp@<version>`), keeping its other fields. Any other
  `mcp.plur` entry is left alone. The node.exe entry itself is repaired the
  same way #1267 repairs the Claude Code one: when the node binary or
  `@plur-ai/mcp` js entry it names no longer exists (after a Node upgrade or a
  version-manager switch), or the js entry differs from the one resolved now,
  init rewrites its `command` and keeps its other fields. A different node
  binary that still exists is left alone, so switching between Node installs
  does not rewrite the entry on every run. Init prints what it wrote: the
  node.exe launcher, or the `cmd.exe /c npx` fallback.
- **Where:** the config directory is resolved the way opencode resolves it:
  `OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`, else
  `~/.config/opencode`. A leftover `~/.config/opencode` no longer receives a
  config opencode never reads.
- Re-running init is idempotent, and an existing `opencode.json` keeps its
  other keys. An existing `mcp.plur` is still left as it is, and an
  `opencode.jsonc` with comments is still reported and left byte-for-byte
  untouched. An existing `@plur-ai/opencode` plugin entry is recognised by
  package name, so a pinned (`@plur-ai/opencode@0.1.1`), tagged
  (`@plur-ai/opencode@latest`) or tuple (`["@plur-ai/opencode", {…}]`) entry is
  left as it is; init no longer appends a second, bare entry that opencode
  would load in its place.

### `plur init` works on Windows, including home directories with a space (#1270)

**An enterprise deployment reported editors on Windows not set up, or set up
twice** (#1267). Three separate faults:

- **Hook commands were the bare shim path.** Editors run hooks through a
  shell, so `C:\Users\Test User\.plur\bin\plur-hook.cmd hook-inject` split at
  the space and every hook failed. Quoting the path does not fix it: the
  editors use different shells (Git Bash or PowerShell for Claude Code,
  PowerShell for Codex and reportedly Cursor, `cmd /C` with escaped quotes
  for Antigravity), and a quoted path is an expression in PowerShell and a
  wrong name in Antigravity. So on Windows no hook relies on shell quoting:
  - **Claude Code** hooks use the documented exec form — `command` + `args`,
    spawned with no shell (https://code.claude.com/docs/en/hooks): node plus
    the CLI's js entry plus the subcommand. Exec form arrived in Claude Code
    2.1.139, so init reads `claude --version`: an older Claude Code gets the
    unquoted short-path string below instead, and so does one whose version
    cannot be read, unless that string would need the fallback. The exec
    form names the node binary that ran init (`process.execPath`), which is
    version-specific: after a Node upgrade or a version-manager switch these
    hooks point at a missing `node.exe` until you re-run `plur init`, which
    rewrites them.
  - **Codex, Cursor and Antigravity** hooks are one unquoted string with
    forward slashes. When the path contains a space, init uses its Windows
    8.3 short name (`C:/Users/TESTUS~1/...`). If the volume has no short
    names, Codex and Cursor get PowerShell's `& "<path>"` and Antigravity the
    plain path, and `plur doctor` names each affected editor
    (`windowsHookFallback`), because those hooks may not run.
  - A Windows CI job (`Windows init hooks`) runs `plur init` into a home with
    a space and executes every generated hook through `bash -c`,
    `pwsh -NoProfile -Command` and `cmd /C`, checking each one reached the CLI.
    It then runs `plur init` again and fails if any editor's hook count
    changed, or if `plur doctor` does not report PLUR's hooks in each editor's
    hooks file.

  macOS/Linux output is unchanged: the path is quoted only when it contains
  whitespace, and a path without one is written byte-for-byte as before
  (pinned by a snapshot test).
- **Re-running init did not recognise its own hooks.** The matcher looked for
  `.plur/bin/plur-hook` with forward slashes only, so every re-run on Windows
  appended another hook set. It now normalises slashes, quotes and case, and
  claims a hook when PLUR's own launcher — the shim, the `npx @plur-ai/cli`
  fallback, or the Claude Code exec form — runs any `hook-*` subcommand. The
  match covers the whole command: PLUR's launcher, the subcommand, then
  plain arguments only. A command that chains, pipes, redirects or
  substitutes (`&&`, `;`, `|`, `>`, backticks, `$(`), or that wraps the shim
  (`echo`, `nice`, `env`), is yours and is left alone. An exec-form hook counts
  only when its js entry is one that init itself recorded in
  `~/.plur/bin/plur-hook.meta.json`. That file now keeps the last 10 entries
  PLUR has recorded (a single-entry file from an older version becomes a list
  of one), so after the CLI moves — an npm prefix change, an upgrade into a
  new directory — re-running init still replaces the old hooks instead of
  adding a second set, while a checkout PLUR never recorded is never claimed.
  The
  shim also counts under its 8.3 short path, where Windows shortens the file
  name too (`.../PLUR~1/bin/PLUR-H~1.CMD`); the short alias is claimed only
  inside PLUR's own bin directory. Re-running init therefore leaves the hook
  count of every editor unchanged, with or without short names. There
  is no subcommand list to keep up to date, so a new hook never duplicates on
  re-init. Re-run `plur init` once: it removes the duplicated, unquoted hooks
  older versions wrote and leaves exactly one set per event. Your own hooks are
  untouched, including one named `hook-*` that another program runs and one
  that shares an entry with a PLUR hook. `plur doctor`, the Cursor and Codex
  legs and `plur-mcp init` use the same matcher (`plur-mcp init` no longer adds
  a second set next to the shim hooks `plur init` wrote).
- **The MCP entry launched a `.cmd`.** Current Node refuses to spawn a `.cmd`
  directly (`spawn EINVAL`). On Windows the entry is now
  `{ command: <node.exe>, args: [<@plur-ai/mcp js entry>] }`, for Claude Code,
  Claude Desktop, Cursor, Codex and Antigravity alike. When the js entry cannot
  be resolved (a CLI-only install), the pinned `cmd.exe /c npx` form remains
  the fallback. Re-running init heals an existing `plur-mcp.cmd` entry that init
  wrote, and a node-form entry whose `node.exe` or js entry no longer exists
  (after a Node upgrade or a version-manager switch); `plur doctor` reports
  such an entry as broken. Init's status line names which of these it healed
  and what it wrote, instead of "upgraded stale npx entry". A hand-written entry is never changed. An entry
  whose command is a bare `node` or `node.exe` is resolved through PATH, so
  doctor never reports it as missing, and init neither pins it to the
  version-specific node path nor replaces it with the npx fallback; this holds
  for opencode's `mcp.plur` too. `plur doctor` now also reports an opencode
  `mcp.plur` whose node path no longer exists (`opencode.mcpPlurMissingPaths`).
  Codex keeps its registration in `config.toml`, which init does not edit by
  hand. `plur doctor` flags any registration whose command is the old
  `plur-mcp.cmd` shim (`codexCmdShimMcp`, and Codex is not reported as wired),
  since it cannot start. When the registration is exactly that shim and
  nothing else, re-running `plur init --codex` replaces it through
  `codex mcp remove` + `codex mcp add`. A registration that also carries an
  `env` (inline or as a subtable), another key, or a multi-line `args` array is
  left alone, because the re-add would drop those settings: init says the
  entry fails to start and prints the `command` and `args` lines to set by
  hand under `[mcp_servers.plur]`, keeping everything else, env included.
- The warning about committing `.cursor/hooks.json` with a machine-local path
  fires again when that path is quoted, and `plur init --no-opencode` now says
  it skipped opencode because of the flag.

### Claude Code: corrections in a prompt now prompt a `plur_learn`

**The correction reminder never fired** (#1312). `plur hook-correction-detect`
spots correction-shaped prompts ("no, …", "from now on", "I prefer" …) and
reminds the agent to save the rule with `plur_learn`. No installer registered
it, so corrections were acknowledged in prose and lost.

`plur hook-inject` now runs the same detection on every `UserPromptSubmit`
and appends the reminder to its own output: after the memory on the first
prompt, alongside the 10-minute reminder when both are due, or on its own on
a later prompt. A prompt that does not match, including the known false
positives ("no problem", "actually that works", "wait a sec"), adds nothing.
There is no extra process per prompt and no `plur init` step beyond the one
for #1313. The standalone command still works for anyone who registered it by
hand; if you did, remove that entry, or the reminder appears twice.

Checked in a real Claude Code session: a second prompt starting "No, from
now on" carried the reminder, and the model quoted it back.

### Claude Code: memory is in place for the first reply

**The first reply of a Claude Code session had no memory unless it called a
tool, and a one-shot `claude -p` never had any** (#1313). `plur init`
registered the `UserPromptSubmit` injection as `async: true`, and Claude Code
delivers async context only at the next safe point. The rehydrate after
compaction (`SessionStart`, matcher `compact`) had the same problem.

Both are now registered synchronously with a 20s timeout. **Re-run
`plur init`** to move an existing registration; it replaces the old entries.
The hook bounds its own work below the timeout: hybrid search gets 8s
(`PLUR_HOOK_HYBRID_DEADLINE_MS`), then BM25 serves the turn, and the hook
exits by itself after 15s (`PLUR_HOOK_CEILING_MS`, was 55s). The inject lock
goes stale on the same clock, so a lock left by a killed run blocks for 15s,
not 55s.

Later prompts do not re-run the injection, so they add little. Measured on a
10,000-engram store (10.6 MB of YAML), each run a fresh process: the first
prompt took 2.3 to 2.5s, the rehydrate 2.3 to 2.7s, and a later prompt 68 to
101ms, against 34ms for a bare `node -e 0`. With no embedding cache, the
hybrid deadline is missed and BM25 answers in 9.1 to 9.3s.

When the hook exits past a hybrid search that missed its deadline, it first
waits, for up to 5s, for that search to finish, and then for any store lock
of its own still on disk. Without the wait, 10 of 12 runs on the same store
left an empty `engrams.yaml.lock` behind. Core cannot tell who owns an empty
lock, so every writer, including the next prompt's hook, waited out the 60s
stale threshold. Checking for the lock file alone was not enough: the
search's lock create can already be under way when the hook looks, and land
after it.

**A cold embedding cache now warms itself.** Core saves the embedding cache
only when a hybrid search finishes. A first prompt that falls back to BM25
exits before that, so a store with no cache stayed without one, and every
session's first prompt missed the deadline again. When the abandoned search
is still running at exit, the hook now starts one background build of the
cache: detached, at the lowest CPU priority, one per store at a time (the
`.embeddings-warming` marker), stopped after 60 minutes
(`PLUR_WARM_CEILING_MS`). It takes no store write lock. The next session's
hybrid search then meets its deadline.

### Codex and Antigravity hooks no longer leave a stale store lock

**The Codex `SessionStart` / `UserPromptSubmit` hooks and the Antigravity
pre-invocation hook could exit in the middle of a store write and leave
`engrams.yaml.lock` behind** (#1343), the same leak #1313 fixed for Claude
Code. They force-exit as soon as the turn is served, while a hybrid search
that missed its deadline is still recording its injection. With lock
acquisition slowed in a test, all three left an empty lock on every run;
the Claude Code hook did the same when its 15s watchdog fired mid-write.

Every force-exit now goes through one bounded wait (`lib/store-lock-exit.ts`,
moved out of `hook-inject`) until the process has no store lock work in
flight. The lock file alone could not show that: when one in-process writer
hands the lock to the next, the next one's create is already issued but is
not on disk yet. Core now exports `pendingStoreLockOps()`, a count of lock
operations that are queued, acquiring, held or releasing. The exit waits
until that count is zero and no lock file of its own is left, and it checks
both in the same step that calls `process.exit()`. The shared
Codex/Antigravity exit waits up to 5s, and the Claude Code watchdog up to 3s,
so it still exits before Claude Code's 20s timeout. The run the watchdog stopped
prints nothing and does not mark the session during that wait. After an
abandoned hybrid search, the Claude Code hook first waits for that search to
finish and then runs this check, both inside the watchdog budget. Hooks that never open the
store (Codex guard, post-tool and session-end; Antigravity guard) share the
exit, so they are covered if they ever start writing. Cursor hooks do not
force-exit and were not affected.

### The primary store is no longer registered a second time as a project store

**On some installs every engram was injected twice, under two ids** (#1319).
Store auto-discovery walks up from the working directory looking for
`.plur/engrams.yaml`, and skipped the primary store by comparing path strings.
When the primary path and the walk spelled the same directory differently —
a symlinked home, or `/var` versus `/private/var` — the check missed, and the
primary `engrams.yaml` was written into `config.yaml` as `project:<home>`. It
was then loaded once as the primary and once as a secondary with namespaced
ids, costing injection budget and splitting feedback between the two copies.

Now:

- Discovery and `addStore` compare canonical paths. `addStore` refuses the
  primary file under any spelling. If `config.yaml` already lists the primary
  file as a store, the error says that entry is ignored and can be removed.
  A second spelling of an already-registered local store returns
  `already_registered` with the scope of an entry that is actually loaded,
  preferring the scope you asked for.
- A `config.yaml` that already holds such an entry needs no edit. At load, a
  local store entry is ignored, with one warning, when its file is the
  primary file, or when both its file and its scope repeat an earlier entry.
  The entry stays in `config.yaml`, and writebacks start from the file on
  disk, so nothing is removed.
- `plur doctor` lists the store entries that are ignored at load (also in
  `--json`, as `ignoredDuplicateStores`), and the new `plur stores prune`
  removes the ones that name the primary store file, which stops the
  warning (#1356). It removes only those entries, leaves every other byte of
  `config.yaml` as it was (comments included), and writes atomically. If the
  `stores:` list is not in plain block style it changes nothing and says so.
  An entry that repeats another store's file and scope is still left for you
  to remove by hand.
- One file registered under two different scopes keeps loading under both,
  as before, because each scope admits different engrams. A warning says the
  two entries share a file, and that engrams scoped `global` in it appear
  under both scopes.
- Path comparison also holds for files that do not exist yet, such as a fresh
  install's `engrams.yaml`. `canonicalize` used to fall back to the path as
  written when it could not be resolved. It now resolves the deepest existing
  folder above it and re-appends the rest, so `/var/…/missing` and
  `/private/var/…/missing` compare equal. How directory trust matches
  symlinked and not-yet-existing folders is settled separately, in #1348.
- Path comparison also folds letter case on a case-insensitive filesystem
  (macOS, Windows) (#1357). `canonicalize` returns the on-disk case, so
  `~/Store/engrams.yaml` and `~/store/engrams.yaml` are one store. The CLI's
  copy of `canonicalize` now matches core's. In the folder map, a checked
  folder is compared in its on-disk case; an `off` entry still matches every
  spelling it matched before, and a `trusted` entry recorded in the on-disk
  case (as `plur trust` records it) now also covers other case spellings.
  `plur folders set`, `plur folders rm` and `plur untrust` find every entry
  recorded for a folder, including one that spells it differently: as
  typed, through a symlink, as `~/dup` beside its absolute path (both kept
  by the `trust.yaml` import), or in another letter case when the
  filesystem shows that spelling is the same folder (a sibling `pROJ` or
  `Ⓟ` on a case-sensitive disk is never taken for `Proj` or `ⓟ`). `rm`
  removes all of them, and `untrust` clears all their grants. `set` merges
  them into one entry and keeps what was in effect: a trust grant and a
  scope come only from entries that applied to the folder, and the scope
  kept is the one the resolver was using. An entry that matched only by
  its spelling never applied its grant or scope (only an `off` applies
  that loosely), so it can only make the mode more restrictive: its `off`
  or `ask` counts, its `on` does not. The most restrictive mode is kept
  unless you set one. `--scope` without a mode
  means `on`, also when it replaces a merged `off`.

### The secret guard now recognises GitHub, GitLab, Slack, npm, Stripe and AWS temporary keys

**A memory holding a GitHub token was stored, and could sync to a team
store** (#1317). `detectSecrets` had no pattern for vendor-prefixed tokens, so a
classic `ghp_…` token and a fine-grained `github_pat_…` token both scanned
clean.

Now flagged, each by the vendor's documented prefix, charset and length:

- GitHub `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` (`github_token`) and
  `github_pat_` (`github_pat`).
- GitLab `glpat-`, `gloas-`, `gldt-`, `glrt-`, `glrtr-`, `glcbt-`, `glptt-`,
  `glft-`, `glimt-`, `glagent-`, `glwt-`, `glsoat-`, `glffct-`
  (`gitlab_token`). GitLab bodies may legitimately contain `-` and `_`, so
  the body must also look random (mixed case or digits); a hyphenated slug
  after the prefix, as in a GitLab docs URL, stays clean.
- Slack `xoxb-`, `xoxp-`, `xoxs-` (with their 8+ digit workspace id),
  `xoxa-`, `xoxr-`, app-level `xapp-` and the token-rotation formats `xoxe-`,
  `xoxe.xoxp-`, `xoxe.xoxb-` (`slack_token`); a prefix followed by a short
  number and hyphenated words stays clean.
- npm `npm_` (`npm_token`).
- Stripe `sk_live_` and `rk_live_` (`stripe_live_key`).
- AWS temporary access key ids, `ASIA…`, under the existing `aws_access_key`.
  Because `ASIA` begins ordinary uppercase words, this branch needs exactly
  20 characters with nothing alphanumeric on either side and at least one
  digit, so region-like prose ("ASIAPACIFIC…") stays clean. The `AKIA` branch
  is unchanged.

Credentials are also matched against a percent-decoded copy of the text, so a
token inside an encoded URL or query string (`access_token%3D` then the token,
or an encoded `_` in the prefix) is found, and against a copy with JSON
backslash escapes unfolded, so a token after a literal `\n`, `\t` or `\r` in
JSON-escaped text or a pasted log is found (#1372). A token glued after a
digit is found too.

A credential finding no longer echoes the first 20 characters of the match,
which for a GitHub or npm token was the prefix plus 16 of its 36 secret
characters. It now shows the prefix (or the keyword of an assignment) and the
last four characters, such as `ghp_...WXYZ`; a value shorter than 16
characters after the prefix, such as a password, is not shown at all (#1373).
This is the text pack-scan issue details carry.

The `jwt` pattern no longer takes quadratic time on repeated `eyJ` input
(#1397). As a regex it took about six minutes on 1 MiB, the size packs and
engrams are scanned up to, so a crafted pack or engram could stall pack
install, preview or `learn`; every added scan view made it worse. It is now
matched in linear time, with the same results and no cap on segment length.

The same patterns apply to the pack scanner, so a pack carrying one of these
refuses to install (`docs/pack-scan-surface.md`). Text that only names a prefix,
such as "use a `ghp_` token", stays clean. No existing pattern changed except
`aws_access_key`, which now also accepts `ASIA`.

### A folder map records your per-folder decisions, and `trust.yaml` folds into it (#1347)

**First half of #1347: core and CLI only. No hook reads the map yet.** A new
file, `~/.plur/folders.yaml`, holds your own decisions about folders: `on`,
`off` or `ask`, a default write `scope`, and `trusted`. `trusted` is the grant
that used to live in `trust.yaml`. `.plur.yaml` is unchanged and stays the
repo's request. Only the CLI writes the map.

- **`resolveFolderPolicy(dir)`** (core, and `Plur.resolveFolderPolicy`) returns
  `{ mode, scope?, remoteAllowed, source }`, resolved in this order:
  1. Any matching `off` entry wins.
  2. A **trusted** `.plur.yaml`, or one that requests nothing, means on, exactly
     as before. A map `scope` beats its scope hint, and its remote is allowed
     only under a `trusted` entry. An **untrusted** `.plur.yaml` that requests a
     scope, domain or remote has those requests ignored. A map decision for the
     folder applies if there is one; otherwise the answer is `ask`, with
     `reason: 'untrusted-plur-yaml'` and what the repo `requested`.
  3. A project MCP config means on.
  4. Otherwise the most specific matching entry decides.
  5. Otherwise the answer is `ask`, and that includes `$HOME`.

  Paths may be globs (`*`, `**`, `?`) and may start with `~`. A plain folder
  also covers everything below it.

  **This changes behaviour for anyone whose `.plur.yaml` is not trusted**
  (owner decision D1, "ignore-ask"). A cloned repo can no longer choose where
  your saves go. Once the hooks use this resolver (the next PR), such a repo
  stops applying its scope hint and asks you once instead. Answering yes records
  `trusted: true` (plus a scope if you choose one), and the repo then works as
  it does today. Until that PR lands, the hooks behave exactly as before. To
  keep a repo working without being asked, run `plur trust <repo>` now.
- **`plur folders list | set <folder> | rm <folder>`.** `set` takes one of
  `--scope <s>`, `--on`, `--off` or `--ask`, plus optional `--trusted` or
  `--no-trusted`.
  - **Outside an interactive terminal, `set` and `rm` need `--nonce <n>`.** That
    is how the ask flow calls them, and it stops an agent from writing any
    folder, `--trusted` included, by leaving `--nonce` out. A person at a
    terminal needs no nonce. `plur trust` is the explicit alias for a person
    and still works in scripts.
  - A nonce names one folder and works once. It is used up only after the map
    is saved, so a failed write does not burn it. It expires when its session
    ends, after 24 hours at most.
  - `set` refuses a team scope (`group:`, `org:`, `team:`, `space:`, `public`)
    that no store in `config.yaml` serves. `project:` scopes live in the local
    store and need none.
  - Neither command writes to a folders.yaml it cannot read; it is never
    overwritten.
- **Upgrade needs no steps.** The first read of a missing `folders.yaml` imports
  the `trust.yaml` entries as `trusted: true` entries.
- **Trust is written to both files, for now.** The published opencode plugin
  still reads only `trust.yaml`. So until every adapter is on this core, each
  grant and each revocation updates both `folders.yaml` and `trust.yaml`. This
  covers `plur trust`, `plur untrust`, `plur folders set --trusted` and
  `--no-trusted`.
  - A revocation lands in both files, so neither an older reader, a downgrade
    nor a fresh import brings it back. This applies to `plur untrust`, to
    `--no-trusted`, and to `plur folders rm` of a trusted entry (owner decision
    F2). A `trust.yaml` line counts as the same folder under the map's own
    matching, so a `~/…` spelling, or a differently-cased spelling on a
    case-insensitive disk, is removed too. When a revocation matches several
    entries for the folder, the line of every entry that held a grant is
    removed. On a case-sensitive disk, the line of a sibling folder whose name
    differs only in letter case is kept. A revocation never adds anything to
    `trust.yaml`.
  - The one-time code is used up as soon as `folders.yaml` is saved, before
    `trust.yaml` is written (owner decision F3). If the `trust.yaml` write
    fails, the command reports the error, and the code cannot be used again;
    the next attempt needs a fresh ask.
  - Glob grants are recorded only in the map, because the old reader cannot
    express them.
  - A grant that an older core adds to `trust.yaml` after the import is not
    seen by this core until you run `plur trust` again.
- **Writes are serialised.** Every change to `folders.yaml`, `trust.yaml` and
  the nonce files is made under one lock. Before this, 12 parallel
  `plur folders set` runs all reported success but only 5 entries were saved.
- **`plur trust`, `plur untrust` and `plur init-remote`** now set and clear
  `trusted` in the map. Their output and exit codes are unchanged, with one
  exception: `plur trust` and `plur untrust` exit 1 on a folders.yaml they
  cannot read, rather than overwrite it. `plur init-remote` still writes
  `.plur.yaml` and exits 0, but warns that it could not record trust and leaves
  remote memory off until you run `plur trust`. It fails safe.
- A folders.yaml that cannot be read counts as empty and logs one warning. It
  never throws.
- **Trust matching is now in one place, the map, and it fails closed.** A
  stored entry is compared exactly as written with the checked folder's
  canonical path. It is never resolved on disk, and neither is its parent. So a
  trusted folder, or its parent, later replaced by a symlink does not pass its
  trust on to wherever the link points.
  - An entry imported from `trust.yaml` keeps its spelling. If an older version
    stored an entry under a symlinked parent for a folder that did not exist
    yet, run `plur trust` again once that folder exists.
  - `plur untrust` also removes an entry stored under the plain spelling of
    the folder you give it.
  - A `~` in the map expands to your home as written and to its canonical path.

### A refused write to one scope no longer pauses writes to the whole server (#1309)

**A few refused writes to one scope could stop queued writes to every other
scope on the same server** (#1308). Each failed outbox push counted toward the
per-host circuit breaker, including refusals: 401, 403 ("Cannot write to scope
..."), 404 and 422. Three of those opened the breaker, and the next flush then
skipped healthy writes to other scopes on that server for five minutes. A
refusal says the request was wrong, not that the server is down.

Now a 401/403/404/422 answer to an outbox push neither counts toward the
breaker nor resets it. Network errors, timeouts and 5xx still count, so a
server that is really down still opens it.

### Queued writes that can never succeed now say so (#1307)

**A queued team write the store keeps refusing was silent** (#1299). On one
developer store, ten writes had been refused with `403 Cannot write to scope`
on every attempt for twelve days, one of them 103 times. Session start,
`plur status`, `plur doctor` and the hooks said nothing. Only `plur outbox`
listed them, and only to someone who knew to look.

**Each outbox entry is now classified by its last failure.** `retrying` covers
the network, 5xx, 429 and timeouts, and those are retried as before.
`needs_action` covers 401, 403, 404, 422, an explicit "cannot write to scope"
refusal, and a scope with no writable store: retrying cannot fix any of these.
A failed push now records its HTTP status on the entry (`last_status`, an
additive field). Entries queued before this are classified from their error
text, and anything unclear counts as `retrying`.

**The `needs_action` entries are reported**, with count, scope, a one-line
reason and a next step, in the places below. There is one row for each scope
and reason: a scope holding both a 403 and a 422 gets two rows, each with its
own advice.
- the MCP `plur_session_start` result (`outbox_needs_action`, plus a line in `guide`);
- `plur status` and `plur_status` (`outbox_needs_action`, `outbox_attention`);
- `plur doctor`, as a failing `outbox` check. A write that only failed on the
  network does not trip it;
- `plur outbox` / `plur_outbox`: `state`, `reason`, `next_step` and
  `next_retry_at` on each entry, plus `retrying` / `needs_action` counts.

The next step names real commands: get write access and run `plur outbox
--flush`, check `plur stores list`, or move the entry with `plur rescope <id>
--to <scope>`.

**Back-off:** automatic flushes (session start and end, stop hooks,
`plur sync`) retry a `needs_action` entry at most once a day. They return the
number held back as `held`. `plur sync` (`outbox.held` in `--json`) and the
hook's stderr line report it, including when every entry was held back.
An explicit flush (`plur outbox --flush`,
`plur_outbox { flush: true }`, or `flushOutbox({ force: true })`) retries it
at once. **Nothing is dropped, rescoped or rewritten automatically.** Only the
retry bookkeeping changes: `attempt_count`, `last_attempt`, `last_error` and
`last_status`.

### SessionEnd finds the checkpoint for session ids with unusual characters (#1400)

**`plur hook-session-end` could miss the session checkpoint, so the session
was not auto-closed.** The Stop hook writes the checkpoint under a key that
**replaces** unsafe characters with `_`. The SessionEnd reader **stripped**
them instead. For a session id such as `a.b:c/d`, the writer produced
`a_b_c_d` and the reader looked for `abcd`. The reader now tries the `_` form
first, then the stripped form older writers used. `plur_session_end` got the
same fix earlier (#1301). Real Claude Code session ids are UUIDs, which both
forms leave unchanged, so only unusual ids were affected.

### Queued team writes now leave the laptop when a session ends (#1277)

**An enterprise deployment reported engrams that stayed on laptops** (#1269).
A team-scoped write that cannot reach its store is queued locally (the
outbox), and was retried only by the MCP tools `plur_session_start`,
`plur_sync` and `plur_outbox`, or by `plur outbox --flush`. No editor hook
retried it, and `plur sync` did not either — although `plur outbox` told you
it did.

**Session-end and stop hooks now flush the outbox**: Claude Code
`SessionEnd`, Codex `SessionEnd`, and Cursor `stop`. Each flush has a budget
that fits inside its hook's timeout (2.5s, 1.2s, 1.2s), and with nothing
queued it is skipped after a single file read; Cursor's `stop`, which fires
on every turn, retries at most once every five minutes. A throttle timestamp
dated in the future, from clock skew, counts as expired instead of blocking
the flush until the clock catches up. When the budget runs out the
in-flight push is cut and the rest stays queued, unchanged; a failing remote
leaves entries queued with the failure recorded, as before. The hook itself
never fails over it. `PLUR_HOOK_OUTBOX_FLUSH=0` turns it off and
`PLUR_HOOK_OUTBOX_FLUSH_MS` changes the budget.

**`plur sync` now flushes too**, and reports what happened: `outbox` in
`--json` output (`flushed`, `pending`, `warnings`), and a line for writes that
are still queued.

`flushOutbox()` takes an optional `{ timeoutMs }`. The clock starts after the
local store is loaded, so a large store does not use up the network budget.
The result has two new counts: `deferred` (entries it did not get to) and
`skipped` (entries held back by an open circuit breaker). `plur sync` now
reports skipped writes and the breaker's reason; before, it said nothing
about them. A cut is not counted as a failure against the host.

**A push that is cut, times out or throws is retried, with the same key.**
The server may have stored it before the answer arrived, and the client cannot
know. The owner decided this is not a "maybe delivered" state: the write stays
queued, the attempt is recorded (`plur outbox` shows it), and the next flush
posts it again. What makes that safe is the idempotency key.

**Idempotency keys are unique per write, and on the row before the first
POST.** An earlier version of this change derived the key from the engram id.
On a direct team write that id is the placeholder `__pending__`, and on queued
writes it is a per-day number that two machines share. A server following the
contract would have kept only the first write and reported the rest as
delivered. Now:

- every write gets a random UUID when it is created. It is stored on the
  queued write's outbox row before that write is first posted, and reused on
  every retry. A row queued by an older client gets a key minted and stored
  before it is posted, so a flush whose local write-back fails afterwards
  still retries with the same key;
- each queued write is *claimed* before it is pushed: a small file created
  with O_EXCL. So a flush and `learn()`'s own background push, or two flushes,
  never push the same write at once. Before, this race gave two server copies
  in half of the audit's runs. A claim is held while the process that made it
  is alive, however long its push runs, so a POST held open by a slow server
  cannot be re-pushed by a second flusher (a 15-minute cap covers a recycled
  process id). Taking over a stale claim is decided by O_EXCL too: one
  takeover marker per stale claim, so exactly one writer wins. Measured with 6
  processes racing for one stale claim: one winner in each of 60 rounds,
  where the earlier read-compare-rename takeover let 2 or 3 win in 26 of 60.
  A marker left by a writer that died cannot block the write;
- a claim is checked against the queued row, not against the flush's
  snapshot of it. A flush that reaches a write after another writer delivered
  it and released the claim re-reads the row, finds it gone, and skips it.
  Before, two racing flushes, three racing flushes, and a flush racing
  `learn()`'s background push each sent the same write twice, measured in
  separate processes against a server that ignores the key. Now each sends
  one POST per write;
- on a key-honouring server every write is stored once, and no write is ever
  dropped. A server that ignores the key gets one extra row for each attempt
  it stored but the client never heard back from, so there is no fixed bound
  per write: 3 flushes cut after the server stored the write, then 1 flush that
  completed, left 4 rows (#1463).

`docs/remote-store-contract.md` states this exactly: unique per logical write,
persisted before the first POST, stable across retries, deduplicated by a
key-honouring server within a 7-day window.

**A recall refused with 422 no longer trips the host breaker.** Like 401, 403
and 404 before it, and like the write leg (#1308), a 422 answer to a recall
neither counts toward the per-host breaker nor resets it. Three refused
recalls used to open a 5-minute cooldown that also parked queued writes to
every scope on the host.

**An empty `PLUR_PATH` no longer hides queued writes from the hook flush.**
The hooks' "is anything queued?" check treated `PLUR_PATH=""` as a path and
looked for `./engrams.yaml` in the current directory, so it skipped a store
under `~/.plur` that had queued writes. An empty value now counts as unset,
as it does everywhere else (#1395).

### Claude Code: one full injection per session, and the reminder fires (#1396, #1401)

**Every prompt in a Claude Code session re-ran the full "session started"
injection, and the 10-minute memory reminder never fired** (#1278). The
session marker in `plur hook-inject` was keyed on the parent process id.
Claude Code runs every hook in a fresh shell, so the id changed on every
prompt, and the "already started" check never matched. This is the same root
cause as the Stop counter (#1266).

The marker, the reminder clock and the concurrency lock are now keyed on the
payload `session_id`, sanitised with the shared session-key helper. They fall
back to `CLAUDE_SESSION_ID`, then the parent process id, only when the payload
has no id. The prompt stored for rehydration after compaction is now updated
on every prompt, not only the first.

The marker is written only after the injected context has been written to
stdout. A first-message injection that does not finish is retried on the next
prompt. That covers one that throws, one the hook's own 55-second watchdog
stops, and one the editor kills at its hook timeout. At most **2** full
attempts run per session. After that the hook stops retrying. It marks the
session and prints a one-line notice that automatic memory was skipped and
suggests `plur_session_start`. There is no keyword-only fallback, because
whatever stopped the full injection (a store too slow for the timeout, or one
that does not load) would stop it too. Rehydration after compaction is not
counted and not capped.

The concurrency lock is released when the injection throws, and the watchdog
removes it before exiting. Before, the lock stayed in place, and every prompt
in the next 55 seconds exited silently. A run the editor kills outright can
still leave the lock. The next prompt after the lock goes stale (55 seconds)
then retries, within the same 2-attempt cap.

Checked in a real Claude Code session: before, the second prompt of a resumed
session got a second full injection; now it gets none.

`plur_session_end` also looks for the session checkpoint under the key the
Stop hook writes. That hook replaces unsafe characters with `_`, while this
reader stripped them, so a session id with such characters left its checkpoint
behind, and the next session reported it as orphaned.

### Claude Code now actually receives injected memory (#1303)

**In Claude Code, automatic memory never reached the model** (#1274). An
enterprise deployment reported that most folders had no automatic memory.
`plur hook-inject` printed `{"additionalContext": ...}` at the top level.
Claude Code records that as plain hook output and does not show it to the
model. The same bug hit the Stop nudge (#1266).

Every Claude Code event that `hook-inject` serves now prints
`{"hookSpecificOutput":{"hookEventName":<event>,"additionalContext":...}}`,
named after the event that fired: `UserPromptSubmit` (the first-message
injection and the 10-minute reminder), `PreToolUse` (plan mode, skills,
agents) and `SubagentStart`. The name comes from the payload's
`hook_event_name`, or from how the hook was invoked when the payload has none.

**Re-injection after compaction moved from `PostCompact` to `SessionStart`
(matcher `compact`).** `PostCompact` cannot carry context at all. Claude Code
rejects `hookEventName: "PostCompact"` with a visible validation error and
ignores the top-level field. **Re-run `plur init`** to move the hook. Until you
do, the old `PostCompact` entry prints nothing. The `SessionStart` payload has
no compaction summary, so the rehydrate query now comes from the session's
last prompt, stored per Claude Code `session_id`. That copy is private: the
session directory is created 0700 and must be a real directory this user owns.
A planted symlink, or a directory another user created, is refused, and state
moves to `hook-sessions/` under the PLUR root instead, but only if that directory
passes the same check. If both are refused, the hook keeps no state at all and
still injects. A refused directory is never written to. The file is written 0600
through an exclusive, no-follow temp file and a rename, so a symlink at its path
is replaced, never followed. It keeps only the first 1000 characters, and the
SessionEnd hook deletes it. On Linux `$TMPDIR` is usually the shared `/tmp`.
The Stop hook's counter follows the same rule, and so does its session
checkpoint in `<PLUR root>/sessions`. An empty `PLUR_PATH` now means "unset"
wherever the hooks resolve the PLUR root, so it never resolves against the
working directory.

This fix alone kept both registrations `async: true`, so the context arrived
only at the next safe point, not on the turn that triggered it. Both are now
synchronous: see "Claude Code: memory is in place for the first reply" above
(#1313).

An unknown `--event` no longer echoes the hook payload back to stdout.

**`plur-mcp init` now registers the same rehydrate hook** (#1279). It still
put rehydrate on `PostCompact`. It now uses `SessionStart` with matcher
`compact`, synchronous with `timeout: 20`, the same as `plur init` (#1313);
its `UserPromptSubmit` injection moves to the same 20s budget. A test fails
if the two diverge. Re-running `plur-mcp init` used to stop at "already
installed". It now removes PLUR's `PostCompact` hooks and, in the same file,
puts the `SessionStart(compact)` one in place of the old rehydrate. A file
with PLUR hooks but no rehydrate gets none added. That covers the global
settings file, where `plur init` puts only its enforcement hooks, so
rehydrate does not run twice. Hooks with no `command` (`type: "prompt"` or
`"agent"`) no longer make init throw. It removes PLUR's hooks one at a time and only
those: a hook counts as PLUR's when it runs the PLUR binary (the
`~/.plur/bin/plur-hook` shim or `npx @plur-ai/cli`) with a subcommand init
writes. Your own hooks, including your own `PostCompact` hooks and one that
shares an entry with a PLUR hook, are left in place. Installs that use the
local shim, including the backslash and quoted Windows paths, now count as
installed too, so re-running no longer adds a second set (#1303, on Windows
as well).

### A killed writer no longer stalls the store for a minute

**A process killed while taking the store lock left an empty
`engrams.yaml.lock` that blocked every other writer for the full 60s stale
threshold** (#1354). The lock was created first and its owner token written
second; a process killed in between (SIGKILL, a hook killed at its harness
budget) left a file with no pid in it, so the liveness check that recovers
from a dead holder at once had nothing to check. Hooks, the MCP server and the
CLI all waited it out.

Now:

- Core publishes the lock complete. The token is written to a private file and
  hard-linked into place, which fails on an existing lock exactly as the
  exclusive create did. A kill at any point leaves either no lock or a lock
  naming a dead pid, which is taken over at once. Measured: an observer
  process polling the lock during 3,000 acquisitions saw an empty lock 4,115
  times before this change and never after it.
- An empty lock older than 10s is treated as abandoned and taken over. Empty
  locks can still come from older clients sharing the store and from
  filesystems without hard links. The 10s comes from measurement: over 20,000
  create-then-write cycles the gap was at most 0.73s, p99 10–117ms depending
  on event-loop load.
- Takeovers are serialized by a ladder of guard slots
  (`engrams.yaml.lock.guard-<key>-<n>`, keyed by the token of the lock being
  taken over). A slot left by a crashed stealer is stepped over, never
  removed, so a crash inside a takeover cannot let two stealers in at once. A
  single guard file had that flaw: after two crashes, two stealers could both
  hold it. Under its slot, a stealer re-inspects the lock and claims it only if
  it is the same file and still abandoned. This closes an older race that applies to every takeover,
  including the immediate one for a dead holder. Two waiters that judged the
  same abandoned lock could both act on it. The second one moved the first
  one's fresh, live lock aside, and while it was putting that lock back, a
  third process could acquire it. A test that pauses a takeover at that point
  shows two holders without the guard and none with it. The claim also checks
  that the file it moved is the one it inspected, not just that the contents
  match, and it puts a live owner's lock back by hard link, so the lock is
  never briefly empty.
- A lock carrying a token is unchanged. A live owner is never stolen from,
  however old the lock. A token that cannot be checked, such as one from
  another host, still gets the full 60s.

This applies to the YAML store, and to PGLite, which keeps YAML as its source
of truth and takes the same lock. A Postgres primary store serializes writers
with a Postgres advisory lock and does not use this lock file.

### A team save is no longer swallowed by a personal note with the same text (#1268)

**A shared-scope write whose text matched a personal engram was never
written.** Cross-scope recurrence (#176) matched any active engram with the same
content hash in a different scope, and on a match it updates that engram
*instead* of writing a new one. So a `group:` or `project:` learn identical to
something in `global`, `local`, `user:` or `agent:` bumped the personal note's
recurrence count and nothing reached the team scope. Found while triaging an
enterprise deployment's report of team saves that never reached the team store.

**A shared-scope save now always writes its team copy.** It is never absorbed
into another engram — not a personal or `global` one (including one the
recurrence ladder graduated, or one you moved to `global` yourself with
`rescope`), and not another team's engram either: a save to `group:a/ops` whose
text matches an engram in `group:a/eng` now reaches the ops store instead of
vanishing into the eng engram. The matching engram is still credited: the team
save is recorded on it as a recurrence (counted, with a source marked
`validated_by` the team scope, and commitment escalated by the usual ladder).
You may end up with several engrams with the same text — your own and each
team's — and that is intended. `plur import` follows the same rule: a record for
a shared scope whose text exists elsewhere is imported into its own scope, and
`--dry-run` now predicts that instead of reporting it as a duplicate.

**What is in a team store stays there.** When the ladder would broaden a
team-bound engram to `global` — one served by, queued for, or in the scope of
any team store, a url store or a `shared: true` file-path store — it now leaves
that engram exactly as it is and creates, once, a `global` copy in your local
store instead. The copy points back at the team engram (`derived_from`), its
first source records `promoted_from` the team scope, its commitment escalates
as the ladder would, and it is never queued for or pushed to a team store.
Later recurrences credit the same copy. A team engram still queued for its
store also records the recurrence on itself (count and source; its scope and
queue entry are kept). The copy keeps the
team engram's validity window, knowledge anchors and dual coding; it does not
take its pin (a pin spends your own injection budget) or its relations (they
name team-store ids). When a `global` engram with the same text already exists,
the ladder credits that one rather than creating a second. Before, the team
engram could be rewritten to `global` in the team's own file, or rewritten
locally and then pushed to the team store as `scope: global`. Non-shared
file-path stores still broaden in place.

Personal→personal recurrence, and a personal save recurring onto a shared
engram, behave as before.

**How far the ladder may escalate is now a setting.** `recurrence.max_commitment`
in `config.yaml` caps the commitment the cross-scope ladder can reach — team
validation and the promoted `global` copy included:

```yaml
recurrence:
  max_commitment: locked   # default: the ladder may lock a rule
  # max_commitment: decided  # stop one step below; only an explicit act locks
```

A config without the key behaves as `locked`, which is what the ladder has
always done. An unresolved tension still blocks the step into `locked` either
way — on the engram itself, on the promoted `global` copy, and on an existing
`global` engram the ladder credits instead. The ladder only moves the four rungs
`exploring → leaning → decided → locked`; a `draft` engram (pending approval)
or any other value is never advanced.

### A team save that stays on this machine now says so (#1264)

**A write to a shared scope with no store registered for it never left the
machine, and nothing said so.** An enterprise deployment reported engrams that
were created and never reached the team. A `learn` to `group:`/`project:`/`org:`…
with no writable url store for exactly that scope falls through to the local
store — deliberately, since nothing is auto-routed into a shared store — but
`plur_learn` answered `decision: "ADD"` and `plur learn` printed nothing else.

Every learn result now carries `delivery`: `remote` (a store accepted it),
`outbox` (saved here and queued for a store — the push is deferred or failed and
will be retried) or `local` (on this machine only). A shared scope that lands
`local` also carries a warning naming the scope and how to register a store for
it. `plur_learn` returns both (`delivery`, `delivery_warning`); `plur learn
--json` does too, and plain `plur learn` prints the warning even with `--quiet`.
Core exposes the same answer as `plur.deliveryOf(engram, requestedScope?)`.

When a save to a shared scope comes back as an engram in a *different* scope —
recorded as a recurrence on another team's engram, or on a `global` one — the
result is `local` and the warning names the scope you asked for and says nothing
was written there. Before, the warning named the other team's scope (the one
you did not write to), or there was no warning at all.

A save that matched an existing row is classified by the store that actually
holds that row. With a url store and a local path store registered for the same
scope, a match on the path store's row is reported `local`, not `remote` —
nothing was sent anywhere.

Nothing about where engrams are written changes. The field is additive.

### `plur stores add` can register a remote store, and checks the token first (#1265)

**An installer script can now connect a machine to a team store without MCP**
(#1265). An enterprise deployment reported that its installer had no way to do
this: `plur stores add` took only `<path> <scope>`, the one command that could
add a url store was the MCP tool `plur_stores_add`, and the advice printed by
`plur stores discover` and `plur login` pointed at a command that could not do
it.

```
plur stores add --url https://plur.example.test --scope group:example/eng --token-env PLUR_TOKEN
```

The token can also come from `--token <t>` or from stdin with `--token -`, so it
need not sit in shell history.

**Nothing is written until the server agrees.** The command asks the server's
`/me` first. A rejected token, an unreachable server, or a scope the token is
not authorised for exits 1 and leaves `config.yaml` as it was; the scope refusal
lists the scopes the token can reach. Running the same command twice exits 0
and says "already registered" without touching the file. The same url and scope
with a *different* token replaces the stored token, but only after the new one
verifies — a token the server rejects never overwrites a working one.

**A scope that already belongs to another store is never taken silently.** The
command refuses, changes nothing, and says to re-run with `--overwrite-scope`.
With that flag the scope is reassigned to the url store, and only after the
token has passed `/me`.

The token is never printed: not in text output, not in `--json`, and not in an
error, including an error that echoes the server's reply. That covers the token
raw, percent-encoded, JSON-escaped and base64-encoded, and a scope or username
in the server's `/me` answer that carries the token (such scopes are left out
of the listed authorised scopes, and the message says how many were withheld).
A fragment of the token, or its base64 buried inside a larger blob, has no
fixed form and is not caught. `plur stores add
<path> <scope>` is unchanged. The core method is `Plur.addRemoteStore()`, which
throws `AddRemoteStoreError` with a stable `code`.

### The end-of-response learning nudge now reaches the model in Claude Code

**The Stop hook's "did you learn something?" nudge was never shown to the
model** (#1266). `plur hook-learn-check` printed a top-level
`{"additionalContext": ...}`, which Claude Code records as plain hook output
and drops. Checked in a real session: a codeword sent that way was never seen;
the same codeword sent as `hookSpecificOutput` was.

It also could not fire on schedule. The every-3rd-response counter was keyed
on `CLAUDE_SESSION_ID`, which Claude Code does not pass to hooks, and fell
back to the parent process id — a fresh shell on every Stop. So every Stop got
its own counter and never reached 3.

Now:

- The nudge is sent as
  `{"hookSpecificOutput": {"hookEventName": "Stop", "additionalContext": ...}}`,
  the shape Claude Code delivers. Delivery works by giving the model **one extra
  turn**. The prompt is written for that turn: call `plur_learn` if something
  is worth keeping, otherwise reply "ok".
- The hook never nudges on a Stop that carries `stop_hook_active: true` — the
  turn its own nudge forced — and does not count it. Sending the nudge on every
  Stop looped (about ten empty turns per prompt).
- The counter and the session checkpoint are keyed on the payload
  `session_id`, sanitised with the shared session-key helper, falling back to
  `CLAUDE_SESSION_ID` and then the parent process id only when it is absent.
- On every other Stop the hook prints nothing. It used to echo its input
  payload back to stdout, which Claude Code parses as hook output — at best
  ignored.

Cost: one short extra turn every third response.

### An unscoped write can no longer land in a team store

**If you wrote an engram without a scope, it could be auto-routed into a shared
team store and pushed to that store's remote** (#1115). The only signal was an
`info` field in the response, easy to miss across a long session — and once the
copy was remote, local cleanup could not undo it.

The decision was narrower than it looked. A write whose `domain` began with a
segment that a shared scope declared in its `covers` was routed there
deterministically, bypassing the confidence gate, whatever its tags or its
statement said. `plur_suggest_scope` weighed all three channels, so it could
name one scope while an unscoped write landed in another.

**Auto-routing now refuses a shared scope.** Unscoped writes still route among
personal scopes (`local`, `global`, `user:*`, `agent:*`), where a wrong guess
costs nothing a `plur_rescope` cannot fix. A shared candidate is passed over —
the next eligible personal one still wins — and the response names the scope it
declined and how to choose it deliberately. Promotion into a team store is now
something you ask for.

Both surfaces share one decision function, so `plur_suggest_scope` reports what
an unscoped write would actually do (`would_route`) rather than an
approximation of it.

Explicit scopes are untouched: `plur_learn` with `scope: "group:acme/eng"` still
writes there. An install that genuinely wants covers-driven team routing can set
`scope_routing.allow_shared_auto_route: true` — deliberately, and in writing.

**Both batch and CLI writes now report the outcome too.** `plur_learn_batch`
echoed neither decision — a batch write could route, or be declined from a
shared scope, with no signal of either reaching the caller — and the CLI read
both markers only to decide whether to print a domain hint. Each result now
carries `routed` / `route_refused`, and a batch summarises any refusals once at
the top level, because a key on item 34 of 50 is not a signal.

### A remote write now says who chose its scope

**A server receiving a write could not tell a scope you typed from one the router picked** (#1221). The body carried the scope string and nothing else; `structured_data`, where the routing decision is recorded, never crossed the wire, and no client name or version was sent either.

That is why the leak above could not be answered on the server side. Every proposed mitigation had to act on the scope alone, which meant acting on every write to a shared scope — deliberate ones included.

Writes now carry `scope_source`: `explicit` (named on the call), `session` (a session or `.plur.yaml` scope was in effect), `default` (nothing named it) or `routed` (the router chose it). It is produced by the one constructor both write paths share, so the shape a server receives and the shape written locally cannot drift, and it is omitted when absent so an older outbox entry sends nothing rather than claiming something it cannot vouch for.

Nothing about routing changes. The decision was always made; it was simply not legible to the other side of the wire.

### Pinned engrams can be marked hard or soft

**A pin can now say how much it matters** (#1082, #1203). `learn()` takes
`pin_tier: "hard" | "soft"` and `pinned_priority` (an integer from 1 to 100),
stored on the engram as `pinned_tier` and `pinned_priority`.

The tiers live inside the pinned budget you already have, not beside it.
The hard tier is a sub-cap of the pinned quota — `injection.pinned_hard_ratio`
of it, default 0.5, so 500 tokens at the default `injection_budget` of 2000 —
and the soft tier gets whatever the hard tier leaves. Within each origin
(your primary store, then `stores:`/remote, then packs) hard pins are selected
first, then soft pins by priority, then by relevance score. Origin stays the
outer key, so a tier can never lift a pack pin above one of your own.

**If you never set a tier, pinning behaves as before**: the same quota, the same share,
the same order and the same `omitted_pinned` reasons (the one estimate correction below aside).

A write that would grow the hard tier past its cap is refused, and every write
path that can produce a hard-tier engram is checked under the store lock:
`learn()`, both halves of `learnRouted()`'s remote route, re-pinning through
`setPinned()`, `updateEngram()` and `saveMetaEngrams()`. The check charges the
same cost injection charges — the rendered text — so admission and injection
cannot disagree. Unpinning clears the tier and priority; packs cannot carry
either. Anything that does not fit at injection is reported in `omitted_pinned`
as `hard-tier-cap` or `soft-tier-budget` rather than dropped silently.

The tier is not yet sent to remote stores: a tiered write to a remote scope
lands there as an ordinary pin until the server accepts the two fields.

**`injection.pinned_ratio` now sets the pinned share at injection too.** It
already set the quota enforced when pinning, but injection used a fixed 0.5, so
with any other value the two disagreed. With the default of 0.5 nothing changes.

**The injection cost estimate now counts `claim_class`.** It is rendered as
`Kind: …` in the meta line and was not charged, which let a rendered field
carry unbudgeted text into the prompt. Engrams with a `claim_class` cost a few
tokens more.

## 0.20.1

### opencode reaches PLUR Enterprise

**If you use PLUR Enterprise from opencode, your team memory was silently never
arriving** (#1207, #1208) — the same failure 0.20.0 fixed for Codex and Antigravity,
in the one adapter that fix did not reach.

`@plur-ai/opencode` merged 25 minutes before the directory-trust gate that
makes a project's `remote_url`/`remote_token` safe to adopt, and the follow-up
that spread that gate across the other adapters never came back to it. So the
plugin picked up your `.plur.yaml`'s `scope` and dropped its remote settings.
Recall served local memory only — while explicit `plur_*` MCP tool calls still
reached the server, which reads as half-working rather than broken.

**The plugin now dials**, behind the same gate as everything else: a
`.plur.yaml` from a directory you have run `plur trust` on gets its remote
settings honored; from a directory you have not, they are dropped and a warning
names the directory and the command. Those two fields are a stronger grant than
`scope` — they send prompt text to the host the file names, under the
credential the file carries — so the gate is not optional, and a repo you
merely cloned cannot supply both.

**If you already have a `.plur.yaml` with remote settings**, run
`plur trust <project-dir>` once. `plur init-remote` has made that grant
automatically since 0.20.0, but a file written before then predates it.

The gate itself moved from `@plur-ai/cli` into `@plur-ai/core`, where an
adapter outside the CLI package can take the capability and the gate together
instead of copying one without the other. No CLI call site moved.

Ships as `@plur-ai/opencode` 0.1.1, alongside the core release that carries the
shared gate.

Verified live, not just in unit tests: a real opencode session against
`plur.datafund.io`, with the local store holding zero engrams and zero
configured stores, pulled 7 team engrams into the injected block and answered
from them. `packages/opencode/test/e2e-enterprise.manual.mjs` is that run, kept
as a manual gate — it asserts on the injected block and on the breaker's own
per-host dial state, and reads the token from stdin because the agent under
test can run `env`.

## 0.20.0

opencode agents get persistent memory!
- plur init --opencode
- Engram creation upgraded
- Team memory fixed for Codex
- Bug fixes and security upgrades

`@plur-ai/opencode` (#1195) is covered in full below. The other headline of this
release is that the engram-authoring skill finally reaches users — both halves of
that were missing (#1190, #1191).

Until now `npm i -g @plur-ai/cli` carried no engram-authoring guidance at all,
and `plur init` never installed any. `skills/plur-create-engrams/` had existed,
been maintained, and been version-stamped by the release script on every release
— while shipping to nobody.

Two independent gaps, each invisible on its own. `packages/cli/package.json`
declares `files: ["dist"]` while `skills/` lives at the **repo root**, and
`files[]` is package-relative, so no manifest entry could ever have reached it —
adding `"skills"` there ships nothing at all. And `plur init` had no
skill-installation leg; its single `Skill` reference is a `PreToolUse` matcher
that fires *when* a skill is invoked, a different thing that reads as coverage at
a glance. Meanwhile the per-release version bump made the skill look shipped in
every diff.

Engram quality degraded accordingly: the guidance on what earns a place in
memory, and how to write a statement, rationale and boundary that still hold
months later, was not present while engrams were being written.

How it works now. The build copies the tree into `dist/`, which `files: ["dist"]`
already ships, so no manifest change — and all of it travels, `SKILL.md` plus the
`references/` the skill tells the agent to read before serialising, which are the
part that actually carries the format. `plur init` installs to `skills/` beside
the `settings.json` it is already writing, so it follows init's existing scope
choice: `--global` lands in `~/.claude/skills/`, project mode in
`./.claude/skills/`. No new flag. The leg is idempotent, is contained like the
harness legs so an unwritable directory cannot abort the hooks and MCP
registration, and says so when it overwrites a skill you had changed locally
rather than clobbering in silence.

`plur-memory` and `plur-session-end` ride the same path and are installed too.

### A new PLUR integration: `@plur-ai/opencode`

**opencode agents now get persistent memory too, with no tool call required.**
A new package, `@plur-ai/opencode`, adds automatic recall, automatic learning,
and learn-before-compaction to the [opencode](https://opencode.ai) agent
harness (#1195). It ships on its own version track (`--opencode <ver>`), starting at
0.1.0, independent of this release's version — the same arrangement as
`@plur-ai/claw` and `@plur-ai/dsh`.

Structurally this is the same integration shape as `@plur-ai/claw` — an
in-process TypeScript plugin driven by lifecycle hooks rather than a subprocess
bridge or JSON hook shim — and the second example toward extracting a shared
`HarnessAdapter` interface (#1034).

- Recall runs once per user turn (`chat.message`) and caches a rendered memory
  block; the system prompt is rebuilt from that cache once per model request
  (`experimental.chat.system.transform`) without recalling again.
- That split exists because injecting at `chat.message` persists into session
  history and **accretes**: measured against a real opencode 1.18.30 binary,
  one stale memory block landed in the transcript per turn, forever — 1, 2, 3
  across three turns. That half is soundly measured. The system-prompt half is
  not shown by the matching 0, 0, 0 message-history count — that run had
  `chat.message` injection off, so nothing was ever available to land in
  message history regardless of what the system prompt did. What actually
  shows `system.transform` doesn't accrete: the `system[]` array's length
  measured `1->2` on every model call of a tool-calling turn, never `2->3` — a
  rebuilt array each request, not a growing one. A live acceptance gate
  (`packages/opencode/test/e2e.manual.mjs` — not part of `pnpm test`, needs a
  real binary and network) drives an actual opencode session and asserts the
  accretion count stays at 0.
- Two learning paths, mirroring claw: the model's own `🧠 I learned:`
  self-report, and user corrections/preferences detected at confidence ≥ 0.7.
- `plur init --opencode` writes both layers opencode needs: the `plugin` entry
  (automatic, this package) and an `mcp.plur` entry (`@plur-ai/mcp`, explicit
  tools) — the same three-layer strategy PLUR already commits to elsewhere.
- **Not yet published to npm.** opencode resolves a bare plugin name by
  fetching it from the npm registry at load time; until `@plur-ai/opencode` is
  published, that entry silently resolves to nothing, with no error anywhere
  in opencode's log. `plur init --opencode` writes a config that looks correct
  and does nothing until the package is on npm. See `packages/opencode/README.md`.

### Security follow-up on the opencode integration (2026-09)

A follow-on adversarial audit of `@plur-ai/opencode` (above) found five more
defects. Two reach shipped packages beyond opencode itself and are the ones
worth knowing about even if you never touch opencode.

- **A negation-inversion bug in the shared extractor is fixed, and it reaches
  `@plur-ai/claw` too.** `learner.ts`'s `CORRECTION_PATTERNS` and
  `PREFERENCE_PATTERNS` used to capture only the TAIL of a match — the text
  after a directive word, or the half of an "X, not Y" contrast before
  "not" — so "never commit the API key" was extracted as the standing
  instruction "commit the API key," and "Deploying straight to production is
  not allowed" as "Deploying straight to production is." Closing it took
  three passes because each fix was narrower than the bug: `always` / `never`
  / `you should` / `you must` / `don't` / `do not` now capture the WHOLE
  match instead of the tail, and the "X, not Y" pattern — which ran FIRST, at
  higher confidence, and so pre-empted the other fixes — is narrowed to
  require a literal comma before "not" (matching "use pnpm, not npm" but not
  a bare "is not allowed") and now also captures the whole match rather than
  the half before "not." Pattern-group order changed too: the narrower,
  keyword-anchored patterns run before the broad comma-based one, so a future
  addition to either group inherits "narrow before broad" instead of relying
  on someone remembering it. `@plur-ai/claw` shares this exact code
  (`packages/claw/src/learner.ts` re-exports it) and both its real-time
  `ingest()` gate and its ungated `compact()` extraction path are affected.
- **A read-only scan for engrams the bug already wrote.** `plur audit
  --source engrams` (new) scans a store's own statements for the two
  truncation shapes above. Heuristic, and honestly documented as such — it
  never rewrites anything; a human reviews each suspect and decides whether
  to fix, retire, or dismiss it.
- **`plur trust` / `plur untrust`** are new commands: a one-time,
  per-directory grant — the same shape as `direnv allow` — that an adapter
  checks before adopting a `.plur.yaml`'s `scope` / `domain` / `remote_url`.
  `plur trust` now prints what it authorizes (the scope/domain/remote_url a
  `.plur.yaml` at that path declares) instead of only the path, the same way
  `direnv allow` shows you the `.envrc` at the one moment a human is actually
  in the loop. `plur untrust <subdir-of-a-trusted-repo>` used to report "was
  not trusted" when an ancestor's grant still covered it — false of the
  actual question a revocation command on a security primitive is answering
  — and now names the covering ancestor and the command that actually
  revokes it.
- **`plur_session_end`'s auto-harvested `engram_suggestions` are now scanned
  for prompt injection** — a shipped-package behaviour change.
  `detectPromptInjection` (previously reachable only from pack installs) now
  also runs on every write tagged `claim_class: 'inferred'`, which includes
  both `@plur-ai/mcp`'s own session-end suggestions and
  `@plur-ai/opencode`'s auto-harvested statements — closing the gap where an
  adapter learning from text an agent merely READ (a webpage, a quoted file,
  tool output) could write attacker-authored instructions into the store
  unchecked. This can refuse a legitimate write: the patterns are broad
  enough that "After the migration you are now on schema v7" trips
  `role_override`, and "The app has a developer mode toggle" trips
  `jailbreak_mode`. A refusal is per-item, not per-call —
  `plur_session_end` reports each failed suggestion in `engrams_failed[]`
  (index, truncated statement, error) and still stores the rest of the
  batch — and `Plur`'s default `autoDiscover` behaviour (which used to walk
  `cwd` for a `.plur/engrams.yaml` and silently register it as a store in
  the user's GLOBAL `~/.plur/config.yaml`) is now something `@plur-ai/opencode`
  opts out of explicitly (`autoDiscover: false`) rather than something every
  adapter inherits by default without knowing it.

### A runbook for hook timeouts

**If a hook times out and your agent starts with no memory, there is now a page
that says what to do** — [`docs/runbooks/hook-timeouts.md`](docs/runbooks/hook-timeouts.md).

Codex, Antigravity and Cursor hooks are synchronous and therefore bounded (25s,
20s, 10s). They cannot be async: an async hook's context is delivered at the
harness's next safe point, which is not the turn that asked for it. Claude
Code's 90s async hook absorbs a slow first recall; the others have to fit.

The tuning knobs existed but were documented nowhere a user hitting a timeout
would look. The runbook names them, and separates two failures that look
identical and want opposite fixes: a missed hybrid deadline (memory arrived,
keyword-only — raise the deadline) versus a hook killed at the harness budget
(nothing arrived — *lower* it, so the fallback starts sooner, or take the local
embedder out of the hot path). The existing stderr hint advises raising, which
is right for the first and wrong for the second.

### Team memory now reaches Codex and Antigravity (Cursor still pending)

**If you use PLUR Enterprise from Codex or Antigravity, your team memory was
silently never arriving** (#1198, #1199). Cursor was affected too and is not yet
fixed — see below.

`.plur.yaml`'s `remote_url`/`remote_token` were read by exactly one integration.
Every other adapter picked up the project `scope` and dropped the remote
settings, so recall served local memory only — with no error and nothing to
explain the absence. Following the documented `plur init-remote` setup gave you
working team memory in Claude Code and silence everywhere else.

**Codex and Antigravity now dial** — both Codex hooks and the Antigravity
pre-invocation hook carry the project's remote settings and reach the server.

**Cursor still does not, and this release does not fix it** (#1200). Its only
injecting hook is bounded at 10s with no async option, so it must stay on the
fast keyword-only path; the remote leg currently rides inside the hybrid search
that also loads the local embedder, which that hook cannot afford. The remote
leg does not actually need the embedder — it sends the query text and the server
embeds — so the fix is to separate the two, and it is tracked rather than
rushed. Cursor also recalls only once per conversation, at session start, which
is a limit of what its hook schema can return.

One helper decides this for every adapter, so the trust gate above travels with
the capability rather than being reimplemented per harness — an adapter cannot
adopt a project's remote settings without the gate coming with it.

**If you already have a `.plur.yaml` with remote settings**, run
`plur trust <project-dir>` once: it predates the automatic grant that
`plur init-remote` now makes. Until you do, those harnesses serve local memory
and say why.

### Security: a cloned repo could send your prompts to a host it named

**A repository you cloned could exfiltrate your prompt text**, on every prompt,
with no action beyond opening it (#1196, #1197).

`hook-inject` adopted a project `.plur.yaml`'s `remote_url` and `remote_token`
without any check. Both come from the file, so a hostile repository supplied the
destination *and* the credential — it needed no remote store of yours and no
scope to guess. The file also satisfied the guard that keeps the hooks silent on
non-PLUR projects, so a project you never opted in was still covered.

**Adopting a project's remote settings now requires trusting the directory**,
granted once with `plur trust <dir>` and recorded under `~/.plur/` so nothing
inside a repository can vouch for itself. The gate is on the directory rather
than on what the config says — the same shape as `direnv allow` and
`git config safe.directory`. It fails closed, and when it refuses it says so,
naming the directory and the command.

- **Only the remote fields are gated.** `scope` and `domain` are local
  visibility filters that send nothing anywhere; they are unaffected, so a
  project using `.plur.yaml` purely for scoping sees no change.
- **`plur init-remote` trusts the directory it configures**, so the documented
  PLUR Enterprise setup is uninterrupted — running it is the explicit act the
  grant represents. It already keeps `.plur.yaml` out of git because the file
  holds an API key, so a committed one was always outside that flow.
- **Enforced immediately rather than warned about first.** A warn-only release
  would leave prompt text reachable for a full cycle.

If you maintain a `.plur.yaml` with remote settings by hand, run
`plur trust <dir>` once in that project; until then PLUR serves local memory
only and tells you why.

### Nothing is silently dropped

An injection payload is read head-first. Until now it led with `DIRECTIVES` —
process hygiene — and placed `CONSTRAINTS`, the prohibitions, behind it; under
budget pressure it then shed `CONSTRAINTS` *first*, and a test enforced that
order. Measured on a real store, the constraints section began 35,260 characters
in, behind 34 directive engrams: far enough that any partially-read payload
reliably contained none of it. The ordering is inverted, and the guarantee with
it (#1138).

- **`CONSTRAINTS` is emitted first, and is never dropped in silence.** In the
  dsh block, where whole sections are shed, constraints are the last section
  standing and their absence is declared rather than implied — the block says
  they were withheld and must be treated as unread, instead of returning process
  hygiene as if no rule applied. In core's per-engram selection the guarantee is
  weaker and worth stating precisely: constraints get a reserved 40% floor plus
  whatever the directives leave over, not absolute priority. With 40 large
  constraints and 40 large directives at a 2,000-token budget the result is 11
  constraints and 10 directives, not 40 and 0.
- **The pinned budget is a quota enforced at pin time, not a truncation at
  injection.** `plur_pin` refuses a pin that would exceed
  `injection_budget × injection.pinned_ratio` and returns current usage plus
  unpin candidates ordered by what they free. The eviction choice goes to a human
  instead of being settled by array order.
- **`estimateTokens` measures the rendered form, not the serialised record.**
  Roughly 68% of an engram's serialised size is metadata the model never sees. On
  a real store this took the pinned set from 18,290 tokens to 3,663 against a
  6,000 quota — from 3.0x over to fitting — and engrams omitted at injection from
  26 to zero.
- **Engrams that a budget omitted are named.** `inject()` returns
  `omitted_pinned`: each id, its cost, and whether it lost to the pinned
  sub-budget or to the total.
- **A pinned engram cannot be displaced by an installed pack.** `pinned` bypasses
  the relevance gate, so pinned rows are ranked by origin — your primary store
  first, then `stores:`/remote, then packs — reading loader-stamped markers so a
  row cannot claim an origin it does not have. Once a pin is skipped for budget,
  no lower-origin pin is admitted behind it.
- **`created_at` and `updated_at` carry provenance.** Both optional and never
  defaulted — absent means genuinely unknown, and synthesising a timestamp
  destroys the record it exists to keep.
- **A `draft` engram is never injected.** Core still stores and recalls it, since
  reviewing one requires reading it, but an unapproved rule cannot shape
  behaviour.
- **Constraints render their contraindications.** A rule delivered without its
  "does NOT apply when" reads as unconditional.
- **`.plur.yaml`'s `domain` is honoured and surfaced at session start** (#1147),
  so an engram written inside a project routes by that project's domain instead
  of falling to `global`.
- **Spreading-activation drop counters are instrumented** (#1113), so what the
  activation pass discards is measurable rather than inferred.

### The pack format, specified and independently checkable

- **Conformance vectors: golden packs and capsule fixtures** (#1022, #1043).
  Thirteen golden pack vectors and thirteen capsule fixtures, with
  `spec/vectors/verify.py` — a checker written in
  nothing but the Python standard library, so a third party can run it against
  their own producer's output and get the same answers the reference does. Every
  vector asserts its outcome, and three gates keep it honest (#1043 review): the
  declarations in `index.json` are checked against the fixture bytes, so a count
  edited by hand or a fixture that no longer shows what it claims is a failure,
  not a note. Capsule fixtures are checked by size and SHA-256, catching a binary
  edit that review could not see. The fixtures are committed and the gate can no
  longer be skipped (#1022).
- **The vectors are pinned to LF** (#1160). Their integrity value is a SHA-256
  over raw bytes, so a checkout that converted line endings — the default on
  Windows — produced a hash mismatch against fixtures that were in fact
  untouched. A `.gitattributes` entry fixes the bytes wherever they are cloned.
- **The pack lifecycle is specified** (#1044) — how an engram changes, and what
  provenance means on import.

Pack lifecycle, from the review of #1044 (ENGRAM-STANDARD-v1 1.7, provenance
profile 0.9):

- **Install refuses a pack that declares a private engram.** `visibility:
  private` written into a shipped `engrams.yaml` is the producer's own record
  that the engram was not cleared to leave, shipped anyway; the pack is refused
  with the ids named, and no option reaches past it (§5.6.1 step 2). An engram
  that merely omits `visibility` still installs, held as private on this side
  and reported as such — the default is the consumer's assignment, not the
  producer's declaration. `PrivacyIssue.declared` tells the two apart.
- **Neutralization is counted per field.** `InstallResult.neutralized`
  reports `pinned_stripped` and `locked_downgraded`; the CLI prints both and
  `plur_packs_install` returns both (with `integrity_check`, which it had also
  dropped). A pack whose only host-overriding field was a locked commitment
  used to install with no output at all. The preview warns about locked
  commitments as it did about pinned.
- **Provenance records are read defensively and reported fully.** A record
  naming an engram the pack does not ship is counted as an orphan
  (`PackProvenanceView.orphan_records`, profile §5.4.2) without being opened.
  `engram:licenseSource` is a closed set: a value outside the four is treated
  as absent and reported, never carried onto `licences[].sources`, which is now
  typed `LicenseSource[]`. `plur packs preview` prints how each licence was
  arrived at, not only whether somebody chose it.
- **Unknown root manifest fields are preserved** (§10.3 rule 2). The Zod
  manifest schema now passes them through at the root, matching the published
  JSON Schema, and the manifest.yaml → SKILL.md upgrade carries them.
  `metadata` stays closed (#1029).
- **`readCapsule` refuses a `SIGNED` flag that disagrees with `header.signer`**
  (§6.7 step 7, mirroring the writer's §6.8 step 4). Such a capsule used to
  fail as a payload size mismatch, so the defect was never named.

Second review round on the same branch:

- **Install reports the four provenance counts** (§5.6.5). `InstallResult`
  gains `provenance`, and both `plur packs install` and `plur_packs_install`
  print or return it. The counts were computed by the preview the install
  already runs and then dropped at every surface, so an installer who did not
  separately run `plur packs preview` was told nothing — including about an
  orphan record. The field is absent, not zeroed, when a pack ships no
  provenance at all.
- **An unreadable provenance record no longer refuses the pack.** Profile
  §5.4.2 says a record a consumer cannot read MUST NOT abort the install; the
  provenance reader complied and the file scan then flagged the same bytes as
  unscannable, so a 17 MiB record refused the whole pack. A `provenance/`
  record that is merely oversize or unreadable is now reported and skipped,
  and the file does not travel into the installed copy. A symlink, a special
  file or a truncated walk still refuses, wherever it is.
- **`plur packs install --force` accepts an integrity mismatch.** The flag was
  listed and wired to nothing, and `allowModified` was declared on
  `InstallOptions` but narrowed away on `Plur.installPack`, so the standard's
  own remedy for a false-positive scan — correct the pack, which moves its
  hash — was unreachable through any shipped surface. `--force` does not reach
  the three refusals §5.6.1 makes non-overridable.
- **The scan surface is documented**, in `docs/pack-scan-surface.md`. §5.6.1
  asks a consumer to write down what its scan matches so a producer can predict
  a refusal; with the refusal unconditional, an undocumented surface made a
  false positive unfixable by anyone who could not read the source.
- **One record is one record.** Two engrams sharing an id named one file and it
  was opened once per engram, so `record_count` double-counted and
  `engrams_without_record` could reach zero, or go negative.
- **A producer's manifest field named after a prototype member survives.** The
  unknown-root-field carry-forward used `k in fm`, which walks the prototype
  chain, so a field called `constructor`, `toString`, `valueOf` or
  `hasOwnProperty` was dropped by the one path that rewrites a manifest. The
  CLI's licence-source table had the mirror problem and is now a `Map`.
- **A licence source the table does not know prints as unrecognised, never
  verbatim** (#1044 review).

### Provenance — experimental, and off by default

**Where an engram came from.** Present in 0.20 but dormant: record generation
defaults to `never`, every CLI flag is opt-in, and `plur_provenance` sits behind
`plur_admin` rather than in the lean tool surface. The profile itself is version
0.9 (draft) and **OPTIONAL** — an implementation that ignores it is still fully
conformant to the Engram Standard. Treat it as experimental; it is not the
headline of this release.

Two parts of it are **not** dormant, and are behaviour changes:

- **`plur packs export` now refuses to run without a chosen licence.** Previously
  the schema filled in a share-alike grant nobody agreed to. This breaks any
  script that exports a pack without `--license`.
- **A credential in `rationale`, `source`, an anchor snippet or `attribution` is
  refused at write time even at local scope** (`allow_secrets` still overrides).
  The leak guard used to read a hand-kept field list that had drifted three times.

The rest only acts when you turn it on.

A memory that cannot say where it came from is a rumour. Until now PLUR stored
statements and nothing else: who asserted a thing, whether a person said it or a
model inferred it, what it was drawn from, and whether you are allowed to reuse
it were all unrecorded. 0.20 records them, and writes the record in a format
other software can read — JSON-LD using [W3C PROV](https://www.w3.org/TR/prov-o/),
so a tool that has never heard of PLUR can still read it.

A provenance record answers five questions about one engram: who made it, how,
when, what it came from, and whether you may reuse it. **It does not say the
statement is true** — it says where the statement came from, and those are
different things. Leave a field out and the record says so rather than guessing.

- **Record it as you learn** (#959, #960). `plur learn --asserted-by
  local:maintainer --claim-class asserted --source https://example.org/runbook
  --license cc-by-4.0`. Engrams link to the session that produced them, and a
  retired engram records why it was retired.
- **Who asserted it, and what kind of claim it is** (#961, #963). `attribution`
  names the agent; `claim_class` distinguishes a thing a person stated from a
  thing a model inferred. The class is visible at injection, not only in a record
  nobody asks for mid-session.
- **An identity comes from configuration, never from the operating system
  account** (#961). With nobody configured the record carries an `unidentified`
  marker, which counts as unanswered — a memory nobody is accountable for cannot
  report itself complete.
- **The default licence grants nothing** (#961, #958). Section 8 now fails closed
  on the schema default: engram-level copyright is opt-in, and `unlicensed` is a
  decision somebody made rather than a field nobody filled. `provenance.path` is
  wired through.
- **Records are built, stored, and written on a schedule you choose**
  (#962, #964, #965, #966). Building a record and deciding when to persist it are
  separate; neither happens behind your back.
- **Provenance travels with a pack** (#967, #972, #973). Pack-level provenance,
  and the fields a particular field of work needs. `plur packs export --provenance`.
- **It is reachable from both surfaces** (#979, #980). `plur provenance <id|search>`
  on the command line (`--record` for the JSON-LD, `--write` to save it), and the
  `plur_provenance` MCP tool, which is **read-only and local** — it never reaches
  a remote store, and it never writes.
- **Attribution and claim_class survive a remote write** (#1172). They used to be
  dropped on the way out, which silently converted an attributed claim into an
  anonymous one.
- **Attribution is scanned as content** (#999). Reverted back in after being
  briefly removed. A credential in
  `attribution.asserted_by`, `attribution.model.prompt_id` or `license` is refused
  at write time, blocked on rescope, and demoted on update — the leak guard reads
  every content field, not a hand-kept list that had drifted three times.

See [`docs/provenance.md`](docs/provenance.md) to try it on memories you already
have — `pnpm --filter @plur-ai/core try:provenance` reads your store, writes
nothing, and tells you whether a stranger receiving the record could answer the
five questions. Expect some "NO" answers on older memories; nothing recorded who
asserted them, and the record does not guess. That gap is what this closes going
forward.

The normative text is [the provenance profile](spec/ENGRAM-PROVENANCE-PROFILE.md)
(version 0.9), a companion to [the Engram Standard](spec/ENGRAM-STANDARD-v1.md)
(version 1.7). The profile is **OPTIONAL**: an implementation that ignores it is
still fully conformant to the standard. One that writes provenance must follow
it, so that two such implementations agree.

**Hardened by people using it cold.**

Four rounds with testers who had not seen it before, and the review of #1002.

- **What testers found using it cold** (#970, #986, #987, #991, #996). The
  ship-blocker, flags that wrote to the wrong store, two licence counts that
  disagreed, a fuzzy match that hid how fuzzy it was, worked examples that could
  go stale, and API keys whose prefix carries structure. Round four covered data
  loss, fail-closed permissions, and non-English text.
- **A pack's integrity is actually checked, and the verdict reaches the terminal**
  (#986, #987). Flags were being swallowed; the integrity verdict — and its caveat
  — are now printed rather than computed and dropped.
- **Every file a pack ships is scanned, and the destructive commands are guarded**
  (#986, #996).
- **A replaced memory says what replaced it** (#992), and statements are clipped
  by display width, never mid-character (#995).
- **Records stay inside the store, and name nothing the recipient cannot resolve**
  (#1002). The privacy scan reads one content surface on every write path,
  symlinks are refused before any read, and what the scan cannot read is flagged
  rather than skipped.
- **A declared flag is never mistaken for a `--path` typo** (#1002).
  Typo detection is edit-distance 1, and a sweep test parses every `'--flag'`
  literal in the CLI source.

### Correctness and security

- **`plur ui --host` keeps its DNS-rebinding check on a widened bind** (#939, #946).
  The flag used to switch the check off, leaving the store reachable under any
  `Host` header a browser could be induced to send. The allowlist is widened
  instead: the literal `--host` value is allowed, IPv6 URLs are bracketed, a
  flag-shaped or unspecified host is refused, and `--allow-host` covers what the
  default policy should not.
- **The two render-boundary forgery sites are closed** (#940, #1167). Text a
  store returned could impersonate PLUR's own framing in a rendered payload.
- **Four defects from the 2026-09-07 audit** (#1149, #1150, #1151, #1152, #1154),
  and the follow-ups that review raised (#1163): `existsById` is bounded, the
  fifth validity site is covered, naive timestamps are UTC-pinned, and the
  write-contract guard actually bites.
- **An unparseable evaluation instant throws `RangeError`** (#1166, #1176)
  instead of silently becoming a date.
- **Tensions skips pairs measured under differing configurations** (#869, #981).
  Two measurements taken under different conditions are not a contradiction.
  Known gaps remain tracked in #1008 and #1009.
- **Line terminators are stripped in `Plur.learn()`** (#952, #953).
- **Cross-process dedup for `co_injection` events** (#975, #1017).

### Fixes

- **Recall returns ids that `plur forget` accepts** (#1119, #1122, #1135).
  Namespaced ids were displayed but not operable, and the CLI aborted before any
  remote dispatch could happen. Thanks to
  **[@amasen02](https://github.com/amasen02)** (Ama Senevirathne) for this, their
  first contribution to PLUR.
- **`plur_learn_batch` returns per-item namespaced ids** (#854, #930, #950).
- **`readIdFor` is applied in the `learn` catch-block, and a namespaced-id remote
  miss throws** (#1109, #1114).
- **`dsh` logs load failures in `loadEngine`** (#941) instead of swallowing them.
- **Three 0.18.0 release-script defects** (#947, #949) — swallowed errors, a
  missing `twine check`, and a silently skipped website step.
- **`typecheck:tests` passes, so the test job can run at all** (#1090).
- **A monthly canary runs the plur-hermes suite against the published
  hermes-agent** (#1120), so an upstream break arrives as a deduplicated issue
  rather than as silent drift.

### Architecture audit (2026-09-03)

From `docs/audits/2026-09-03-architecture-audit.md`: fewer mechanisms, one drift
bug fixed, no feature changes.

- **claw heartbeats reach the live endpoint again.** claw carried copies of core's
  three telemetry modules; #562 pointed the copy at `heartbeat.plur-ai.org`, which
  does not resolve, while core (MCP, CLI) kept `plur.ai/v1/heartbeat`, which does.
  claw now imports core's modules and passes its own `packageVersion`; the copies
  and their duplicated tests are gone. **This fix reaches npm for the first time
  in `@plur-ai/claw@0.20.0`** — claw is on an independent version track and was
  last published at 0.17.1.
- **`learnRouted()` refuses an empty statement** before dialing a remote store, as
  `learn()` always did — both now run one input gate.
- **`updateEngramAsync()` / `setPinnedAsync()`** are the same implementation as
  `updateEngram()` / `setPinned()` (as their docs claimed since 0.16). A remote that
  refuses a PATCH is now skipped in favour of the next writable store on the
  deprecated names too, instead of throwing.

### Removed from `@plur-ai/core`

Breaking for anyone importing them; nothing in this repo did. `YamlStore`,
`SqliteStore`, `createStore`, `migrateStore`, `EngramStore`, `StorageBackend`,
`StorageConfig` — the pre-ADR-0003 persistence seam. `YamlStore.save()` was a
second whole-corpus YAML writer that had shipped without the shrink guard (#824),
and `SqliteStore` made SQLite a primary store against the documented invariant.
`saveEngrams` is now the only whole-corpus YAML writer. The unread `storage:`
config key that only fed the deleted factory is gone too (unknown keys are
ignored, so existing `config.yaml` files still load).

Also removed: `rebuildJsonCache`, `COMMITMENT_MULTIPLIER`, `BoundedRecallResult`,
`computePackChecksum`/`verifyPackChecksum` (never exported), `computeQualityScore`
(no caller), the embedder dim-check module (the doctor grew its own).

Internal: one cross-encoder module builds both rerankers; the rerankers import
cycle is gone; `mcp`, `cli` and `claw` each show their version from one constant
(`release.sh` bumps 15 places, not 17; claw bumps one source file, not two).

### Not in this release — the pinned two-tier model

**The pinned two-tier model (hard-cap + priority eviction) is not in 0.20.**
#1082 and its successor #1121 are both closed unmerged, deliberately, after a
measurement changed the premise they rested on.

`estimateTokens` had been charging the injection budget for `activation`,
`feedback_signals`, `usage`, `sources[]` and `provenance` — 68% of the cost, none
of it ever rendered (#1145). Estimating the rendered form instead made engrams
roughly four times cheaper, and on a real store the pinned set went from 18,290
tokens against a 6,000 quota to 3,663 with room to spare; engrams omitted at
injection went from 26 to zero. Eviction machinery exists to decide what to drop
when the set does not fit. It now fits, so a second tier and a priority field
would rank a set that no longer overflows.

The pressure that remains is handled at pin time instead (#1142): a pin that
would exceed the quota is refused, with current usage and unpin candidates, so
the set cannot become over-committed in the first place. What the closed work got
right was lifted into #1138 with credit — origin ranking for pinned rows, and the
greedy-selection defect from #1124 scoped to origin.

If priority ordering is wanted later it should be reopened against the corrected
cost basis; the numbers that motivated it are no longer the numbers. The branch
`review/1082-pinned` is retained.

## 0.19.4

Patch release: makes the Hermes memory provider actually load. 0.19.3 shipped the entry
point and still discovered nothing.

- `plur-hermes` now resolves through Hermes' memory-provider loader

**The memory-provider entry point now resolves (#957 follow-up).** 0.19.3 declared
`[project.entry-points."hermes_agent.memory_providers"]` but pointed it at the factory
function, and Hermes' `_load_provider_from_entry_point` returned `None` anyway. It tries
`isinstance`/`issubclass` against its `MemoryProvider` ABC, then `hasattr(loaded, "register")`,
then `callable(loaded)` — and `PlurMemoryProvider` deliberately does not subclass the ABC,
because subclassing would make `hermes_agent` a hard runtime dependency and cost the
zero-dependency guarantee. A plain function has no `.register`, so every branch missed and the
loader fell through to `loaded(collector)`, returning `collector.provider` = `None`.

The entry point now targets the package: `plur_hermes.register()` already calls
`ctx.register_memory_provider()`, which is the one loader branch with no type check.

Verified on two hosts against a clean clone of `NousResearch/hermes-agent` main, driving the
real loader — the old value yields `None`, the new one yields `PlurMemoryProvider` with 22
tools. Injection verified end-to-end: the registered `pre_llm_call` hook returns engram
content, and `prefetch()` correctly no-ops while hooks are active so nothing double-injects.
Three regression tests pin the two properties the loader depends on; they fail against the
old value.

**Note:** `plur-hermes` requires the `@plur-ai/cli` binary on PATH. Without it,
`plur_hermes.register()` returns early and registers nothing — pip install alone is not enough.


## 0.19.3

Patch release: ships the Hermes memory-provider entry point that 0.19.0-0.19.2
were missing, and carries engram provenance through team pushes.

- `plur-hermes` is discoverable as a Hermes memory provider again
- remote-store team pushes no longer drop `origin`/`chain`/licence fields

**PlurMemoryProvider is registered as a Hermes memory provider (#957).** The
`[project.entry-points."hermes_agent.memory_providers"]` group was never declared
in `packages/hermes/pyproject.toml`, so `create_memory_provider()` was unreachable
and auto-discovery silently did nothing. 0.18.1 shipped the group; 0.19.0, 0.19.1
and 0.19.2 did not — 0.19.2 contained `memory_provider.py` but no entry point, so
the capability it advertised could not load. This release restores the group and
adds the provider suite (204 tests). Requires hermes-agent Herald (0.20.x) for the
`memory_providers` group; on earlier gateways the plugin path is unaffected.

**Remote-store pushes carry provenance (#983).** `RemoteStore.append()` dropped
`origin`, `chain` and licence fields on team push, so engrams arriving at a shared
store lost the record of where they came from. They are now carried through.


## 0.19.1

Patch release (#1072): every finding from the independent 0.19.0 audit (#1058),
the two same-day production crash bugs, and every finding from this patch's own
three-audit round — with the bonus instances the fixes' bug classes turned up
on the way through.

- `plur init` never destroys a config it cannot parse
- tmp-dir hardening now covers the Codex and Cursor hook families, not just agy
- doctor/migrate stop calling a config-selected PGLite index an orphan

**`plur init` and `plur-mcp init` refuse to write through a config they could
not parse (#1059).** A config with a JSON error (one trailing comma) was read
as empty and written back, silently discarding everything else the user had in
it. Every write-back leg now refuses with a fix-by-hand message: the three
harness MCP legs (Claude Desktop, Cursor, Antigravity), BOTH Claude Code
`settings.json` legs — the most hand-edited file of them all, carrying the
user's permissions, env and other hooks, which the first cut of this fix
missed — and `plur-mcp init`'s `.mcp.json`/`settings.json` writers. The Cursor
hooks leg additionally gained the valid-JSON-wrong-shape refusal and now
preserves unknown top-level keys through the round trip.

**Session tmp-dir hardening for every hook family (#1060).** 0.19.0 shipped
symlink/ownership/mode vetting (0700 dirs, 0600 files) for the Antigravity
session directory only. The shared `ensureSessionDir` now covers Codex and
Cursor too, and every stale-file sweep first refuses to delete through a
symlink or another user's directory — closing an arbitrary-file-deletion
primitive on shared-/tmp systems. Bonus instance: Cursor's counter could throw
out of a hook (fail-closed); it now fails open like the Codex and agy counters.

**doctor/migrate honour `backend: pglite` in config.yaml (#1061).** Both used
to test only `PLUR_BACKEND`, so a user who selected PGLite via config.yaml was
told their live index was an orphan they could delete. Both now resolve the
tier through the same `resolveBackendTier` the engine uses. The orphan
advisory also appears in `plur doctor --json` output, not just text (#1065).

**PGLite embeddings export: one bad row costs one vector (#1063).** Any throw
while decoding a row used to abort the whole export (`ported: 0`) — the silent
full re-embed the export exists to avoid. Rows are now contained individually
(reported as `malformed`), the BYTEA decode copies before viewing so alignment
can never throw, and schema discovery reads every schema holding
`engram_embeddings` deterministically instead of `LIMIT 1`-ing an arbitrary
one on stores that ran both with and without AGE.

**The MCP server survives background faults (#1070).** Unhandled rejections
are survived with rate-limited logging; an uncaught EXCEPTION now logs and
exits instead — resuming after one is unsafe, and a wedged-but-alive server
holding the store lock would block every other writer indefinitely (the
cross-process stale-lock recovery rightly never steals from a live pid).
Original entry: Node's default turns any
unhandled rejection — an un-awaited retry, a background probe — into process
death, and Claude Code never restarts an MCP server mid-session, so one
transient hiccup silently ended memory for the whole session (the observed
"plur_doctor failed after 0s: Connection closed" was the server already dead —
doctor found the corpse, it didn't create it). The stdio server now logs and
survives unhandled rejections and uncaught exceptions, with a spawned-process
regression test proving plur_doctor over MCP returns AND the server answers
the next call.

**MCP config entries pin their version — never `@latest` (#1069 root cause).**
The cold-start SIGKILL was macOS's code-signing monitor: an `@latest` npx
entry makes npx rewrite its cached native binaries (`better_sqlite3.node`) on
every publish, and any process paging in a mid-rewrite binary dies with
"CODESIGNING Invalid Page" (captured in Diagnostic Reports). `plur init`
writes the shim where resolvable (including, at last, from the monorepo
workspace layout) and otherwise pins the installing CLI's own version;
`plur-mcp init` pins its own version. Re-running either HEALS a stale
`@latest` entry instead of reporting "already registered" past it — healing
only the exact racey shapes init itself wrote: a deliberate old-version pin,
a fork package, or a custom command that merely mentions the package name is
never touched, and unknown fields on the entry survive the upgrade. The Codex
leg (TOML, managed by `codex mcp`) detects a stale entry and prints the exact
fix. Version constants are parity-and-shape-tested against package.json in
both packages, and the release script refuses non-release-shaped versions.

**Dead remote hosts cost one timeout per process, not one per store entry
(#1069).** A production config was observed with nine store entries pointing
at one unreachable host — every load paid nine connect timeouts, in every
fresh process, multiplied by concurrent hook processes, all inside
`plur_session_start`. A network-level failure now marks the HOST down for 60s
process-wide: every store on that origin fast-fails to its prior cache. HTTP
errors never trip it — a 401 is a live host talking.

**Remote schema drift no longer silently hides engrams (#1071).** An
enterprise server on a different release can serve field values a stricter
client rejects — observed live: ~100 engrams dropped wholesale over
`commitment: invalid_enum_value`, invisible to recall with no signal. Both
remote read paths now salvage such rows by dropping exactly the drifted
optional field (one warning per drift shape, on both paths), keeping the
engram. Privacy and privilege fields fail CLOSED: a drifted `visibility` or
`pinned` still drops the whole row, because their absence is more permissive
than any value — stripping `visibility` would have fail-opened the
pack-export privacy gate. A genuinely malformed row still drops.

**Test suite is hermetic against the host's git config (#1062).** Three sync
tests failed on any machine whose global gitignore lists `engrams.yaml` —
exactly how a PLUR user keeps their memory store out of every repo. Git-config
isolation (first added for #329) is now a shared helper used by every
git-spawning test file.

Also fixed from this release's own audit round: three scratch probe files
(one carrying a machine-local path) removed and gated at release time
(`*.tmp.*` refused when tracked); the accidentally-committed machine-local
`.claude/settings.json` and installer-generated `AGENTS.md` untracked and
gitignored; doctor's PGLite+embedding-gemma advisory resolves the backend
through `resolveBackendTier` like everything else (#1061 class); the in-app
update advice no longer recommends the `@latest` invocation that pinned
configs made a no-op.

Also: the dev scratch script `packages/core/mig-seed.mjs` is gone from the repo
(#1066), the 0.19.0 changelog entry below no longer claims to be unreleased
(#1065), and the release script now refuses to ship a version whose changelog
section still carries an `(unreleased)` marker.

## 0.19.0

The memory layer forgot Codex. Awkward. Fixed — agy too.

- `plur init --codex` / `--antigravity`
- Hybrid recall in hooks
- Size ladder: yaml → sqlite → postgres

**Codex CLI adapter (#1031).** `plur init --codex` wires `~/.codex/hooks.json` (five lifecycle
hooks), registers the MCP server via `codex mcp add`, and adds a PLUR section to
`AGENTS.md`. One manual step: Codex refuses untrusted hooks *silently* — run `/hooks`
in Codex once and trust the PLUR entries. `plur doctor` reports Codex wiring and
repeats that caveat.

**Antigravity CLI (agy) adapter (#1033).** `plur init --antigravity` wires agy's global config
(`~/.gemini/config/`): a `plur-memory` hook set (PreInvocation injection + PreToolUse
guard), the MCP server, and `AGENTS.md`. No trust step — restart agy and memory flows.
Per-prompt recall reads the conversation transcript (agy's hook payload carries no
prompt text), and each turn's memory is re-injected as an ephemeral message on every
model invocation so it survives tool calls without accumulating in history. Google is
transitioning Gemini CLI to Antigravity; Gemini CLI itself remains tools-only.

**Hybrid injection in hooks.** Hook injection is now hybrid (BM25 + embeddings) with an
automatic BM25 fallback on an 8s soft deadline — measured ~4.7s hybrid vs ~1.6s BM25 on
a 5,775-engram store, with hybrid diverging most exactly on the vague prompts where
memory matters. `PLUR_HOOK_HYBRID=0` forces BM25; `PLUR_HOOK_HYBRID_DEADLINE_MS` tunes
the deadline (keep it under your harness's hook timeout: Codex 25s, agy 20s). Enabled
by the `@huggingface/transformers` 3.8.1 → 4.2.0 upgrade, which fixes a SIGABRT during
ONNX teardown (#1040) that made every embedder-touching process exit 134 — and, in
3.8.1, could leave a truncated model file that permanently and silently degraded search
to BM25 (#340's failure mode; 4.2.0 downloads atomically). Embedding vectors are
bit-identical across the upgrade — no re-embed, caches stay valid.

**PGLite sync is no longer quadratic with your session count.** `syncFromYaml` batches
upserts (a 5,000-engram corpus builds in ~2s instead of 10+ minutes), records a
fingerprint so an unchanged store skips the sync entirely, tolerates duplicate ids
last-wins, and the CLI drains background index work before exiting so the index
actually converges.

**Security.** Transitive `adm-zip` is forced to `>=0.6.0` via pnpm override
(GHSA: crafted ZIP triggers a 4GB allocation; pulled in by `onnxruntime-node`,
where it only ever extracts onnxruntime's own install artifact — exposure was
minimal, now zero).

**Release tooling.** The release script now probes the X credentials it will
actually post with before any irreversible step (#948, #951), so a dead token
aborts the release instead of stranding it half-published.

### BREAKING — PGLite is opt-in, never selected by corpus size (#1046)

The automatic ladder is now **yaml → sqlite → postgres**. Stores past 5,000 engrams
select a SQLite metadata index (sub-millisecond opens measured to 500k engrams)
instead of PGLite, which boots a full Postgres-in-WASM per process — measured at
0.61s vs 300s+ per command on a 5,775-engram store under PLUR's
fresh-process-per-hook model.

**Who is affected:** any default install with more than 5,000 engrams. On first run
after upgrading, selection moves to `sqlite` and builds `engrams.db`. Nothing is
lost — YAML remains the source of truth.

**Migration: nothing to do.** Recall keeps working immediately (BM25), and
embeddings rebuild automatically — the first hybrid recalls re-embed the corpus,
which takes a few minutes of background CPU on a large store and then it is done.
The old `~/.plur/store.pglite/` directory (typically 60–500MB) is orphaned and safe
to delete whenever convenient; `plur doctor` points it out.

Optional shortcut for large stores: `plur migrate` carries the old store's
embedding vectors straight into the new tier's cache (each verified against the
engram's current text and the active embedder's dimension), skipping the rebuild
window entirely.

To keep the old behaviour set `backend: pglite` in `~/.plur/config.yaml` or
`PLUR_BACKEND=pglite`; PGLite remains the right choice only where its pgvector/AGE
capabilities are the point, and it now logs its per-process boot cost once at
startup when explicitly selected.


## 0.18.1

### Added

- **`plur-hermes` is now discoverable as a Hermes MemoryProvider.** Added the
  `hermes_agent.memory_providers` entry point (`plur_hermes.memory_provider:create_memory_provider`)
  so `hermes plugins --memory` lists PLUR alongside bundled providers and `memory.provider: plur`
  works in `config.yaml`. `register()` also calls `ctx.register_memory_provider()` when the
  context supports it (Hermes Herald Release ≥ 0.20.0), passing a `PlurMemoryProvider` instance
  that shares the same `PlurBridge` as the standalone hook path — no duplicate CLI subprocess
  spawns. Older Hermes versions that lack `register_memory_provider()` are unaffected; the
  standalone `hermes_agent.plugins` entry point is retained alongside the new one.

## 0.18.0
Your agents' memory, on a dashboard.

- Open it: `plur dashboard`
- Recall stats and written-per-day
- Also inside DeepSeek Harness
- `plur migrate` heals stale hashes

**The memory dashboard.** `plur dashboard` opens a local web view of everything your
agents learned — every engram, what actually gets recalled and how often, and a
written-per-day chart with the most-recalled list. It speaks English and
中文, stays read-only and local-only by default, and the same dashboard rides
inside DeepSeek Harness as `/plur-memory` via the new native `@plur-ai/dsh`
plugin — engrams land in the system prompt, no tool call. Upgrades self-repair:
`plur migrate` recomputes stale content hashes, `plur doctor` counts them, and
`plur_learn` records measurement conditions.

### Migration note — non-ASCII stores

**If your store contains statements with non-ASCII letters** (Cyrillic, Japanese,
Korean, Arabic, Greek, accented Latin, etc.), those engrams have a stale
`content_hash` after upgrading. The normalizer used ASCII-only `\w` in older
versions, so non-Latin text normalized to the empty string and every such engram
shared `SHA-256("")` — they collided with each other and absorbed unrelated writes.
The normalizer is fixed in this cycle, and the repair ships with it.

**Affected population:** stores with any non-ASCII letter in at least one statement.
Pure-ASCII stores are unaffected — hashes are byte-identical before and after.

**How to repair:** run `plur migrate` once after upgrading — migration 006 (#928) recomputes
the stale hashes, under the store lock, with a backup taken first and a rollback on
failure. `plur reindex-hashes --apply` remains available for the repair alone, and
its dry-run (`plur reindex-hashes`, no flag) reports the count without writing.
`plur doctor` also counts stale hashes and prints the remedy if any are detected
(#911).

### Breaking

- **`exportPack` and `plur packs export` refuse to run without a licence (#970).**
  A pack with no `license` used to be written with the schema default,
  `cc-by-sa-4.0` — a share-alike grant over other people's memories that nobody
  chose. Pass `--license` (for example `cc-by-4.0`, `apache-2.0`, `cc0-1.0`, or
  `unlicensed` to grant nothing), or set `provenance.default_license` in your
  config to answer once. Scripts that exported without a licence now exit
  non-zero; the `plur_packs_export` tool returns `{ exported: false, next_step }`
  asking the agent to put the question to the user rather than guess.

### Added

- **Provenance: record where an engram came from (#958).** An engram can now
  carry who asserted it, what software and model were involved, and what kind of
  claim it is — a statement someone made, a conclusion a model reached, or a line
  a pattern scraped. Those three were previously stored identically.
  ([docs/provenance.md](docs/provenance.md))
- `plur.provenanceFor()` and `plur.writeProvenance()` build a W3C PROV record for
  an engram, as JSON-LD, from the engram plus the history log (#964). Storage is
  pluggable and separate from generation (#965), and a `provenance.generate`
  setting chooses when records are written — `never` by default (#966).
- Engrams written at session end now link back to the session that produced them
  (#960). The session identifier was already an argument of that tool call and
  was simply not passed on, so most engrams had no session to point at.
- **The feature can now be reached (#979, #980).** A `plur_provenance` tool and a
  `plur provenance` command answer where a memory came from, in prose rather than
  JSON-LD, by search term as well as identifier. Both name what was NOT recorded
  as prominently as what was — a memory written before this existed genuinely
  cannot say who asserted it, and presenting the record as complete would make it
  look more authoritative than it is. `plur packs export --provenance` includes
  records in a pack.
- **Packs carry provenance (#972).** Exporting with `provenance: true` writes one
  record per engram plus one for the pack, which answers a question no single
  engram can: is this pack worth anything? It says who assembled it, when, how
  many engrams a person stated versus a model inferred, what dates they span, and
  whether every engram carries a licence. Records are written only for engrams
  that pass the privacy scan.
- **Records can carry fields for a particular field of work (#973)** — medical,
  geographic, supply chain — under their own prefix. Claiming a core prefix, or
  redefining a core term, throws rather than silently corrupting a reader.
- **Licences become machine-readable (#967).** Seven licence names map to a
  policy an agent can act on, each carrying the canonical licence address,
  because the licence text stays authoritative. An unrecognised licence produces
  no policy at all rather than a permissive default.
- `plur_forget` accepts a reason, and records it (#959). Every retirement made
  through the tool previously recorded an empty one.

### Fixed

- Which model made each near-duplicate verdict is now recorded (#962). A model
  rewrote the statement and that rewrite became the memory, with nothing saying
  which model did it.

- **`plur dashboard` opens a local memory viewer** (#934, #936) (alias: `plur ui`;
  `plur status` points at it) — every engram, what gets recalled and how
  often, a written-per-day chart, and the most-recalled list. Selecting a row expands the
  whole engram. Read-only: browsing memory never mutates it, including through a lazy write
  path such as decay. Binds `127.0.0.1` by default and deliberately — the viewer serves an
  entire memory store with **no authentication**; `--host` widens it and prints a warning.
  The pages live in `packages/ui` — zero-dependency, pure render functions, with the HTTP
  host behind a `/server` subpath so the root entry stays free of `node:http`. It is
  internal and bundled into its consumers, not published.

- **`@plur-ai/dsh` — a native DeepSeek Harness plugin.** Not an MCP bridge: PLUR mounts as (#918)
  a Cordis plugin and writes engrams into the system prompt, so the model reads them the
  way it reads its own instructions — no tool call, no round trip, no turn spent deciding
  whether to look. The section is re-rendered on each prompt assembly rather than appended,
  so memory does not accumulate in the context as a session runs; the blocking cost on the
  turn path measured 0.0ms p50, because recall happens off it. Five tools are still
  registered for deliberate use. Scope defaults closed, resolved per workspace from its
  `.plur.yaml` — a global store holds server addresses and client names and must not follow
  you into an unrelated project.

- **Bilingual viewer (English / 中文).** Follows the browser's `Accept-Language`, or force
  it with `?lang=zh`. Each language owns its own punctuation and date format rather than
  sharing a template — an ideographic sentence closed with a Latin full stop reads as
  machine output. Dates are formatted by hand rather than through `Intl`, so the page
  renders identically regardless of the host's ICU build. Engram content is never
  translated; it is your data, not chrome.

- **`/plur-memory` inside DeepSeek Harness** opens that same viewer. A command rather than
  a native tab: dsh renders its UI as a React client assembled over a typed slot registry,
  so a tab would mean shipping a browser bundle bound to that registry's pre-1.0 internals.

- **`plur doctor` reports stale `content_hash` values** (#911, #919): after upgrading,
  any engram whose `content_hash` no longer matches `computeContentHash(statement)`
  is counted and surfaced as an advisory. Non-zero means `plur reindex-hashes
  --apply` is needed. Does not fail the overall doctor check — pure read, no lock,
  no writes.

- **`plur reindex-hashes`** (#852, #897): repair command for engrams whose
  `content_hash` is stale (does not match the current statement) or missing
  (predates the field). Dry-run by default; writes only with `--apply`. Ships
  counts separately — stale hashes actively absorb unrelated writes; missing hashes
  are inert until something matches on them.

- **`content_hash` exposed as an MCP lookup key** (#895): agents can now retrieve
  an engram by its exact content hash, enabling stable cross-session references
  without relying on ids that change on MERGE.

- **`measured_under` field on `plur_learn`** (#869): numeric and benchmark engrams
  can now record their measurement conditions (date, dataset, config, hardware),
  preventing stale numbers from being treated as eternal facts out of context.

- **`PLUR_MODEL_CACHE_DIR` places the embedding-model cache** (#886): transformers.js
  derives its cache from the package location and reads no environment variable, so
  an npm-installed consumer kept the ~128MB model inside `node_modules` and every
  `npm ci` destroyed it. Precedence: `PLUR_MODEL_CACHE_DIR`, then `HF_HOME`
  (honoured even though the library ignores it, because an operator reasonably
  expects it to work), then the library default.

- **`injection_count` field** (#866): counts `inject()` selections separately from
  `recall()` activations. High injection with low positive feedback is the
  efficacy-failure signal #865 needs.

### Fixed

- **CJK bigram emission is capped per space-less run** (#899, #903): one long
  pasted CJK document wrote ~n GIN index entries and dominated the index.
  `MAX_SPACELESS_RUN_CHARS = 512` truncates the run — prefix kept, because the
  opening of a run is what a query is most likely to share.

- **Installed-pack engrams are injected once, not twice** (#901, #903): the
  corpus merge and the pack loop each scored the same engram under different
  rules, letting the stray copy displace a distinct engram and inflating
  `total_injections`. `pack_counts` telemetry now buckets in the pack loop,
  preserving #553's guarantee.

- **A compacted engram id is never minted again** (#816, #903): max-suffix id
  allocation now consults `history.jsonl` (append-only, synced, never pruned)
  as well as the live corpus, so `compact()` cannot free an id for reuse. No
  new persistent state; a missed history write can only leave allocation where
  it is, never collide. Also from #903: every `RemoteStore` request is bounded,
  and `forget`/`feedback` remote walks distinguish "not found" from "could not
  look" (#907) — `forget` refuses on uncertainty, `feedback` warns and proceeds.

- **`plur doctor` sanitises remote error response bodies** (#912, #919): `RemoteStore.append`
  now truncates server error responses to 200 characters and strips control characters
  before storing in `outbox.last_error`, preventing large HTML error pages from
  polluting the outbox view or injecting terminal escape sequences.

- **`content_hash` kept in step with the statement on UPDATE and MERGE** (#852, #894): when `learn()` rewrote a statement (UPDATE path) or merged two engrams
  (MERGE path), the stored `content_hash` was not recomputed. The updated statement
  therefore had a hash pointing at its old text — making it an attractor for any
  future write whose statement hashed to the old value. Now recomputed on every
  path that changes the statement, and absorptions are recorded.

- **Non-Latin statements no longer collapse to a shared hash** (#896): `normalizeStatement`
  used JavaScript's ASCII-only `\w` (`[A-Za-z0-9_]`), so every non-Latin character
  was stripped before hashing. Statements in Cyrillic, Japanese, Korean, Arabic,
  Greek, and accented Latin all normalized to the empty string and therefore to
  `SHA-256("")`. Four unrelated facts written in the same non-Latin script were
  absorbed into one engram, with three silently destroyed and four reported as
  successes. Fixed in the #896/#900 audit pass; a migration command (`plur
  reindex-hashes --apply`) ships alongside so existing stale hashes can be repaired.

- **`reindex-hashes --apply` now runs inside the store lock** (#900): the previous
  implementation did an unlocked whole-corpus read-modify-write, reproduced as a
  silent data-loss race on a 4,642-engram store at 6/6. Moved inside
  `_withStoreLock` and refuses to write the shared empty-string hash (reporting
  those rows as a third category rather than stamping the collision hash onto every
  previously-affected engram).

- **Eleven post-merge defects** (#900): a three-pass audit over the 2026-08-13
  batch — data-loss, adversarial, and evaluator passes run blind to each other —
  found and fixed: non-Latin dedup collapse (#896), locked reindex, local-scope
  remote-DELETE, unbounded fetch inside store lock, supersedes flush ordering,
  inject whole-corpus writer, outbox merge-back snapshot revert, circuit breaker
  dual state file, Japanese loanword tokenizer split, `searchBM25Exhaustive`
  readonly whitelist gap, and a `saveEngrams` quarantine precondition. Every fix
  has a test that fails when the fix is reverted.

- **js-yaml advisory GHSA-5p4m-2wfm-xmqj (high)**: the root pnpm override permitted 4.3.0.
  Tightened to `>=4.3.1 <5`.

- **Remote error sanitisation no longer destroys non-ASCII diagnostics** (#923, #925):
  the truncation added above stripped `[^\x20-\x7E]` — everything outside printable
  ASCII — so a server error in Japanese, Cyrillic or any accented Latin arrived in
  `outbox.last_error` as a row of nothing. The escape-injection vector it exists to
  block is entirely within the control-character range, so the class is narrowed to
  `[\x00-\x1F\x7F]` and the 200-character truncation is now code-point-safe rather
  than UTF-16-safe (an emoji at the boundary was being cut in half).

- **`ENGRAM-STANDARD-v1.md` documents `measured_under`, and cannot silently drift
  again** (#924, #927): the field shipped in the schema but not in the published
  interoperability standard, so an implementer reading the standard concluded it was
  not part of v1 while the reference implementation accepted and wrote it. The JSON
  Schema was already drift-guarded in CI; the markdown was not. A test now asserts
  every top-level `EngramSchema` field appears in the standard. Two fields are
  excluded with the reason recorded: `exchange` (documented as `exchange.*`
  sub-fields) and `insight` (genuinely undocumented — a real gap, tracked rather
  than hidden).

- **Deliberate feedback is no longer erased by mere use** (#888): passive retrieval
  moved `retrieval_strength` by +0.10 while an explicit positive rating moved it
  +0.05 and a negative one −0.10 — so a star was worth half of being incidentally
  fetched, and a considered "this is wrong" was exactly cancelled by the next recall
  that returned the engram. The field saturated at 1.0 within three recalls, after
  which no feedback in either direction was visible in it at all. Retrieval and
  rating are now separated rather than rebalanced, so each remains legible.

- **Local cosine dedup actually runs when no LLM is configured** (#854, #856): the
  cosine fallback existed only in comments — candidates were fetched, filtered, and
  discarded unread, so every install without an LLM key had exact-hash dedup only
  and wrote every reworded near-duplicate. Measured on the store: 131 near-duplicate
  engrams in 63 clusters over five months. Local similarity now decides, and both
  write paths report `dedup.near_duplicates` instead of guessing a threshold.

- **Every script is tokenized, not just ASCII and Han** (#890): measured before the
  fix, Japanese kana, Korean, Arabic and Hindi returned `[]` from the FTS tokenizer,
  Russian and Thai returned only embedded English words, and accented Latin split at
  each accent (`déploiement` → `ploiement`). Nonspacing marks (`\p{M}`) join the
  character class, space-less runs are stripped from the word path, and the length
  floor respects dense scripts where two-character words are ordinary (도커).

- **`plur_learn` reports ids in the namespaced form recall returns** (#914, #916):
  the write report handed back the server-assigned id while every read path returns
  the namespaced one, so a caller that recorded what it had just written held a
  shape no read path produces. The namespacing rule lives in one function
  (`namespaceEngramId`) so the two surfaces cannot drift apart. (The batch path was
  missed and still misreports — tracked as #930.)

- **`supersedes` is remapped or refused on outbox flush, never dropped** (#863, #892): an edge pointing at a local id was silently discarded when the engram was
  delivered to a remote store. It is now remapped when the target resolves and the
  write refused with the reason recorded when it cannot — an explicit failure
  instead of quietly severed provenance.

- **A rescoped engram is not later delivered to the store it was moved away from**
  (#882): the outbox entry kept the original target, so when that host recovered —
  arbitrarily later — the delivery silently undid the rescope. The pending entry is
  now cancelled at rescope time.

- **Outbox flush consults the per-host circuit breaker** (#887): the read leg
  already backed off after three network-class failures; the write leg attempted one
  full-timeout write per queued engram against a host the client had already given
  up on, every session start, and never fed its failures back.

- **Remote writes carry `pinned`, `rationale`, `commitment` and `tags`** (#768,
  in #875): the POST body serialized only statement/scope/domain/type, so a
  team-scope policy engram written with `pinned: true` was stored without the pin
  and never bypassed the relevance gate for subscribers.

- **Server `null`s in scope metadata no longer disable covers-based auto-routing**
  (#880): Zod's `.optional()` rejects `null`, and an unset nullable column is
  exactly what a server serialises as null — every ordinary scope row failed
  parsing, vanished inside a `flatMap`, and team knowledge silently stopped
  reaching team scopes while the admin dashboard showed every scope healthy. The
  schema now tolerates the shape, and a dropped entry is logged instead of silent.

- **An explicit empty `forbid` list means "not configured", not "forbid nothing"**
  (#883): `?? default` supplies the default only for null/undefined, so a policy
  normalised with `forbid: []` turned the sensitive-content scan off while looking
  more governed than no policy at all. Core's own paths were not live-exposed (the
  schema already coerces `[]` to the default — pinned by two tests), but the guard
  was wrong standalone and now defaults on emptiness too.

- **`readonly: true` works on stores that answer queries themselves** (#884):
  `ReadonlyStoreGuard` forwarded a whitelist that omitted `role`/`searchBM25`, so a
  guarded query-capable store failed the adapter check and recall fell through to a
  path with nothing to read — a crash exactly where readonly is most wanted
  (shared multi-tenant storage).

- **Hybrid recall no longer reads the whole corpus when a Postgres primary can
  filter server-side** (#906, #922): `recallHybridWithMeta` called
  `_loadAllEngrams` — a full table read — on every invocation even when the
  primary store supports a scoped query. `_filterEngrams` now pushes
  status/scope/domain filters down to the adapter, with packs and remote
  secondary stores merged through the same loader every other read path uses.
  `ReadonlyStoreGuard` forwards `loadFiltered`, so guarded multi-tenant stores
  keep the pushdown instead of demoting to the fallback; a query-capable store
  without `loadFiltered` takes the fallback read rather than crashing.

- **`plur doctor` reports the live remote state, not a cached failure** (#864, #873): one cold-start timeout stamped a degradation warning onto every later
  response for the life of the process, pointing the operator at a healthy server.
  Outcomes now carry their age; present-tense surfaces fall silent past the TTL
  while doctor keeps history and renders the age.

### Also in this release

- Release pipeline: the smoke gate waits for core propagation instead of
  burning a version on registry lag (#842); `--trust-ci` verifies required CI
  on the exact commit when the release machine is too contended for the local
  suite (#943).
- The forensic payload-drop log records scalar-only drops, so it can falsify
  rather than assume #297's array hypothesis (#853).
- CI detects the `addAssignees` silent-drop for first-time contributors (#862).
- Engram field-compatibility rules live in one place, applied at every loader
  (#879).
- A pushdown storage adapter can signal candidate-set exhaustion, saving 2-3x
  re-query amplification at 50k+ engram scale (#891); the routing test spy
  counts both adapter entry points (#893).
- The geo-visibility skill was added (#849) and removed (#926) within this
  cycle — net absent from 0.18.0.
- The 0.18.0 notes themselves were audited against the shipped-PR manifest and
  completed (#929, #944) — including entries this gate itself forced.

### Changed — operations that used to succeed can now refuse

- **`forget()` refuses an ambiguous bare id** (#831, #855): ids are minted per
  store, so one bare id can name several unrelated engrams. `forget` resolved
  primary-first and retired whichever it reached — in real use it destroyed the
  wrong engram (history for one id showed three creations across three scopes).
  An unqualified id that resolves in more than one place is now an error;
  `{ scope }` disambiguates. Retiring is destructive and not reversible from the
  caller's side, so refusing beats guessing by a wide margin.

- **`feedback()` refuses an ambiguous bare id across stores** (#850, #851): the
  same ambiguity, the same resolution — a rating that could land on the wrong
  engram is refused with the candidate scopes listed, rather than applied to a
  coin-flip target.

### Changed — forward compatibility

- **`commitment` accepts a fifth value, `draft`** (#905, #908): the schema documented
  a review-queue state that deployments could supposedly add through the schema's
  `passthrough()`. That mechanism cannot work — `passthrough()` preserves undeclared
  *keys*, never an out-of-enum *value* for a declared key — so `commitment: 'draft'`
  failed validation and was quarantined at load. The enum is widened rather than the
  claim deleted, because a review queue is genuinely wanted.

  Core **stores and recalls a `draft` engram like any other**; it is not withheld from
  recall, injection or sync. Enforcement belongs to deployments that implement a queue.
  A positive feedback signal does not promote it out of review (`nextCommitment`).

  **This is a forward-compatibility break worth planning around.** Widening an enum is
  safe for readers of old data, but not for writers of new: an engram written with
  `commitment: 'draft'` **fails validation on an older core** and is quarantined there.
  In a mixed-version fleet, or a store synced between machines on different versions,
  upgrade the readers before anything starts writing `draft`.

- **`reference_count` is renamed `write_count`** (#866, #874, #875): Node 26 is
  supported in the same change. the schema field
  name never matched what the write path set, so the counter never incremented —
  4,496 of 4,559 engrams stuck at 1 confirmed the bug was universal. `loadEngrams`
  backfills the legacy key on first parse and strips it on the next write; both
  decrement sites read `reference_count` as a fallback so an old store arriving
  mid-decrement does not lose its count. Per the spec: implementations MUST
  backfill on first parse of old stores. The JSON Schema and
  `ENGRAM-STANDARD-v1.md` are updated.

## 0.17.2 (2026-08-04)

Chinese search works — found and fixed by skyeryg.

- Chinese text is searchable
- BM25 saw no Han at all
- Postgres guards stale tokens
- Stale stores self-heal

### Fixed

- **Chinese text is now indexed for BM25** (#780, #782): `ftsTokenize` discarded every Han
  character, because JavaScript's `\w` is ASCII-only (`[A-Za-z0-9_]`). Pure-Chinese queries
  tokenized to zero terms, so BM25 contributed nothing for non-English stores — hybrid recall
  silently degenerated to embedding-only, and under `bm25-only` degradation a Chinese query
  returned nothing at all. Han runs are now indexed as overlapping character bigrams: the standard
  approach for scripts without word boundaries, no new dependency, and deterministic across
  runtimes in a way a locale-dependent segmenter is not. ASCII behaviour is unchanged, at a
  measured 4.50µs → 4.78µs per tokenization. Reported and fixed by
  [@skyeryg](https://github.com/skyeryg), who hit it integrating PLUR into a Chinese-language
  workflow. Chinese only — Japanese kana, Korean, Cyrillic, Arabic, Indic scripts and accented
  Latin are still dropped or mangled, tracked in #833.
- **Security: SSRF-relevant dependency upgrades** (#841): `ip-address` to >=10.3.1 and `hono` to
  >=4.12.34, raised as floors in the existing `pnpm.overrides` block. Both reach users: they arrive
  through `@modelcontextprotocol/core` as runtime dependencies of the published `@plur-ai/mcp`.
  The high-severity one (GHSA-mwp4-54f8-5fhr) decodes leading-zero octets as decimal while
  resolvers decode them as octal, which bypasses SSRF and trust-boundary checks; the others cover
  CIDR-suffix and IPv4-mapped/NAT64 misclassification, plus a ReDoS in Hono's CORS middleware.
- **Stale tokens re-derive themselves, and `plur reindex-tokens` forces it** (#840, #839): the
  detection above named a remedy — re-save the store — that nothing in ordinary use performs.
  `PostgresAdapter` implements the targeted `append` / `updateMany` seams, so `learn()` and
  `feedback()` each touch one row and leave every other row's version untouched; an upgraded store
  would sit on the correct-but-slower fallback indefinitely, having permanently lost the pushdown,
  visible only as a log line. Stale rows are now re-derived in the background the first time they
  are noticed, and `plur reindex-tokens` forces the same pass synchronously with a count for
  operators who want the pushdown back before the first user query rather than after it.
- **Postgres stores detect tokens written by an older tokenizer** (#834, #837): `PostgresAdapter`
  derives tokens at write time and persists them, which is what lets the BM25 pushdown claim
  exactness — `df` counted in SQL and `tf` counted in JS agree because one tokenizer produced both.
  Changing the tokenizer breaks that for rows already written, and breaks it silently: pre-#782
  rows contain no Han, so a Chinese query never matches them and the corpus reports it does not
  hold an engram it does hold. Rows now carry the tokenizer version that produced them, and
  `corpusStats` refuses rather than answering from a corpus it cannot vouch for, naming the
  re-save that fixes it. Without this, the fix above would have reached only engrams written
  *after* the upgrade.

## 0.17.1 (2026-08-03)

Learning something no longer reads your whole memory first.

### Changed — performance

- **`learn()` and `feedback()` stop loading the whole corpus** (#827, #828, (#829)): `learn()` read every
  engram twice before writing one — once to check for a duplicate statement, once to work out the
  next id — and `feedback()` read every engram to fetch the single one you rated. On a plain YAML
  store that costs nothing, because the file is parsed either way; on a database-backed store it is
  a full table scan standing in for an index lookup, on every write. Two optional store methods
  (`findActiveByContentHash`, `nextEngramId`) let a store answer both questions directly, and the
  same targeted-read treatment now covers `updateEngram`, `setPinned`, `forget` and `rescope`.
  Nothing changes for the default YAML store, which keeps the behaviour it had.

  One deliberate trade-off for stores that opt in: the dedup lookup is scope-**bound**, so it cannot
  see — and must not disclose — a matching statement in a *different* scope. Cross-scope recurrence
  (the rule that re-learning the same sentence under a second scope graduates the original toward
  `global`) is therefore skipped on such stores, and the statement becomes its own engram instead.
  This is the point rather than a side effect: where scopes are a permission boundary, one tenant's
  engram must not be broadened because another tenant learned the same sentence. See
  [ADR-0003](docs/adr/ADR-0003-primary-store-capability.md).

## 0.17.0 (2026-08-03)

Your memory now backs itself up.

- Daily backups + `plur restore`
- Move engrams between scopes
- Switch scope mid-session
- Faster writes at scale

### Added — new capabilities

- **Validity-gated daily backups and `plur restore`** (#799, #803): a snapshot on the first store write
  of each day, taken only if the store passes a validity gate — parses, no schema-invalid entries,
  no unexplained shrink, unique ids, no truncation. Backing up an already-damaged store is worse
  than not backing up. `plur restore` lists snapshots, verifies against a sha256 sidecar, and names
  exactly which engrams a restore would drop before it touches anything.
- **`plur_rescope`** (#676, #790): move an existing engram to another scope, instead of forgetting it and
  re-learning it somewhere else.
- **`plur_session_scope`** (#243, #788): change the session's default scope mid-session, so a session
  that starts personal and turns into team work does not have to be restarted.
- **`plur login --status`** (#587, #786): reports whether the enterprise token is actually valid, rather
  than echoing whatever is in the config file.
- **Read-only mode and an incremental write seam** (#731, #740, #745): `learn()` appends instead of
  rewriting the whole corpus on backends that support it, which is the difference between a
  constant-cost write and one that grows with the store. Read-only mode makes a `Plur` instance
  refuse every mutation, for analysis tooling that must not touch the corpus.
- **Postgres semantic recall uses the vector index** (#762, #792): `engram_embeddings` now tracks the
  corpus on the server tier, so `recallSemantic` queries the index instead of loading the corpus
  and scoring it in memory. Previously the table stayed empty and the fallback was silent —
  correct results, wrong performance, no error.
- **`plur_admin` is discoverable** (#761, #787): the gateway that reaches every non-core tool is now
  visible to clients rather than something you had to know about.
- **Pack integrity is reported, not implied** (#805, #819): `plur packs list` distinguishes `ok`,
  `modified` and `unverified`. It previously printed nothing at all for a pack whose integrity
  could not be checked, which looked identical to a pack that verified clean.
- **`plur status` reports unreadable artifacts** (#821, #822) through `store_errors`, instead of failing
  or silently reporting zero.

### Changed — operations that used to succeed can now refuse

An adversarial data-loss audit of every store write path (#794) found that a corrupt store was
being read as an *empty* one, and that the next write then persisted the emptiness. Measured: 5
engrams → 0, including through `recall()` alone, because reactivation writes activation back. The
fix is to refuse rather than guess, which means a small number of operations now throw where they
previously returned quietly. Each throw replaces a silent corpus deletion.

- **An existing store file that says nothing intelligible is an error, not an empty store**
  (#795): a zero-length `engrams.yaml`, a mapping with no `engrams` key, and a top-level sequence
  now raise `EngramStoreUnreadableError`. A **missing** file is still an empty store — that is the
  only way a first run can work — and an explicitly empty `engrams: []` still loads as empty. If
  you hit this, the file is damaged; `plur restore` (below) is the way back.
- **A write that would shrink the corpus by more than 10% is refused** unless it declares itself
  (#795). `compact`, `forget`, the outbox handoff and pack uninstall declare it; nothing else does,
  so an unexpectedly short corpus is refused rather than written. Raises `EngramStoreShrinkError`.
- **`plur sync` refuses to run against an unparseable store** (#798) instead of committing and
  pushing it verbatim. See Fixed below — this one was also a privacy leak.

### Added

- **Validity-gated daily backups and `plur restore`** (#799): PLUR previously had no backup line at
  all, which is why every finding in #794 that ended "the corpus is gone" ended there. A snapshot
  is now taken on the first store write of each day — but only if the store passes a validity gate
  (parses, no schema-invalid entries, no unexplained shrink, unique ids, no truncation). Backing up
  an already-corrupt store is worse than not backing up, so a store that fails the gate warns and
  leaves the previous snapshot untouched.

  `plur restore --list` shows snapshots; `plur restore` shows what restoring *would* do without
  doing it; `plur restore --yes` performs it. Restore verifies the snapshot independently (sha256
  sidecar plus the same validity gate), **names the engrams it cannot recover** by reading the
  append-only history log, and keeps the pre-restore store aside so a mistaken restore is itself
  reversible.

  Snapshots are daily, so engrams learned after a given day's snapshot are not in it — this turns
  silent total loss into partial, *named* loss. `backups/` is never synced: a snapshot is a
  whole-corpus copy including `scope:local` engrams.

  **Disk cost:** snapshots are uncompressed copies, retained 7 daily + 4 weekly, so the set costs up
  to 11× your store size — about 113 MB for a 10 MB store, about 431 MB for a 39 MB one. That is the
  deliberate trade for backups you can read, diff, and verify by eye rather than through tooling.

### Fixed

- **`plur sync` no longer pushes a corrupt store, and no longer leaks `scope:local` engrams doing
  it** (#798): an unparseable `engrams.yaml` silently disabled the scope strip, and the verbatim
  blob — conflict markers and local-only engrams alike — was committed *and pushed*. Measured: the
  pushed blob contained both, while sync returned `{action:'synced'}`. Sync now refuses, and
  refuses separately to stage an unmerged store file (`git add -A -f` on a conflicted path marks it
  "resolved" with the markers still in it). Both errors name `git stash list`, because after an
  autostash pop conflict the only complete copy of your corpus may be in `stash@{0}` — check it
  before `git stash drop` or `git reset --hard`.
- **`plur sync` stops reporting pulls it did not make** (#798): the pull result was discarded and
  the message reported the commits it *meant* to pull. It said `"pulled 1 remote commit(s)"` while
  still one commit behind. It now says `"NOT pulled — still N commit(s) behind"`.
- **The sync warning no longer claims to back up everything** (#798): it said the remote "receives
  all engrams" while `scope:local` engrams were stripped — measured at 3 of 5 reaching a fresh
  clone. It now names the count that is **not** backed up, and says plainly when a remote backs up
  nothing at all.
- **Invalid engrams are quarantined instead of deleted** (#795): `loadEngrams` skipped entries that
  failed schema validation, and the next unrelated write persisted the filtered array as the whole
  corpus — a silent permanent delete. Measured: 5 on disk, 2 invalid, one ordinary `learn()` and
  both were gone. They are now withheld from callers but preserved in the file.
- **Store writes are fsynced** (#796): `grep fsync` across the TypeScript packages returned zero
  hits. write+rename survives a dying process but not a dying kernel, and the artifact it leaves is
  a zero-length file — exactly the input to the corrupt-read wipe above. Both atomic writers now
  fsync the file and its parent directory, and use unique temp names so concurrent writers cannot
  rename each other's partial file. Derived caches (embeddings, reranker-eval) opt out.
- **Episode capture is no longer lossy under concurrency** (#797): `captureEpisode` was
  load/push/write with no lock, reachable from `plur_capture`, `plur_session_end` and
  `reportFailure` — i.e. from every MCP server open at once. Measured: 4 processes × 25 episodes,
  **30 of 100 survived**. Now 100 of 100.
- **A slow writer no longer causes other processes to fail, or to steal its lock** (#804): the lock
  had its budgets inverted — a waiter gave up after ~3.1 s while a holder was not considered
  abandoned until 10 s, so a legitimately slow write failed everyone waiting on it, and for MCP
  `plur_learn` that meant the engram was silently never stored. The stale threshold is now 60 s
  (a 50,000-engram store legitimately holds the lock ~6.3 s, and the daily backup adds ~1.4 s once
  per day), and the waiter's deadline always exceeds it, so a live holder is waited for rather than
  abandoned.

  Two things keep that from being simply slower. A lock whose owning process is **gone** is stolen
  immediately rather than waited out, so crash recovery did not get slower — the check is scoped to
  the host that wrote the lock, since a pid means nothing on another machine and `~/.plur` can live
  on a synced volume. And a holder now removes the lock only if it still carries its own token:
  previously, once a lock was stolen the original holder's cleanup deleted the *thief's* lock, and a
  third process walked in while the thief was still writing.
- **The exported `YamlStore` had drifted back to pre-#766 behaviour** (#794 F14): it kept its own
  copy of the parse rules, which still caught errors and returned `[]`, after which
  `append`/`remove` rewrote the file from that empty list. Both readers now share one parser, so
  the copies cannot drift again.

- **Sibling-file strip completes the shared-remote guarantee** (#686): #640/#678 stripped only `engrams.yaml`, but `episodes.yaml`, `candidates.yaml`, and `tensions.yaml` synced verbatim — a teammate cloning a `shared` remote could still receive statement text *derived* from private/personal engrams (a tension's statement snapshots, a failure-report episode) even though the engrams themselves were withheld. A sibling record is now pushed to a `shared` remote only when every engram id it references resolves to the shared push set; records referencing personal, private, or unresolvable engrams stay local (strip-on-doubt), the working tree keeps everything, and the strip is deterministic so the #396 no-infinite-dirty property holds. The sync `warning` reports the stripped sibling record count. `personal` remotes are unchanged.

### Fixed — the audits of the fixes

The first audit (#794) hardened the store write paths. Two further independent passes then audited
that work — a whole-repository adversarial audit (#811) and an audit of the fix diff itself (#821)
— on the reasoning that fixes written under release pressure have their own defect rate. They did:
#821 found sixteen, every one introduced by an earlier fix. An independent human review (#823)
cleared the result and added one more.

- **The shrink guard had a bypass, and it was the guard's own optimisation** (#821): the exact
  record count ran only when the outgoing document was >5% smaller than the file on disk. That
  encoded an assumption engrams do not satisfy — a bare statement and one carrying `rationale`,
  `dual_coding` and `knowledge_anchors` differ by an order of magnitude — so a write dropping 11 of
  100 records moved the count 11% and the bytes under 5%, and the guard never ran. The count is now
  unconditional, and cheap enough to afford it: counting scans for record-start lines instead of
  parsing (62ms on a 20,000-engram/19.1MB save, against 246ms for the parse it replaced).
- **The shrink guard now protects every whole-corpus writer** (#824): it lived in `saveEngrams`,
  while `YamlStore.save()` — the `EngramStore` backend — replaced the whole file without it.
- **A corrupt sibling store no longer takes down the session** (#821): `status()` is a diagnostic
  and now reports unreadable artifacts through `store_errors` instead of throwing — including the
  corpus itself. MCP `session_start` awaits `status()`, so a truncated `episodes.yaml` previously
  meant no session could start at all. One damaged pack no longer hides the others.
- **Atomic writes preserve file permissions** (#821): replace-by-rename creates a new inode, so a
  `0600` `config.yaml` — bearer tokens, Postgres DSNs — came back `0644` under the usual umask.
  Config files are also created `0600` rather than inheriting it.
- **An engram's embedding now follows its text** (#812): nothing invalidated a vector when the text
  changed, so a dedup UPDATE could rewrite a statement and semantic recall would rank it by the old
  wording indefinitely. Both tiers store the hash of the text actually embedded.
- **Migrations hold the corpus lock across plan, apply and version stamp** (#821): a concurrent run
  and rollback could leave the store reporting a schema version it did not have.
- **The pack registry is atomic, locked, and refuses to be read as empty** (#805): a truncated
  registry destroyed every installed pack's integrity baseline, after which a tampered pack
  reported its integrity as *unknown* rather than *modified*. `plur packs list` now distinguishes
  `ok` / `modified` / `unverified` instead of printing nothing for the last two.
- **Stale-lock recovery can no longer delete a live lock** (#821): the steal is an atomic
  `rename` claim, so a contender can only remove a file it has already moved aside.
- **Tension records, config writes, restore planning, pack installs and the MCP drop log** all
  gained the locking, atomicity or quarantine-carrying they were missing (#805, #821).

### Added — invariants that fail the build

The recurring cause was invariants documented in prose. Prose does not fail a build, so each change
re-derived them by hand and hand-derivation kept missing a call site.

- **Property tests for the shrink guard**: random heterogeneous corpora and random writes against
  the stated invariant, rather than fixtures. Both historical bypasses reproduce against them.
- **A corruption matrix**: every store artifact, damaged eight ways, against every entry point —
  asserting both that diagnostics survive and that write paths still refuse.

### Security

- All seven open Dependabot advisories cleared (#818), with bounded version ranges so a patch-level
  advisory can no longer pull in a new major.


### Also in this release

Smaller changes that ship with 0.17.0, grouped by what they touch.

**Recall and scoping**
- Mounted store scopes become read-side visibility grants (#775, #777), and remote recall is
  server-authoritative with per-host degradation surfaced rather than silently absorbed (#776, #778).
- A recall `limit` floor leak is closed — `slice(0, limit)` now applies on every hybrid path (#774).
- Engram ids are unified on `ENG-YYYY-MM-DD-NNN` (#771, #791), and the version-behind notification
  re-checks its TTL instead of firing on a stale timestamp (#760).

**Stores and sync**
- A filesystem store materializes on registration rather than at first write, and the outbox skips
  retired engrams instead of resurrecting them remotely (#766, #767).
- Optional engram fields are transmitted on remote append (#769); previously they were dropped.
- The dedup path no longer full-replaces the corpus on every backend (#802, #807).
- Private-derived episode, candidate and tension records are stripped for `shared` remotes
  (#686, #789) — a teammate cloning a shared remote could otherwise receive text derived from
  private engrams even though the engrams themselves were withheld.
- `close()` no longer leaks a connection pool or hangs on a held client (#751).

**CLI and diagnostics**
- `--quiet` is honoured across every command via a central output policy (#784).
- `plur doctor` reports the live tool surface (#763) and probes the configured MCP server rather
  than a synthesised one (#765).
- The `#772` whole-payload-drop diagnostic is corrected, with a bounded forensic drop log (#779).
- `learn()` and `learnRouted()` validate `type` instead of accepting anything (#729, #733).
- `plur migrate` resolves receiver chains split across lines, anchored at the chain head (#758, #783).

**The audit series**
- Store write-path hardening (#800, #801, #806, #809, #810).
- The independent whole-repository audit and its fixes (#814, #815, #817).
- The audit of the fixes, and the human review that followed (#820, #822, #826).


## 0.16.1 (2026-07-29)

Engine primitives are importable, and feedback stops disagreeing with itself.

- `rrfMergeEngrams` and `applyFeedbackSignal` are now exported
- same engram, same thumbs-up, same result — wherever it is stored

### Fixed

- **Feedback no longer means different things in different stores** (#759): `Plur.feedback` wrote out the feedback rule three times — once for the primary store, once for secondary stores, once for packs — and the three had drifted. Only the primary copy promoted `commitment`. The same engram given the same positive signal advanced `leaning → decided` in your own store and stayed at `leaning` in a team store or an installed pack, silently. The rule now lives in one place and all three call it.

### Added

- **Engine primitives are exported** (#759): `rrfMergeEngrams` (the k=60 Reciprocal Rank Fusion used by hybrid search) and `applyFeedbackSignal` / `nextCommitment` (what a feedback signal does to an engram) are now part of the public surface, along with `POSITIVE_STRENGTH_DELTA` and `NEGATIVE_STRENGTH_DELTA`. These were reachable only by reimplementing them, and a reimplementation cannot report when it drifts — it keeps returning a plausible ordering and a plausible strength while quietly disagreeing. `applyFeedbackSignal` is a pure mutation with no I/O, so a server-side consumer can reuse it without inheriting the file-backed single-user machinery around it in `Plur`.

### Changed

- **The commitment ladder is stated once, completely** (#759): an unset `commitment` now seeds at `leaning` on positive feedback rather than staying unset — an engram that received a positive signal has demonstrably been retrieved and found useful, and leaving it unset let older engrams accumulate unlimited positive signal while still reading as though nobody had an opinion. `decided` remains the ceiling; reaching `locked` still requires explicit human intent. An unrecognised commitment is returned untouched, so a deployment that extends the enum — e.g. a `draft` staged in a review queue — is never promoted out of review by a thumbs-up.

## 0.16.0 (2026-07-28)

The big memory update.

- BREAKING: async writes for shared memory
- npx @plur-ai/migrate adds awaits
- Postgres option: scale out
- scope allow-list, BM25 in SQL
- cross-process write safety
- unified recall surface — same engine local and server-side

One engine, two deployments: the same memory engine now spans a laptop YAML
file and a shared Postgres server. That is why the write path went async —
memory that several agents and processes share safely cannot pretend it is a
synchronous local file. Postgres is an option for stores that outgrow local
files, not a new requirement: YAML stays the default and the source of truth
everywhere else.

### BREAKING — the write path is asynchronous

`Plur`'s store interface and 23 public methods now return promises (#728):
`compact`, `episodeToEngram`, `getById`, `ingest`, `inject`, `installPack`,
`learn`, `list`, `listPinned`, `listStores`, `outboxCount`, `purgeTensions`,
`recall`, `receipt`, `recordTensions`, `reindex`, `rerankerEvalStatus`,
`resolveTension`, `saveMetaEngrams`, `setPinned`, `status`, `sync`,
`updateEngram`.

`learnRouted`, `learnBatch`, `recallHybrid`, `injectHybrid`, `feedback`,
`forget` and `flushOutbox` were ALREADY async before 0.16 and are unchanged
here — an earlier draft of this section listed them as newly promise-returning,
which would have sent you auditing call sites that never moved.

`npx @plur-ai/migrate` still reports un-awaited calls to `learnRouted`,
`learnBatch`, `feedback`, `forget` and `flushOutbox`, because such a call was a
bug before this release too. It does NOT report `recallHybrid` or
`injectHybrid` — those are embedding-backed retrieval that callers have always
awaited, so they are out of the tool's scope.

**Every out-of-tree consumer must add `await`.** The failure mode is quiet: a
call whose result is used without awaiting yields a `Promise`, and most
assertions and property reads on a `Promise` succeed rather than throw, so code
appears to work while operating on nothing. `{...plur.status()}` becomes `{}`.
`for (const e of plur.recall(q))` throws, but `plur.recall(q).length` is simply
`undefined`. TypeScript catches all of it; JavaScript consumers will not.

`capture()` and `timeline()` stay synchronous — they are backed by
`episodes.yaml`, not the engram primary store. So do `suggestScope`,
`dismissScope`, `reofferScopes`, `CapabilityCanary.warnings` and
`listImportSources`: an automated pass made them async during the flip even
though they do no async work, and they were reverted rather than shipped as
breaking changes that bought nothing.

Why: a network-backed store cannot satisfy a synchronous contract (there is no
synchronous Postgres client for Node, and manufacturing one trades a documented
limitation for an undocumented hazard). The sync interface was a hard ceiling on
running core anywhere except one local process. See ADR-0003 and ADR-0004.

`PrimaryStore` and `AsyncPrimaryStore` have collapsed into one interface;
`AsyncPrimaryStore` remains as a deprecated alias so existing imports resolve.

`StorageAdapter` — a public export — gains two required members (`role`,
`vectorIndex`) and demotes `syncFromYaml()` / `reindex()` to optional. An
out-of-tree implementation of that interface will not compile until updated;
`DERIVED_INDEX_DEFAULTS` is exported to make that a two-line change for an
adapter that has the historical behaviour (a derived index over YAML, answering
`searchVector` exactly). Adapters that are approximate should declare that
rather than take the default — a wrong `vectorIndex` is worse than none,
because it is a claim a caller may act on.

### Added

- **MCP Toplist rank badge** (#748) in the README.
- **Packs install from a URL** (#746): `plur packs install <url>` and
  `plur packs preview <url>` fetch a pack over HTTP instead of requiring a local
  directory, so a pack can be shared by link. Preview still runs the security
  scan before anything is written, and the same scan gates install.
- **The engram schema tolerates an unknown `commitment` value** (#744): parsing
  passes through values it does not recognise rather than rejecting the engram,
  so a store written by a newer or differently-configured deployment stays
  readable instead of failing the whole load.
- **`@plur-ai/mcp` exposes a side-effect-free `./tools` subpath** (#714, #717):
  `import { getToolDefinitions } from '@plur-ai/mcp/tools'` yields the tool
  definitions without starting a server or touching stdio, so another server can
  host PLUR's tools inside its own process.
- **`npx @plur-ai/migrate`** — finds the un-awaited calls this release creates, and fixes the unambiguous ones. Reports by default; `--write` applies. It refuses to rewrite the three cases where inserting `await` changes program meaning rather than just adding a wait (inside a `Promise` combinator array, a concise arrow body, a result consumed across lines) and lists them for a human instead. Exit code 2 when anything needs attention, so it composes in CI. Every hazard it guards is one the codemods that migrated PLUR itself actually hit.
- **Postgres as a primary store** (ADR-0005) (#720). `new Plur({ store: new PostgresAdapter({ connectionString }) })` runs the engine directly against server Postgres — the same engine, a different deployment. `pgvector` for vectors, exact or HNSW with the recall target declared rather than implied.

  **Vectors on this tier are not populated by the engine.** `upsertEmbedding`
  and `searchVector` are implemented and work, but core's only caller of
  `upsertEmbedding` runs for the PGLite derived index, never for a primary
  store — so `engram_embeddings` stays empty unless your deployment writes to
  it, and semantic recall falls back to loading engrams and scoring in memory.
  Configuring `vectorIndex: 'hnsw'` now logs a warning saying so rather than
  quietly indexing an empty table. Wiring the engine to fill it is follow-up
  work: the existing auto-embed pass loads the whole corpus and probes each id
  on every write, which at the 50,000-engram threshold that selects this tier
  would cost more than the gap it closes.
- **Cross-process write safety** (ADR-0004) (#719). `PrimaryStore.withExclusiveAccess?()` — the store decides how it is serialized, because the store is what knows what it shares. `PostgresAdapter` takes a session-scoped advisory lock; a local-file store keeps its file lock. Without this, two processes over one database silently overwrote each other, and a *read-only* `recall()` on one could delete an engram another had just committed (`recall` updates activation, so it is a whole-corpus write).
- **Permitted-scope allow-list pushed into the query** (#715, #739, #743) — `scopes` on `RecallOptions` and now `InjectOptions`. An AUTHORIZATION filter, distinct from the `scope` visibility filter: absent = unrestricted, `[]` = matches nothing, non-empty = exact membership with no hierarchy expansion and no personal-family pass-through. `inject()` had no authorization filter at all before this, which for a multi-tenant caller meant every principal's personal engrams reached every other principal's context.
- **BM25 narrowing pushed into Postgres** (#711, #732, #743) via `pg_trgm`, with corpus-wide statistics (`CorpusStats`: `N`, per-term `df`, `avgDocLength`) supplied by the store so narrowing cannot change the ranking. Tokens are computed in TypeScript at write time by the same `ftsTokenize` the scorer uses, so there is no second tokenizer free to drift.

### Fixed

- **Pre-release audit fixes** (#747): concurrent Postgres schema init, the migrate
  tool's combinator/paren/template/optional-chaining scanning, `setPinned`'s
  fabricated remote return, the release smoke's authorization checks and its CI
  wiring, plus lean-tool/storage/ADR documentation drift.
- **Independent pre-release audit fixes** (#752, #755): the migrate tool's ASI
  hazard (a line-leading `(await ...)` after an unterminated statement parses
  as a call on the previous expression — it now refuses), bracket-indexed
  receivers it silently missed, and a combinator false positive from comment
  text; recall's multi-store union is now scored with exact union corpus
  statistics instead of primary-only ones (a term absent from the primary
  corpus priced as maximally rare and buried the best match); vacuous fallback
  paths in the migrate method-list guard now hard-fail in CI; `Plur`'s
  constructor warns when a supplied store implements exactly one of
  `loadByIds`/`updateMany` (safe via the call-site fallback, but almost
  certainly an implementation mistake); the
  `PostgresAdapter.close()` construction-race leak is actually documented
  (#751); release.sh gained a working-tree preflight and canary-publish
  recovery guidance; README states the Postgres-tier embeddings caveat.
- **A `recall()` could delete the corpus on a partially-targeted store** (#749).
  `loadByIds` and `updateMany` are independently optional on `PrimaryStore`;
  with the targeted read present and the targeted write absent, reactivation's
  whole-file fallback replaced the corpus with the current result page —
  measured: 12 engrams in, `recall(limit 3)`, 3 left. Both paths are now gated
  behind one capability check (the pair, or neither), and `updateEngram`'s
  remote-store error path no longer takes down the MCP server.
- **`recall()` returned the wrong rows on a pushdown store** (#750). Two bugs:
  secondary-store and pack engrams were appended AFTER primary results, so a
  team engram that was the single best match never appeared once the primary
  store had `limit` hits — they are now ranked together; and the fixed 3x
  over-fetch starved recall when residual filters (expiry, `min_strength`)
  rejected more than two thirds of a page — the fetch now widens and re-queries,
  bounded at three rounds (recoverable rejection ceiling 26/27 ≈ 96.3%).
### Fixed

- **BM25 reverse-substring matches** (#721, #724): `qt.includes(t)` let any document token that was a non-prefix substring of the query score a hit — `deploying` matched an engram about *yin*, `postgres` matched one about *res*. Now `qt.startsWith(t)`, which keeps morphological prefixes (`deploy` → `deploying`) and drops the junk. Measured on a 3,930-engram store: no query loses results, and the reverse-substring matches it removes were never meaningful.
- `pg` is externalized from the bundle — it is an `optionalDependency`, so it was being inlined into `dist` and the published `PostgresAdapter` would have thrown on first use.
- `plur learn`'s 5s remote-write timeout was dead code (an `await` inside `Promise.race` resolved the call before the timer was armed).
- `init-remote` silently ignored `--quiet` and printed prose under `--json`.
- **MCP tool schemas silently dropped array items** (#705): a union item schema was
  emitted without a usable `items` definition, so a client sending a well-formed
  array had elements discarded on the way in. Union item schemas are now coerced,
  and a partial drop is surfaced rather than passed through as a shorter array.
- **`truncated` was reported wrong when `budget.max_results` capped a recall**
  (#725, #726): the flag was computed before the budget cap applied, so a
  truncated result set claimed to be complete and callers had no signal to page.
- **`server.json` version drift** (#699): the MCP Registry manifest carried its
  version in two places and only one was bumped, so the published listing could
  disagree with the package. `release.sh` now writes both.

### Changed

- **`plur_recall` is now the unified recall tool (#693, #702)**: gains a `mode` parameter — `'hybrid'` (default, BM25 + local embeddings via RRF) or `'keyword'` (BM25-only). Existing callers that pass no `mode` get a quality upgrade without any API change. **Breaking for the lean/cursor profile**: `plur_recall_hybrid` is no longer a top-level lean tool — `plur_recall` takes its slot. Agents configured against the lean profile that call `plur_recall_hybrid` by name will still get results (the tool remains accessible via `plur_admin` dispatch), but should migrate to `plur_recall`.
- **`plur_recall_hybrid` is a deprecated alias** (#693): it invokes the canonical `plur_recall` handler with `{mode:'hybrid'}` and prepends a one-line `deprecated` notice — a real forwarder, so budget capping, episode expansion, the degraded-embeddings warning and reranker surfacing cannot drift between the two before the alias is removed. Removal target: 0.18. Accessible in both full and lean profiles (via `plur_admin`) to avoid breaking existing CLAUDE.md files and agent templates in the wild.

### Added

- **`plur init` now prompts for anonymous usage statistics opt-in** (#701). On interactive installs a single yes/no prompt asks "Enable anonymous usage statistics? (helps us improve PLUR — no code, no keys) [y/N]" and persists the answer to `~/.plur/telemetry.json`. Non-interactive installs (CI, piped stdin, `--no-prompt`) write `enabled:false` silently — they are never opted in without explicit consent. Already-configured installs skip the prompt entirely, as do installs with an explicit `PLUR_TELEMETRY` env var — env wins at runtime, so no contradictory config file is written. To enable after the fact: `PLUR_TELEMETRY=on` env var or edit `~/.plur/telemetry.json`. See [`docs/telemetry-design.md`](docs/telemetry-design.md) for what is collected (learn/recall counters only — no code, no keys, no content).

## 0.15.0 (2026-07-21)

Scopes go live + leaner MCP.

- lean default — 74% fewer tokens
- scope routing + plur scopes CLI
- plur receipt — memory receipt
- scope-aware sync + security fixes
- MCP SDK v2 (split packages)
- Windows path + ID uniqueness fix
- two P0 security fixes: credential redaction + receipt snippet sanitization

### Changed

- **Lean tool profile is now the default** (#625, #694): the MCP server exposes 12 tools — 11 core + the `plur_admin` dispatch (down from 40) to every consumer — Claude Code, Cursor, Windsurf, OpenClaw, Hermes, and nightshift agents alike. Per-turn tool-schema overhead drops ~74% (~2K vs ~9K tokens). All 40 tools remain reachable via `plur_admin { action: "<tool>", args: {...} }`. Restore the full surface with `PLUR_TOOL_PROFILE=full`. **Consumers that depend on all 40 tools being available by default must either call via `plur_admin` or set `PLUR_TOOL_PROFILE=full`.**
- **MCP SDK v2 migration** (#638): `@plur-ai/mcp` now uses the MCP SDK v2 split packages (`@modelcontextprotocol/server`, `@modelcontextprotocol/client`, `@modelcontextprotocol/core` @ 2.0.0-beta.4), replacing the monolithic `@modelcontextprotocol/sdk@^1.12.0`. Prepares for the MCP spec stable release (2026-07-28). The public API of `@plur-ai/mcp` is unchanged; 226 tests pass.

### Added

- **`plur-langchain` adapter** (#529): new Python package providing a LangChain `BaseMemory` + `BaseChatMessageHistory` adapter. Install with `pip install plur-langchain`. Chains and LCEL pipelines now get persistent engram memory with zero extra wiring.
- **`plur scopes` CLI — per-scope opt-out for authorized-but-unregistered scopes** (#647, #656): `plur scopes` lists shared scopes from configured remotes (with each scope's description); `plur scopes register <scope>` adds one; `plur scopes dismiss <scope>` opts out permanently (persisted to `~/.plur/config.yaml`); `plur scopes --reoffer` clears all dismissals. Dismissed scopes are excluded from `plur scopes list` and from the MCP session-start hint. The session-start nudge is now a single quiet line pointing at `plur scopes` (replacing the all-or-nothing `register:true` model and the verbose agent-facing guide text users never saw).
- **`plur receipt` + `plur_receipt` MCP tool — the memory receipt** (#660): a counted, local, read-only report of what your memory actually retrieved for you — how many times a memory was put in front of the model, how many distinct engrams it drew on, and which are most relied on (with their statement text). Every figure is directly counted — no estimate, no counterfactual, no dollar or token-savings figure (on a subscription your marginal token cost is zero). Scoped to local memory (primary store + installed packs) so the number is identical from the cold CLI and the warm MCP server; retrievals of team-store engrams are reported separately. Nothing leaves the machine.
- **`co_injection` history events now record `tokens_used` and the calling `source`** (#660): `session_start` / `inject` / `hook` sources are tagged at every injection call site. Hook retrievals now also carry the session id, so the receipt's (engram, session) unit is well-defined. Events written before this change remain fully readable.
- **Missing-domain nudge at capture time** (#671, #677): a write without a `domain` cannot auto-route (the domain-prefix channel is the only signal that reliably clears the auto-route threshold), so `plur_learn`, `plur_learn_batch`, and `plur learn` now return an advisory `domain_hint` when a domain-less, scope-less write lands unrouted while covers-declaring scopes are registered. Silent on personal installs with no covers-bearing scopes; never blocks a write.
- **Scope-filtered push for shared sync remotes** (#640, #678): new `sync.remote_type` config (`personal` | `shared`). `personal` (default) keeps the historical mirror-everything behavior; `shared` pushes ONLY shared-family-scope, non-private engrams — personal-family (`local`/`global`/`user:*`/`agent:*`) and `visibility: private` engrams never reach a team remote, by construction. Also fixes a latent leak: the merge-conflict resolution commit previously staged `engrams.yaml` verbatim, so `scope:local` engrams could ride into the remote on that path. Known limit: the filter covers `engrams.yaml`; the sibling store files (`episodes.yaml`/`candidates.yaml`/`tensions.yaml`) still sync verbatim — sibling-file strip tracked in #686.
- **`min_confidence` floor wired into the suggestion surface** (#670, #675, #683): `suggestScope` accepts `{ minConfidence }`, a new `scope_routing.min_confidence` config key floors the advisory candidate list, and `plur_suggest_scope` applies a display default of 0.15 so lone-keyword noise (≈0.12) no longer surfaces to agents (pass `min_confidence: 0` for the unfiltered list). The auto-route gate (`match_threshold`) is unchanged.

### Fixed

- **`plur_recall_hybrid` fails with `ENOENT: mkdir ''` on Windows** (#641, #642): `saveCache` extracted the directory with `cachePath.lastIndexOf('/')`, which returns -1 on Windows backslash paths — `substring(0, -1)` yields `''`, and `mkdirSync('')` throws ENOENT. Replaced with `path.dirname()` (cross-platform) and added a guard against empty dirname. `plur_recall` / `plur_learn` / `plur_doctor` were unaffected; only the hybrid path (`plur_recall_hybrid`) hit `saveCache`. Regression tests added (4 cases, offline mock embedder).
- **Dependency security overrides** (#632): tightened transitive dependency overrides addressing 30 Dependabot alerts across `openclaw`, `undici`, `linkify-it`, and `js-yaml`.
- **`generateInjectionId` / `generateEventId` cross-process uniqueness** (#596): IDs are now unique across processes started within the same millisecond. Replaced `Date.now() + 4-char random suffix` with a per-process counter — eliminates the ~0.07% birthday-collision chance per 50-call batch and removes the intermittent `expected 49 to be 50` flake in co-injection tests.
- **`RemoteStore.load()` — no cache poisoning on mid-pagination error** (#550): a network or server error mid-way through a paginated remote load no longer overwrites the local cache with partial data. The local cache is only updated after a complete, successful load.
- **PID salt for cross-process ID uniqueness** (#600): ID generation now includes the process ID as a salt, preventing collisions between sibling processes (e.g. parallel nightshift agents) that start in the same millisecond.
- **Security: `plur status --json` printed live enterprise bearer tokens** (#660): `StatusResult` embedded the full `PlurConfig`, so `--json` piped the `stores[].token` values (live credentials for configured enterprise servers) to stdout — into CI logs, pasted issues, and agent transcripts. All CLI JSON output is now credential-redacted at the output boundary, so every present and future JSON command inherits the protection. Redaction also masks credentials embedded in string values (URL userinfo, e.g. `https://user:pass@host`), which a key-based denylist cannot reach.
- **Security: memory receipt snippet sanitized against hostile engram statements** (#660): statement text can come from third-party installed packs; the "most relied on" snippet (printed to the terminal and returned to the calling agent) now strips ANSI/terminal escapes, C0/C1/DEL controls, Unicode line/paragraph separators, and bidi (Trojan-Source) reordering + zero-width spoofing characters before rendering. Truncation is grapheme-safe.
- **MCP Registry publish now fires on every release** (#695): the publish workflow ran on `release: published`, which GitHub suppresses when the release is created by a GITHUB_TOKEN actor — v0.14.0 shipped to npm while registry.modelcontextprotocol.io stayed at 0.13.0 (the registry feeds mcp.so and PulseMCP). `release.sh` now triggers the workflow deterministically after `gh release create` (Step 7b); the workflow is `workflow_dispatch`-only so the suppressed/double-run event path is gone.
- **`suggestScope` silently inert for remote scopes** (#668, #674): `discoverRemoteScopes()` fetched `scope_metadata` (including `covers[]`) from `GET /api/v1/me` but never wrote it to the local config store entries that `listScopeMetadata()` and `suggestScope()` read — so scope routing returned `[]` for every remote scope regardless of query relevance. New `persistScopeMetadata()` call at every `/me` pull site (session_start, registerDiscoveredScopes, registerScope) fixes this.
- **Scope metadata trust hardening + registry hygiene** (#685): nine fixes from the 2026-07-24 scope audit. HIGH: a hostile/compromised enterprise `/me` could serve `sensitivity:{allow:['secrets','infra']}` and — because `persistScopeMetadata()` persisted it verbatim and the leak guard checks `allow` before `forbid` — silently disarm the write-time leak guard at the next session_start. Remote sensitivity now only TIGHTENS: remote `allow` is never persisted, `forbid` is sanitized to the known categories, and a hand-edited local `allow` remains honored. Also: the metadata change-detector now converges (no more config.yaml rewrite + mtime churn on every session_start); `plur_scopes_discover register:true` respects dismissed scopes (per-scope `registerScope` stays the override); session_start guidance describes post-#674 auto-routing honestly; overwriting hand-set local covers/description warns; endpoint URL identity folds `https://x.com` / `https://x.com/` / `https://x.com/sse` spellings (new `normalizeEndpointUrl`); config.yaml persists run under `withLock`; scope-family prefixes and dismissed-scope matching are case-insensitive; the unscoped write path reloads a changed config before routing.

## 0.14.0 (2026-07-15)

A hardening release — 24 issues closed.

- sharper recall + reranker fixes
- hardened shared-scope metadata
- feedback + hook reliability
- CLI pack management

A reliability and hardening release: memory-quality, feedback, and security fixes across recall and shared-scope handling, plus CLI pack management and richer status filters. npm `latest` moves 0.13.0 → 0.14.0; 0.12.0 remains deprecated.

### Changed

- **batchDecay removed — decay is a read-time property, not a scheduled job** (#563). The weekly/cron decay pass materialized elapsed-time decay back into stored `retrieval_strength`, which both double-counted against the read-time decay already applied at injection and mutated provenance on a timer. Decay is now computed only at read time (`decayedStrength` over `last_accessed`), and reinforcement re-anchors `last_accessed` on access. The `plur batch-decay` CLI command and `plur_batch_decay` MCP tool are **removed** — any cron or client still invoking them will get an "unknown command/tool" error, so delete those schedules. There is no replacement scheduled job, by design. The superseded-engram "decays 2× faster" path lived only inside batchDecay and is gone with it; superseded engrams are still de-prioritized at injection time by the ×0.3 historical-intent penalty, which is unaffected.
- **`plur_learn_batch` output contract** (#281, #572) — *breaking for direct MCP consumers*: on partial failure, `ids` is now a 1:1 input-aligned array with `null` in each failed slot, instead of a compacted array of only the successes. A client indexing `ids` positionally against its inputs was silently misattributing IDs on any partial failure; it now lines up. Update anything that assumed `ids.length === successCount`.
- **`plur login` groundwork landed but is not active** (#532): the enterprise OAuth device-flow login implementation shipped in the tree but is **intentionally not registered** in the CLI dispatcher — `plur login` returns "Unknown command." It is happy-path only (no paste-token fallback, a hard dependency on server device-flow endpoints, no refresh tokens), so it is deactivated pending that hardening and will be enabled in a later release. See #300.

### Fixed

- **Reranker fit-check judges relevance, not co-membership** (#451, #565): the per-store `plur doctor` reranker gate built its pairs from same-domain co-membership, which a cross-encoder can't meaningfully score. It now synthesizes a probe query per engram and scores (probe, own-doc) as positive vs (probe, cross-domain-doc) as negative, so the gate measures whether a reranker actually helps a given store.
- **Commitment and confidence render as distinct fields** (#348, #564): `formatLayer3` overloaded a single slot; the injected line now shows `Commitment: <tier> | Confidence: <float>`, so a decided/locked commitment is no longer misread as a confidence value.
- **Historical-intent match is word-boundary, not substring** (#481, #567): substring matching false-positived ("prior" ⊂ "priority", "old" ⊂ "threshold", "was" ⊂ "wasm"), wrongly suppressing the superseded-engram penalty and injecting stale memory. Now anchored on word boundaries; multi-word keywords like "used to" match across any whitespace gap, including a newline or tab.
- **SessionEnd no longer destroys checkpoints; session_id path traversal closed** (#217, #568): the SessionEnd hook deleted the learn checkpoint even when the capture had failed, losing the session's learnings. It now deletes only after a confirmed capture and retains an unparseable checkpoint in place. A crafted `session_id` could also escape the sessions dir — now sanitized on both the write and read sides.
- **claw setup no longer destroys third-party OpenClaw config** (#51, #566): the stale-entry prune fired transiently during every install/upgrade and could delete other plugins' config entries, including their API keys. Removed; claw now seeds only what's absent and writes atomically.
- **EmbeddingGemma uses its model-card role prefixes, not E5's** (#483, #573): the opt-in `embedding-gemma` embedder applied E5-style `query:`/`passage:` prefixes instead of Gemma's `task: search result | query:` / `title: none | text:`, degrading recall. Fixed, with the embedder cache name bumped so the JSON embedding cache rebuilds automatically. **PGLite-backed stores (`PLUR_BACKEND=pglite`) on `embedding-gemma` must reindex once** with `plur sync --reembed --full`: that path keys on vector dimension, which didn't change, so it can't auto-detect the prefix change.
- **Scope metadata is length- and control-char-bounded on the remote path** (#345, #571): a hostile or MITM'd `/api/v1/me` could return an oversized or newline/control-char-laden scope `description`/`covers`, surfaced verbatim to the agent. These fields are now bounded (≤500 / ≤120 chars, ≤32 covers) and reject C0/C1 controls, DEL, and the U+2028/U+2029 line separators. This hardens against *structural* injection (faking a new instruction line); it does not, and cannot, filter a plain in-band instruction — treat scope metadata from an untrusted store as untrusted text. The local, user-authored config path is unaffected.
- **Feedback re-anchors `last_accessed`**: `plur_feedback` adjusted stored `retrieval_strength` without advancing `last_accessed`, so read-time decay immediately swallowed the adjustment — a >4× distortion on dormant engrams, exactly where a fade-vs-keep signal matters most. Feedback now re-anchors `last_accessed`, mirroring the reinforcement path.
- **Tension pre-filter stemming dropped** (#489, #570): the suffix-stemming step changed the labeled recall suite on zero pairs (29/30 with and without) while generating false positives ("states"/"station"/"stats" → "stat"); removed for precision.
- **Python SDK bridge robustness** (#495, #569), with the SDK's npx-fallback CLI pin now auto-bumped and verified at release so it can't ship pointing at a pre-fix CLI (#577).
- **Process-group orphan kill ported to the hermes bridge** (#575): the `plur-hermes` bridge now kills the whole process group on timeout (`start_new_session` + `killpg`), so a timed-out `npx @plur-ai/cli` can't orphan a runaway `node` grandchild.
- **Hooks fail open on an unwritable state dir** (#574): the session-guard, learn-check, and inject-lock hooks now proceed instead of crashing the prompt or tool call when their state directory isn't writable.
- **Assorted hook/remote robustness**: per-session concurrency lock for hook-inject (#519), AbortController coverage extended to the `RemoteStore.load()` body read (#531), and `isPlurConfigured` checks the home directory only when the working directory is under home (#521, #247).
- **`plur doctor` flags stale PGLite + embedding-gemma vectors** (#581): the companion diagnostic to the #483 caveat above — when the PGLite backend runs the opt-in `embedding-gemma` (whose vectors that backend does not auto-rebuild), doctor advises a one-time `plur sync --reembed --full`. Advisory only; it never fails the overall check.
- **claw warns non-destructively on orphaned OpenClaw config entries** (#583): #51 removed the destructive prune that deleted third-party plugin config — including embedded API keys — whenever a plugin dir was transiently absent during install. `plur doctor` now *warns* about genuinely-orphaned entries (PLUR's own and third-party) without ever deleting, restoring detection without the data-loss.

### Changed (cleanup)

- **Removed dead `strengthToStatus`** (#582): unused since batchDecay's removal, and its label vocabulary never matched the persisted `status` enum. The `dormant`/`candidate` enum values are retained (legacy/reserved) for backward-compatibility with stores written before #563 — removing them would reject existing data.

### Added

- **Session injection telemetry** (#536): per-pack activation tracking logged at `session_end` for offline relevance analysis.
- **`plur_status` domain + `created_after` filters** (#522, #524).
- **packs install/list/uninstall CLI subcommands** (#513), and the claw `before_prompt_build` migration with sharpened ClawHub positioning (#516).

### Release tooling

- The manifest gate (`release.sh`) now recognizes multi-issue commit trailers like `(#521, #247)` — the old extraction silently dropped every number in a comma trailer — and curates out this repo's internal `ops`/`cmo` commit types alongside the standard non-user-facing set. The canary smoke-test command substitution is also guarded under `set -e` (#578).
- **Publish verification hardened** (#584): the `@next` smoke test now covers `core` (install + ESM import, catching the import-time crash class that bricked `cli@0.9.2`) and `mcp`, not just `cli` — the audited fixes live in `core`. PyPI publish now verifies the version is retrievable after upload and prints an explicit recovery path on failure (PyPI is immutable). The session-guard's unwritable-state-dir fail-open now leaves a stderr audit trail instead of a silent bypass.
- The pre-release hardening pass for this release — the U+2028/U+2029 scope-metadata gap, multi-word historical-keyword matching, the `feedback()` `last_accessed` re-anchor, and the manifest-gate fix above — landed in (#579). The audit follow-ups (#581–#584) landed in (#585).

## 0.13.0 (2026-07-09)

Withdrawn — manifest-gate incident (#544). Cut ~90 minutes after 0.12.0 to walk back unintended features that weren't sufficiently tested. npm `latest` skips this version; upgrade directly to 0.14.0.

## 0.12.0 (2026-07-09)

Cursor IDE support (experimental/beta), plus a batch of queued core improvements: batch learning, supersedes chains, commitment tiers, reranker fit checks, session-end auto-close.

### Cursor IDE support (experimental/beta)

PLUR now works inside Cursor — its own hook system (`sessionStart`, `preToolUse`, `postToolUse`, `stop`), its own MCP config, and a reduced tool profile so PLUR doesn't blow Cursor's ~40-MCP-tool-per-workspace budget.

- **Install**: `npx @plur-ai/cli@0.12.0 init --cursor` (auto-detected too, if a `.cursor/` dir already exists in your project). Writes `.cursor/mcp.json`, `.cursor/hooks.json`, and `.cursor/rules/plur-memory.mdc`.
- **Reduced tool profile**: Cursor gets ~11 core tools (`plur_session_start`, `plur_learn`, `plur_recall_hybrid`, `plur_feedback`, `plur_forget`, `plur_session_end`, `plur_status`, `plur_doctor`, `plur_packs_uninstall`, `plur_tensions_purge`) plus **`plur_admin`**, a dispatch tool for everything else (`{ action, args }`) — instead of the full 39-tool surface, which alone would consume ~97.5% of Cursor's per-workspace MCP budget.
- **Memory delivery workaround**: Cursor's hook-output `additional_context` field is dropped by a confirmed race condition (acknowledged by Cursor's own team, no fix ETA), so PLUR delivers recalled memory and reminders through dynamically-rewritten `.cursor/rules/*.mdc` files instead — Cursor's rules engine reliably loads these.
- **`plur doctor`** now diagnoses Cursor-specific wiring (`.cursor/mcp.json` / `.cursor/hooks.json`, tool-profile env, live MCP tool count for both the full and Cursor profiles).
- **Why "experimental/beta"**: this integration has been through a full implementation review, an adversarial Codex review, and a 5-round multi-evaluator audit — but has **not yet been verified against a live Cursor install** (Cursor's hooks API is itself documented as beta and may change). Field-name assumptions (`conversation_id` vs `session_id`) and a couple of behaviors are confirmed via Cursor's own documentation and community forum, not a live run. Report issues at github.com/plur-ai/plur/issues.

### Added

- **`plur_learn_batch`** (#281): persist many engrams in one MCP call — same dedup + policy pipeline as `plur_learn`, partial-failure isolation, bounded LLM dedup cost.
- **Supersedes chain consumer behavior** (#481): inject prefers chain tips under budget pressure (unless the query is historical), recall annotates superseded engrams with their replacement, decay accelerates for low-recall superseded engrams. (The "decay accelerates for low-recall superseded engrams" behavior was **removed in 0.14.0** (#563): it lived only inside the batchDecay pass, which was retired. Superseded engrams are still de-prioritized at read time by the ×0.3 injection penalty — that part is intact.)
- **Commitment tier in injected text** (#348): `formatLayer3` shows the commitment label (`exploring`/`leaning`/`decided`/`locked`) instead of a raw confidence float when set.
- **Per-store reranker fit check** (#451): `plur doctor` scores whether a cross-encoder reranker is actually helping on a given store's domain, since out-of-domain rerankers can produce inverted scores.
- **`plur_session_end` wired to Claude Code's SessionEnd hook** (#217): memory lifecycle now auto-closes when a session ends, instead of depending on the agent remembering to call it.
- Python SDK bumped to 0.10.0 (`recall_hybrid`, npx pin fix).

### Fixed

- **Orphaned hook processes on degraded networks** (#504): `hook-inject` had no process-level ceiling and `RemoteStore.load()` made unbounded fetch calls — together these could accumulate dozens of orphaned processes and gigabytes of swap on a flaky connection. Added a self-watchdog (55s default ceiling) and a 30s fetch timeout with fail-open (cached engrams or `[]`, no cache poisoning).
- **Tension subject filter** (#489): suffix-stemming in the contradiction pre-filter. (The "77%→90% recall" figure originally published here was withdrawn on 2026-07-14 — re-running the commit's own 30-pair suite gives 29/30 both with and without stemming, changing the outcome on zero pairs. The number was never reproducible. See #489.)
- **`hook-learn-check`'s Stop-hook counter** made atomic (append-only, not read-increment-write) — the same race class found and fixed in the new Cursor hooks during their audit.
- Three OpenClaw (`@plur-ai/claw`) UX fixes: stale plugin-manifest pruning, `plugins.allow` seeding on fresh installs, `runtime_registered` verified via an actual filesystem check instead of a hardcoded placeholder.

### Changed

- Benchmarks consolidated into the standalone `plur-bench` repo; `benchmark/micro.ts` (core-operation latency) stays in-repo as `pnpm bench:micro`.

## 0.11.0 (2026-07-06)

Hooks that actually finish, tension lifecycle, migration importers.

- Injection hooks now install async — no more hook timeouts on large stores
- Event hooks switch to BM25 and complete in <1s instead of dying at timeout
- Tension lifecycle: confirm/dismiss/resolve + injection warnings
- Migrate from mem0/gp-engram/generic JSON: `plur import --from`
- Tiny-tier reranker (ms-marco-MiniLM-L6) + per-store rerank eval gate

### Fixed: installed hook config timed out on every prompt for large stores (#502)

Once a store grows past a few thousand engrams, the CLI cold-start pays ~20s to load the BGE embedder for hybrid injection. The hook config `plur init` installed (sync, `timeout: 15`) meant users eventually hit `UserPromptSubmit hook timed out — output discarded` on **every first prompt** — full cold-start cost paid, zero engrams injected.

- `plur init` now installs `hook-inject` (UserPromptSubmit) and `hook-inject --rehydrate` (PostCompact) with `async: true` and a 90s ceiling. The prompt proceeds immediately; injected context arrives when search completes. **Run `plur init` again after upgrading to migrate an existing install** — init strips and reinstalls its hooks.
- The `--event` hooks (plan_mode / skill / agent / subagent) drop hybrid search and go straight to BM25. They must stay sync — their context has to arrive *before* the tool runs — so they must actually fit their 10s window; hybrid never could on a cold start, so they were killed at timeout on every invocation, burning CPU and injecting nothing. BM25 completes in <1s against a 4k-engram store. First-message injection keeps full hybrid.

### Added

- **Tension lifecycle** (#181, #240): tensions persist with confirm/dismiss/resolve actions and surface as injection warnings; detection is temporal-aware — a genuine contradiction is distinguished from knowledge that merely evolved.
- **Migration importers** (#441): `plur import --from generic|gp-engram|mem0` brings existing memory stores into the engram format.
- **Tiny-tier reranker** (#451): ms-marco-MiniLM-L6 adapter for faster reranking, plus a per-store reranker eval gate that self-checks rerank vs plain RRF and disables reranking where it doesn't help.
- **Lexical query rewriting** (#224): deterministic query expansion for hybrid recall.
- **Injection provenance** (#452): `co_injection` and `injection_outcome` events logged for offline relevance analysis.
- **Scope-routing tuning** (#362): `match_threshold` and `weight_tag` exposed as config.
- **ETL extraction provenance** (#463): convention for `structured_data.extraction` metadata on imported engrams.

### Fixed

- EMBED_DIM contract completed — active-dim column sizing enforced at the storage boundary (#335).
- Async UPDATE/MERGE increments `engram_version`, not `version` (#487).
- MCP array-typed tool arguments hardened against client serialization bugs (#297).
- Reranker pre-flight probe added to the benchmark harness (#341).

## 0.10.0 (2026-06-25)

Security-hardening release, independently audited.

- Engram leak guard hardened
- Pack & sync locked down
- Private-by-default scopes
- Independently re-audited (Črt)
- **Python SDK (`plur-ai`)**: bumped to 0.10.0 — adds `recall_hybrid()` (BM25 + embeddings + RRF), pins npx fallback to CLI 0.10.1

PLUR's engram leak guard, scope isolation, pack/sync distribution, and remote-store trust boundaries were hardened across three internal audit rounds **and an independent adversarial re-audit by Črt** — the Blocker and the full High confidentiality cluster fixed and re-verified, plus every Medium/Low finding. Also lands per-engram scope routing, **private-by-default** visibility, and read-side personal-scope visibility on all three read paths. No breaking API changes; the behavior changes are noted per entry below.

### Security: sensitivity scan window raised to 1 MiB and fail-closed past it (#386)

`detectSensitive()` truncated its input to the first 64 KB before scanning, then silently passed the rest. The infra-topology detectors (`public_ipv4`, `public_ipv6`, `basic_auth_url`, `fqdn_port`, `ipv4_port`, `internal_host`) exist only in `detectSensitive`, so an engram whose first 64 KB was benign filler but which carried a public IP / basic-auth URL / internal host **after** byte 64 KB passed the write guard un-demoted and was written to a shared/remote store (and slipped past `filterPublishable`).

- The scan window is raised from 64 KB to **1 MiB** — far above any realistic engram. The detector regexes were described here as bounded/linear; that was wrong for `jwt`, which was quadratic on repeated `eyJ` (1 MiB took about six minutes) until #1397 replaced it with a linear matcher. A benign full-window pass is ~7ms/64KB but adversarial regex-dense input measured ~300–420 ms for a full 1 MiB pass (#386 review). Total scan work is capped at 1 MiB regardless of input size (bounded, linear — a per-write CPU cost on >64KB engrams, not a DoS).
- Input larger than the ceiling is now **fail-closed**: `detectSensitive` appends a synthetic `scan_truncated` hit so `_guardSensitiveScope` demotes the write and `filterPublishable` excludes the engram — the unscanned tail can no longer be assumed clean. The `scan_truncated` signal is always offending regardless of a scope's `sensitivity` policy.
- **Packs export inherits this** (via #389): `scanPrivacy` now routes through `detectSensitive` + `truncateToScanLimit`, so the raised window, the infra-family detectors, and the `scan_truncated` fail-closed all apply to `exportPack`/`installPack` too — the "...and packs" half of #386, delivered by the #389 packs-scan change rather than here.

**Behavior change:** infra/secret content anywhere in the first 1 MiB is now detected and demoted; an engram larger than 1 MiB destined for a shared/remote scope is demoted to `local`/`private` (fail-closed) rather than silently passing.

### Security: `plur sync` never commits secrets or machine-local files (#380, #384)

`plur sync` could commit and push `~/.plur/config.yaml` — which holds remote-store Bearer tokens — to any git remote, because the sync `.gitignore` excluded only derived/cache files and `git add -A` staged everything else. It also ran `git config core.excludesFile /dev/null`, defeating any protective ignore a security-conscious user had configured (#384).

- **Allowlist staging.** Sync now stages *only* the engram-store files (`engrams.yaml`, `episodes.yaml`, `candidates.yaml`, `packs/`, `.gitignore`) via a force-add (`git add -A -f -- <allowlist>`). Secrets (`config.yaml`, `secrets.yaml`) and machine-local derived files (`engrams.db`, `store.pglite/`, `exchange/`) are no longer in the staging pathspec, so they **cannot** ride along regardless of how the user's gitignore is configured.
- **Pack-nested secrets excluded.** Because `packs/` is force-added, a secret *inside* a pack (`packs/<name>/config.yaml`, `secrets.yaml`, `*.token`) would otherwise ride past `.gitignore` — and packs install from untrusted sources. The force-add now carries `:(exclude)packs/**/config.yaml` / `secrets.yaml` / `*.token` pathspecs so those never stage, while the pack's real content still syncs (#387 review).
- **No more global-excludes neutralization.** The `core.excludesFile=/dev/null` call is removed. The force-add on the allowlist preserves the #329 guarantee (engram files stage even when a user's global excludes would ignore them) without stripping the user's protection for everything else.
- **Self-healing.** Sync untracks `config.yaml`/`secrets.yaml` if a vulnerable pre-fix client already committed them, so the next sync stops carrying the secret forward. (Rotating the exposed token and purging git history remain manual operational steps.)
- The sync `.gitignore` now also lists the secret files and `store.pglite/` as defense-in-depth.

**Behavior change:** synced repos created before this fix that contain `config.yaml` will have it untracked on the next `plur sync`. If a token was already pushed to a shared/public remote, rotate it and purge it from history.

### Security: pack secret/PII scan covers the full serialized engram (#381)

`scanPrivacy` ran `detectSecrets` over only `statement + rationale + source`, while `exportPack` serializes the *whole* engram. Any exported-but-unscanned field was a leak: `summary` (formatLayer1), and the caller-supplied `domain`, `tags`, `structured_data`, and `contraindications` all exported with `clean: true`, defeating the "secrets are ALWAYS blocked" export invariant.

- **Secret/PII scan is now serialize-based.** `scanPrivacy` scans the *serialized engram payload* (every caller-settable field, including future additions) for secrets, personal paths, emails, and private IPs — not a hand-maintained field list, which is the same enumerate-vs-serialize drift that caused the bug. Fields `exportPack` strips (`relations`/`associations`/`knowledge_anchors`) and internal/numeric bookkeeping are excluded so they don't cause false rejections; PLUR-internal `_`-prefixed `structured_data` keys are dropped. `installPack` blocks and `exportPack` filters an engram with a secret in any scanned field.
- **Infra family is now scanned (review fix).** The serialized scan uses `detectSensitive` (a superset of `detectSecrets`), so public IPv4/IPv6, internal hosts, basic-auth URLs and host:port topology — the 2026-06 infra-leak class — are blocked on pack export/install, not just API-key-shaped secrets. The previous `detectSecrets` gate missed all of these, so an infra leak in `summary`/`tags`/`source` exported clean.
- **ReDoS guard (review fix).** The serialized scan input is capped (`truncateToScanLimit`, 64 KB) before any regex runs, and the email matcher now uses bounded quantifiers. Uncapped, an attacker-authored engram with a long dotted run after `@` made the email regex backtrack ~8–17s, hanging `previewPack`/`installPack`/`exportPack`.
- **Prompt-injection scan stays field-based** (`statement + rationale + source + summary + domain`) — only fields rendered into agent context can carry an effective injection, and scanning arbitrary metadata would add false positives.
- `learn()` / `learnRouted()` now secret-scan the caller-supplied `domain`, `tags`, and `abstract` (not just `statement`) when `allow_secrets` is false, rejecting a secret in any of them at write time.

**Behavior change:** a pack engram carrying a secret in any exported field (`summary`/`domain`/`tags`/`structured_data`/`contraindications`/…) is now blocked on install / filtered on export; a `learn` with a secret in `domain`/`tags`/`abstract` throws unless `allow_secrets` is set.

### Security: scope auto-registration refuses personal-family scopes from `/me` (#382)

`registerDiscoveredScopes()` registered **every** scope a server returned from `GET /api/v1/me` as a writable remote store, with no shared-scope check. A compromised or MITM'd endpoint could return `scopes: ['global', 'user:<victim>', 'local']`; registering `global` (the default unscoped routing fallback) as a writable remote store would route every later default/unscoped `learn` to the attacker's server.

- `registerDiscoveredScopes()` now filters `/me`-advertised scopes through `isSharedScope()` before `addStore`: only shared-family scopes (`group:`/`project:`/`space:`/`team:`/`org:`/`public`) are auto-registered. Personal-family scopes (`global`/`local`/`user:*`/`agent:*`) are refused, logged, and returned in a new `skipped` field on `RegisterDiscoveredResult`. The CLI (`plur stores discover --register`) and MCP (`plur_scopes_discover`) surface the skipped scopes.
- A genuine remote-backed personal scope (e.g. a `user:` scope on your own server) must be added deliberately via `plur stores add`; it is never auto-registered from untrusted server input.

**Behavior change:** `plur_scopes_discover register:true` / `plur stores discover --register` no longer register personal-family scopes a server advertises — they are reported as `skipped`.

### Security: segment-aware scope membership — no sibling-prefix bleed (#383)

The read-side scope filters and store-load gates decided shared-scope membership with a bare string-prefix test (`scope.startsWith(query)` / `LIKE query || '%'`) and no delimiter boundary. A shared scope that is a string-prefix of a sibling leaked across the isolation boundary: a `project:app` recall/inject/list surfaced `project:application` and `project:app-secret`; a `group:plur/eng` query surfaced `group:plur/eng-private`.

- New `isScopeWithin(scope, queryScope)` predicate in `scope-util.ts` matches a scope iff it is exactly equal or a descendant separated by a real delimiter (`:` or `/`) — so `project:app:sub` and `project:app/x` still match, but `project:application` does not.
- Applied at all read paths and store-load gates: non-indexed recall (`index.ts`), indexed SQLite `loadFiltered` + reindex gate (`storage-indexed.ts`), PGLite `buildFilterClause` (`storage-pglite.ts`), inject `scoreEngram` (`inject.ts`), and the in-memory store gate (`index.ts`). SQL paths use `scope = ? OR scope LIKE ?||':%' OR scope LIKE ?||'/%'`.
- The personal-family pass-through (`isPersonalScope`) is unchanged — personal scopes still surface under a project-scope recall.

**Behavior change:** an engram in a shared scope that is merely a string-prefix of the query scope is no longer returned by recall/inject/list. True descendants (delimiter-separated) are unaffected.

### Security: full audit remediation — Medium/Low cluster + independent re-audit (#387–#429)

Beyond the Blocker/High items above, the complete audit set was remediated and independently re-verified:

- **Scope routing & visibility:** keyword-only over-routing capped so a generic memory can't auto-file into a team store; equal-confidence domain ties resolve by coverage specificity; `public`-prefixed scopes no longer misclassified as shared; the pglite backend passes all personal-family scopes on a project recall; dedup demote now scans merged tags; the dead engram-publish filter removed.
- **Distribution & packs:** `exportPack` excludes every privacy-flagged engram (PII/injection, not just secrets); the agent keystore plus a pack-content **allowlist** close the sync leak surface; the pack scan is fail-closed past 1 MiB.
- **Remote-store trust:** driver cache invalidates on token rotation; server-assigned ids are shape-validated; `/me` scope names are validated at the trust boundary (non-string + injection-name); per-scope registration is isolated; malformed-row logs are sanitized; `stores add` reports honestly when a path drops a scope.
- Verified by the full test suite (2000+ tests), a 287-case adversarial fuzzer suite, our own pre-handoff adversarial audit, and **Črt's independent re-audit (HOLD → cleared)**.

### Leak guard: write-time demotion now covers `saveMetaEngrams` and remote-backed scopes (#368, #370)

The sensitivity leak guard — which detects secrets/infra patterns in an engram and demotes a shared-scope write to `local`/`private` before it can reach a shared store — now runs on more write paths:

- **`saveMetaEngrams` is guarded (#368).** Meta-engrams (abstractions, summaries) created on the save path now pass through the same `_guardSensitiveScope` check and context-field scan (`rationale`/`source`/`snippet`/`dual_coding`) as ordinary learns. A meta-engram carrying a secret in its statement *or* its context fields is demoted, and the demotion is **surfaced** to the caller (no longer silent) — the CLI/MCP display a "held back from shared scope" warning.
- **Remote-backed personal scopes are covered (#370).** The guard now demotes sensitive content destined for any **remote-backed** scope, including `user:*` family scopes that resolve to a remote store — not just `group:`/`project:`/`space:` team scopes. Closes the gap where a remote-backed personal scope could receive un-demoted sensitive content.

**Behavior change:** writes (including meta-engram saves) whose statement or context fields match a secret/infra pattern are demoted to `local`/`private` and the demotion is reported. Re-scope deliberately if a match is a false positive.

### Routing recalibration: unscoped default = `global`, deterministic domain-prefix routing, readonly scopes excluded (#367, #369)

The unscoped-write routing introduced for per-engram scoping is recalibrated:

- **`WEIGHT_DOMAIN` raised 1.0 → 1.5 and readonly scopes excluded from auto-route (#367).** Domain-channel matches carry more weight when scoring candidate scopes, and read-only stores are no longer eligible auto-route destinations (a write can't land where it can't be written).
- **Deterministic routing on a full domain-prefix match (#369).** When a genuinely-unscoped write's `domain` is at least as specific as a writable scope's declared `covers` namespace, it auto-routes to that scope deterministically (no edge-of-threshold flakiness). The default for a write with no matching cover remains `global`.

**Behavior change:** an unscoped `plur learn` (no `--scope`) defaults to `global` and may **auto-route to a writable team scope** when its `domain` matches that scope's `covers`. This is the same path the CLI, MCP, OpenClaw, and Hermes (as of this release) all reach — Hermes no longer forces `--scope global` and so participates in auto-routing.

### Detector quality: INTERNAL_HOST two-pass detection, `basic_auth` recategorized infra → secrets, 64 KB scan cap (#364)

- INTERNAL_HOST detection is a two-pass match (candidate match + false-positive gate) so benign config-file names (`config.local`, `data-staging.csv`) don't suppress a real internal host elsewhere in the same text, and host-shaped tokens in ordinary prose are detected.
- `basic_auth_url` is recategorized from `infra` to `secrets` (a HARD family) so a credential-bearing URL triggers write-time demotion under the default `allow_secrets:false` policy.
- The sensitivity scan is capped at 64 KB of input per engram to bound worst-case scan cost on pathologically large content.

**Behavior change:** more internal-host and credential-URL content is now detected and demoted; very large engram bodies are scanned up to a 64 KB cap.

### Config robustness: stores writeback passthrough preserves `url`/`token` across version skew (#365)

`persistStores` / `mergeStoresForWriteback` now pass unknown nested `sensitivity` fields through on writeback, so an older PLUR writing back a config authored by a newer PLUR no longer strips a store entry's forward-compat metadata — the store's `url`/`token` survive a load → persist round-trip even when the `sensitivity` block carries fields this version doesn't recognize.

**Behavior change:** remote-store `url`/`token` are preserved across a config round-trip under version skew (previously a malformed/forward-compat `sensitivity` block could drop the entry).

### Un-scoped write default reverted to `global` + read-side personal-scope visibility on all 3 paths (#353)

The Stage 3b un-scoped WRITE default (`local`) is reverted to `global` (the historical default). The revert alone was insufficient: the read-side scope filters hardcoded a `global`-only personal pass-through and DROPPED other personal-family scopes (`local`, `user:*`, `agent:*`) under a project-scoped recall/inject. This PR fixes the read side on **all three read paths** — inject `scoreEngram`, the non-indexed recall filter, and the DEFAULT indexed SQLite path (`storage-indexed.ts`, via a new `personal` column) — using the authoritative predicate `isPersonalScope(scope) = !isSharedScope(scope)`, not a hardcoded `{local,global}` set.

**Intended read-visibility surface change (not a leak):** Engrams at `scope=local` (including those written during the Stage 3b period) and any `scope=local` / `user:*` engrams now appear in project-scoped sessions after this fix, consistent with non-shared scopes being personal-family. Personal scopes never reach team shared stores; only an explicit shared scope (`group:`/`project:`/`space:`/`team:`/`org:`/`public`) does.

**RECALL/INJECT asymmetry (intentional, kept):** an explicit `scope=global` RECALL returns ALL personal-family engrams, but an explicit `scope=global` INJECT returns ONLY global-scoped engrams (targeted global-namespace injection, encoded by `INJECT_GLOBAL_IS_TARGETED`). The `plur_recall` tool description and `plur_session_start` guidance note this.

**Note:** Users with `unscoped_default: local` should be aware that cross-scope recurrence promotion currently ignores `unscoped_default` and promotes to `global` on the 2nd cross-scope hit (tracked as Stage 3b v2, see `docs/KNOWN_ISSUES.md`).

**Cross-surface consistency:** the CLI `plur learn` now omits the scope key when `--scope` is absent (flowing through unscoped routing via `learnRouted`) and the OpenClaw `_learnIfNew` routes via `learnRouted` (so shared-scope auto-learns reach their remote store); both pass `undefined` rather than a hardcoded `global` for unscoped sessions. The MCP `scope_hint` now fires on any non-shared landing scope (`isSharedScope` swap).

The module cycle that this required (inject.ts needing `isPersonalScope` from index.ts) is broken by moving the scope-family predicates to a new leaf module `scope-util.ts`; `@plur-ai/core` re-exports `isSharedScope`/`isPersonalScope` unchanged.

### Security hardening: pack install, remote-store, learnBatch (#306)

Addresses the 2026-06-10 security audit of `@plur-ai/core`:

- **Pack install** now clamps host-overriding fields before pack engrams can reach injection: `pinned` is stripped and `commitment: locked` is downgraded to `decided` (the on-disk pack and its integrity hash reflect the sanitized content). `scanPrivacy` detects prompt-injection / instruction-override text across **every field rendered into agent context** — `statement`, `rationale`, `source`, and `summary` — and `installPack` blocks on it unless `allowInjection: true` is passed. `previewPack` surfaces pinned/injection counts. `visibility: private` engrams no longer skip the scan (they are still installed and injected, so they must be scanned).
- **Pack export** strips `pinned` and locked `commitment` from exported engrams — never ship an always-load directive in a shareable pack.
- **Remote store** validates every server row against `RemoteRowSchema` (lenient, `.passthrough()`) in `load`/`getById`/`patch`; malformed rows are dropped and logged instead of cast with `as unknown as Engram`. Authoritative `id`/`scope`/`status` columns win over `data`. Fields rendered into agent context or used in arithmetic (`confidence_score`, `rationale`, `summary`, `domain`) are type-checked; explicit nulls pass. Verified against all production rows on both enterprise servers (137/137 pass).
- **`learnBatch`** caps LLM dedup calls per batch (default **50**, `maxLlmCalls` option, `Infinity` to opt out); once spent, remaining statements fall back to the hash/cosine path. Bounds bulk-import cost.
- **CI governance**: `.github/CODEOWNERS` covers workflows and `release.sh`. Note: only enforced once branch protection enables "Require review from Code Owners".

**Behavior changes:** `installPack` can now throw on injection-flagged packs (override with `allowInjection`); bulk imports of >50 novel statements use cheaper dedup for the remainder; remote rows failing validation are dropped (previously passed through unvalidated).

### `@plur-ai/core` exports the embedding primitive (#289)

`embed()`, `EMBED_DIM`, `embedderStatus()`, and `cosineSimilarity()` are now part of `@plur-ai/core`'s public API. Previously only the `SimilarityResult` type was re-exported, so the local BGE embedder (`BAAI/bge-small-en-v1.5`, 384-dim) was effectively internal. Alternative store backends that persist vectors and run similarity in a database can now compute embeddings identically to core's hybrid search instead of re-implementing the embedder and risking model/dimension drift.

```ts
import { embed, EMBED_DIM } from '@plur-ai/core'
```

- `EMBED_DIM` (384) is a new named constant. `embed()` asserts its first successful output against it once per process, so a model swap that changes the dimension fails loudly instead of silently corrupting persisted vectors.
- **Breaking-change contract:** the embedding model identity and `EMBED_DIM` are a stable public contract. Changing either is a breaking change for any consumer that persists vectors — they must re-embed. Treat a model/dimension change accordingly.

No new model and no external dependency — this only makes the existing capability reusable.

### `plur_stores_add` no longer silently drops additional scopes for the same remote URL (#291)

A user authorized for several team scopes on one enterprise instance could only ever register the **first** one. `addStore()` deduplicated remote stores by **URL only**, so a second scope for an already-registered URL hit an early `return` — persisting nothing — while the MCP tool still reported `success: true`. The misleading success masked the failure, and because reads are server-scope-filtered (`?scope=` per store), the user silently lost access to every team beyond the first.

- **`packages/core/src/index.ts`** — remote stores now deduplicate by **url + scope**, so one URL can host N scopes. Local stores keep **path-only** identity: one `engrams.yaml` is one store — the loader clones global-scoped engrams into each entry's scope, so a second scope on the same file would double-load them. `addStore()` returns `{ status: 'added' | 'already_registered' | 'overwritten', scope }` instead of `void` (on `already_registered`, `scope` is the existing entry's — for local stores it may differ from the request). The existing scope-conflict guard — a *different* endpoint claiming the same scope — is unchanged.
- **`packages/mcp/src/tools.ts`** — `plur_stores_add` surfaces `status` and only claims `success: true` when a scope genuinely persisted. Description notes that one remote URL can host multiple scopes.
- **`packages/cli/src/commands/stores.ts`** — `plur stores add` prints the real outcome (added / already registered / reassigned).

Token rotation is intentionally out of scope: re-adding the same URL+scope with a different token stays an `already_registered` no-op rather than silently swapping the stored token.

### Client scope discovery — find & register all authorized scopes (#292)

The client never asked the enterprise server which scopes a token can access, so a user authorized for N teams had to discover scopes out-of-band and hand-register each. The server already exposes the full resolved scope set at `GET /api/v1/me`; this wires the client to it. (Builds on #291 — registering N scopes under one URL is what makes auto-register meaningful.)

- **`packages/core/src/store/remote-store.ts`** — new `RemoteStore.me()` calls `GET /api/v1/me` and returns the resolved identity + authorized scopes.
- **`packages/core/src/index.ts`** — `discoverRemoteScopes()` reports, per configured remote URL, the authorized scopes split into `registered` vs `unregistered` (read-only, per-URL timeout, failures captured not thrown). `registerDiscoveredScopes()` registers every authorized-but-unregistered scope in one step.
- **`packages/mcp/src/tools.ts`** — new `plur_scopes_discover` tool (read-only by default; `register: true` registers all). `plur_session_start` now surfaces a best-effort hint when the token is authorized for scopes that aren't registered yet — bounded by a short timeout and fully swallowed on error, so it never blocks or slows session start.
- **`packages/cli/src/commands/stores.ts`** — new `plur stores discover [--register]`.

One token → discover all authorized team scopes → register them in one action.

### Surface remote-store auth failures instead of failing silently (#295)

When an enterprise token expired, the client failed silently: team-scoped writes 401'd and queued to the local outbox, reads returned 0, and `plur_doctor` still reported "healthy". The only way the gap surfaced was a human noticing no new engrams. This makes the failure legible.

- **`packages/core/src/jwt.ts`** (new) — `decodeJwtExpiry()` reads a token's `exp` claim (no signature verification) so the client can warn before/after expiry. Opaque (non-JWT) keys return all-null and callers fall back to the live probe.
- **`packages/core/src/index.ts`** — `checkRemoteHealth()` probes `GET /api/v1/me` per configured remote (raced against a timeout) and combines it with the JWT-expiry read, classifying each endpoint as `ok` / `auth_expired` / `unreachable`. `remoteTokenExpiries()` is a local-only (no network) expiry read for the fast session-start path. `learnRouted()` now flags `_outbox.auth_failed` when a remote write fails with 401/403, so a queued engram is distinguishable from a transient network blip.
- **`packages/mcp/src/tools.ts`** — `plur_doctor` adds a per-remote check (reachable / auth-expired / unreachable + "expires in N days"), so it no longer reports "healthy" when the remote auth is dead, with reauth remediation. `plur_session_start` surfaces a loud guide warning when discovery hits a 401/unreachable (reusing the discovery probe — no extra round-trip) and a proactive "token expires in N days" warning from the local JWT read.

The reauth command itself (`plur login`) and longer-lived keys are tracked separately as a fast-follow.

### Teach per-engram scope selection so team knowledge stops defaulting to global (#296)

Per-engram scoping was supported (every `plur_learn` takes a `scope`) but nothing taught agents to use it, so they routinely omitted `scope` → it fell back to `global` → team-relevant knowledge silently never reached the configured group store. This affects any install with a remote/group store. The capability worked; the guidance and the defaults didn't. Fixed at three layers — always-on instructions, install-time guidance, and a runtime safety net:

- **`packages/mcp/src/server.ts`** — the server `INSTRUCTIONS` block (advertised to every client on connect) gains a single "SCOPE SELECTION" section: scope is content-driven and per-call; team/shared knowledge → the matching `group:<org>/<team>` scope (`plur_session_start` lists the writable ones); personal/local → default; never let team knowledge fall back to `global`. Exported for testing.
- **`packages/cli/src/commands/init.ts`** (+ repo `CLAUDE.md`, `README.md`) — the CLAUDE.md `plur init` generates replaces the thin "Multi-project scoping" note with a fuller "Scope selection (set scope PER engram, by content)" guide enumerating the team / project / personal routing and the global-fallback anti-pattern.
- **`packages/mcp/src/tools.ts`** — runtime safety net: when a `plur_learn` call omits `scope`, lands at `global`, **and** a team store is configured, the response carries a non-fatal `scope_hint` naming the writable team scopes (silent on personal installs). `plur_session_start` guidance is also made prescriptive about per-engram routing.

`plur_session_start` already surfaces the live writable remote scopes (#229); this adds the always-on, install-time, and at-write-time guidance around it. Relates to #291 (a comms/second scope can't be registered against the same URL until that lands) and #295 (silent auth-expiry). Consolidates #299 (install surfaces) and #324 (runtime).

## 0.9.11 (2026-05-26)

Bug sweep — three independent fixes bundled.

### `plur_session_end` no longer crashes on string-array suggestions (#231)

Calling `plur_session_end` with `engram_suggestions: ["a", "b"]` (bare strings rather than `{statement, type}` objects) used to crash with the cryptic `Cannot read properties of undefined (reading 'match')`. The MCP JSON-Schema→Zod converter ignored nested `items` shape, the handler dereferenced `s.statement` on a string, and `detectSecrets()` exploded inside `plur.learn` with no context. Fixed at every layer:

- **`packages/mcp/src/server.ts`** — schema-to-Zod converter now recurses into array `items` and supports `anyOf`/`oneOf` via `z.union`.
- **`packages/mcp/src/tools.ts`** — `engram_suggestions` schema declares `items` as `anyOf: [string, object]`. Handler coerces bare strings into `{statement: s}` (LLM-friendly recovery) and throws a clear error for non-string non-object items.
- **`packages/core/src/secrets.ts`** + **`packages/core/src/index.ts`** — `detectSecrets()` and `plur.learn()` throw clear `TypeError` when called with non-strings, instead of letting `undefined.match()` propagate.

### `plur_stores_list` reports accurate remote engram counts (#184)

`plur_stores_list` used to return `engram_count: 0` for remote stores on the first call of a fresh MCP server session because `_loadRemoteCached` is synchronous and returns whatever's in the driver cache (empty on first call) while triggering an async load in the background. New `Plur.listStoresAsync()` awaits each remote driver's `load()` with a per-store 5-second timeout race so a hung remote can never block the listing call. The MCP `plur_stores_list` handler and the `plur stores list` CLI command both call the async variant. Sync `listStores()` is retained with `@deprecated` for callers that cannot await.

### `plur doctor` exits cleanly even when the embedder crashes (#197)

`onnxruntime-node` has a known SIGABRT crash on macOS during libc++ thread-pool cleanup on process exit, which caused `plur doctor` itself to exit with code 134 even when everything else was healthy. The embedder probe now runs in an isolated subprocess (`plur _embedder-probe`, an internal subcommand guarded by `PLUR_INTERNAL_PROBE=1`) — if it crashes, only the subprocess dies and the doctor reports `embedder: degraded` with the parent's exit code intact. Handles compiled binaries (pkg, bun --compile, nexe) gracefully by skipping the probe when the CLI entry isn't a JS file.

### Tests

11 new tests across `packages/core/test/secrets.test.ts`, `packages/core/test/remote-store-cache.test.ts`, `packages/mcp/test/server.test.ts`, `packages/mcp/test/session.test.ts`, and `packages/cli/test/embedder-probe.test.ts`. Full suite: 1045 passed, 19 skipped.

### Packages bumped

- `@plur-ai/core`: 0.9.10 → 0.9.11
- `@plur-ai/mcp`: 0.9.10 → 0.9.11
- `@plur-ai/cli`: 0.9.10 → 0.9.11
- `@plur-ai/claw`: unchanged (no claw-side changes)

## 0.9.9 (2026-05-14)

Concurrent writes — hardened.

- Multi-agent writes serialize cleanly
- Failed saves logged, not silent
- Pipelines auto-resume mid-run
- Jittered retries bound wall time

### What changed (Hermes plugin)

When two agents write engrams at the same time — a Twitter cron and a Telegram bot, say — they can race for the engram-store lock. Before 0.9.9, the second writer's call would fail silently and the engram would be lost. 0.9.9 retries lock-contended writes with jittered exponential backoff, surfaces typed `PlurLockError` exceptions for callers that want to react, and bounds wall-time exposure via a circuit breaker.

The meta-extraction pipeline now preserves recovery state on partial failure — if 3 of 10 saves fail mid-run, the failed three are retained and can be retried via an empty-body resubmit (caller doesn't have to re-run the full 6-stage pipeline).

### Improvements

- **Layered retry**: outer layer handles CLI hangs (TimeoutExpired → graceful safe-fallback after 5/15/30s backoff). Inner layer handles lock contention (PlurLockError → jittered 1/2/4s backoff). Both honor `PLUR_BRIDGE_RETRY=false`.
- **`PlurLockError`** — new typed exception (subclass of `PlurBridgeError`) so callers can distinguish transient lock contention from permanent errors. Backwards compatible: existing `except PlurBridgeError` still catches it.
- **Jitter** (±50% on each retry delay) defeats thundering-herd phase-lock between concurrent bridge instances.
- **Failed engram saves** in the meta-pipeline are now logged at WARNING with `exc_info=True` instead of silently swallowed by `except: pass`. The response surfaces `saved` / `failed` / `skipped` / `failed_engrams` counts.
- **Stage-5 retry path** in `submit_analysis`: after a partial save failure, the pipeline state is preserved with only the failed engrams. Resubmit with `submit_analysis(session_id, [])` to retry exactly those — no need to re-run the full pipeline.
- **Crash-resume guidance**: `start_extraction` on a stage-5 retry-pending session returns `status: "retry_pending"` with explicit instructions instead of confusing `status: "resuming"` with empty prompts.
- **Circuit breaker** in `_save_and_finalize` (3 consecutive failures → defer remaining engrams) bounds wall time on sustained contention. Prevents N × bridge-timeout blocking when the engram store is unreachable.
- **JSON error message extraction** unwraps `{"error": "..."}` from `--json` CLI output authoritatively, suppressing npm/Node stderr noise from leaking into user-facing exception messages.

### Internal

- New `_call_with_lock_retry()` helper extracts the inner retry; `_invoke_cli()` is the single CLI invocation that propagates `TimeoutExpired` / `FileNotFoundError` to the outer layer and raises `PlurLockError` / `PlurBridgeError` for callers.
- `_is_lock_failure()` regex covers 3 phrasings — survives minor wording changes in core's `withLock` / `withAsyncLock` messages.
- 38 net-new tests (42 → 88 total) covering retry boundaries, jitter bounds, JSON-envelope edge cases (null/empty/malformed/array), circuit breaker, multi-round retry, stderr-noise scenarios, `_save_state` failure path, None-responses guard, bytecode-level `-O` safety.
- 4 evaluator audit iterations (critic ×4, dijkstra ×2, data ×3). Final critic verdict: ready to merge.

### Versions

- `@plur-ai/core` 0.9.8 → 0.9.9
- `@plur-ai/mcp` 0.9.8 → 0.9.9
- `@plur-ai/cli` 0.9.4 → 0.9.9
- `plur-hermes` 0.9.4 → 0.9.9

### Deferred to follow-up

- Core-side `withLock` retry-budget bump (needs configurable per-consumer defaults, not a global change).
- `_find_duplicate` swallows `PlurLockError` silently — pre-existing, results in one extra CLI call under contention, not data loss.

## 0.9.8 (2026-05-06)

`plur_learn` with a remote scope now returns the **server-canonical
engram id** so a later `plur_forget(id)` / `plur_feedback(id)` actually
finds the engram.

### Fixes

- **New `Plur.learnRouted(statement, context)` async method** — for remote-scope writes, awaits the POST to `/api/v1/engrams` and returns an Engram with the server-assigned id (e.g. `ENG-2026-05-06-008`). For local-scope writes, defers to sync `learn()` so dedup behavior is unchanged.
- **`RemoteStore.appendAndGetServerId(engram)`** — companion to `append()` that returns `{ id }` parsed from the server's response. The existing `append()` keeps its `Promise<void>` shape to satisfy the `EngramStore` interface contract; the new method is for callers that need the canonical id.
- **MCP `plur_learn` handler routes through `learnRouted` first** — was using `learnAsync` (LLM-driven dedup) which ultimately called sync `learn()` and returned the local placeholder id. Users saw e.g. `ENG-2026-0506-017`, then `plur_forget("ENG-2026-0506-017")` returned "Engram not found" because the engram only existed on the server with id `ENG-2026-05-06-008`.
- **Loud failure on remote-write failure** — `learnRouted` throws when the POST fails (network, 5xx). The MCP handler catches and falls back to sync `learn()`, returning the local placeholder id with a `warning` field naming the trade-off so the caller can react instead of silently believing the write succeeded.

### Verification (against production)

Verified end-to-end before publish:
1. `plur.learnRouted(stmt, { scope: 'group:plur/plur-ai/engineering' })` returned `ENG-2026-05-06-008` (server format `^ENG-\d{4}-\d{2}-\d{2}-\d{3}$`)
2. `GET /api/v1/engrams/ENG-2026-05-06-008` returned 200 with the same statement → roundtrip works

All 806 tests pass.

### Versions

- `@plur-ai/core` 0.9.7 → 0.9.8
- `@plur-ai/mcp` 0.9.7 → 0.9.8
- `@plur-ai/claw` 0.9.13 → 0.9.14

### Why this matters

0.9.7 fixed routing-to-remote and the silent config clobber. But the engram object returned to the caller still had the *local* placeholder id — meaning that any code holding onto that id (to pass to `forget`, `feedback`, or `history`) had a phantom reference. Users would write a team engram, copy the id, try to retire it, and get "Engram not found" — even though the write succeeded on the server. 0.9.8 closes the id-roundtrip loop so the value the caller gets back is the value they can use.

## 0.9.7 (2026-05-06)

`loadConfig` no longer drops the entire `stores` array on a single bad
entry. Closes the silent-clobber pathway that made the 0.9.6 fix hard
to land.

### Fixes

- **Per-entry tolerance in `loadConfig`** — previously `loadConfig` parsed the entire config with `PlurConfigSchema.parse()`. Any single invalid `stores` entry threw, and the catch returned an empty config (`{}`), silently dropping every other valid entry too. In the wild this meant a pre-0.9.5 MCP process running against a 0.9.6+ config (which has `url`-based remote stores its old schema doesn't know about) would: load → throw → fall back to empty → save back over the file → permanently lose the user's remote store registration. Now each store entry is validated independently with `safeParse`; invalid entries are dropped with a `[plur:config] dropping invalid stores[N] (label) ...` warning, valid entries survive.
- **Loud failure on top-level config parse errors** — when `loadConfig` falls back to defaults due to YAML or schema issues at the top level, it now logs the path and the error reason. Silent fall-back was the worst kind of failure mode.

### End-to-end verification (production)

This release was verified against `https://plur.datafund.io` before publish:
1. Config with mixed valid (URL+token) and invalid entries → only the invalid entry dropped, URL store survived
2. `plur.learn(stmt, { scope: 'group:plur/plur-ai/engineering' })` → POSTed to `/api/v1/engrams`, returned server-assigned ID
3. REST GET on the new ID → confirmed engram on server with correct scope
4. Local `engrams.yaml` not created → no leak

All 516 core tests pass.

### Versions

- `@plur-ai/core` 0.9.6 → 0.9.7
- `@plur-ai/mcp` 0.9.6 → 0.9.7
- `@plur-ai/claw` 0.9.12 → 0.9.13

### Why this matters

0.9.6 shipped the `learn()` routing fix for plur-ai/enterprise#25 but in practice teams couldn't observe it: any pre-0.9.5 MCP instance still running on the same machine would clobber the config file on each load/save cycle, dropping the URL store entry. 0.9.7 removes that pathway — even an old client behaving badly can no longer take down the whole stores array.

## 0.9.6 (2026-05-06)

`plur_learn` now actually writes to remote stores. Closes the half-shipped
RemoteStore work from 0.9.5.

### Fixes

- **`learn()` routes writes to matching remote stores** ([plur-ai/enterprise#25](https://github.com/plur-ai/enterprise/issues/25)) — when an engram's scope matches a registered remote store entry (writable, exact-scope match), the engram is POSTed to that store's `/api/v1/engrams` endpoint instead of being written to the local YAML. 0.9.5 shipped registration (`plur_stores_add`) and remote reads (`RemoteStore.load()`) but missed the write routing — engrams with team scopes silently stayed local. The Datafund pilot's entire shared-memory value prop was broken until this fix.
- Routing is **fire-and-forget for the sync path** — `learn()` returns the engram object immediately and the network append completes in the background. Failures log loudly via `[plur:learn] remote append failed for ...`. The proper outbox pattern (queue + retry + reconcile) is tracked in [plur-ai/enterprise#26](https://github.com/plur-ai/enterprise/issues/26).
- Match rule (pilot scope): exact-match `entry.scope === engram.scope`. Prefix-match deferred — narrower scopes need explicit registration. Keeps routing predictable, prevents accidental cross-team writes.
- Read-only remote entries (`readonly: true`) keep writes local — same as filesystem stores.

### Versions

- `@plur-ai/core` 0.9.5 → 0.9.6
- `@plur-ai/mcp` 0.9.5 → 0.9.6
- `@plur-ai/claw` 0.9.11 → 0.9.12

### Migration

If you followed the onboarding for 0.9.5 and `plur_learn` with a team scope wrote locally — those engrams need to be re-published. There's no auto-sync. Either:
- Manual: read each affected engram from local YAML, call `plur_learn` again with the same statement+scope (now-fixed routing sends it to the server)
- Wait for #26 (outbox pattern) which will reconcile pending local writes against the remote on next session start

## 0.9.5 (2026-05-05)

Remote stores — register PLUR Enterprise (or any compatible REST endpoint) as a store via `plur_stores_add`.

### Features

- **`RemoteStore` driver** in `@plur-ai/core` — implements the same `EngramStore` interface as `YamlStore`/`SqliteStore` but reads/writes against an HTTP endpoint (PLUR Enterprise's `/api/v1`). 60s TTL cache, in-flight request dedup, paginated load, never-throws on network failure.
- **`plur_stores_add` accepts `url`+`token`** — was `{path, scope}`-only; now `{path | url+token, scope}`. Schema requires exactly one of path/url. Backwards compatible: existing filesystem-store call sites unchanged.
- **`StoreEntry` config schema** — adds optional `url` and `token` fields, refine() enforces exactly-one-of-path-or-url.
- **`Plur.addStore()`** — accepts `options.url` and `options.token` to register remote stores. `Plur.listStores()` returns `{path?, url?, scope, ...}` shape.
- **MCP `plur_stores_add` tool** — `required: ['scope']` (was `['path', 'scope']`). Returns `kind: 'filesystem' | 'remote'`.

### Why this matters

The PLUR Enterprise pilot needed a clean answer to "what does an existing local-PLUR user do?" The previous answer was "configure two MCP servers in `mcp.json` and prefix every call with `plur-local__` or `plur-enterprise__`." The new answer is `plur_stores_add url=... token=... scope=...`, registered once on the existing single-MCP-server install. Existing multi-store recall machinery handles the merge.

## 0.9.4 (2026-05-04)

Hybrid recall, restored.

- BGE embeddings actually work
- Pinned engrams (always-inject)
- plur_doctor diagnostic
- PLUR_DISABLE_EMBEDDINGS opt-out

### Fixes

- **Hybrid search degraded-mode surfacing** — `plur_recall_hybrid` now reports `mode: 'hybrid-degraded'` (with the underlying error) when the embedding model failed to load. Previously it lied with `mode: 'hybrid'` while silently falling back to BM25-only.
- **Embeddings build config** — `@huggingface/transformers`, `onnxruntime-node`, `onnxruntime-web`, `sharp`, `@huggingface/jinja` now marked external in the core tsup config. Bundling them broke ONNX backend registration in production with "listSupportedBackends is not a function".
- **Embedder retry** — `getEmbedder()` no longer latches the first-load failure forever. Each call re-attempts so first-run download races resolve themselves.
- **Embedding boost uses cosine, not rank** — `injectHybrid` previously gave the top semantic result a hardcoded boost of 1.0 regardless of how unrelated it was. Now uses the actual cosine score so the threshold is meaningful.
- **Embedding threshold raised 0.3 → 0.5** — the lower threshold was tuned for a non-functional embedder. Once BGE actually loaded, 0.3 surfaced spurious matches between unrelated short English sentences.
- **Pinned engrams bypass minRelevance filter** — without this, sessions with strong unpinned matches would silently drop pinned engrams (the entire pinning contract failed). Pinned engrams are also now sub-capped at 50% of the token budget so they can't starve relevance-scored engrams when many pinned packs are installed.
- **`plur init` upgrades stale packs** — was name-only (existing installs missed new pack content); now compares manifest versions and reinstalls when bundled > installed. Versionless packs are upgraded unconditionally.

### Features

- **`plur_doctor` MCP tool + extended `plur doctor` CLI** — probes embedder availability, reports the actual load error, and lists remediation steps including the corrupt-cache recovery path. Use this first when recall feels off.
- **Pinned engrams** (`pinned: true` on the schema) — bypass the keyword-relevance gate in `scoreEngram`, the per-pack/per-domain caps in `fillTokenBudget`, and the minRelevance filter. Use sparingly — meta-rules and safety conventions only.
- **`plur_pin` MCP tool + `pinned` param on `plur_learn`** — toggle and create pinned engrams.
- **API additions**: `Plur.setPinned(id, bool)`, `Plur.listPinned()`, `Plur.embedderStatus()`, `Plur.resetEmbedder()`, `Plur.recallHybridWithMeta()`.
- **Embeddings opt-out** — `PLUR_DISABLE_EMBEDDINGS=1` env var (also accepts `true`, `yes`) or `embeddings.enabled: false` in `~/.plur/config.yaml`. Doctor distinguishes "disabled by design" from "embedder broken." Hybrid recall reports the new `mode: 'bm25-only'` when opted out.
- **Three-way mode reporting on hybrid search** — `mode: 'hybrid' | 'hybrid-degraded' | 'bm25-only'`. `bm25-only` is the new "by design" state; `hybrid-degraded` is reserved for actual embedder load failures.

### Hardware footprint

0.9.4 makes embeddings actually work. First `plur_recall_hybrid` after upgrade triggers a one-time **~130MB BGE model download** (Xenova/bge-small-en-v1.5) plus ONNX runtime load (~few hundred MB RAM while resident, a few seconds first-call latency). Subsequent calls are fast. **Opt out** for low-resource or strict-offline environments via `PLUR_DISABLE_EMBEDDINGS=1` or `embeddings.enabled: false` in `~/.plur/config.yaml`.

### Knowledge pack consolidated

`effective-memory` v1.0.0 (8 engrams) → **v1.1.0 (12 engrams, all pinned)**. Merged the meta-rules from the standalone `plur-required` pack into the canonical `effective-memory` pack so users get one essential pack, pinned, with examples and analogies preserved. Existing 0.9.2/0.9.3 installs auto-upgrade on the next `plur init` (now version-aware).

### Packages

- `@plur-ai/core` 0.9.4 — pinned field, embedder helpers, build config fix, opt-out, mode reporting
- `@plur-ai/mcp` 0.9.4 — `plur_doctor`, `plur_pin`, hybrid-degraded + bm25-only mode reporting, version-aware pack upgrade
- `@plur-ai/cli` 0.9.4 — extended `doctor` with embedder check + opt-out hints
- `@plur-ai/claw` 0.9.10 — version bump (independent track; was 0.9.9 on npm)

## 0.9.3 (2026-04-22)

### Fixes

- **ESM import fix in core** (critical): Replaced `require('os')` and `require('path')` with ESM imports. The CJS `require()` calls crashed consumers running PLUR in pure-ESM environments (Node 20+ with `"type": "module"`, modern bundlers). Affects `autoDiscoverStores` and related code paths in `@plur-ai/core`.

### Packages

- `@plur-ai/core` 0.9.3 — ESM import fix
- `@plur-ai/mcp` 0.9.3 — version parity
- `@plur-ai/claw` 0.9.3 — version parity
- `@plur-ai/cli` 0.9.3 — version parity

## 0.9.2 (2026-04-22)

### Auto-Discover Moved Into the Constructor

Project-store auto-discovery now happens inside the `Plur` constructor instead of on first `init()`. Claw and Hermes get it for free — no extra wiring required.

- **Auto-discover in constructor**: `new Plur({...})` scans for project stores immediately. Previously only the MCP server triggered discovery.
- **MCP bundles effective-memory pack**: The MCP server ships the `effective-memory` pack bundled and auto-installs it on `plur init`. Closes the gap where new installs had zero prior-art knowledge until a manual `plur pack install`.
- **BM25 fallback for tiny corpora** (#30, #31): Robust BM25 behavior for stores with very few engrams or uniform term frequencies — previously returned empty results. Matches expectations on fresh installs.

### Packages

- `@plur-ai/core` 0.9.2 — auto-discover in constructor, BM25 fallback
- `@plur-ai/mcp` 0.9.2 — bundled effective-memory pack, auto-install on init
- `@plur-ai/claw` 0.9.2 — version parity
- `@plur-ai/cli` 0.9.2 — version parity

## 0.9.1 (2026-04-22)

### Auto-Discover Project Stores

A multi-project setup used to need explicit `--domain`/`--scope` flags on every call. 0.9.1 auto-discovers `.plur/` directories in the working tree at session start, so engrams from parent and sibling projects join the recall pool automatically.

- **Auto-discover project stores at session start**: Walks upward from `cwd` collecting `.plur/` stores; registers them alongside the global store. Makes multi-repo workflows work without config.
- **Project engram store**: Adds 67 PLUR-specific learnings (architecture, conventions, gotchas) shipped in the repo itself so contributors inherit team knowledge on first clone.
- **CLI + Hermes feature parity with 0.9.0**: `similarity-search` and `batch-decay` exposed in CLI and Hermes plugin to match the 0.9.0 core additions.
- **skills.sh ecosystem publish**: `plur-memory` skill published to skills.sh — reach across amp, cline, opencode, cursor, kimi-cli, and warp via SKILL.md auto-indexing.

### Packages

- `@plur-ai/core` 0.9.1 — auto-discover project stores, project engram store
- `@plur-ai/mcp` 0.9.1 — version parity
- `@plur-ai/claw` 0.9.1 — version parity
- `@plur-ai/cli` 0.9.1 — similarity-search + batch-decay parity

## 0.9.0 (2026-04-22)

### Memory That Maintains Itself

Engrams now have a lifecycle. They strengthen when used, weaken when forgotten, merge when duplicated, and leave an audit trail of every event. Until now PLUR had learn and recall but no maintenance — an untouched engram from January had the same injection priority as one used yesterday. 0.9.0 closes the loop.

- **Similarity search with cosine scores**: `similaritySearch()` returns `{engram, score}[]` for dedup classification. Thresholds: >0.9 duplicate, 0.7-0.9 related, <0.7 new. Scores clamped to [0, 1].
- **Batch decay**: `batchDecay()` applies ACT-R exponential decay to all primary engrams. Emotional weight slows decay for painful lessons. Scope-matched engrams are immune. Status transitions (active/fading/dormant/retirement) are logged to history.
- **Extended lifecycle events**: 5 new history event types — `recurrence_detected`, `contradiction_detected`, `scope_promoted`, `buffer_pruned`, `weekly_review`. Foundation for weekly reports and team dashboards.
- **MCP tools**: `plur_similarity_search` and `plur_batch_decay` exposed to agents for automated learning loops.
- **Multi-store search verified**: `recallHybrid` and `similaritySearch` confirmed to include engrams from registered project stores.

### Fixes

- **Scope matching precision**: Decay now uses exact + child matching (`project:alpha/sub` matches `project:alpha`, but `project:beta` does not). Previously all same-type scopes matched.
- **Engram cache invalidation**: `batchDecay` uses `_writeEngrams` for proper cache invalidation after writes.
- **Engram cache race fix** (#25, #26): Writes invalidate the read-cache via `_writeEngrams` helper. Fixes intermittent "Engram not found" failures when read and write happen in the same second.

### Multi-Project Setup Improvements (#19, #24)

- **Default to project-level config**: `plur init` creates `.claude/settings.json` in the current directory by default. Users who want global config can use `--global` flag.
- **Improved documentation**: Clarified `--domain` and `--scope` flags as the multi-project scoping solution.

### Packages

- `@plur-ai/core` 0.9.0 — similarity search, batch decay, extended history events
- `@plur-ai/mcp` 0.9.0 — plur_similarity_search + plur_batch_decay tools
- `@plur-ai/claw` 0.9.0 — version parity
- `@plur-ai/cli` 0.9.0 — project-level config, multi-project docs

## 0.8.2 (2026-04-09)

### Architecture Clarity & Multi-Project Scoping

Clarifies PLUR's architecture: **global tool, per-project scoping**. One MCP server, one engram store, available everywhere. Multi-project users scope via domain/scope fields — not per-project installations.

- **Hook-driven session start**: `hook-inject` now auto-generates a session ID on first message — no need for explicit `plur_session_start` call. Session ID is included in injected context for `plur_session_end`.
- **Project config (`.plur.yaml`)**: `plur init --domain X --scope Y` writes a `.plur.yaml` in the project root. Hooks read this file and auto-apply domain/scope to injection and learn reminders.
- **Improved init messaging**: `plur init` output now explains the global architecture and scoping model.
- **CLAUDE.md template rewrite**: Clearer architecture section, documents auto-session and multi-project scoping. Removed verbose sections in favor of concise guidance.
- **MCP server instructions updated**: Clarifies hook-driven lifecycle vs manual session start.
- **README multi-project docs**: Install section documents `--domain`/`--scope` workflow.

### Packages

- `@plur-ai/core` 0.8.2 — version bump
- `@plur-ai/mcp` 0.8.2 — updated instructions, init messaging, CLAUDE.md template
- `@plur-ai/cli` 0.8.2 — `.plur.yaml` support, auto session start, improved init output
- `@plur-ai/claw` 0.8.2 — version bump

## 0.8.0 (2026-04-08)

### Competitive Absorption: 50+ Features from 7 Memory Systems

50+ improvements absorbed in one session from Mem0, Claude-Mem, Mengram, Forge, Lossless Claw, OB1, and II-Agent. Implemented across 5 sub-projects, benchmarked, zero regressions.

- 75% faster learn/recall/inject
- 10% fewer injection tokens
- LLM-driven dedup (opt-in)
- Three-memory taxonomy

### Memory Intelligence (SP1)

- `learnAsync()` method: pre-store dedup pipeline — content hash → semantic recall → LLM decision (ADD/UPDATE/MERGE/NOOP)
- Commitment levels on engrams: exploring / leaning / decided / locked
- Tension detection: surfaces contradictions between engrams at learn time
- Confidence decay with 90-day grace period from deployment
- Content hash fast-path deduplication (SHA256 of normalized statement)

### History & Evolution (SP2)

- Event-sourced history in `~/.plur/history/YYYY-MM.jsonl` (true append-only)
- Version lineage: engrams track `engram_version` and reference previous version in history log
- `plur_history(engram_id?)` tool for auditing engram evolution
- `plur_episode_to_engram()` promotes episodic timeline events to episodic engrams
- `plur_report_failure()` for failure-driven procedure evolution (rewrites procedures after failures, max 3 revisions/24h)

### Retrieval & Injection (SP3)

- Progressive disclosure: top 30% relevance get full detail, next 40% get statements, rest get index lines
- `recallAuto()` search orchestrator: auto-selects BM25 / hybrid / expanded based on query characteristics
- Fresh tail boost: engrams from last 7 days get +0.2 retrieval strength (exploring/leaning only)
- Cognitive profile synthesis via `plur_profile()`: LLM-generated narrative summary from engram corpus, cached 24h
- Bounded sub-agent expansion with token budgets and caller session tracking
- Cost-aware model routing for LLM operations (dedup / profile / meta tiers)

### Infrastructure (SP4a + SP4b)

- Migration system with timestamp-based IDs, opt-in CLI (`plur migrate`), auto-backup
- Schema passthrough: unknown fields preserved through serialize/deserialize cycle
- Storage factory pattern: YamlStore (default) + SqliteStore (opt-in for scale)
- Async-first internals using `async-mutex` and `fs/promises`

### Benchmarks

- New `benchmark/run.ts` — LongMemEval harness (30 scenarios, 6 categories) committed permanently
- New `benchmark/micro.ts` — per-operation latency micro-benchmark with LLM dedup validation
- Both runnable on any branch: `npx tsx benchmark/run.ts` and `--compare a b`

### Deferred to 0.9.x

- Vault export (Obsidian-compatible markdown)
- Pack registry discovery (GitHub-hosted)
- Python SDK

### Packages

- `@plur-ai/core` 0.8.0 — all SP changes
- `@plur-ai/mcp` 0.8.0 — new tools: plur_history, plur_profile, plur_tensions, plur_report_failure, plur_episode_to_engram
- `@plur-ai/cli` 0.8.0 — version bump
- `@plur-ai/claw` 0.8.0 — version bump (features available via core)

## 0.7.3 (2026-04-02)

- Fix OpenClaw compat: remove pluginApi:"1" that blocked install on OpenClaw >=2026.3.31

## 0.7.2 (2026-04-02)

- Learning reflection hook: Stop hook nudges plur_learn every 3rd response — catches reasoning moments that tool-level hooks miss
- Claw system prompt updated to v3: session workflow, pack commands, correction protocol, verification rules
- Claw /packs slash command: list, install, uninstall from OpenClaw
- 9 hooks installed by plur init (was 8)

## 0.7.0 (2026-04-02)

### Knowledge Packs: Share What You Know

Knowledge Packs are thematic engram collections you can share with your team, community, or across machines. Export what you've learned about a domain, share the pack, and anyone can install it.

- Thematic export: `plur packs export react-patterns --domain code.react --tags hooks,state`
- Privacy scan on export: blocks secrets and private engrams, warns on personal paths and emails
- Conflict detection on install: flags duplicates and contradictions with existing engrams
- Uninstall: `plur packs uninstall <name>`
- Integrity hash (SHA256) per pack for tamper detection
- Auto-derived match_terms from engram tags and domains
- Internal references stripped on export (clean, portable packs)
- Output to ~/plur-packs/ (visible, easy to find and share)

### Full Memory Lifecycle Hooks

`plur init` now installs 8 hooks (was 2). Your agent gets contextual memory injection at every stage:

- Plan mode entry: broad context for architecture decisions
- Skill invocation: domain-specific engrams for the skill being used
- Agent spawn: scoped engrams for the agent's task
- Subagent start: memory carried into subagents
- Observation capture: tool calls logged for offline pattern extraction

### Observation Capture

New `hook-observe` command logs tool calls to ~/.plur/observations/ for deterministic pattern extraction. Hooks fire 100% of the time vs LLM-driven learning at ~80%.

### Packages
- `@plur-ai/core` 0.7.0 — thematic export, privacy scan, conflict detection, uninstall, integrity hash, export sanitization
- `@plur-ai/mcp` 0.7.0 — plur_packs_uninstall tool, improved export with thematic filtering, 8 hooks on init
- `@plur-ai/cli` 0.7.0 — hook-observe command, hook-inject --event for contextual injection, packs uninstall
- `@plur-ai/claw` 0.7.0 — version bump (pack features available via core)

## 0.6.0 (2026-04-01)

### Multi-Store: Share Knowledge Across Teams

PLUR now reads engrams from multiple stores. Your team's learned knowledge lives in their git repo — PLUR reads it alongside your personal memory. No copying, no syncing. Just add a store path and your agent knows what the team knows.

```yaml
# ~/.plur/config.yaml
stores:
  - path: ~/projects/my-team/engrams.yaml
    scope: my-team
    readonly: true
```

Or register via CLI: `plur stores add ~/projects/my-team/engrams.yaml --scope my-team`

- Store engrams get namespaced IDs (`ENG-DFD-2026-0401-001`) to prevent collisions
- Scope validation: store engrams auto-narrow to their scope, mismatched scopes skipped
- Feedback and forget route to the correct store (readonly stores reject writes gracefully)
- mtime-based cache: no re-parsing YAML files that haven't changed

### Performance: SQLite Index Default

`index: true` is now the default. At 600+ engrams, every recall was parsing 80KB of YAML. SQLite index makes filtered queries instant. The index syncs across all stores automatically.

### Packages
- `@plur-ai/core` 0.6.0 — multi-store reads, mtime cache, store-aware writes, index default
- `@plur-ai/mcp` 0.6.0 — graceful readonly feedback, one-command init, cold start fixes
- `@plur-ai/cli` 0.6.0 — hook-inject, plur init, stores commands
- `@plur-ai/claw` 0.6.0
- `plur-hermes` 0.6.0

### Update
```
npm update -g @plur-ai/mcp @plur-ai/cli
pip install --upgrade plur-hermes
```

## 0.5.2 (2026-04-01)

### Cold Start Fix (#7)
- `plur_session_start` returns store stats (engram count, episodes, packs) and contextual guides
- Empty store gets actionable messaging: "You have 0 engrams. Call plur_learn..."
- Fresh install triggers `setup_hint` suggesting `npx @plur-ai/mcp init`
- `plur_session_end` returns hint when no engrams captured

### One-Command Setup
- `npx @plur-ai/mcp init` now does everything: storage + MCP config + Claude Code hooks
- `plur init` (CLI) installs hooks only, for users with existing MCP config
- `plur hook-inject` — hook handler for automatic engram injection on first message
- `plur hook-inject --rehydrate` — re-inject engrams after context compaction

### Stronger Instructions
- MCP INSTRUCTIONS split into REQUIRED (session boundaries, corrections) vs OPTIONAL (feedback, recall)
- Concrete triggers ("when user corrects you") instead of vague "use proactively"

### Packages
- `@plur-ai/core` 0.5.2
- `@plur-ai/mcp` 0.5.3 — cold start fix, one-command init, stronger instructions
- `@plur-ai/cli` 0.5.4 — init, hook-inject commands
- `@plur-ai/claw` 0.5.2

### Update
```
npm update -g @plur-ai/mcp @plur-ai/cli
```

## 0.5.0 (2026-03-31)

### Session Management
- `plur_session_start` — inject relevant engrams at session start, returns session ID + context
- `plur_session_end` — capture learnings as engrams + record episode at session end

### Extended Learning
- `plur_learn` now accepts: tags, rationale, visibility, knowledge_anchors, dual_coding, abstract, derived_from
- Pack engram feedback — rate pack engrams, not just personal ones
- `plur_promote` — activate candidate engrams (single + batch)

### Improved UX
- Batch `plur_feedback` — rate multiple engrams in one call
- Search-mode `plur_forget` — find engram by keyword, not just ID
- `injected_ids` returned from inject tools — structured feedback loop
- `plur_packs_export` — export filtered engrams as shareable packs
- `plur_ingest` CLI command — extract engrams from stdin

### Packages
- `@plur-ai/core` 0.5.0 — extended LearnContext, getById, pack feedback, injected_ids
- `@plur-ai/mcp` 0.5.0 — 24 tools (was 18), session management, promote, export
- `@plur-ai/claw` 0.5.0 — enriched LearnContext in auto-learning, injected_ids in assembler
- `@plur-ai/cli` 0.5.3 — promote, stores, ingest commands, batch feedback, search forget
- `plur-hermes` 0.5.0 — extended bridge (all new features), ingest tool, batch feedback

### Update
```
npm update -g @plur-ai/mcp @plur-ai/cli
pip install --upgrade plur-hermes
```

## 0.4.2 (2026-03-28)

Initial public release. Core memory engine, MCP server, OpenClaw plugin, CLI.
