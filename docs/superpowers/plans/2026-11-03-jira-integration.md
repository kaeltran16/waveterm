# Jira Cloud integration implementation plan

**Spec:** `docs/superpowers/specs/2026-11-03-jira-integration-design.md` (a verbatim copy of the approved brainstorm spec, committed with this plan)
**Verify:** `node scripts/verify.mjs ./pkg/jira/... ./pkg/jarviscapture ./pkg/jarvisstate ./pkg/jarvis ./pkg/waveobj ./pkg/wconfig ./pkg/wshrpc/... ./cmd/wsh/cmd`
**Check:** `go vet ./pkg/jira/... ./pkg/wshrpc/... ./pkg/jarviscapture ./pkg/jarvisstate ./cmd/wsh/cmd && task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs jira-settings jira-check jira-initiative jira-post jira-sidebar jira-details jira-wsh`
**Prototype:** C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/jira-integration/project/Main.dc.html

> **For agentic workers:** implement your task inline (TDD where a test is named). Do not spawn subagents or forks. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Jira Cloud in Arc: connect in Settings, Check Jira and Make initiative from the Brief, the ticket drawn wherever the initiative is, `wsh jira check/show`, and Post progress to Jira from the open plan, with every state change animated.

**Architecture:** A new Go package `pkg/jira` is the only thing that talks to Jira (REST v3, basic auth, token from `pkg/secretstore`). wavesrv exposes it as six wshrpc commands; the cockpit and `wsh jira` both go through them, so no agent ever sees the token. The initiative keeps a last-seen copy of its ticket on `Effort.Jira` (efforts are vault JSON files, so no migration), and a chunk is "posted to Jira" when it carries a note with `JiraPost` set.

**Tech stack:** Go (wavesrv, wsh, cobra), wshrpc + `task generate`, React 19 + jotai + Tailwind 4 + `motion/react`, vitest, CDP scenarios.

## Read first (every worker)

- The spec (path above) and the board(s) your task names, in `C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/jira-integration/project/` (gitignored; read them at that absolute path). The boards' names, keys, counts and sample text are fixture data, not constants. Copy their layout, words and states; take colours only from `@theme` tokens in `frontend/tailwindsetup.css` (no raw hex, no new tokens).
- `DESIGN.md` (motion section above all), `AGENTS.md`, `frontend/app/element/motiontokens.ts`.
- Work by these principles: simple, direct solutions; SOLID, KISS, YAGNI, DRY; one source of truth; measure before optimizing; no abstraction for one implementation; handle errors at boundaries and never swallow them silently; long-term fixes, not band-aids. Read a file's exports and callers before editing it, and reuse what exists before writing a helper.
- Pure logic goes in `foo.ts` with `foo.test.ts` beside it; `.tsx` stays thin. No jsdom render tests: rendered UI is proven by your task's CDP scenario steps, which Final runs.
- Never hand-edit generated files (`task generate` writes them). Never run prettier on `scripts/*.mjs`. Check formatting only on files you touched.

## Decisions made beyond the design (and why)

1. **Storage of the last-seen copy and posts.** `Effort.Jira *EffortJira` (summary, type, status, status category, plain-text description, acceptance criteria, `SeenTs`, `SeenVia`, `LastPost`). Efforts are vault JSON files (`pkg/effortstore`), so a new field needs no migration and syncs with the vault. `EffortNote.JiraPost` holds the comment URL on each note a post wrote: the spec makes that note the mark of "posted to Jira" and the memory of what was reported, so it is the single source of truth for "changed since the last post".
2. **Changing or clearing an initiative's ticket clears `Effort.Jira`** (in `setTicket`), then attaches wavesrv's in-memory cached copy of the new key if Arc saw it this session. A stale copy of a different ticket would be drawn as if it were this one. The cache is also how "make" updates the copy without a Jira call: the agent's `wsh jira show <KEY>` runs before `wsh effort create --ticket <KEY>`, so the create attaches what the show just saw.
3. **Six wshrpc commands**, `pkg/wshrpc/wshrpctypes_jira.go`: `JiraConnection`, `JiraCheck`, `JiraShow` (also the refresh and the details lookup, told apart by `Via`), `JiraPostDraft`, `JiraPostSummaries`, `JiraPost`. Drafting the code version and the model rewrite are separate calls so the dialog opens on the code draft at once and Post never waits on the model.
4. **Errors travel as coded strings**, matching the repo's `EC-` convention, and `wsh` prints them as they are: `EC-JIRA-NOTCONFIGURED: Jira isn't set up: add your <missing> in Settings > Jira.`, `EC-JIRA-HTTP <status>: <Jira's own message>`, `EC-JIRA-UNREACHABLE: <cause>`. The frontend parses them once (`parseJiraError`).
5. **Settings:** `jira:site` and `jira:email` are synced settings keys (Go `wconfig`, so `task generate`); the token is secret `JIRA_API_TOKEN`, written with the existing `SetSecretsCommand`, which only ever reports whether it exists. The Settings form only accepts `https://<name>.atlassian.net`. The Go client also accepts an `http://127.0.0.1:<port>` or `http://localhost:<port>` site. That lets the CDP fixtures point the dev app at a fake Jira, so Final runs the real Go client, the copy writes and the ADF building. A loopback site never sends the token off the machine.
6. **Connection status** is kept in wavesrv memory, updated by every Jira call. `JiraConnection{Test:false}` reads it without calling Jira (Arc talks to Jira only when you press something); Test again sets `Test:true`.
7. **Search:** `POST /rest/api/3/search/jql` (the current endpoint; the old `/search` is deprecated), JQL `assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`, one page of 50.
8. **"Already on an initiative"** means any initiative whose `Ticket` matches the key case-insensitively, archived ones included: an archived initiative is work Arc already handled. Check Jira also refreshes the copy on those initiatives, since the search returned their tickets anyway.
9. **Acceptance criteria:** the site's field named "Acceptance Criteria" (case-insensitive, found once per site through `GET /rest/api/3/field` and cached). Without that field, Arc uses the list items under a description line that reads "Acceptance criteria". Without either, the list is empty.
10. **Project inference threshold.** For each registered project, Arc counts the initiatives whose ticket has the same Jira project key, and the commit subjects matching `\b<KEY>-\d+\b` in the last 2000 commits on its HEAD. Candidates rank by (initiatives, commits). A winner is sure when it has at least 1 initiative or at least 3 tagged commits, and either has strictly more initiatives than the runner-up, or ties on initiatives with at least twice the runner-up's commits. Otherwise the result is unsure ("Agent will ask"). The evidence reads `4 initiatives, 23 tagged commits` (singular for 1), `No history for GROW`, or `Tied: payments-api and infra`.
11. **Make initiative agent:** it uses the same harness pick as Work on (preference, then catalog, then claude) and the flags New Agent remembers. It is named `<KEY> <summary>`. When the project is sure, it starts in that project's folder. When it is unsure, it starts in the home folder with no project, and its prompt tells it to ask which project before creating anything. It only runs `wsh` commands, so a home cwd cannot touch the wrong repo. The launch goes through an exported `jiraMakeDeps.launch` (default `launchAgent`), so the CDP scenario can stand in for the agent without starting a real model session.
12. **The building row leaves** when the Brief's effort index (`briefEffortIndexAtom`, which gains `ticket`) contains its key. No new event or polling is needed: the Brief already refreshes on effort changes.
13. **Post order:** comment, then record, then move, then record the move. The record (each reported chunk's note, an initiative-level note with the link, `LastPost`) is written as soon as the comment exists. A failed move or a retry therefore never re-reports a chunk. If the record write itself fails after the comment posted, the error says the comment is on Jira and Arc could not record it.
14. **Done summaries:** one Headless AI call (`consult.HeadlessSpecForTier(consult.TierCheap)`, 60 s timeout) for all items, returning JSON `{ "<chunk label>": "<summary>" }`. The code fallback is the finishing run's `Report` first paragraph, else the chunk's newest note. The run that finished a chunk is the newest run whose `EffortRef` names the chunk and whose `Land.State` is `landed`; its merge commit is `Land.Commit` (short, 7 chars). If you edit the comment before the summaries arrive, your edit wins and the late summaries are dropped with a line saying so: the spec makes the box editable and Post never waits.
15. **Comment format** (plain text, turned into ADF paragraphs and bullet lists): `Progress: <done> of <total> parts done.`, then the sections `Done` (chunks done and not yet in a post: `- <label>. <summary> Merged into <branch> as <sha>.`, with the merge sentence left out without a landed run), `In progress` (active, and blocked with ` (blocked)`), and `Next` (pending). Deferred and skipped chunks are left out, and so are empty sections.
16. **After a post:** a full success closes the dialog, and the footer line and chunk tags fade in. If the comment posted but the move failed, the dialog stays open on its result (board RunSheetPosted). If the comment failed, nothing is recorded, the error shows in the dialog and Post re-enables.
17. **Palette action:** a registry binding `jarvis:check-jira`, label "Check Jira for my tickets", group "Jarvis", active on the Jarvis surface. The worker picks a single-key chord not already bound there and adds it to `docs/keyboard-shortcuts.md`. Bindings feed the palette's Jarvis group, which is where the board shows it.
18. **CDP fixtures:** `scripts/cdp/jira-fixtures.mjs` runs a fake Jira HTTP server inside the scenario process and connects the dev app to it. Loading and drafting states hold the RPC with the existing `holdRpc`. The model rewrite is stood in by replacing `RpcApi.JiraPostSummariesCommand` in the page. Each Jira scenario lives in its own `scripts/cdp/scenarios-jira-<area>.mjs`, which Task 1 registers as a skip stub, so tasks running in parallel never share a scenario file.
19. **`wsh effort show`** gains a `project <name>` line and, with a ticket, `ticket <KEY> <type> · <status> (seen <MM-DD HH:mm>)` and `  read it: wsh jira show <KEY>` (board Elsewhere). **`wsh effort list`** gains a trailing tab column `<KEY> <type> · <status>` (or `<KEY>` before any copy exists). `EffortSummary` gains `TicketSeen` so `list` needs no extra reads.
20. **Records:** for a run with an `EffortRef` whose initiative has a ticket, `pkg/jarviscapture` uses that key, and falls back to the goal regex otherwise.

## Global constraints

- Jira Cloud only; REST v3; basic auth `email:token`; comment bodies are ADF.
- The token only ever lives in `pkg/secretstore`. No RPC returns it, and nothing logs it.
- Nothing calls Jira except a Jira action you pressed, the details field losing focus, or a `wsh jira` command. There is no polling and no call at launch.
- Motion: `motion/react` with values from `element/motiontokens.ts`, inside `MotionConfig reducedMotion="user"`. Entrances animate opacity and scale, never x/y, and there are no entrance cascades.
- UI copy: use the spec's and boards' words exactly: "Check Jira", "Your Jira tickets", "Make initiative", "Building in Agent", "Agent will ask", "post to Jira", "Post progress to <KEY>", "Leave as is", "Post comment" / "Post and move", "Posting…", "Drafting summaries…", "posted to Jira", "Connect Jira", "Replace token", "Test again", "Checking…", "Check again".

## Review focus

1. **Jira refusing or unreachable partway through a flow** (401 from an expired token, 404 for a key you can't see, a dropped network): every surface shows Jira's own status and message, or the unreachable cause, and no spinner is left running. Covered by Task 2's client tests and by each UI task's refused step.
2. **Key shape typed by hand** (` pay-318 `, `PAY-318 `, lowercase): normalized to `PAY-318` before the lookup, the dedupe in Check Jira and the copy matching; a string that is not key-shaped is never sent to Jira. Covered by Task 1's `normalizeKey` tests and Task 11's lookup tests.
3. **Retrying after the comment posted but the move failed:** nothing is reported twice. Covered by Task 4's `TestJiraPostMoveFailsKeepsRecord`.
4. **Editing the comment before the summaries arrive:** your text is kept. Covered by Task 9's `keeps the user's edits when summaries land late`.
5. **Changing or clearing an initiative's ticket:** the old ticket's copy is never drawn for the new key. Covered by Task 4's `TestSetTicketClearsStaleCopy`.

---

### Task 1: Wire types, settings keys, shared helpers and CDP fixtures
**Depends on:** none
**Files:** `pkg/waveobj/wtype.go`, `pkg/wshrpc/wshrpctypes_jira.go`, `pkg/wshrpc/wshrpctypes.go`, `pkg/wshrpc/wshrpctypes_effort.go`, `pkg/wconfig/settingsconfig.go`, `pkg/wconfig/metaconsts.go`, `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, `pkg/jira/jira.go`, `pkg/jira/jira_test.go`, `pkg/wshrpc/wshserver/wshserver_jira.go`, `frontend/app/view/jarvis/jiraticket.ts`, `frontend/app/view/jarvis/jiraticket.test.ts`, `frontend/app/view/jarvis/jiraactions.ts`, `frontend/app/view/jarvis/briefrows.ts`, `frontend/app/view/jarvis/briefrows.test.ts`, `frontend/app/view/jarvis/briefsurface.tsx`, `scripts/cdp/jira-fixtures.mjs`, `scripts/cdp/scenarios.mjs`, `scripts/cdp/scenarios-jira-settings.mjs`, `scripts/cdp/scenarios-jira-check.mjs`, `scripts/cdp/scenarios-jira-initiative.mjs`, `scripts/cdp/scenarios-jira-post.mjs`, `scripts/cdp/scenarios-jira-sidebar.mjs`, `scripts/cdp/scenarios-jira-details.mjs`, `scripts/cdp/scenarios-jira-wsh.mjs`

The interface every other task builds on. Keep implementations to stubs except the pure helpers and the fixtures.

- [ ] **Step 1: Go types.** In `pkg/waveobj/wtype.go`:
  - `Effort.Jira *EffortJira \`json:"jira,omitempty"\``.
  - `EffortJira{Summary, Type, Status string; StatusCategory string /* new | indeterminate | done */; Description string; Acceptance []string; SeenTs int64; SeenVia string /* check | show | refresh | post | lookup | make */; LastPost *EffortJiraPost}`, with json tags lowercased like their neighbours, and `description`, `acceptance` and `lastpost` omitempty.
  - `EffortJiraPost{Ts int64; CommentURL string; From string; MovedTo string; MoveError string}` (`movedto` and `moveerror` omitempty).
  - `EffortNote.JiraPost string \`json:"jirapost,omitempty"\``: the comment URL of the post that wrote this note.
  
  In `wshrpctypes_effort.go`, `EffortSummary.TicketSeen *EffortTicketSeen` with `EffortTicketSeen{Type, Status string; SeenTs int64}`.
- [ ] **Step 2: wshrpc.** In the new `wshrpctypes_jira.go`, define `JiraCommands` and compose it into the interface in `wshrpctypes.go` the way `EffortCommands` is:
  ```go
  JiraConnectionCommand(ctx, CommandJiraConnectionData{Test bool}) (*JiraConnection, error)
  JiraCheckCommand(ctx) (*CommandJiraCheckRtnData, error)
  JiraShowCommand(ctx, CommandJiraShowData{Key string; Via string /* show | refresh | lookup */}) (*CommandJiraShowRtnData, error)
  JiraPostDraftCommand(ctx, CommandJiraPostDraftData{EffortOID string}) (*CommandJiraPostDraftRtnData, error)
  JiraPostSummariesCommand(ctx, CommandJiraPostDraftData) (*CommandJiraPostSummariesRtnData, error)
  JiraPostCommand(ctx, CommandJiraPostData{EffortOID, Comment, TransitionID string; DoneChunks []string}) (*CommandJiraPostRtnData, error)

  JiraConnection{Configured bool; Missing []string /* site | email | token */; Site string; Ok bool; DisplayName string; CheckedTs int64 /* last attempt */; LastOkTs int64 /* last successful call */; Error string}
  JiraTicket{Key, Summary, Type, Status, StatusCategory, Description string; Acceptance []string; URL string; UpdatedTs int64}
  JiraTicketRow{JiraTicket; Project, Evidence string; Sure bool}            // embed or flatten; tsgen must emit flat fields
  CommandJiraCheckRtnData{Site string; CheckedTs int64; Tickets []JiraTicketRow; Covered int}
  CommandJiraShowRtnData{Ticket JiraTicket; Project, Evidence string; Sure bool; SeenTs int64}
  JiraTransition{ID, Name, To string}
  CommandJiraPostDraftRtnData{Key, Status string; LastPost *waveobj.EffortJiraPost; Comment string; DoneChunks []string; Transitions []JiraTransition}
  CommandJiraPostSummariesRtnData{Comment string; Rewritten bool; Reason string}
  CommandJiraPostRtnData{CommentURL string; PostedTs int64; From, MovedTo, MoveError, Status string}
  ```
  Every new wshrpc Jira type gets lowercase json tags like its neighbours (`rewritten`, `commenturl`, `lastokts`, …); the frontend reads those names. If tsgen does not flatten an embedded struct, give `JiraTicketRow` the fields of `JiraTicket` directly rather than nesting them. Settings keys: `JiraSite string \`json:"jira:site,omitempty"\``, `JiraEmail string \`json:"jira:email,omitempty"\`` in `settingsconfig.go`. Run `task generate`.
- [ ] **Step 3: `pkg/jira/jira.go`.** Constants: `SecretName = "JIRA_API_TOKEN"`, `CodeNotConfigured = "EC-JIRA-NOTCONFIGURED"`, `CodeHTTP = "EC-JIRA-HTTP"`, `CodeUnreachable = "EC-JIRA-UNREACHABLE"`. Error types and messages:
  - `type NotConfiguredError struct{ Missing []string }`, with `Error()` = `EC-JIRA-NOTCONFIGURED: Jira isn't set up: add your <site, account email and API token> in Settings > Jira.` (it names only what is missing).
  - `type HTTPError struct{ Status int; Message string }`, with `Error()` = `EC-JIRA-HTTP <status>: <message>`.
  - `func Unreachable(err error) error`.
  - `func ProjectKey(issueKey string) string` (`"PAY-318"` → `"PAY"`) and `func NormalizeKey(s string) string` (trim, uppercase, `""` unless it matches `^[A-Z][A-Z0-9]+-\d+$`).
  
  Test the three `Error()` strings and `NormalizeKey(" pay-318 ")=="PAY-318"`, `NormalizeKey("pay")==""`.
- [ ] **Step 4: Server stubs.** In `wshserver_jira.go`, each of the six methods returns `errors.New("EC-JIRA-UNREACHABLE: not built yet")`. Task 4 replaces them.
- [ ] **Step 5: `jiraticket.ts`** (pure, with tests):
  - `normalizeKey(s: string): string`, the same rule as Go.
  - `ticketUrl(site: string | undefined, key: string): string | null`: `${site without trailing /}/browse/${key}`, or null without a site.
  - `type JiraFailure = { kind: "off"; message } | { kind: "refused"; status: number; message } | { kind: "other"; message }` and `parseJiraError(err: unknown): JiraFailure`, which strips the `EC-…` prefix from `message`.
  - `type StatusTone = "todo" | "progress" | "done"` and `statusTone(category: string): StatusTone` (new → todo, indeterminate → progress, done → done, anything else → todo).
  - `STATUS_CHIP: Record<StatusTone, string>`: token classes for muted, accent and success chips.
  - `seenLabel(seenTs, now): string` (`"seen 2h ago"`, using `formatAgeShort`).
  - `seenTitle(seenTs, via): string`, e.g. `"Arc last saw this ticket 11-03 14:02, when you posted progress"`. Phrases per via: check "on Check Jira", show "when an agent ran wsh jira show", refresh "when you refreshed it", post "when you posted progress", lookup "when you looked it up in initiative details", make "when the initiative was made from it".
  
  Tests cover every branch, including `parseJiraError(new Error("EC-JIRA-HTTP 401: Client must be authenticated"))` → `{kind:"refused", status:401, message:"Client must be authenticated"}`.
- [ ] **Step 6: `jiraactions.ts`:** `openJiraSettings(): void` sets `pendingSettingsSectionAtom` to `"jira"` and switches to the Settings surface, the way `frontend/app/cockpit/app-bar.tsx` opens `"remote"`.
- [ ] **Step 7: Effort index ticket.** `EffortRef` in `briefrows.ts` gains `ticket: string`; `briefsurface.tsx`'s `briefEffortIndexAtom` fill passes `e.ticket ?? ""`. Add `ticket: ""` to the `EffortRef`-shaped literal in `briefrows.test.ts` (the `runRowFace` test near line 565), or `task check:ts` fails.
- [ ] **Step 8: `scripts/cdp/jira-fixtures.mjs`.**
  - `startFakeJira(opts?) → { url, state, close() }`. It is a `node:http` server on `127.0.0.1:0` that checks basic auth against `state.token` and serves exactly:
    - `GET /rest/api/3/myself` → `{displayName}`
    - `POST /rest/api/3/search/jql` → `{issues:[{key, fields:{summary, issuetype:{name}, status:{name, statusCategory:{key}}, updated, description:<ADF>, customfield_10050:<ADF bullet list>}}]}`
    - `GET /rest/api/3/field` → includes `{id:"customfield_10050", name:"Acceptance Criteria"}`
    - `GET /rest/api/3/issue/{key}`
    - `GET /rest/api/3/issue/{key}/transitions` → `{transitions:[{id,name,to:{name}}]}`
    - `POST` to the same path, which applies the move or answers 400 `{errorMessages:[...]}` when `state.failTransition[id]` is set
    - `POST /rest/api/3/issue/{key}/comment` → `{id}`, recorded in `state.comments`
    
    `state.refuse = {status, message}` makes every call answer with that status and `{errorMessages:[message]}`. The seeded issues are the Main board's four (PAY-318, PAY-311, OPS-77, GROW-12, with their summaries, types, statuses and the Initiative board's description and three criteria for PAY-318), and the transitions are To Do → In Progress, In Review, Done.
  - `connectFakeJira(h, fake) → restore()` remembers and then sets `jira:site`, `jira:email` (`setconfig`) and `JIRA_API_TOKEN` (`setsecrets`); restore puts the previous values back.
  - `disconnectJira(h) → restore()` clears all three.
  - `seedTicketedInitiative(h, {title, project, key, chunks}) → effortoid` runs `effortcreate` with `ticket`, then `jirashow {key, via:"show"}` so the copy lands.
  - `motionSamples(h, {selector, props, ms, trigger}) → frames[]` samples computed styles once per animation frame while `trigger` (a page-side expression) runs.
  - `withReducedMotion(h, fn)` wraps `fn` in `Emulation.setEmulatedMedia` `prefers-reduced-motion: reduce` and always clears it.
- [ ] **Step 9: Scenario stubs.** Create the seven `scenarios-jira-<area>.mjs` files, each exporting one scenario named `jira-settings`, `jira-check`, `jira-initiative`, `jira-post`, `jira-sidebar`, `jira-details`, `jira-wsh` whose single step is `skip` with detail "not built yet". List them in `SCENARIOS` in `scenarios.mjs`. The owning tasks replace the bodies. Tasks 5-11 depend only on this task, not on Task 4's real handlers, so in their own trees their scenarios meet the `not built yet` stubs: a worker there proves the scenario file loads and its arrange runs, and the scenario's first real run is Final, on the merged result.
- [ ] **Step 10: Verify.**
  - Run `go test ./pkg/jira -run 'TestError|TestNormalizeKey|TestProjectKey'` and `npx vitest run frontend/app/view/jarvis/jiraticket.test.ts`: they pass.
  - `task check:ts` exits 0.
  - `go build ./...` succeeds.

### Task 2: Jira REST client and ADF
**Depends on:** Task 1 (uses the `pkg/jira` error types, `NormalizeKey` and the `wshrpc.JiraTicket`/`JiraTransition` types it adds)
**Files:** `pkg/jira/config.go`, `pkg/jira/client.go`, `pkg/jira/adf.go`, `pkg/jira/config_test.go`, `pkg/jira/client_test.go`, `pkg/jira/adf_test.go`

Interfaces it produces (Task 4 relies on them):

```go
func LoadConfig() (Config, error)                    // jira:site, jira:email, secret JIRA_API_TOKEN; *NotConfiguredError listing what is missing
func NormalizeSite(raw string) (string, error)       // https://<name>.atlassian.net, or http(s)://127.0.0.1|localhost[:port]; trims a trailing "/" and any path
type Config struct{ Site, Email, Token string }
func New(cfg Config, hc *http.Client) *Client        // nil hc = a client with a 20s timeout
func (c *Client) Myself(ctx) (displayName string, err error)
func (c *Client) SearchOpen(ctx) ([]wshrpc.JiraTicket, error)
func (c *Client) Issue(ctx, key string) (wshrpc.JiraTicket, error)
func (c *Client) Transitions(ctx, key string) ([]wshrpc.JiraTransition, error)
func (c *Client) AddComment(ctx, key, plain string) (commentURL string, err error)   // builds ADF from plain
func (c *Client) DoTransition(ctx, key, id string) error
func ADFToPlain(doc json.RawMessage) string
func PlainToADF(plain string) map[string]any
```

- [ ] **Step 1: Tests first,** each against an `httptest.Server`:
  - `TestSearchOpenSendsJQLAndParses`: the body's `jql` equals decision 7's string exactly and `maxResults` is 50; the reply maps to tickets with `URL == site+"/browse/<KEY>"` and `UpdatedTs` parsed from Jira's `2026-11-03T12:00:00.000+0000`.
  - `TestIssueAcceptanceFromField`: the field is found through `/field` by name, case-insensitively, and the list comes from that field.
  - `TestIssueAcceptanceFallsBackToDescription`: with no such field, the list items under a description paragraph reading "Acceptance criteria" are used.
  - `TestFieldLookupCachedPerSite`: `/field` is hit once across two `Issue` calls.
  - `TestHTTPErrorCarriesJiraMessage`: 401 with `{errorMessages:["Client must be authenticated to access this resource."]}` gives `*HTTPError{401, that text}`; a 400 with only `errors:{"Reviewer":"Field 'Reviewer' is required"}` gives the joined `errors` values.
  - `TestUnreachable`: a closed server yields an error starting `EC-JIRA-UNREACHABLE:`.
  - `TestBasicAuth`: the `Authorization` header is `Basic base64(email:token)`.
  - `TestAddCommentReturnsURL`: the URL is `<site>/browse/<KEY>?focusedCommentId=<id>`, and the posted body is ADF.
  - `TestLoadConfigMissing`: with no settings and no secret, `Missing == ["site","email","token"]`.
  - `TestNormalizeSite`: `https://acme.atlassian.net/` → `https://acme.atlassian.net`; `http://127.0.0.1:5555` is accepted; `http://acme.atlassian.net` and `https://example.com` are rejected.
  - `TestADFToPlain`: paragraphs, headings, bullet and ordered lists, hardBreak, mention and inline card come out as readable text, and an unknown node type yields its text children rather than an error.
  - `TestPlainToADF`: blank-line-separated blocks become paragraphs, runs of `- ` lines become one `bulletList`, and a one-word line followed by list lines (`Done`, `In progress`, `Next`) becomes a paragraph with a `strong` mark.
- [ ] **Step 2:** Run `go test ./pkg/jira -run 'TestSearchOpen|TestIssue|TestField|TestHTTPError|TestUnreachable|TestBasicAuth|TestAddComment|TestLoadConfig|TestNormalizeSite|TestADF|TestPlainToADF'`: they fail.
- [ ] **Step 3: Implement** with the endpoints Task 1's fake serves, and no other.
  - The token never appears in an error or a log line.
  - Read `wconfig` through `wconfig.GetWatcher().GetFullConfig().Settings` and the token through `secretstore.GetSecret`.
- [ ] **Step 4:** The step 2 command passes.

### Task 3: Project inference and the progress comment (pure)
**Depends on:** Task 1 (uses the `pkg/jira` package and the `Effort.Jira`/`EffortNote.JiraPost` fields it adds)
**Files:** `pkg/jira/infer.go`, `pkg/jira/infer_test.go`, `pkg/jira/progress.go`, `pkg/jira/progress_test.go`

Interfaces it produces (Task 4 relies on them):

```go
type Inference struct{ Project, Evidence string; Sure bool }
func InferProject(jiraProject string, efforts []*waveobj.Effort, commits map[string]int) Inference
func CommitCounts(ctx context.Context, projects map[string]string /* name -> path */, jiraProject string) map[string]int  // git log -n 2000 --format=%s per project; a failing repo counts 0 and is logged
type Finisher struct{ Report, Commit, Branch string }       // Commit already 7 chars; empty when no landed run
func DoneSincePost(e *waveobj.Effort) []string               // done chunk labels with no note carrying JiraPost, in plan order
func CodeSummary(report string) string                       // first paragraph, markdown headings/emphasis stripped, one line
func CodeDraft(e *waveobj.Effort, fin map[string]Finisher) string        // decision 15's format; summary = CodeSummary(report) else the chunk's newest note's first line
func SummariesPrompt(e *waveobj.Effort, labels []string, fin map[string]Finisher) string
func ParseSummaries(reply string) (map[string]string, error)              // tolerates a json code fence around the object; error on no JSON object
func DraftWithSummaries(e *waveobj.Effort, fin map[string]Finisher, sums map[string]string) string // CodeDraft with each Done item's summary replaced when present
```

- [ ] **Step 1: Tests:**
  - `TestInferClearWinner`: two initiatives in A, none in B, gives Sure A with evidence `2 initiatives, 5 tagged commits`.
  - `TestInferCommitsOnly`: 0/0 initiatives with 6 vs 2 commits gives Sure; 6 vs 4 gives unsure with `Tied: a and b`.
  - `TestInferNoHistory`: unsure with `No history for GROW`.
  - `TestInferSingularEvidence`: `1 initiative, 1 tagged commit`.
  - `TestDoneSincePostSkipsPosted`.
  - `TestCodeDraftMatchesBoard`: the PostToJira board's comment, exactly, from a three-chunk effort with one landed finisher whose branch is `main` and commit `3e91a0c`.
  - `TestCodeDraftOmitsEmptySectionsAndDeferred`.
  - `TestCodeDraftFallsBackToNote`: no finisher, so the newest note's first line.
  - `TestCodeSummaryFirstParagraph`.
  - `TestParseSummariesFenced`.
  - `TestParseSummariesGarbage`, which returns an error.
  - `TestDraftWithSummariesKeepsMerge`: the merge sentence survives the replacement.
  - `TestCommitCountsMatchesKeyBoundary`, against a temp git repo: `PAY-1` counts and `XPAY-1` does not.
- [ ] **Step 2:** `go test ./pkg/jira -run 'TestInfer|TestDoneSincePost|TestCodeDraft|TestCodeSummary|TestParseSummaries|TestDraftWithSummaries|TestCommitCounts'` fails, then passes after implementation.

### Task 4: wavesrv Jira commands, the last-seen copy and posting
**Depends on:** Task 2 (the client), Task 3 (inference and drafts)
**Files:** `pkg/jira/seen.go`, `pkg/jira/seen_test.go`, `pkg/wshrpc/wshserver/wshserver_jira.go`, `pkg/wshrpc/wshserver/wshserver_jira_test.go`, `pkg/wshrpc/wshserver/wshserver_effort.go`, `pkg/jarvis/effortops.go`, `pkg/jarvis/effortops_test.go`, `pkg/jarvisstate/jarvisstate.go`, `pkg/jarvisstate/jarvisstate_test.go`

- [ ] **Step 1: `seen.go`.**
  - `func RecordSeen(ctx, t wshrpc.JiraTicket, via string, now int64) error` writes the copy (keeping `LastPost`) onto every effort whose `Ticket` matches `t.Key` case-insensitively (via `effortstore.Update`), and stores `t` in an in-memory cache.
  - `func Cached(key string) (wshrpc.JiraTicket, int64, bool)`.
  - `func CopyOf(t wshrpc.JiraTicket, via string, now int64, prev *waveobj.EffortJira) *waveobj.EffortJira`.
  - Connection memory: `func NoteConnection(displayName string, err error, now int64)`, and `func LastConnection() wshrpc.JiraConnection` for the fields a call can know. Every call sets `CheckedTs` (the last attempt) and `Error`; only a successful call sets `LastOkTs` and `DisplayName`, so a refusal keeps when Jira last answered (the CheckJiraStates refused board's "Last checked …").
- [ ] **Step 2: `setTicket` in `effortops.go`.** When the key changes, it clears `e.Jira`. On `EffortCreate` and on a `setTicket` op, `wshserver_effort.go` then attaches `jira.Cached(key)` as `CopyOf(..., "make", ...)` (via `make` on create, `lookup` on setTicket). `EffortSummaryOf` fills `TicketSeen` from `e.Jira`.
- [ ] **Step 3: Handlers in `wshserver_jira.go`.** Every handler that calls Jira reports the outcome through `NoteConnection`.
  - `JiraConnection`: with `Test`, it calls `Myself`. It always returns `Configured` and `Missing` from `LoadConfig`.
  - `JiraCheck`: `SearchOpen`, then `RecordSeen(via "check")` for the tickets already on an initiative (decision 8), dropping them and counting `Covered`. It runs `InferProject` once per distinct Jira project key, with `CommitCounts` over the registered projects (from `projects.json`, through the same reader `pkg/storagereport` uses) and every effort.
  - `JiraShow`: `Issue`, `RecordSeen(via)`, plus the inference.
  - `JiraPostDraft`:
    - It refuses an effort with no ticket (`EC-INVALID: this initiative has no ticket`).
    - It reads the ticket and its transitions from Jira (and `RecordSeen(via "post")`).
    - It builds the finisher map from runs: the newest run per chunk whose `EffortRef` matches and whose `Land.State=="landed"`, with branch from the run's base branch field when it records one, else omitted.
    - It returns `CodeDraft` and `DoneSincePost`.
  - `JiraPostSummaries`:
    - Done chunks with no report and no note: nothing to rewrite.
    - Headless AI not set up, a timeout (60 s) or a parse failure: `Rewritten:false`, `Reason` one line, `Comment` the code draft.
    - Otherwise `DraftWithSummaries`.
  - `JiraPost`: decision 13's order. The chunk notes are author `you` with text `Reported as done in the progress comment.` and `JiraPost` set. The effort-level note reads `Posted progress to <KEY>.` plus ` Moved <From> to <To>.` when it moved, with `JiraPost` set. `LastPost` is set, and after a failed move the issue is re-read so `Status` is Jira's real status.
- [ ] **Step 4: Tests** (`wshserver_jira_test.go` uses an `httptest` fake Jira and a temp effort root via `effortstore.UseRootForTest`; settings and secret injected the way existing wshserver tests inject config. If none does, give `LoadConfig` a package-level `var loadConfig = jira.LoadConfig` seam in the handler file.)
  - `TestJiraCheckDropsTicketsOnInitiatives` (archived counts), `TestJiraCheckRefreshesCoveredCopies`.
  - `TestJiraShowRecordsSeenOnEveryMatchingEffort`.
  - `TestSetTicketClearsStaleCopy`, `TestCreateWithTicketAttachesCachedCopy`.
  - `TestJiraPostRecordsNotesAndLastPost`.
  - `TestJiraPostMoveFailsKeepsRecord`: the move answers 400, the result carries `MoveError` and Jira's real status, the chunk notes exist, and a second `JiraPostDraft` lists no Done chunks.
  - `TestJiraPostCommentFailsRecordsNothing`.
  - `TestJiraPostSummariesFallsBack`: with no headless runtime, `Rewritten=false` and the comment is the code draft.
  - `TestNotConfiguredMessage`: every handler returns the `EC-JIRA-NOTCONFIGURED` text with nothing set.
  - `TestRecordSeenKeepsLastPost`, `TestRecordSeenMatchesKeyCaseInsensitively`, `TestRecordSeenCaches` (then `Cached` returns it), `TestCopyOf`, and `TestNoteConnectionKeepsLastOk` (a failure after a success keeps `LastOkTs` and `DisplayName`, and moves `CheckedTs` and `Error`) in `seen_test.go`.
  - `TestEffortSummaryTicketSeen` in `jarvisstate_test.go`.
  - `TestSetTicketChangeClearsJira` in `effortops_test.go`.
- [ ] **Step 5:** `go test ./pkg/wshrpc/wshserver -run 'TestJira|TestSetTicketClearsStaleCopy|TestCreateWithTicketAttachesCachedCopy|TestNotConfiguredMessage'`, `go test ./pkg/jira -run 'TestRecordSeen|TestCopyOf|TestNoteConnection'`, `go test ./pkg/jarvis -run TestSetTicketChangeClearsJira` and `go test ./pkg/jarvisstate -run TestEffortSummaryTicketSeen` all pass.

### Task 5: `wsh jira`, `wsh effort show/list` with the ticket, and the initiatives skill
**Depends on:** Task 1 (uses the generated `wshclient` Jira commands and `EffortJira`/`TicketSeen`)
**Files:** `cmd/wsh/cmd/wshcmd-jira.go`, `cmd/wsh/cmd/wshcmd-jira_test.go`, `cmd/wsh/cmd/wshcmd-effort.go`, `cmd/wsh/cmd/wshcmd-effort_test.go`, `skills/initiatives/SKILL.md`, `cmd/wsh/cmd/claude-mod/skills/initiatives/SKILL.md`, `scripts/cdp/notes-wsh.mjs`, `scripts/cdp/scenarios-jira-wsh.mjs`

- [ ] **Step 1: Tests:**
  - `TestFormatJiraCheck`: one line per ticket, `<KEY>\t<type> · <status>\t<summary>\t<project or "agent will ask"> (<evidence>)`, then `N more assigned tickets already have an initiative.` (or `Every ticket assigned to you has an initiative.` with none).
  - `TestFormatJiraShow`: summary title line, `type · status`, the URL, a blank line, the description, `Acceptance criteria` with `- ` items, then `project <name> (<evidence>)` or `project unsure (<evidence>); ask which project before creating anything`.
  - `TestFormatEffortShowTicket`: the Elsewhere board's lines exactly.
  - `TestFormatEffortShowNoTicket`: unchanged apart from the project line.
  - `TestEffortListTicketColumn`.
- [ ] **Step 2: Implement.**
  - `wsh jira check [--json]` and `wsh jira show <KEY> [--json]` (the key goes through `jira.NormalizeKey`; a non-key argument is an error naming the expected shape, with no RPC call). `show` calls `JiraShowCommand` with `Via:"show"`; `check` calls `JiraCheckCommand`, which takes no data.
  - The effort show/list lines per decision 19.
  - In `skills/initiatives/SKILL.md`, a short "From a Jira ticket" section: run `wsh jira show <KEY>`, and when it says the project is unsure, ask the human which project. Then `wsh effort create "<ticket title>" --ticket <KEY> --project <p> --chunk …`, planning chunks from the description and acceptance criteria (not sub-tasks), and then `wsh effort note <oid> "<first chunk label>" --note "Made from <KEY>: <how you planned the chunks>"` (the command is `note <effort> <chunk> --note`; the ChunkSidebar board shows this note on chunk 1). Copy it with `task sync:claudemod` (never hand-edit the claude-mod copy).
- [ ] **Step 3: Scenario `jira-wsh`** (board Elsewhere, terminal half). Extract the driver in `notes-wsh.mjs` into an exported `runWsh(h, argvList) → [{code, stdout, stderr}]` and keep `notesWsh` working on it. The scenario does `startFakeJira` + `connectFakeJira` + `seedTicketedInitiative(PAY-318…)`, then runs `wsh effort show <oid>`, `wsh jira show PAY-318`, `wsh jira check` and `wsh jira show pay-318`. Steps assert:
  - the `ticket PAY-318 Story · To Do (seen …)` and `read it: wsh jira show PAY-318` lines;
  - the show output's criteria;
  - the check output omitting PAY-318 and listing the other three;
  - the lowercase key normalized.
  
  A `disconnectJira` step asserts `wsh jira check` exits nonzero with the `Settings > Jira` message.
  
  Final judges screenshots only, so after the asserts the scenario draws the `wsh effort show` and `wsh jira show PAY-318` stdout into a temporary `<pre data-jira-wsh-output>` overlay in the page (the terminal font and `@theme` tokens), takes a shot (Elsewhere, terminal half), and removes the overlay in teardown.
- [ ] **Step 4:** `go test ./cmd/wsh/cmd -run 'TestFormatJira|TestFormatEffortShow|TestEffortListTicketColumn'` passes. `claude plugin validate claude/arc-mod` is unchanged (no mod files touched beyond the synced skill).

### Task 6: Settings > Jira
**Depends on:** Task 1 (uses the settings keys, `JiraConnectionCommand` and `parseJiraError`)
**Files:** `frontend/app/view/agents/settingsmodel.ts`, `frontend/app/view/agents/settingsmodel.test.ts`, `frontend/app/view/agents/settingssurface.tsx`, `scripts/cdp/scenarios-jira-settings.mjs`

Board: Settings.

- [ ] **Step 1: Tests in `settingsmodel.test.ts`.**
  - The `jira` section sits in the Data group between Headless AI and Storage, with rows `jira.site`, `jira.email`, `jira.token` and `jira.connection`, using the board's titles and descriptions.
  - `jiraSiteError("acme.atlassian.net")` returns a message, and `jiraSiteError("https://acme.atlassian.net")` returns null.
  - `jiraConnectionLine(conn, now)` covers four states:
    - not configured → `Add your <missing> to connect.`
    - never checked → `Not checked yet`
    - ok → `Connected as <name>` with `Checked 3m ago`
    - failed → Jira's message
- [ ] **Step 2: Implement `JiraSection`** in `settingssurface.tsx`, following `HeadlessAISection`'s secret handling (has-key probe through `GetSecretsNamesCommand`, write-only `SetSecretsCommand`):
  - Site and email inputs write `jira:site` / `jira:email`, with the site validated before saving.
  - Token shows `Saved` + `Replace token` (an input appears) or the input when none, plus `Create a token at id.atlassian.com ↗` linking to `https://id.atlassian.com/manage-profile/security/api-tokens`.
  - Connection reads `JiraConnection{Test:false}` on mount and `Test again` calls `{Test:true}`. The button keeps its width as `Testing…`.
  - The section's `pendingSettingsSectionAtom` id is `"jira"`, which `openJiraSettings` relies on.
- [ ] **Step 3: Scenario `jira-settings`.**
  - (1) With `disconnectJira`, open Settings > Jira and assert the four rows and the not-configured line, with a shot.
  - (2) `connectFakeJira`, then Test again: `Connected as Fixture User` and `Checked` text, with a shot matching the board.
  - (3) `fake.state.refuse = {status:401,…}`, then Test again shows the 401 message.
  - (4) Typing `acme.atlassian.net` in Site shows the site error.
  - Teardown restores.
- [ ] **Step 4:** `npx vitest run frontend/app/view/agents/settingsmodel.test.ts` passes.

### Task 7: Check Jira dialog, Make initiative, toolbar and palette
**Depends on:** Task 1 (uses `JiraCheckCommand`, `jiraticket.ts`, `openJiraSettings`, the index's `ticket`)
**Files:** `frontend/app/view/jarvis/jiracheck.ts`, `frontend/app/view/jarvis/jiracheck.test.ts`, `frontend/app/view/jarvis/jiracheckdialog.tsx`, `frontend/app/view/jarvis/jiramake.ts`, `frontend/app/view/jarvis/jiramake.test.ts`, `frontend/app/view/jarvis/brieftoolbar.tsx`, `frontend/app/view/jarvis/briefsurface.tsx`, `frontend/app/store/keybindings/bindings.ts`, `docs/keyboard-shortcuts.md`, `scripts/cdp/scenarios-jira-check.mjs`

Boards: Main, CheckJiraStates, and Elsewhere (palette half). Motion moments 2 and 3.

Interfaces:

```ts
// jiracheck.ts
export const checkJiraOpenAtom: PrimitiveAtom<boolean>;
export type CheckState = { kind: "loading"; prev?: CommandJiraCheckRtnData } | { kind: "list"; data: CommandJiraCheckRtnData }
  | { kind: "off"; message: string } | { kind: "refused"; status: number; message: string; site: string; lastChecked?: number } | { kind: "other"; message: string };
export function checkSubtitle(s: CheckState): string;      // "4 assigned to you without an initiative" / "Checking your open tickets" / "0 assigned to you without an initiative" / "Jira isn't set up"
export function visibleRows(data: CommandJiraCheckRtnData, onInitiative: Set<string>): JiraTicketRow[];   // drops keys now on an initiative
export function footerLine(covered: number): string;       // "2 more assigned tickets already have an initiative."
// jiramake.ts
export const jiraMakeDeps: { launch: typeof launchAgent };
export function makePrompt(row: JiraTicketRow): string;    // decision 11
export function makeTarget(row: JiraTicketRow, registry: Record<string,{path?:string}>): { projectPath: string; projectName: string };
export async function makeInitiative(model: AgentsViewModel, row: JiraTicketRow): Promise<string /* tabId */>;
```

- [ ] **Step 1: Tests:**
  - every `checkSubtitle` state;
  - `visibleRows` drops a key that appears in the set, case-insensitively;
  - `footerLine(0)` is `""` and `footerLine(1)` is singular;
  - `makePrompt` for a sure row names the project, and for an unsure row says to ask before creating anything; both mention `wsh jira show <KEY>`, `--ticket <KEY>` and the `Made from <KEY>` note;
  - `makeTarget` gives the project's path when sure, and `{projectPath:"", projectName:""}` when unsure or unregistered.
- [ ] **Step 2: Implement.**
  - **Toolbar:** a `Check Jira` button with `data-jarvis-check-jira`, placed beside New initiative in `brieftoolbar.tsx`, which opens the dialog.
  - **Binding:** `jarvis:check-jira` per decision 17.
  - **Mount:** `briefsurface.tsx` mounts `JiraCheckDialog` while `checkJiraOpenAtom` is true; it runs `JiraCheckCommand` on open and on Check again.
  - **Dialog shell:** `ModalShell` (motion moment 2: its existing enter/leave). The header has the title, the subtitle, `<site> · just now`, Check again (`Checking…` while loading, same width) and Close.
  - **Loading:** the list layout with bars where text lands (three placeholder rows at the board's widths), crossfaded to rows with `AnimatePresence mode="popLayout"`/`microFade` on a fixed-height body, so nothing shifts.
  - **Row:** the key opens Jira (`ticketUrl`); summary; `type · status · updated <age>`; the project with its evidence, or `Agent will ask` in the warning token; `Make initiative`; an Open in Jira icon.
  - **Make initiative (motion moment 3):** it crossfades in place to `Building in Agent` (same box size; it links to the tab through `openTarget`), with building state keyed by ticket in the dialog's own state. Rows leave through `visibleRows` with the Brief index's tickets, in `AnimatePresence mode="popLayout"`, where each row is a `motion.div` direct child with `layout` and exit opacity/scale.
  - **Empty, off and refused states:** the board's copy, with `Connect Jira` → `openJiraSettings()` and `Replace token` → `openJiraSettings()`. The refused state's `lastChecked` comes from `JiraConnectionCommand{Test:false}`'s `LastOkTs`, read when the check fails; with `0` the "Last checked" line is left out.
  - **Launch failure:** a toast with the error, and the row returns to Make initiative.
- [ ] **Step 3: Scenario `jira-check`.** Fake Jira connected; `seedTicketedInitiative` for PAY-290, so `Covered` is 1.
  1. With `holdRpc(JiraCheckCommand)`: press Check Jira (the toolbar button); assert the dialog, the three bars and `Checking…`, then shot (CheckJiraStates "Loading").
  2. Release: assert four rows, keys and summaries as on the board, GROW-12's `Agent will ask`, the footer line, and the bars → rows crossfade sampled with `motionSamples` (opacity passes between 0 and 1, and the body height stays constant across frames). Shot (Main).
  3. Replace `jiraMakeDeps.launch` with a stub returning a fake tab id; press Make initiative on PAY-311. Assert `Building in Agent` with an unchanged box size (`getBoundingClientRect` before and after) and an intermediate opacity frame.
  4. `effortcreate` with `ticket:"PAY-311"` (standing in for the agent); assert the row leaves, the rows below move up to close the gap (a `motionSamples` frame mid-move) and the new initiative appears in the Brief's Initiatives with the fresh mark.
  5. Repeat step 4's removal under `withReducedMotion`: no intermediate transform frames.
  6. Close: assert the dialog's exit.
  7. `fake.state.issues = []`: Check again gives Nothing new (shot).
  8. `disconnectJira`: Not connected (shot, CheckJiraStates), and Connect Jira lands on Settings > Jira.
  9. Refused 401: Jira's status and message, and Replace token (shot).
  10. Palette: open it, type `Check Jira`, assert the `Check Jira for my tickets` row in the Jarvis group, Enter, and the dialog opens. Shot. Also type `PAY-29` and assert the ticketed initiative row; shot (Elsewhere board, palette half).
- [ ] **Step 4:** `npx vitest run frontend/app/view/jarvis/jiracheck.test.ts frontend/app/view/jarvis/jiramake.test.ts frontend/app/store/keybindings` passes (the keybinding tests guard chord conflicts).

### Task 8: The ticket on the initiative: Brief row and ticket bar
**Depends on:** Task 1 (uses `jiraticket.ts`, `JiraShowCommand`, `Effort.Jira`; shares `briefrows.ts`)
**Files:** `frontend/app/view/jarvis/briefrows.ts`, `frontend/app/view/jarvis/briefrows.test.ts`, `frontend/app/view/jarvis/briefrowviews.tsx`, `frontend/app/view/jarvis/ticketbar.ts`, `frontend/app/view/jarvis/ticketbar.test.ts`, `frontend/app/view/jarvis/ticketbar.tsx`, `frontend/app/view/jarvis/briefinitiatives.tsx`, `scripts/cdp/scenarios-jira-initiative.mjs`

Board: Initiative. Motion moments 1 and 5.

- [ ] **Step 1: Tests.**
  - `initiativeLine` sets a new `BriefLine.ticket` (the key, or `""`) and keeps `meta` as `PAY-318 · payments-api`.
  - `ticketBarModel(effort: Effort, site: string | undefined, now: number) → null | { key, url, type, status, tone, firstLine, description, acceptance, seen, seenTitle }` returns null with no ticket. With a ticket but no copy it returns the key and url, empty fields, and `seen` = `"not seen yet"`. `firstLine` is the description's first non-empty line.
- [ ] **Step 2: Implement.**
  - **InitiativeRow:** draws the meta's key as a link (`ticketUrl`; `stopPropagation` so the row still opens the plan on any other click); plain text when no site is set.
  - **TicketBar:** mounted in `briefinitiatives.tsx` inside the plan reveal, above `InitiativeDetail`; nothing for an initiative with no ticket. It is compact by default: a chevron (rotates 90° on `durMicro`), the key link, the type, the status chip (`STATUS_CHIP`; its background and foreground colour transition on `durMicro` via `turnTransition`-style CSS, motion moment 5), the truncated first line, `seen 2h ago` with `title=seenTitle`, and a refresh icon.
  - **Expand/fold:** the chevron or the first line expands to the full description and `Acceptance criteria`, with `paneReveal` height+opacity on `durMacro` (motion moment 1); the chevron folds it. Expanded state is a per-effort jotai atom (the surface unmounts on switch).
  - **Refresh:** calls `JiraShowCommand{key, via:"refresh"}` then `loadEffortDetail(oref)`. While it runs, the icon spins; a failure shows `parseJiraError`'s message in one line in the bar.
- [ ] **Step 3: Scenario `jira-initiative`.** `seedTicketedInitiative(PAY-318, three chunks, Build stage)`.
  1. Assert the Brief row's meta `PAY-318 · payments-api`, the key an `<a>` to `<fake>/browse/PAY-318`, and that clicking the title opens the plan. Shot.
  2. Assert the compact bar (key, Story, To Do chip, first line, `seen` text and title). Shot (Initiative board, folded).
  3. Click the chevron: `motionSamples` shows height and opacity passing through intermediate values and the chevron's rotate going 0→90; then assert the full description and three criteria. Shot (expanded).
  4. Fold under `withReducedMotion`: no intermediate height frames.
  5. Set the fake's PAY-318 status to In Progress (indeterminate), press refresh, and sample the chip's `background-color` passing an intermediate value; assert the `In Progress` text and a fresh `seen` value.
  6. An initiative with no ticket shows no bar.

### Task 9: Post progress to Jira
**Depends on:** Task 1 (uses the post commands, `EffortNote.JiraPost`, `jiraticket.ts`)
**Files:** `frontend/app/view/jarvis/jirapost.ts`, `frontend/app/view/jarvis/jirapost.test.ts`, `frontend/app/view/jarvis/jirapostdialog.tsx`, `frontend/app/view/jarvis/inlinetrackerview.tsx`, `frontend/app/view/jarvis/inlinetracker.ts`, `frontend/app/view/jarvis/inlinetracker.test.ts`, `scripts/cdp/scenarios-jira-post.mjs`

Boards: PostToJira and RunSheetPosted (footer and failed move). Motion moment 4.

Interfaces:

```ts
export const jiraPostOpenAtom: PrimitiveAtom<string | null>;   // the effort oref the dialog is open on
export type PostDraft = { text: string; drafting: boolean; edited: boolean; note: string };
export function onDraft(rtn): PostDraft;                        // code draft, drafting: true
export function onSummaries(d: PostDraft, s: CommandJiraPostSummariesRtnData): PostDraft;  // swaps only when !edited and s.rewritten; note "Summaries were not rewritten: <reason>" or "Kept your edits; the drafted summaries were not applied."
export function onEdit(d: PostDraft, text: string): PostDraft;
export function moveOptions(t: JiraTransition[]): { id: string; label: string }[];   // "Leave as is" (id "") first
export function postSentence(status: string, pick: { id: string; label: string }): string;  // "Posts the comment; the ticket stays To Do." / "Posts the comment, then moves To Do to In Progress."
export function postLabel(pick): "Post comment" | "Post and move";
export function lastPostedLine(lp: EffortJiraPost | undefined, now: number): string;  // "Last posted: never." / "Last posted 2h ago."
export function footerPosted(lp, now): string;                  // "Posted 2h ago, moved to In Progress" / "Posted 2h ago"
```

- [ ] **Step 1: Tests:**
  - each function above;
  - `keeps the user's edits when summaries land late`;
  - `swaps the drafted summaries when untouched`;
  - `DetailRow` chunk rows gain `posted: boolean`, true when any of the chunk's notes has `jirapost` (in `inlinetracker.ts`).
- [ ] **Step 2: Implement.**
  - **Footer:** in `inlinetrackerview.tsx`, `post to Jira` between activity and pause, accent-styled per the board, shown only when the effort has a ticket. Read the effort from `effortDetailAtom` by the plan's oref; don't add props to `InitiativeDetail`'s callers. It is followed by the `footerPosted` line linking to `LastPost.CommentURL`, which fades in with `microFade` when it appears.
  - **Chunk tag:** each `posted` chunk row shows a quiet `posted to Jira` that fades in the same way.
  - **Dialog (`ModalShell`, `onSubmit` = ctrl+⏎):** `JiraPostDialog` mounts in `inlinetrackerview.tsx` while `jiraPostOpenAtom` is set (not in `briefsurface.tsx`, which Task 7 owns).
    - On open, it calls `JiraPostDraftCommand`, then `JiraPostSummariesCommand` without awaiting it before rendering.
    - Header: `Post progress to <KEY>`, and `Currently <status> in Jira.` + `lastPostedLine`.
    - Comment textarea: greyed with `Drafting summaries…` while `drafting`; the drafted text crossfades over the code draft (`AnimatePresence mode="popLayout"` keyed on the text version, opacity only); the board's helper line.
    - Move pills from `moveOptions`; footer `postSentence`; Cancel; and the post button (`postLabel`), which keeps its width as `Posting…`.
    - Result: full success closes; comment-ok/move-failed shows the RunSheetPosted lines (`Comment posted.`, `Couldn't move it to <X>, so it is still <status>.`, `Jira: <message>`, `Move it in Jira ↗` → the ticket URL, Close), fading in. A comment failure shows the error and re-enables Post.
    - Draft errors use `parseJiraError` (an off error offers Connect Jira).
- [ ] **Step 3: Scenario `jira-post`.** `seedTicketedInitiative(PAY-318)` with chunk 1 done.
  1. Open the plan, assert `post to Jira` in the footer, and click it.
  2. With `holdRpc(JiraPostSummariesCommand)`: assert the greyed code draft, `Drafting summaries…`, the Done item naming `Retry with backoff`, the `Leave as is` pill first, and the footer sentence. Shot (PostToJira).
  3. Replace `RpcApi.JiraPostSummariesCommand` with a stub returning a rewritten comment; reopen; sample the crossfade (an intermediate opacity frame on the new text) and assert the new text.
  4. Pick In Progress: the sentence and the `Post and move` label. Press ctrl+⏎ with `holdRpc(JiraPostCommand)` and assert `Posting…` at an unchanged button width; release.
  5. Assert the dialog closed, the fake recorded one comment and the move, the footer reads `Posted … moved to In Progress` with the link fading in (an intermediate opacity frame), and `posted to Jira` on chunk 1. Shot (RunSheetPosted, footer).
  6. Mark chunk 2 done, set the fake's `failTransition` for In Review to `Field 'Reviewer' is required for this transition.`, post with In Review, and assert the failed-move lines and `Move it in Jira ↗`. Shot (RunSheetPosted, failed move). Reopen and assert the draft's Done section is empty of chunks 1 and 2.
  7. Repeat 5's fade under `withReducedMotion` to assert it lands.

### Task 10: The ticket in the chunk sidebar and the run sheet
**Depends on:** Task 8 (shares `briefinitiatives.tsx`, which mounts the sidebar)
**Files:** `frontend/app/view/jarvis/chunksidebar.tsx`, `frontend/app/view/jarvis/sidebarnotes.ts`, `frontend/app/view/jarvis/sidebarnotes.test.ts`, `frontend/app/view/jarvis/effortfeed.ts`, `frontend/app/view/jarvis/effortfeed.test.ts`, `frontend/app/view/jarvis/effortdetailview.tsx`, `frontend/app/view/jarvis/briefinitiatives.tsx`, `frontend/app/view/jarvis/runsheet.tsx`, `scripts/cdp/scenarios-jira-sidebar.mjs`

Boards: ChunkSidebar and RunSheetPosted (run half).

- [ ] **Step 1: Tests.**
  - `effortFeed` carries `jirapost` on note entries.
  - `sidebarNotes` gives a jira-post note `who` = `""`, a new `heading` = `In a post to <KEY>`, `by` = `you`, and `link = { label: "View comment ↗", url }`; other notes are unchanged. `sidebarNotes` takes the key as a new trailing parameter.
- [ ] **Step 2: Implement.**
  - **Sidebar:** `ChunkSidebar` gains a `ticket: { key: string; url: string | null } | null` prop, passed from `briefinitiatives.tsx` (from the effort detail and `jira:site`). The breadcrumb ends with the key as a link (`BUILD / DONE / PAY-318 ↗`), and jira-post note cards draw their heading and comment link per the board.
  - **Activity view:** `NotesFeed` in `effortdetailview.tsx` draws a `View comment ↗` link to the note's `jirapost` URL on a jira-post note, so the initiative-level `Posted progress to <KEY>. Moved <From> to <To>.` note carries the comment link and the move (spec: the post is recorded in the initiative's activity feed).
  - **Run sheet:** the initiative line in `runsheet.tsx` (the only place it is drawn) leads with the ticket from `briefEffortIndexAtom` (`↳ PAY-318 · <initiative> · <stage> · <chunk>`), still opening the chunk, and has no Post to Jira anywhere.
- [ ] **Step 3: Scenario `jira-sidebar`.** `seedTicketedInitiative(PAY-318)`; chunk 1 done; post once through `jirapost` RPC against the fake.
  1. Open chunk 1's sidebar and assert the crumb ends `PAY-318 ↗` linking to the ticket, plus the note `In a post to PAY-318 · you · <time>` with `View comment ↗` to the comment URL. Shot (ChunkSidebar).
  2. Use `arrangeFixtureRun` (see `docs/reference/cdp-run-fixtures.md`) for a run with `effortref` to PAY-318's chunk 1, open its sheet, and assert the line starts `↳ PAY-318 ·` and that no `post to Jira` text appears in the sheet. Shot (RunSheetPosted, run half). Teardown removes the run.
  3. Open the initiative's activity view and assert the `Posted progress to PAY-318.` note with `View comment ↗` linking to the comment URL. Shot.

### Task 11: The Ticket field looked up in initiative details
**Depends on:** Task 1 (uses `JiraShowCommand`, `normalizeKey`, `parseJiraError`, `openJiraSettings`)
**Files:** `frontend/app/view/jarvis/jiralookup.ts`, `frontend/app/view/jarvis/jiralookup.test.ts`, `frontend/app/view/jarvis/effortcreateform.tsx`, `scripts/cdp/scenarios-jira-details.mjs`

Board: EditInitiative. Motion moment 6.

```ts
export type LookupState = { kind: "idle" } | { kind: "looking"; key: string } | { kind: "found"; key: string; summary: string; type: string; status: string }
  | { kind: "notfound"; key: string } | { kind: "off" } | { kind: "error"; message: string };
export function shouldLookUp(prevKey: string, raw: string): string | null;   // normalized key when it changed and is key-shaped, else null
export function lookupLine(s: LookupState): { text: string; tone: "muted" | "error" | "faint" | "ok"; fieldError: boolean; connect: boolean } | null;
export function fromLookupError(key: string, err: unknown): LookupState;     // 404 -> notfound, off -> off, else error
```

- [ ] **Step 1: Tests:**
  - `shouldLookUp("", " pay-318 ")` is `"PAY-318"`; the same key again is null; `"pay"` is null;
  - each `lookupLine` gives the board's exact text: `Looking up PAY-318 in Jira…`, `Jira has no PAY-381, or your account can't see it. Saving keeps it as text.` (fieldError), `Saved as text; Arc can't check it until Jira is connected.` (connect);
  - for found, `lookupLine` returns null, since its own row renders the check, the summary and `type · status`;
  - `fromLookupError` maps a 404 and an off error.
- [ ] **Step 2: Implement.** On the Ticket field's blur in `effortcreateform.tsx`, call `JiraShowCommand{key, via:"lookup"}` (one call per changed key; the field keeps what you typed, normalized). The line under the fields fades in with `microFade` (motion moment 6). Connect Jira → `openJiraSettings()`. Saving never waits on or depends on the lookup.
- [ ] **Step 3: Scenario `jira-details`.** Fake connected; open New initiative.
  1. With `holdRpc(JiraShowCommand)`, type `pay-318` and blur: assert `Looking up PAY-318 in Jira…` with an opacity frame between 0 and 1. Shot (Looking up).
  2. Release: assert the found line with the summary and `Story · To Do`. Shot (found).
  3. Type `PAY-381`, blur: the not-found text and the field's error border. Shot.
  4. `disconnectJira`, type `PAY-318` again on a fresh form: the not-connected text, and Connect Jira lands on Settings > Jira. Shot.
  5. Edit initiative on a seeded PAY-318 initiative shows the field filled and a lookup on blur only after a change.

### Task 12: Records use the initiative's ticket
**Depends on:** Task 1 (the run's Check vets `./pkg/jira/...`, which Task 1 creates)
**Files:** `pkg/jarviscapture/capture.go`, `pkg/jarviscapture/capture_test.go`

- [ ] **Step 1: Tests.**
  - `TestCaptureUsesInitiativeTicket`: a run with `EffortRef` to an effort with ticket `PAY-318` and goal `fix OPS-77 too` gets the dossier ticket `PAY-318`.
  - `TestCaptureFallsBackToGoal`: no `EffortRef`, or an effort with no ticket, so `OPS-77`.
  - `TestCaptureMissingEffortFallsBack`: an unknown effort oid falls back to the goal, and the miss is logged rather than failing the capture.
  
  Use `effortstore.UseRootForTest`.
- [ ] **Step 2: Implement** `runTicket(ctx, run) string`, which tries `effortstore.Get(ctx, run.EffortRef.EffortOID)` and then `extractTicket(run.Goal)`, and use it in `captureRunDossier`.
- [ ] **Step 3:** `go test ./pkg/jarviscapture -run 'TestCapture'` passes.
