# Harness contract probes

One file per third-party agent harness. Each probe answers a single question
that its vendor's documentation cannot: **does context this plugin injects
actually reach the model, at this exact binary version?**

Docs describe intent; the binary decides. Every adapter in `packages/` should
have a probe here that was run against a pinned version before the adapter was
written, and that can be re-run when the harness moves.

## Method

1. **Pin the version.** Record it in the findings. These surfaces move daily.
2. **Isolate the home.** Point the harness at a scratch config dir so a probe
   cannot corrupt the real one.
3. **Marker-echo.** Inject `MARKER-<PATH>-<nonce>` down every candidate
   injection path, then ask the model to echo every `MARKER-` token it can see.
   This is what separates *hook fired* (a log line) from *hook output reached
   the model* (an echo). A hook that fires and injects nothing is the default
   failure mode, and it passes every other check.
4. **Keep a control.** Mint one marker that is never injected anywhere. If the
   model echoes it, the run proves nothing. Note what this control does and
   does not establish: since it is never shown to the model at all, not
   echoing it is the default expectation, not a discriminating result — it
   only rules out gross pattern-completion of the marker family (the model
   inventing a plausible-looking token it never saw). A real negative control
   is a second run of the *same* path with injection switched off, checking
   the model reports `NONE` — that is the test that would actually catch a
   marker leaking in some other way.
5. **Log from inside every hook.** The log tells you which hooks fired, in what
   order, and how often — cadence is a design input, not a detail.

## opencode

`opencode-plugin-probe.mjs` — run against **opencode 1.18.30**,
`@opencode-ai/plugin@1.18.30`, 2026-09-15.

```bash
SCRATCH=$(mktemp -d) && mkdir -p "$SCRATCH/plugins" "$SCRATCH/work"
cp scripts/probes/opencode-plugin-probe.mjs "$SCRATCH/plugins/"
printf '{"$schema":"https://opencode.ai/config.json","share":"disabled","autoupdate":false}' > "$SCRATCH/opencode.json"
cd "$SCRATCH/work" && OPENCODE_CONFIG_DIR="$SCRATCH" OPENCODE_CONFIG="$SCRATCH/opencode.json" \
  PLUR_PROBE_LOG="$SCRATCH/probe.log" \
  opencode run --model openai/gpt-5.5 \
  "List every token you can see anywhere in your context that begins with MARKER-. Output only those tokens, one per line, nothing else. If there are none, output NONE."
```

Expected: the model echoes `MARKER-SYSTEM-<nonce>` and `MARKER-CHATMSG-<nonce>`
and does **not** echo `MARKER-CONTROL-<nonce>`.

### Isolation knobs

Each injection arm can be switched off independently, so a run can isolate
one path or serve as the real negative control described in Method step 4:

- `PLUR_PROBE_NO_PART=1` — `chat.message` fires (logged) but pushes no `Part`.
- `PLUR_PROBE_NO_SYSTEM=1` — `system.transform` fires (logged) but pushes
  nothing onto `output.system`.

Both hooks log `output.system.length` at hook entry regardless of which arm is
active, so a run can measure `system[]` accretion in the array it would
actually happen in — not only via the message-history meter, which cannot see
`system[]` content by construction. A real negative control for either path is
a run with that path's knob set and the other left on: the model should report
`NONE` for that path's marker while still echoing the other's.

Findings from the 2026-09-15 run are written up in
`docs/specs/2026-09-15-opencode-plugin-design.md` (spec) — read that
before changing `packages/opencode/`.
