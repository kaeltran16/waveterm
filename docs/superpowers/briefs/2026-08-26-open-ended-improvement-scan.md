# Open-ended improvement scan

**Date:** 2026-08-26
**Status:** Findings only; sequencing and approval deliberately not decided here.
**Source:** Read-only repository scan produced by four fresh-context subagent scans (frontend cockpit,
Go backend core, Rust shell/toolchain, Pi integration), each reconciled against `docs/open-issues.md`
and `docs/deferred.md`. The strongest finding per area was then re-read and confirmed by the
orchestrating session (marked **verified** below). Nothing was live-reproduced or measured.

## Ranked shortlist (cross-area)

| Rank | Area | Finding                                                                            | Severity | Effort | Confidence |
| ---- | ---- | ---------------------------------------------------------------------------------- | -------- | ------ | ---------- |
| T1   | FE   | F1 Failed GetObject leaves a WaveObj atom loading forever (+ unhandled rejection)  | high     | S      | verified   |
| T2   | Rust | S1 `open_external` opens any unvalidated string via the OS opener                  | high     | S      | verified   |
| T3   | Go   | W1 `ShellController.SendInput` can panic on closed channel or block forever        | med      | S–M    | verified   |
| T4   | Go   | W4 StartJob logs the full command env (potential secrets) to the app log           | med      | S      | verified   |
| T5   | Pi   | P1 simplify-gate extension authored+tested but never installed by any in-repo path | med-high | S      | verified   |
| T6   | Rust | S2 CSP explicitly null (`csp: null`) — compounds S1 into an RCE chain              | med      | M      | verified   |
| T7   | FE   | F2 WS msgQueue unbounded while disconnected; drains at 10 msg/s after reconnect    | med      | S–M    | reported   |
| T8   | Rust | S3 packaged version stuck at 0.1.0, never synced from version.cjs                  | med      | S      | reported   |

Everything else is area-ranked below. Known-backlog adjacency is noted per section; nothing here
duplicates an active/actionable/held/declined backlog item.

---

## Frontend cockpit (`frontend/app/**`)

All findings read directly in source by the scanning agent ("verified" there); citations current as of
2026-08-26.

### F1 — Failed GetObject leaves a WaveObj atom stuck loading forever · high · S · verified

`createWaveValueObject` (`frontend/app/store/wos.ts:171-192`) chains `GetObject(oref).then(...)`
with **no `.catch`**. On any transient backend failure (wavesrv restart, websocket gap):

1. the rejection is unhandled;
2. `dataAtom` stays `{ value: null, loading: true }` forever;
3. the failure is cached — `getWaveObjectValue` returns the same cached `WaveObjectValue`, and
   `pendingPromise` is never cleared, so unmount/remount cannot recover. Only a page reload helps.

Same missing-catch shape in `reloadWaveObject` (`wos.ts:155-162`). Affected consumers include
`useWaveObjectValue<Block>` in `frontend/app/view/term/term.tsx:187` (term blocks skeleton forever),
`dagmodal.tsx:167`, `dagstore.tsx:72`.
**Why:** any momentary backend hiccup permanently bricks affected surfaces with no user-visible
error — the "looks live but is stale" failure mode this codebase otherwise designs against.
**Direction:** `.catch` that sets loading:false (+ error flag), clears `pendingPromise`, drops the
cache entry so the next mount retries. Reject-then-retry test beside the existing global-atoms tests.
_(Hand-re-verified by orchestrator.)_

### F2 — WS msgQueue unbounded while disconnected; slow drain after reconnect · med · S–M

`pushMessage` (`frontend/app/store/ws.ts:~218`) queues everything while `!this.open`; nothing caps
the queue or stamps age. On reconnect, `runMsgQueue` (`ws.ts:~137`) sends one message per 100 ms.
After a 10-minute outage, hundreds of stale poller RPCs flood back at 10/s, head-of-line blocking
fresh traffic; stale responses can race newer ones. `ws.ts` has no test file today; the queue policy
is pure logic and cheap to unit-test (`capLines` in livetranscript.ts is the house pattern).
**Direction:** cap (drop-oldest) and/or TTL-stamp entries discarded on drain; add ws.test.ts.

### F3 — Unprotected `JSON.parse` in onmessage; ping interval survives shutdown · low-med · S

`onmessage` (`ws.ts:~145`) parses outside try/catch — one malformed frame throws inside the socket
handler. Separately `setInterval(this.sendPing..., 5000)` (`ws.ts:60`) is never cleared in
`shutdown()`. Harmless today, but a live timer per instance.
**Direction:** try/catch with dlog; retain and clear the interval id.

### F4 — WshRouter rpcMap leaks entries for unanswered requests · low-med · S

`recvRpcMessage` sets `rpcMap.set(msg.reqid, ...)` (`frontend/app/store/wshrouter.ts:~87`); entries
are deleted only when a matching response arrives (`:~116`). Responses lost during reconnect gaps or
server timeouts leak forever; long-lived sessions accumulate. `wshrouter.test.ts` exists — add the
leak case there.
**Direction:** age-prune on insert (Map order makes a small LRU trim trivial) or cap size.

### F5 — Unconditional console.log on hot paths in wos.ts · low · S

`debugLogBackendCall` logs **every** backend service call; `updateWaveObject` /
`createWaveValueObject` log every object update broadcast (higher frequency now delta broadcasts are
live). Rest of the store layer uses gated `dlog("wave:...")` — wos.ts predates the convention.
_(Spot-confirmed by orchestrator while verifying F1.)_ **Direction:** convert to `dlog`.

### F6 — Card-resize drag lacks pointercancel cleanup · low · S

Grip drag in `frontend/app/view/agents/agentrow.tsx:620-641` adds window pointermove/pointerup,
removes them only inside `up()`. A cancelled pointer (alt-tab mid-drag, pen leaving range) fires
`pointercancel`: listeners leak for the session and resize state stays active.
**Direction:** pointercancel listener running the same cleanup, or setPointerCapture +
lostpointercapture.

### F7 — waveEventUnsubscribe aborts remaining batch on first unknown id · low · S (latent)

`frontend/app/store/wps.ts:88-104`: inside the unsubscribe loop, `if (...) return` should be
`continue`. Latent (every caller passes exactly one unsub today) but the signature invites batching.
**Direction:** two-character fix.

### F8 — Dead fields and debug global · low · S

`ws.ts:40-42` `watchSessionId` / `watchScreenId` / `wsLog` declared and never referenced
(grep-verified); `(window as any).term = termWrap` at `term.tsx:325` is a debug leftover.
**Direction:** delete.

**Adjacent to backlog (linkage only):** livetranscript full-retention/re-projection = the HELD
"incremental stateful transcript projection" item; vdom TODOs sit under the HELD "Pi Part B widget";
OS badge = tracked actionable small B2.

**Test gaps:** `ws.ts`, `wps.ts` have none — pair naturally with F2/F3/F7.

---

## Go backend core (`pkg/wshrpc`, `pkg/waveobj`, `pkg/wstore`, `pkg/blockcontroller`, `pkg/jobcontroller`, `pkg/wconfig`)

### W1 — SendInput can panic (send on closed channel) or block forever · med · S–M · verified

`ShellController.SendInput` grabs `sc.ShellInputCh` under lock then sends **outside** any
synchronization (`pkg/blockcontroller/shellcontroller.go:147-156`). The pty-read teardown closes that
exact channel after a 100 ms sleep (`shellcontroller.go:556-559`). A keystroke landing in that window
panics the RPC handler goroutine. Independently, the send is blocking with no select/ctx escape: if
the input loop wedges on a stuck pty, every SendInput blocks indefinitely (cap-32 channel fills
first). _(Hand-re-verified by orchestrator.)_ The DurableShellController path does not share this bug.
**Direction:** closed-flag/mutex guard before close(), plus bounded send.

### W2 — StartJob failure paths leak the stream reader and swallow a DB error · med · S–M

In `StartJob` (`pkg/jobcontroller/jobcontroller.go`): reader created/registered at `:680-681`;
`MakeFile` failure at `:687` returns without closing the reader or unregistering the stream. On
remote-start failure the status update error is discarded (`DBUpdateFn` at `:723`) — job can silently
stay `init` in the DB.
**Direction:** close/unregister on all post-create failure paths; check the DBUpdateFn error.

### W3 — CheckConnStatus nil-derefs on unknown WSL distro · low-med · S

`pkg/blockcontroller/blockcontroller.go:444-448`: `GetWslConn(distroName)` result used without nil
check; the parallel call site `shellcontroller.go:342-345` checks exactly this. A shell start racing
conn creation panics instead of returning "not connected".
**Direction:** mirror the shellcontroller nil check.

### W4 — StartJob logs the full command env (potential secrets) · med · S · verified

`jobcontroller.go:717`: `log.Printf("[job:%s] env=%v", jobId, params.Env)` writes API keys/tokens
passed through env into plaintext `waveapp.log`, which outlives the process and may ride along in bug
reports. Adjacent same class: `SetMetaCommand` logs full meta (`wshserver.go:139`).
_(Hand-re-verified by orchestrator via the ranked-table confirmation pass.)_
**Direction:** drop the line or log key names only.

### W5 — SetBaseConfigValue pointer branch is a dead store · low · S

`pkg/wconfig/settingsconfig.go:872-879`: the `*T` branch stores `&val` at `:874` then falls through
to unconditional `m[configKey] = val` at `:879`, overwriting it. Every pointer-typed settings key
takes this branch. Accidentally correct today; intent defeated.
**Direction:** make branches exclusive or normalize element types everywhere.

### W6 — Config read-modify-write races outside configWriteLock · low-med · M

The Set/Delete config functions read the file before taking `configWriteLock`
(`settingsconfig.go:847-852`, lock only around write at `:576`). Two concurrent sets touching
different keys interleave read-read-write-write; first update lost. R2 fixed watcher _delivery_; the
write path still has the window.
**Direction:** hold the lock across the whole read-modify-write in the four Set/Delete functions.

### W7 — Job-keyed maps grow unbounded for process lifetime · low · S

`lastAutoReconnectAttempt` (`jobcontroller.go:106`) never deleted; `jobStreamIds` not cleared in
`DeleteJob` (`:1401` clears other state).
**Direction:** delete both in DeleteJob.

### W8 — pkg/jobcontroller (1,615 lines) has zero tests · med · M

Reconnect/durable-shell state machine with no `_test.go`. Pure-ish starting points: pruneUnusedJobs
candidate intersection, restartStreaming seq/gap accounting (`:1319-1330`).
**Direction:** table tests for those two first.

**Minor (below threshold):** PathCommand empty-path `open.Run("")` (`wshserver.go:385-401`);
ResyncController sleeps holding per-block mutex; WshActivityCommand non-exclusive ifs; DBDelete
goroutine-per-delete.

**Excluded as known:** scaling Phase 3 (held), DAG M1/R1–R5 (held/resolved), remote worker routing
(blocked), E8 handshake incl. the `wslconn.go:346` sleep TODO (held redesign).

---

## Rust shell + toolchain (`src-tauri/src`, Taskfile, configs)

### S1 — open_external accepts any string, hands it to the OS opener · high · S · verified

`src-tauri/src/commands.rs:39-43`: `open::that(&url)` with no scheme/path validation. Windows
resolves through ShellExecute "open", which launches executables and opens `file://` paths. The
webview renders model-controlled markdown/links and there is no CSP (S2) — one injection bug away
from arbitrary program launch.
**Direction:** allowlist schemes (http/https/mailto); reject + log everything else.
_(Hand-re-verified by orchestrator.)_

### S2 — CSP explicitly null · med · M · verified

`src-tauri/tauri.conf.json` `"security": { "csp": null }`. Any injected script executes unrestricted
and can reach the localhost wavesrv WS (auth key handed to the FE via get_init). Hardening only; no
observed exploit.
**Direction:** start from Tauri's recommended SPA CSP (`default-src 'self'` + localhost
ws/http connect-src), iterate against console violations.

### S3 — Packaged version stuck at 0.1.0 · med · S

`tauri.conf.json:4` says `0.1.0` while package.json says `0.14.5`; nothing syncs it during release
(grep-confirmed). Add/Remove Programs and `app.getVersion()` diverge; will bite updater/diagnostics.
**Direction:** one line in the build/release flow writing the computed version in.

### S4 — task dev rebuilds the full 8-target wsh cross-compile matrix · med · S–M

`Taskfile.yml`: `tauri:dev` deps chain to `build:wsh:parallel` (darwin×2, linux×4 incl. mips,
windows×2) over all of `cmd/wsh` + `pkg`; any Go change rebuilds all 8 even though dev uses only the
windows host binary. A host-only flavor exists (`build:backend:quickdev:windows`) but isn't wired in.
Claim reasoned from Task semantics, not measured end-to-end.
**Direction:** platform-guarded host-only dep for dev; keep the matrix for release; consider dropping
mips targets entirely.

### S5 — check:ts target uses bare npx tsc, crashes on this repo · med · S

Taskfile `check:ts` runs `npx tsc --noEmit`, which dies with stack-overflow on this tree (documented
gotcha; workaround exists in AGENTS.md but never folded back into the task).
**Direction:** swap cmd for `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`.

### S6 — wavesrv spawn failure panics mid-setup · low-med · S

`main.rs` spawn_wavesrv `unwrap_or_else(|e| panic!(...))` inside the Tauri setup closure. Missing/
corrupted binary aborts with an opaque crash; packaged GUI builds show no message.
**Direction:** return Err from setup; thread the Result through.

### S7 — ESTART regex recompiled per stderr line · low · S

`estart.rs:14` compiles inside parse_estart, called for every wavesrv stderr line for the app
lifetime.
**Direction:** hoist to a `LazyLock<Regex>` (std, no new dep).

### S8 — Dead weight cluster · low · S

`electron.vite.config.ts` (zero references), `winston` + `@rollup/plugin-node-resolve` deps (no
consumers), WAVESRV-EVENT stderr filter with no emitter anywhere in `pkg/`/`cmd/`, arg-dropping
telemetry stub (`osc-handlers.ts:110` → `api.ts:67` → no-op Rust command).
**Direction:** delete each independently.

**Explicitly not findings:** migrations consistent (000001–000018 paired .up/.down, embedded-FS
apply); dev/packaged data isolation, job-object teardown, endpoint-wait correct. No Cargo CVE audit
(out of scope).

---

## Pi integration (`pi/**`, `pkg/harness`, `pkg/agentsessions`)

### P1 — simplify-gate extension authored and tested but never installed · med-high · S · verified

`pi/extensions/waveterm-simplify-gate.ts` (+ `-core.ts`) shipped in e5be2c29, registered in
`pi/package.json:17-18`, 205 lines of passing tests. But `task sync:piartifacts`
(`Taskfile.yml:193-210`) syncs status/tools/tools-core/ask/ask-core/prose-core — **not**
simplify-gate — and `wshcmd-installhooks.go` embeds/writes seven templates (`:284-305`,
`:372-457`) with no simplify-gate pair. No other installer exists in-repo: the feature is
dead-on-arrival for anyone provisioned by Wave. Caveat: if the arc-pi npm-package channel is the
intended delivery it would load there, but nothing in-repo shows that channel used, and all six
other extensions are duplicated through installhooks regardless.
**Direction:** add both files to sync:piartifacts + embed/write pair in wshcmd-installhooks.go
(mirroring ask/prose), or explicitly decline shipping it.
_(Hand-re-verified by orchestrator: grep over Taskfile/installhooks/package.json + ls pi/extensions.)_

### P2 — Control-channel watcher can lose or duplicate commands · med · S

`startControlWatcher` (`pi/extensions/waveterm-tools.ts:196-238`): async `process()` invoked directly
from every fs.watch callback with no serialization; all commands share one filename. Two close
commands → concurrent runs: run B's rmSync can delete command 2 before run C reads it (silent loss),
or both pass existsSync against different generations (stale dispatch, unordered steer/follow_up).
The "idempotent" comment only holds for serialized execution, which isn't enforced.
**Direction:** promise-queue the processing (`p = p.then(process)`).

### P3 — pi/opencode transcript derivations re-read storage redundantly · med-low · S

Pi: candidate walk reads the whole file, discards the lines, then `extractPiSession` and
`extractPiEvents` each call `pisession.Read(path)` again — three full reads+parses per candidate per
scan (`agentsessions.go:896-905, :911, :1017`). The claude provider was deliberately fused to avoid
exactly this (`:558-560`). Opencode similarly walks messages/parts twice (`:851-861`).
**Direction:** thread the parsed file/slice through both derivations, mirroring claude fusion.

### P4 — Status/prose-bridge extensions not inert outside Wave · med-low · S

Headers promise inertness outside Wave (`waveterm-status.ts:4`, `waveterm-ask.ts:15`); actually
`registerWavetermStatus` has no env guard and execs failing wsh processes per tool call, and the ask
prose bridge fires unconditionally — only its tool mirror checks `WAVETERM_BLOCKID`
(`waveterm-ask.ts:88-90` vs `:113-131`). Errors swallowed by design, so nobody notices.
waveterm-tools fails closed correctly.
**Direction:** gate both on `WAVETERM_BLOCKID` at registration time.

### P5 — trimTo truncates by bytes, can emit invalid UTF-8 titles · low-med · S

`agentsessions.go:455-461` slices raw bytes; multi-byte rune split yields replacement chars in the
cockpit row. Sibling `clipText` (`:652-658`) does it correctly by runes.
**Direction:** reuse clipText.

### P6 — resume-command strings inconsistently quoted · low · S

Pi quotes its path; claude/codex/opencode interpolate raw ids (`agentsessions.go:838,869,886,907`).
Codex's id comes from transcript content — display-only impact (FE launches via tokenized args), but
copy-paste fidelity suffers. **Direction:** quote uniformly.

### P7 — package.json registers no-op core modules as extensions · low · S

`pi/package.json:6-14` lists four `-core.ts` modules whose headers say they are dependencies, not
extensions (deliberate no-op exports). Manifest contradicts stated design.
**Direction:** drop the -core entries or document why listed.

### P8 — Test gap: waveterm-status helpers uncovered · low · S

Repo convention is pure .ts + .test.ts beside it; every extension follows it except
waveterm-status.ts (`sessionTitle`, `basename`, `detailForTool` untested).
**Direction:** add the test file.

**Coverage note:** all 12 pi/extensions files + package.json, agentsessions.go in full, harness
catalog in full, plus cross-checks into wshserver_picontrol.go / Taskfile / wshcmd-installhooks / FE
launch consumers. Skimmed without assertions: pi/skills, prompts, theme, ~70% of pisession.go.

---

## Reconciliation statement

Every finding above was checked against `docs/open-issues.md` (consolidated 2026-08-24) and
`docs/deferred.md` by its scanning agent; none duplicates an active workstream, actionable small,
blocked item, held-with-trigger item, or declined item. Deliberate adjacencies are called out inline
(livetranscript/vdom linkage, B2 badge, E8 sleep TODO). Per repo convention this doc records problems
only — picking anything up starts with its own spec/plan against these findings.
