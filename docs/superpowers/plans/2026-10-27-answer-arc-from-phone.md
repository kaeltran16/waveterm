# Answer Arc from your phone Implementation Plan

**Spec:** `docs/superpowers/specs/2026-10-27-answer-arc-from-phone-design.md` (its "Builder's calls" section settles every open choice; read it before your task)
**Verify:** `node scripts/verify.mjs ./pkg/remotemode/... ./pkg/wshrpc/... ./cmd/...`
**Check:** `task check:ts && go vet ./pkg/... ./cmd/...`
**Final:** `node scripts/cdp/final-verify.mjs remote-switch remote-phone`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\arc-remote-phone\project

**Goal:** Remote mode: while the owner turns it on, what waits on them reaches an installed iPhone web app through a Cloudflare named tunnel behind Access, and they answer agent questions from it.

**Architecture:** One Go package, `pkg/remotemode`, owns remote mode: config in one secretstore entry, a second loopback listener (only while on) serving an embedded plain-JS phone page and four JSON calls behind an Access JWT check, a cloudflared child, Web Push, and keep-awake. `wsh remote` and the cockpit reach it over new wshrpc commands; a `remote:status` event keeps the cockpit current.

**Tech stack:** Go stdlib (crypto/ecdh, crypto/hkdf, crypto/ecdsa, net/http, embed), `golang-jwt/jwt/v5` and `golang.org/x/sys/windows` (both already in go.mod), plain HTML/CSS/ES modules for the phone page, React + jotai for the cockpit, vitest, the CDP scenario harness.

## Global constraints

- No new Go or npm dependency.
- The main wavesrv listener (`pkg/web/web.go`), its auth key and its RPCs are untouched and never reachable through the tunnel.
- The phone listener binds `127.0.0.1` only and exists only while remote mode is on. Off means cloudflared and the listener are both stopped.
- Arc never holds a Cloudflare API token. The tunnel token never appears in a process's arguments, a log line, or an RPC return value.
- Every request to the phone listener, static files included, passes the Access check; no dev or test bypass exists in anything wavesrv builds. The test verifier lives only in `cmd/remotepreview`.
- Phone page: Midnight palette from the synced `@theme` tokens (never raw hex in `phone.css`), Hanken Grotesk and JetBrains Mono, no text under 10.5 px, touch targets at least 44 px.
- A push payload carries the agent or run name and the question header or wait kind only, never question text or a hold reason.
- Never hand-edit generated files (`task generate` outputs, and the synced `tokens.css`, fonts and icon under `pkg/remotemode/web/static/`).
- Tasks 1 to 6 write `pkg/remotemode` files at the same time, so names must not collide at merge: every unexported identifier and test helper carries its file's prefix (`config`, `access`, `push`, `awake`, `tunnel`, `handler`, `waiting`, `pusher`, `remote`), and base64url is `base64.RawURLEncoding` used directly, never a shared helper.

## Wire shapes several tasks share

Go types for these live in the task named; the JSON is fixed here so tasks can build against it in parallel.

- `GET /api/waiting` → `{"vapidpublic": "<base64url>", "questions": [Q...], "shown": [S...]}`
  - Q: `{"key", "oref", "askid", "source", "project", "runtime", "waitingsince", "prose": bool, "questions": [AgentAskQuestion...]}` (`AgentAskQuestion` is `pkg/baseds`' JSON shape; `runtime` is `"claude"`, `"pi"` or `""`)
  - S: `{"key", "kind", "title", "project", "waitingsince", "reason"}` (`kind` is the `AttentionItem` kind; `reason` is `Reason` when set, else `Text`)
- `POST /api/answer` body `{"oref", "askid", "answers": [AgentAnswerItem...]}` → 200 `{"ok":true}`; 409 `{"error":"gone"}` when the ask was answered or withdrawn; 400 on a malformed body.
- `POST /api/off` → 200 `{"ok":true}`, then remote mode turns off.
- `POST /api/subscribe` body is the browser's `PushSubscription.toJSON()`: `{"endpoint", "keys": {"p256dh", "auth"}}` → 200 `{"ok":true}`.
- Every route: 403 without a valid Access token. POSTs: 415 unless `Content-Type: application/json`; 403 unless `Origin` is `https://<hostname>`.
- Push payload (encrypted body): `{"title", "body", "key"}`.
- Tunnel states: `"off"`, `"starting"`, `"up"`, `"down"`.

## Review focus

1. A request with no `Cf-Access-Jwt-Assertion`, or a token for another email, audience or issuer, must get 403 on every route, static files included (Task 2, Task 5 tests).
2. A form POST from another site carrying the owner's Access cookie must be refused: wrong `Origin` or non-JSON content type (Task 5 tests).
3. Answering from the phone after the question was answered at the desk, or after the agent asked a new one, must refuse with "gone" and never deliver into the new ask (Task 5, Task 7 tests).
4. cloudflared crashing while on must restart without the owner, and turning off from the phone must not leave cloudflared, the listener or the keep-awake behind (Task 4, Task 7 tests).
5. A push subscription that the push service reports gone (404/410) must be dropped, not retried forever (Task 3, Task 7 tests).

---

### Task 1: Remote mode wire types, stored config and RPC handlers
**Depends on:** none
**Files:** `pkg/wshrpc/wshrpctypes_remote.go`, `pkg/wshrpc/wshrpctypes.go`, `pkg/wps/wpstypes.go`, `pkg/tsgen/tsgenevent.go`, `pkg/wshrpc/wshserver/wshserver_remote.go`, `pkg/remotemode/config.go`, `pkg/remotemode/config_test.go`, `pkg/remotemode/remote.go`, `pkg/remotemode/web/embed.go`, `pkg/remotemode/web/static/index.html`, `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, `frontend/types/waveevent.d.ts`

The interface every other task builds on. Small on purpose.

- `pkg/wshrpc/wshrpctypes_remote.go` (pattern: `wshrpctypes_vault.go`; compose `RemoteCommands` into the interface in `wshrpctypes.go`), with these declarations:

```go
type RemoteCommands interface {
    RemoteStatusCommand(ctx context.Context) (*RemoteStatusData, error)
    RemoteSetupCommand(ctx context.Context, data CommandRemoteSetupData) (*RemoteStatusData, error)
    RemoteOnCommand(ctx context.Context) (*RemoteStatusData, error)
    RemoteOffCommand(ctx context.Context) (*RemoteStatusData, error)
}
type CommandRemoteSetupData struct { TunnelToken, Team, Aud, Email, Hostname string; Port int } // json: tunneltoken, team, aud, email, hostname, port (omitempty)
type RemoteStatusData struct {
    On bool; Missing []string; Hostname string; Port int
    Tunnel string; TunnelError string; Subscriptions int; CloudflaredMissing bool
} // json: on, missing, hostname, port, tunnel, tunnelerror, subscriptions, cloudflaredmissing
```

- `Missing` lists setup field names not yet stored (`"tunneltoken"`, `"team"`, `"aud"`, `"email"`, `"hostname"`). The status never carries the token.
- `wps.Event_RemoteStatus = "remote:status"`, type `*wshrpc.RemoteStatusData`, following the three steps in the comment atop `pkg/wps/wpstypes.go`. Run `task generate`.
- `pkg/remotemode/config.go`: `type PushSubscription struct { Endpoint string; Keys struct{ P256dh, Auth string } }` (JSON matches `PushSubscription.toJSON()`); `type Config struct { TunnelToken, Team, Aud, Email, Hostname string; Port int; VapidPrivate, VapidPublic string; Subscriptions []PushSubscription; On bool }`; `const SecretName = "arc_remote"`; `const DefaultPort` (pick a fixed high port and name it in the comment); `LoadConfig() (Config, error)`, `SaveConfig(Config) error` (one JSON value in `pkg/secretstore`), `(Config) Missing() []string`. VAPID keys: P-256, `VapidPrivate` = base64url (no padding) of the 32-byte scalar, `VapidPublic` = base64url of the 65-byte uncompressed point.
- `FindCloudflared() (string, error)`: `exec.LookPath("cloudflared")`, then winget's install location (`%ProgramFiles(x86)%\cloudflared\cloudflared.exe`, `%ProgramFiles%\cloudflared\cloudflared.exe`).
- `pkg/remotemode/remote.go`: `Setup(data wshrpc.CommandRemoteSetupData) (*wshrpc.RemoteStatusData, error)` (validates: hostname has no scheme or path, email contains `@`, port 1024-65535 or 0 for `DefaultPort`; stores; generates the VAPID pair only if none is stored; a re-setup keeps subscriptions); `Status() *wshrpc.RemoteStatusData` (`Missing` from the config, `CloudflaredMissing` when `FindCloudflared` fails, `Subscriptions` = stored count, `Tunnel` = `"off"` until Task 7 adds live state; make `FindCloudflared` reachable through a package var so tests can fake it); `On() (*wshrpc.RemoteStatusData, error)` and `Off() (*wshrpc.RemoteStatusData, error)` as stubs returning an error saying remote mode is not built yet (Task 7 replaces them); `publishStatus()` publishing `Event_RemoteStatus`.
- `pkg/wshrpc/wshserver/wshserver_remote.go`: the four handlers delegate to `remotemode`.
- `pkg/remotemode/web/embed.go`: package `web`, `//go:embed static`, exported as `var FS fs.FS` (the `static` subtree via `fs.Sub`, so `/` maps to `static/index.html`). `static/index.html` is a placeholder Task 6 replaces. Only `static/` is ever served.

Acceptance: `go test ./pkg/remotemode -run 'TestConfigRoundTrip|TestConfigMissing|TestSetupValidates|TestSetupKeepsVapidAndSubscriptions|TestStatusOmitsToken'` passes: a saved config loads back equal; `Missing` names exactly the empty fields; bad hostname (`https://x`, `x/y`), bad email and port 80 are refused; a second `Setup` keeps the first VAPID pair and the subscriptions; no `Status` JSON contains the token string; `TestStatusReportsCloudflaredAndSubscriptions`: a faked failing `FindCloudflared` sets `CloudflaredMissing`, and two stored subscriptions give `Subscriptions: 2`; `go build ./pkg/remotemode/web` passes. Point secretstore at a temp config dir in tests the way `pkg/secretstore/secretstore_test.go` does.

### Task 2: Access token check (lock 2)
**Depends on:** none
**Files:** `pkg/remotemode/access.go`, `pkg/remotemode/access_test.go`

- `TeamCertsURL(team string) string` → `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`; `TeamIssuer(team string) string` → `https://<team>.cloudflareaccess.com`.
- `NewAccessVerifier(certsURL, issuer, aud, email string, client *http.Client) *AccessVerifier`; `(*AccessVerifier) Verify(r *http.Request) error`.
- Reads only the `Cf-Access-Jwt-Assertion` header. RS256 only (refuse `none`, HS*, ES*). Keys from the certs URL's `keys` array (JWK `kid`, `n`, `e`), cached; an unknown `kid` refetches once, rate-limited so a stream of bad tokens cannot hammer Cloudflare. Checks `aud` contains the stored AUD, `iss` equals the issuer, `exp`/`nbf` with a small leeway, and the `email` claim equals the owner's email case-insensitively. Use `golang-jwt/jwt/v5`.
- Errors name the reason (missing header, bad signature, wrong audience, ...) for the log line; the handler never sends the reason to the client.

Acceptance: `go test ./pkg/remotemode -run 'TestAccess'` covers, against an `httptest` certs server and a test RSA key: valid token passes; missing header, wrong aud, wrong iss, expired, other email, `alg: none`, HS256 signed with the public key bytes, and a token from an unknown key all fail; `Owner@Example.com` matches `owner@example.com`; a rotated key (new `kid`) is fetched once and passes; 20 tokens with unknown kids cause at most one or two refetches.

### Task 3: Web Push sender
**Depends on:** none
**Files:** `pkg/remotemode/webpush.go`, `pkg/remotemode/webpush_test.go`

- `SendPush(ctx context.Context, client *http.Client, endpoint, p256dh, auth, vapidPrivate, vapidPublic, subject string, payload []byte, ttl time.Duration) error`; `var ErrSubscriptionGone` returned on 404 or 410; other non-2xx return an error with the status.
- RFC 8291 `aes128gcm` payload encryption (`crypto/ecdh`, `crypto/hkdf`, AES-128-GCM, record size 4096, single record) and RFC 8292 VAPID: header `Authorization: vapid t=<ES256 JWT>, k=<vapidPublic>` with `aud` = endpoint's scheme+host, `exp` ≤ 12 h ahead, `sub` = subject (`mailto:<owner email>`); headers `Content-Encoding: aes128gcm`, `TTL`, `Urgency: high`.
- Keep the encryption in an unexported function taking the salt and sender key so the test can pin them.

Acceptance: `go test ./pkg/remotemode -run 'TestPushEncryptRFC8291Vector|TestVapidHeader|TestSendPushGone|TestSendPushHeaders'`: the RFC 8291 Appendix A inputs produce exactly its ciphertext; the VAPID JWT verifies with the public key and has the right `aud`, `sub` and an `exp` within 12 h; a 410 from an `httptest` endpoint returns `ErrSubscriptionGone`; the request carries the headers above.

### Task 4: Keep-awake and the cloudflared supervisor
**Depends on:** none
**Files:** `pkg/remotemode/awake_windows.go`, `pkg/remotemode/awake_other.go`, `pkg/remotemode/awake_windows_test.go`, `pkg/remotemode/tunnel.go`, `pkg/remotemode/tunnel_test.go`

- `KeepAwake() (release func())`: on Windows a goroutine `runtime.LockOSThread()`s, calls `SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED)` (not `ES_DISPLAY_REQUIRED`: the screen may turn off), waits, then calls `SetThreadExecutionState(ES_CONTINUOUS)` on the same thread. `release` is idempotent. Other OSes: no-op.
- `StartTunnel(path, token string, onState func(state, lastErr string)) (*Tunnel, error)`; `(*Tunnel) Stop()`. Runs `<path> tunnel --no-autoupdate run` with `TUNNEL_TOKEN=<token>` added to the environment, in a kill-on-close job object (`pkg/util/jobobject`). Output lines go to the wavesrv log, with the token redacted if it ever appears. State: `starting` at launch, `up` on a line containing `Registered tunnel connection`, `down` with the last `ERR` line (or the exit status) when it exits; then it restarts after a backoff (start at 1 s, double, cap at 60 s, reset after 5 min up). `Stop` kills the process, stops restarts, and reports `off`.

Acceptance: `go test ./pkg/remotemode -run 'TestKeepAwakeSetsSystemRequired|TestTunnel'`. Keep-awake (Windows): after `KeepAwake()`, `CallNtPowerInformation(SystemExecutionState)` includes `ES_SYSTEM_REQUIRED`; calling `release` twice does not panic (clearing cannot be asserted while other apps may hold the state; say so in the test comment). Tunnel tests use the test binary as a fake cloudflared (helper-process pattern): the token reaches the child's environment and not its arguments; states go `starting` → `up` → `down` (with the fake's error line) → `starting` again; after `Stop` the child is gone and no restart happens; backoff constants are injectable so the test runs in well under a second.

### Task 5: Phone handler and waiting list
**Depends on:** Task 1 (uses `PushSubscription`)
**Files:** `pkg/remotemode/handler.go`, `pkg/remotemode/handler_test.go`, `pkg/remotemode/waiting.go`, `pkg/remotemode/waiting_test.go`

- `waiting.go`: `WaitingList`, `WaitingQuestion`, `WaitingShown` matching the JSON above; `BuildWaiting(items []wshrpc.AttentionItem, asks map[string]agentask.PendingAsk, blockInfo func(oref string) (runtime, project string)) WaitingList`, pure. Kind `ask` items become questions: oref = the item's key minus `ask:`; `askid`, `questions`, `prose` and `waitingsince` (= `PendingAsk.Ts`) from the pending ask; `source` = `Source`; `project` = `ChannelName`, or `blockInfo`'s project when that is empty (a standalone agent); `runtime` from `blockInfo`. An ask item with no pending entry is dropped. Every other kind becomes a shown row in the list's order: `title` = `Source`, `project` = `ChannelName`, `waitingsince` = `WaitingSince`, `reason` = `Reason` when set, else `Text`. Questions come first in the result, oldest first.
- `handler.go`: `var ErrAskGone`; `type Deps struct { Static fs.FS; Verify func(*http.Request) error; Origin, VapidPublic string; Waiting func(context.Context) (WaitingList, error); Answer func(ctx context.Context, oref, askID string, answers []baseds.AgentAnswerItem) error; Off func(context.Context) error; Subscribe func(context.Context, PushSubscription) error }`; `NewHandler(d Deps) http.Handler` serving the routes and status codes in "Wire shapes". `/` serves `index.html` from `Static`; API responses carry `Cache-Control: no-store`; `Answer` returning `ErrAskGone` maps to 409; an empty `oref` or `askid`, or no answers, is 400. POSTs compare `Origin` with `Deps.Origin` exactly. A refused token logs the verifier's reason and returns a bare 403. The Off route writes its response before calling `Off` (the listener it runs on is about to close).

Acceptance: `go test ./pkg/remotemode -run 'TestBuildWaiting|TestHandler'`: `BuildWaiting` orders questions before shown rows, drops an ask item with no pending ask, carries `Reason` over `Text` for a held run, maps `title`, `project` and `waitingsince` as above, and takes a standalone agent's project and runtime from `blockInfo`; handler tests with `fstest.MapFS` and fake deps: every route including `/` and a static file returns 403 when `Verify` fails; POST with `text/plain` → 415; POST with `Origin: https://evil.example` → 403, and with `Deps.Origin` → accepted; a good answer calls `Answer` with the decoded items; `ErrAskGone` → 409 `{"error":"gone"}`; `/api/waiting` includes `vapidpublic`; `/api/off` returns 200 and then `Off` is called once; `/api/subscribe` passes the decoded subscription.

### Task 6: The phone page
**Depends on:** Task 1 (replaces its placeholder `index.html`)
**Files:** `pkg/remotemode/web/static/index.html`, `pkg/remotemode/web/static/phone.css`, `pkg/remotemode/web/static/phone.js`, `pkg/remotemode/web/static/model.js`, `pkg/remotemode/web/model.test.js`, `pkg/remotemode/web/static/sw.js`, `pkg/remotemode/web/static/manifest.webmanifest`, `pkg/remotemode/web/static/tokens.css`, `pkg/remotemode/web/static/icon.png`, `pkg/remotemode/web/static/fonts/hanken-grotesk-variable.woff2`, `pkg/remotemode/web/static/fonts/jetbrains-mono-v13-latin-regular.woff2`, `pkg/remotemode/web/static/fonts/jetbrains-mono-v13-latin-700.woff2`, `scripts/sync-remote-web.mjs`, `Taskfile.yml`

Matches the boards `Main`, `Answer`, `Empty` and `Unreachable` in the Prototype folder (structure, order, copy, controls; the board's sample data is invented). Read `DESIGN.md` and `frontend/app/view/agents/answerbar.tsx` first.

- Every served file goes under `static/` (Task 1's `embed.go` embeds that folder); `model.test.js` sits one level up, importing `./static/model.js`, so tests are never served.
- `scripts/sync-remote-web.mjs` (4-space indent, never prettier) writes `static/tokens.css` as `:root { ... }` with every `--color-*` and `--font-*` declaration from the `@theme` block of `frontend/tailwindsetup.css`, copies the three woff2 files from `public/fonts/`, and writes the 256 px PNG frame of `src-tauri/icons/icon.ico` to `static/icon.png` (every frame of that ico is PNG-encoded; fail loudly if not). A `sync:remoteweb` task runs it and becomes a dep wherever `sync:piartifacts` is one. Run it and commit its outputs.
- `index.html`: links `tokens.css`, `phone.css`, `<link rel="manifest" href="manifest.webmanifest" crossorigin="use-credentials">`, `apple-touch-icon`, `apple-mobile-web-app-capable`, viewport with `viewport-fit=cover`; loads `phone.js` as a module. The manifest has `display: standalone`, `start_url: "/"`, `scope: "/"`, the Midnight background color.
- `model.js` (pure, no DOM): `viewState(list, error)` → `"main" | "empty" | "unreachable"`; `countsLine(list)` (e.g. `2 questions to answer · 2 runs held`, singulars right, other shown kinds counted as `N other`); `formatAge(ms)` (`12m`, `2h 14m`, `3d`); `optionCountLine(q)`; `buildAnswers(questions, picks, texts)` → `AgentAnswerItem[]`, one per question: typed text wins over a pick, a multi-select gives every picked index, a prose ask sends the picked option's label as `text`, and it returns `null` while any question has neither; `shownWord(kind)` (`Held`, `Blocked`, `Escalated`, `Unverified`, `Workflow scan`).
- `phone.js`: renders from `model.js`. Main: header "Waiting on you", "Remote on" chip, counts line; Questions (agent, project, runtime dot, `waiting <age>`, header, text, option count, Answer); then the shown rows (word, project, age, title, reason verbatim, "Clear it at the desk"); the foot's **Turn off remote mode** with "This page goes offline and the PC may sleep again. Turn it back on at the desk." Empty: "Nothing is waiting on you." plus "Your phone buzzes when one asks you something or a run is held." (no agent count). Answer: each question's full text, a fold holding only the options' descriptions and previews, numbered option rows (recommended marked when the label ends in `(Recommended)`, shown without that suffix), an own-answer field per question, one **Send answer**; after 200 it shows "Answered" and "Sent to <agent>: <answer>" with "Back to what is waiting"; after 409 it says the question was already answered or withdrawn and returns to the list. Unreachable: "Not reachable", "Last reached <time>" (kept in `localStorage` from the last good list), the board's copy with `wsh remote on`. A **Turn on notifications** button appears only when `Notification.permission` is `default` and push is supported; its tap subscribes with `vapidpublic` and POSTs `/api/subscribe`. Refresh: on load, on `visibilitychange` to visible, and every 10 s while visible. The off button asks for a confirm tap, then POSTs `/api/off` and shows Unreachable.
- `sw.js`: caches the shell (`/`, css, js, fonts, icon) on install. Navigations: network first; a redirect response (Cloudflare's login) passes through untouched; a network error or 5xx serves the cached shell. `/api/*` is never cached. `push` shows a notification from `{title, body, key}` with `tag: key`; `notificationclick` focuses or opens `/`.

Acceptance: `npx vitest run pkg/remotemode/web/model.test.js` covers every `model.js` export, including a multi-question ask where one question is still unanswered (`null`), multi-select, prose, typed-text-over-pick, and the empty list with a fetch error (`unreachable`) versus without (`empty`). `go build ./pkg/remotemode/web` passes. Re-running `node scripts/sync-remote-web.mjs` leaves `git status` clean. The rendered views, the gone message and the Turn on notifications button are shown by Task 10's `remote-phone` steps.

### Task 7: Remote mode on and off, push, and restore at boot
**Depends on:** Task 1, Task 2 (uses `NewAccessVerifier`), Task 3 (uses `SendPush`), Task 4 (uses `KeepAwake`, `StartTunnel`), Task 5 (uses `NewHandler`, `BuildWaiting`)
**Files:** `pkg/remotemode/remote.go`, `pkg/remotemode/remote_test.go`, `pkg/remotemode/pusher.go`, `pkg/remotemode/pusher_test.go`, `cmd/server/main-server.go`

- `On()`: refuse with the missing fields named if setup is incomplete; refuse with the winget line (`winget install --id Cloudflare.cloudflared`) if `FindCloudflared` fails; listen on `127.0.0.1:<port>` (a port in use is a clear error, nothing else started); serve `NewHandler` with: `Static` = `web.FS`, `Verify` = an `AccessVerifier` for the stored team/aud/email, `Waiting` = `jarvis.GatherAttention` + `agentask.GlobalRegistry.List()` through `BuildWaiting` (`blockInfo` reads the block's agent runtime meta and the basename of its cwd, each `""` when absent), `Answer` = `agentask.DeliverAnswer` with `agentask.ErrNoPendingAsk` mapped to `ErrAskGone`, `Off` = `Off`, `Origin` = `https://<hostname>`, `Subscribe` = replace any stored subscription with the same endpoint and save; start the tunnel (its `onState` updates status and publishes), `KeepAwake`, the pusher; save `On=true`; publish. Idempotent when already on.
- `Off()`: stop the pusher, tunnel, listener (shut down with a short timeout) and keep-awake; save `On=false`; publish. Idempotent.
- `Restore()`: if the stored config says on, call `On()`; log a failure and keep `On=true` stored so the next start tries again. Call it from `cmd/server/main-server.go` after the web listeners are created.
- `pusher.go`: `pushNotes(seen map[string]bool, list WaitingList) []PushNote` (pure; `PushNote{Title, Body, Key}`: a question's title is its source, body its first question's header or `Question`; a shown row's title is its title, body `shownWord`-style kind text like `Run held`), marks keys seen. The loop reads the waiting list every 5 s; its first read only seeds `seen`. Each note goes to every subscription via `SendPush` (subject `mailto:<email>`, TTL 1 h); `ErrSubscriptionGone` drops that subscription and saves; other errors are logged.

Acceptance: `go test ./pkg/remotemode -run 'TestPushNotes|TestOnRefusesIncompleteSetup|TestOnOffLifecycle|TestOffFromPhone|TestRestore|TestGoneSubscriptionDropped|TestAnswerGoneMapping'`: `pushNotes` returns nothing on the seeding read, one note per new key afterwards, none for a key seen before, and never question text or a reason; `On` with missing setup names the fields; with a fake cloudflared path and a free port, `On` binds only `127.0.0.1`, a request without a token gets 403, `Off` closes the port (dial fails), stops the tunnel and calls the keep-awake release; `POST /api/off` through the live listener ends with remote mode off and the port closed; `Restore` with `On=true` turns it on; a 410 from a fake push endpoint removes that subscription from the saved config; a stale ask id through the live `Answer` dep returns 409. Make the tunnel starter, keep-awake and push client injectable package vars for these tests.

### Task 8: `wsh remote` and the setup guide
**Depends on:** Task 1 (uses the generated `wshclient` remote commands)
**Files:** `cmd/wsh/cmd/wshcmd-remote.go`, `cmd/wsh/cmd/wshcmd-remote_test.go`, `docs/remote-phone.md`, `docs/README.md`

- `wsh remote setup --team <name> --aud <tag> --email <addr> --hostname <host> [--port N]`: reads the tunnel token from stdin (first non-empty line, trimmed; with a terminal, prompt `Tunnel token:` on stderr), never a flag. Prints the status after. `wsh remote on`, `wsh remote off`, `wsh remote status` print the status. Pattern: `wshcmd-vault.go`.
- The status text: `Remote mode: on|off`, `Address: https://<hostname>` (when set), `Local port: <port>`, `Tunnel: <state>` plus the error when down, `Phone: subscribed (N)` or `Phone: not subscribed yet`, `Setup: complete` or `Setup: missing <fields>, run wsh remote setup`, and when cloudflared is missing `cloudflared not found: winget install --id Cloudflare.cloudflared`.
- `docs/remote-phone.md`: install cloudflared; in the Cloudflare dashboard create a named tunnel, add a public hostname on the owner's domain pointing at `http://localhost:<port>` (the default port), copy the tunnel token; create a self-hosted Access application for that hostname with a policy allowing only the owner's email (one-time PIN or Google), and find the team name and the application's AUD tag; run `wsh remote setup`; `wsh remote on`; on the iPhone open the address in Safari, log in, Add to Home Screen, open it from there, tap Turn on notifications. Then the login check (spec, "Check the login on a real iPhone"): log in from inside the installed app, get a push, open the app from it, answer a question; what a failed login looks like (the login opens outside the app, or the app loops back to the login) and that the owner then reports it rather than weakening a lock. Add one line for it to `docs/README.md`.

Acceptance: `go test ./cmd/wsh/cmd -run 'TestRemoteStatusText|TestReadTunnelToken'`: status text for off-and-unset, on-and-up, down-with-error, and cloudflared-missing matches the lines above and never contains a token; the token reader trims, skips blank lines and fails on empty input.

### Task 9: Cockpit switch and Remote on pill
**Depends on:** Task 1 (uses the generated `RemoteStatusData`, RPCs and `remote:status` event)
**Files:** `frontend/app/view/agents/remotestore.ts`, `frontend/app/view/agents/remotemodel.ts`, `frontend/app/view/agents/remotemodel.test.ts`, `frontend/app/view/agents/settingsmodel.ts`, `frontend/app/view/agents/settingssurface.tsx`, `frontend/app/cockpit/app-bar.tsx`, `scripts/cdp/scenarios.mjs`

- `remotestore.ts`: `remoteStatusAtom` (jotai, `RemoteStatusData | null`), loaded once by `RemoteStatusCommand` and kept current by the `remote:status` event; the subscription lives where the always-mounted app bar mounts it.
- `remotemodel.ts` (pure): `remoteSwitch(status)` → `{ enabled, on, note }` (disabled with `Run wsh remote setup first` while `missing` is non-empty, or the winget line while cloudflared is missing); `remoteStatusLines(status)` (setup, tunnel state with error, address, phone subscribed or not); `showRemotePill(status)`.
- Settings: a `remote` section, name "Remote", in the `Cockpit` group, holding the switch (calls `RemoteOnCommand`/`RemoteOffCommand`, shows the RPC error inline) and the status lines. App bar: a **Remote on** pill while on (style after `VersionMismatchPill`, tokens only), whose click opens Settings > Remote through the existing settings navigation.
- Scenario `remote-switch` in `scripts/cdp/scenarios.mjs`, scoped to `[data-settings-section="remote"]` and a `data-remote-pill` attribute. Fixtures go into `remoteStatusAtom` through the frontend store. Step 1 opens Settings > Remote with the dev store's real state (setup missing: switch disabled, the setup note visible, no pill). Step 2 sets an on, tunnel-up, one-phone fixture: the pill shows in the app bar and the section shows on, the address and "subscribed". Step 3 goes to the Agents surface, clicks the pill, and asserts Settings > Remote is shown. Step 4 sets an on, tunnel-down fixture with an error: the section shows the down line with that error. Step 5 sets a setup-complete, cloudflared-missing fixture: the switch note shows the winget line. Step 6 sets a setup-complete, off fixture and clicks the switch: the real `RemoteOnCommand` in the dev app refuses (the dev store has no setup), and the section shows that error inline. Teardown reloads the real status.

Acceptance: `npx vitest run frontend/app/view/agents/remotemodel.test.ts` covers the three functions for unset, set-but-off, on-and-up, down-with-error, cloudflared-missing. The views, the pill click and the switch click are shown by `remote-switch` steps 1 to 6.

### Task 10: Phone page preview and the remote-phone scenario
**Depends on:** Task 5 (uses `NewHandler`, `WaitingList`), Task 6 (serves the finished page through `web.FS`), Task 9 (shares `scripts/cdp/scenarios.mjs`)
**Files:** `cmd/remotepreview/main.go`, `cmd/remotepreview/main_test.go`, `scripts/cdp/scenarios.mjs`

- `cmd/remotepreview` (dev tool, never built into wavesrv or by `build:backend`): `--fixture main|empty`; serves `remotemode.NewHandler` with `web.FS` on `127.0.0.1:0`, `Verify` accepting every request, `Origin` set to its own `http://127.0.0.1:<port>`, and a fixture `WaitingList`: for `main`, three questions (one single-select with a `(Recommended)` option and a preview; one with two questions where the second is multi-select; one whose `Answer` always returns `ErrAskGone`, as if answered at the desk meanwhile) and two held runs whose reasons are long, verbatim git messages; for `empty`, nothing. `Answer` removes the answered question and records it; `Off` and `Subscribe` record. Prints `REMOTEPREVIEW http://127.0.0.1:<port>/` on stdout.
- Scenario `remote-phone`: `go run ./cmd/remotepreview`, then headless Edge or Chrome (find it as `scripts/cdp/design-states.mjs` does) at 390 x 844, mobile, device scale 2, attached over its own CDP port; record its PNGs among the run's shots. Before load, stub `PushManager.prototype.subscribe` and `Notification.requestPermission` with `Page.addScriptToEvaluateOnNewDocument` (headless Chrome has no push service); the stub's subscription carries a fake endpoint and keys. Steps: 1 `Main` (questions then held runs, counts line, off button, the Turn on notifications button); 1b tap Turn on notifications: the preview recorded a subscribe with the stub's endpoint and the button is gone; 2 open the first question: `Answer` (full text, fold opened showing the preview, numbered rows with the recommended mark, own-answer field, Send); 3 pick and send: "Answered" with what was sent, and the preview recorded the answer; 4 open the two-question ask, answer only the first, Send stays disabled, answer the second, send; 4b open the withdrawn question and send: the page says it was already answered or withdrawn and returns to the list; 5 restart the preview with `--fixture empty`: `Empty`; 6 stop the preview and reload: `Unreachable` with "Last reached"; 7 restart it and tap Turn off remote mode, confirm: the preview recorded Off and the page shows Unreachable. Teardown kills the preview and the browser.

Acceptance: `go test ./cmd/remotepreview -run 'TestFixtureMain|TestPreviewServes'`: the main fixture has the shapes above; the preview serves `/` and `/api/waiting` on loopback. Every board is shown by `remote-phone` steps 1, 2, 5 and 6, the Answered state by step 3, the notifications button by steps 1 and 1b, and the gone message by step 4b.
