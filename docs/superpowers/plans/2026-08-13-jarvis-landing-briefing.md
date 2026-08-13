# Jarvis Landing Briefing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Jarvis a permanent, pinned `◈ Briefing` subject that presents deterministic work state (active runs/agents, since-last-visit delta, 7-day shipped evidence, one stateless all-work ask) as the once-per-launch first view.

**Architecture:** Two backend corrections to the shipped Axis-1 ledger (`pkg/jarvisstate`): windowed derivations and complete-per-leg source health, plus one additive wire field (run worker orefs). The frontend adds a pure projection (`briefingmodel.ts`), a load/cursor store (`briefingstore.ts`), a pinned row + once-per-launch landing guard (Subjects column), a Tailwind-only Stage body (`briefingview.tsx`), and a briefing composer face. No new backend object, no SQL migration, no polling.

**Tech Stack:** Go (wshrpc, wstore, wavevault), React 19 + jotai + Tailwind 4 (existing `@theme` tokens), vitest, generated TS via `task generate`, CDP scenario harness (`scripts/cdp/scenarios.mjs`).

## Global Constraints

- The repo working tree is dirty with unrelated changes (`docs/deferred.md`, `pkg/memvault/projection.go`, `pkg/memvault/projection_test.go`, `pkg/wshrpc/wshserver/wshserver_ask_test.go`). Never `git add -A`; every commit lists explicit paths and never touches those files.
- Per repo AGENTS.md: no commits without explicit approval; batch into one commit at the end of the plan (plan doc folds into the feature commit). Task steps therefore end at the test run, not a commit.
- Never hand-edit generated files (`frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, `pkg/wshrpc/wshclient/wshclient.go`). Edit Go wire types, then run `task generate`.
- Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json` (plain `npx tsc` stack-overflows). Baseline is clean — any error is yours.
- `go test ./pkg/...` needs the CGO include: run from PowerShell with `CGO_CFLAGS=-I<repo>/pkg/jarvisembed/csrc`, or scope to the packages listed per task (`./pkg/jarvisstate/... ./pkg/wshrpc/wshserver/...`).
- Styling: Tailwind utilities + existing `@theme` tokens only. No SCSS, no raw hex, no new motion beyond what exists.
- No arbitrary row caps. No `kind:"session"` rows anywhere in Briefing (Active or Since-last-visit) — the scanner is not a liveness source.
- The only new durable UI state is one localStorage timestamp under `jarvis.briefing.lastseen` (browser-profile-wide, not per-Space).
- `JarvisAskCommand` from the frontend must pass `{ timeout: 180_000 }` (matches the CLI's `askRpcTimeoutMs`; the 5s default EC-TIMEs).
- Accessibility: navigable rows are semantic `<button>`s with one accessible name; non-navigable facts are non-interactive; `aria-live="polite"` on load-state and ask changes; the pinned row participates in the existing `j`/`k` list-nav contract.

## Design interpretations locked in (from the spec)

1. **First-entry semantics:** "neutral" means nothing explicit is pending (no `pendingRunFocus`, no `pendingRunDraft`, no already-selected subject). The once-per-launch guard intercepts the FIRST Jarvis entry of a frontend load and selects Briefing even when a persisted subject exists — the persisted subject continues to be remembered (never overwritten by Briefing) and remains the target of explicit re-selection. This makes "work state the predictable first Jarvis view once per Wave launch" (Goal 1) hold for returning users too.
2. **Worker suppression identity:** `RunPhase.WorkerOrefs` values are `tab:<tabId>` orefs (stamped by `EnsureWorkers`); `AgentVM.id` is the tabId. Suppression matches `tab:<AgentVM.id>` exactly; no fallback dedup by title.
3. **Attention delta dedup:** a delta `attention` event matches a current attention item by exact `(WaitingSince === ev.Ts && Source === ev.Title && Action+": "+Text === ev.Detail)` — the two come from the same `GatherAttention` response, so this is exact, not fuzzy.
4. **Shipped `New` promotion:** a delta `run-done` event (NavTarget `run:<oid>`) is removed from Since-last-visit and marks the matching 7-day Shipped row `New`. A run-done older than the 7-day window stays in the delta (when the cursor is old enough to include it) — promotion never hides an older unseen completion.

---

## File Structure

**Backend (Go):**
- `pkg/wshrpc/wshrpctypes_jarvis.go` — add `WorkerORefs []string` to `ActiveWorkItem` (wire, additive).
- `pkg/jarvisstate/jarvisstate.go` — `ActiveWork` projects sorted/deduped worker orefs per run row.
- `pkg/jarvisstate/fetch.go` — windowed `Shipped`/`Timeline`/`Delta` for nonzero `SinceMs`; complete-per-leg source health; test seams.
- `pkg/jarvisstate/jarvisstate_test.go` — worker-oref tests (Task 1).
- `pkg/jarvisstate/maintest_test.go` (new) — temp-dir wstore TestMain (mirrors `pkg/wstore/wstore_maintest_test.go`).
- `pkg/jarvisstate/fetch_test.go` (new) — windowing + health tests over real wstore + seams.

**Frontend pure logic:**
- `frontend/app/view/jarvis/briefingmodel.ts` (new) — pure projection: WorkState + AgentVM[] → render-ready rows. Exports `SEVEN_DAYS_MS`, `projectBriefing`, `normalizeBriefingNav`, row types.
- `frontend/app/view/jarvis/briefingmodel.test.ts` (new) — projection behavior.
- `frontend/app/view/jarvis/briefingstore.ts` (new) — cursor, load generations, snapshot, landing guard, inline ask.
- `frontend/app/view/jarvis/briefingstore.test.ts` (new) — cursor + request lifecycle.
- `frontend/app/view/jarvis/briefingfixtures.ts` (new, DEV-only content) — CDP fixture WorkStates + roster + ask fixture.
- `frontend/app/view/jarvis/subjects.ts` — `briefing` kind + `◈` mark + `BRIEFING_SUBJECT` identity.
- `frontend/app/view/jarvis/subjectrestore.ts` — briefing never restores (defensive clear).
- `frontend/app/view/jarvis/jarvissubjectstore.ts` — `selectSubject` briefing branch (no persist).
- `frontend/app/view/jarvis/stagecompose.ts` — briefing table row + `showGraph` field.

**Frontend components:**
- `frontend/app/view/jarvis/subjectscolumn.tsx` — pinned row, keyboard order, once-per-launch landing, click-to-refresh.
- `frontend/app/view/jarvis/briefingview.tsx` (new) — Tailwind-only Stage body.
- `frontend/app/view/jarvis/stage.tsx` — briefing thread branch, band skip, header props.
- `frontend/app/view/jarvis/stageheader.tsx` — graph gating, snapshot time + Refresh.
- `frontend/app/view/jarvis/stagecomposer.tsx` + `frontend/app/view/jarvis/composertarget.ts` — all-work ask face.
- `frontend/app/view/jarvis/stagerail.tsx` — bounded zero-state copy.
- `frontend/app/view/jarvis/jarvisfixturebar.tsx` — briefing fixture row (DEV-only).

**Verification:**
- `scripts/cdp/scenarios.mjs` — `jarvis-briefing` scenario.

---

### Task 1: Backend wire — run worker orefs on ActiveWorkItem

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_jarvis.go` (ActiveWorkItem)
- Modify: `pkg/jarvisstate/jarvisstate.go`
- Test: `pkg/jarvisstate/jarvisstate_test.go`

**Interfaces:**
- Produces: `wshrpc.ActiveWorkItem.WorkerORefs []string` (json `workerorefs,omitempty`) — the sorted, deduplicated union of that run's `Phases[].WorkerOrefs`; absent (nil) when the run has no phases. Later consumed by `briefingmodel.ts` for exact Run-vs-Direct-agent suppression.

- [ ] **Step 1: Write the failing tests**

Append to `pkg/jarvisstate/jarvisstate_test.go`:

```go
func TestActiveWorkRunWorkerOrefsSortedDeduped(t *testing.T) {
	r := trun("r1", "executing", 100, 0, nil)
	r.Phases = []waveobj.RunPhase{
		{Kind: "plan", WorkerOrefs: []string{"tab:b", "tab:a"}},
		{Kind: "execute", WorkerOrefs: []string{"tab:a"}},
	}
	items := ActiveWork([]*waveobj.Run{r}, nil, nil, nil)
	if len(items) != 1 {
		t.Fatalf("items=%+v want the one run", items)
	}
	got := items[0].WorkerORefs
	if len(got) != 2 || got[0] != "tab:a" || got[1] != "tab:b" {
		t.Fatalf("workerorefs=%v want [tab:a tab:b] sorted + deduped", got)
	}
}

func TestActiveWorkRunWithoutPhasesHasNoWorkerOrefs(t *testing.T) {
	items := ActiveWork([]*waveobj.Run{trun("r1", "executing", 100, 0, nil)}, nil, nil, nil)
	if items[0].WorkerORefs != nil {
		t.Fatalf("workerorefs=%v want nil (omitted on the wire)", items[0].WorkerORefs)
	}
}
```

- [ ] **Step 2: Run to verify they fail**

```bash
go test ./pkg/jarvisstate/ -run TestActiveWorkRunWorkerOrefs -v
```
Expected: FAIL — `WorkerORefs` does not exist on `wshrpc.ActiveWorkItem`.

- [ ] **Step 3: Add the wire field**

In `pkg/wshrpc/wshrpctypes_jarvis.go`, extend `ActiveWorkItem`:

```go
type ActiveWorkItem struct {
	Project     string   `json:"project"`
	Kind        string   `json:"kind"` // "run" | "session" | "attention" | "blocker"
	Title       string   `json:"title"`
	Detail      string   `json:"detail,omitempty"`
	Ts          int64    `json:"ts"`
	NavTarget   string   `json:"navtarget,omitempty"` // "run:<oid>" | "vault:<id>"
	WorkerORefs []string `json:"workerorefs,omitempty"` // run rows only: sorted deduped phase worker orefs ("tab:<id>")
}
```

- [ ] **Step 4: Project the orefs in ActiveWork**

In `pkg/jarvisstate/jarvisstate.go`, add a helper and use it in the run loop:

```go
// workerORefsFor returns the sorted, deduplicated union of a run's phase worker orefs. Runs carry no
// identity for their workers elsewhere on the wire; this is what lets the frontend suppress a live
// agent already represented by its Run.
func workerORefsFor(r *waveobj.Run) []string {
	seen := make(map[string]bool)
	var out []string
	for _, p := range r.Phases {
		for _, oref := range p.WorkerOrefs {
			if oref != "" && !seen[oref] {
				seen[oref] = true
				out = append(out, oref)
			}
		}
	}
	sort.Strings(out)
	return out
}
```

In `ActiveWork`'s run loop, add the field:

```go
	out = append(out, wshrpc.ActiveWorkItem{
		Project: r.ProjectPath, Kind: "run", Title: r.Goal,
		Detail: "status: " + r.Status, Ts: r.CreatedTs, NavTarget: "run:" + r.OID,
		WorkerORefs: workerORefsFor(r),
	})
```

`sort` is already imported in this file.

- [ ] **Step 5: Run the package tests**

```bash
go test ./pkg/jarvisstate/
```
Expected: PASS (both new tests + existing).

- [ ] **Step 6: Regenerate the wire clients**

```bash
task generate
```
Then confirm `frontend/types/gotypes.d.ts` `ActiveWorkItem` gained `workerorefs?: string[]` and the typecheck stays clean:

```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
```
Expected: exit 0. Also run `go vet ./pkg/jarvisstate/` (exit 0).

---

### Task 2: FetchWorkState — windowed derivations, complete source health, test seams

**Files:**
- Modify: `pkg/jarvisstate/fetch.go`
- Create: `pkg/jarvisstate/maintest_test.go`
- Create: `pkg/jarvisstate/fetch_test.go`

**Interfaces:**
- Produces: `SetFetchSeamsForTest(s fetchSeams) func()` — package-level seam setter (pattern: `jarvisrecall.SetOpenVaultForTest`); returns a restore func.
- Consumes (from Task 1): unchanged `ActiveWork`/`Shipped`/`Timeline`/`Delta`.
- Behavior contract: nonzero `SinceMs` windows Shipped, Timeline, and Delta; `0` stays unbounded (existing callers: `JarvisStatusCommand` untouched, `JarvisAskCommand`'s status/history routes pass 0, delta routes pass their own window). Health: any `GetChannelRuns` failure keeps partial runs but marks `Sources.Runs = false`; any dossier/decision load failure keeps other vault data but marks `Sources.Dossiers = false`; `GatherAttention` failure sets `Sources.Attention = "error"` (success stays `"volatile"`); session scan failure stays `Sources.Sessions = false`.

- [ ] **Step 1: Write the failing tests**

Create `pkg/jarvisstate/maintest_test.go` (mirrors `pkg/wstore/wstore_maintest_test.go`):

```go
package jarvisstate

import (
	"os"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// TestMain points the wave data dir at a throwaway temp dir and initializes the wstore SQLite DB so
// fetch tests can exercise FetchWorkState against a real, empty store.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "jarvisstate-test-*")
	if err != nil {
		panic(err)
	}
	wavebase.DataHome_VarCache = dir
	if err := wavebase.EnsureWaveDBDir(); err != nil {
		panic(err)
	}
	if err := wstore.InitWStore(); err != nil {
		panic(err)
	}
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}
```

Create `pkg/jarvisstate/fetch_test.go`. The windowing test uses the real store (channel + two sealed runs); the failure tests use the seams. Vault-backed tests seed a real vault at a temp dir (`wavevault.OpenVaultAtForTest`) with `jarvisdossier.CreateDossier`/`AppendDecision` and seam `openVault` to return it.

```go
package jarvisstate

import (
	"context"
	"errors"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/agentsessions"
	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// seedStore writes one channel with two done+sealed runs and one in-flight run.
func seedStore(t *testing.T, ctx context.Context) {
	t.Helper()
	ch, err := wstore.CreateChannel(ctx, "rpc", "/p/one")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	seedRun := func(id string, status string, created, completed int64) {
		t.Helper()
		if err := wstore.AppendRun(ctx, ch.OID, waveobj.Run{OID: id, ID: id, Goal: "goal-" + id, Status: status, ProjectPath: "/p/one", CreatedTs: created}); err != nil {
			t.Fatalf("append run %s: %v", id, err)
		}
		if status == "done" {
			if err := wstore.UpdateRun(ctx, ch.OID, id, func(r *waveobj.Run) error {
				r.CompletedTs = completed
				r.Evidence = &waveobj.RunEvidence{Summary: "shipped " + id}
				return nil
			}); err != nil {
				t.Fatalf("seal run %s: %v", id, err)
			}
		}
	}
	seedRun("r-old", "done", 100, 500)
	seedRun("r-new", "done", 100, 900)
	seedRun("r-live", "executing", 300, 0)
}

func TestFetchWorkStateWindowsShippedTimelineAndDelta(t *testing.T) {
	ctx := context.Background()
	seedStore(t, ctx)
	st, err := FetchWorkState(ctx, "", 600)
	if err != nil {
		t.Fatalf("FetchWorkState: %v", err)
	}
	var shipped, events, delta int
	for _, p := range st.Projects {
		shipped += len(p.Shipped)
		events += len(p.Events)
		delta += len(p.Delta)
	}
	// window 600: r-old (created 100, done 500) and r-live (created 300) fall outside; r-new's
	// run-done at 900 is the only event inside. Delta adds nothing beyond Timeline (no attention).
	if shipped != 1 || events != 1 || delta != 1 {
		t.Fatalf("windowed: shipped=%d events=%d delta=%d want 1/1/1", shipped, events, delta)
	}
	// unbounded stays unbounded for existing callers.
	all, err := FetchWorkState(ctx, "", 0)
	if err != nil {
		t.Fatalf("FetchWorkState: %v", err)
	}
	var shippedAll int
	for _, p := range all.Projects {
		shippedAll += len(p.Shipped)
	}
	if shippedAll != 2 {
		t.Fatalf("shipped=%d want both sealed runs unbounded", shippedAll)
	}
}
```

Wait — check the math in that test: with window 600: Timeline includes r-old created 100? No — 100 < 600 excluded; r-old done 500 < 600 excluded; r-new created 100 excluded; r-new done 900 kept; r-live created 300 excluded. So events = 1, delta = 1. Fix the assertions accordingly: `events != 1`, and remove the stale comment. The remaining tests:

```go
func TestFetchWorkStateMarksRunsUnhealthyOnChannelReadFailure(t *testing.T) {
	ctx := context.Background()
	seedStore(t, ctx)
	if _, err := wstore.CreateChannel(ctx, "rpc2", "/p/two"); err != nil {
		t.Fatalf("create second channel: %v", err)
	}
	reads := 0
	restore := SetFetchSeamsForTest(fetchSeams{
		getChannels:    func(ctx context.Context) ([]*waveobj.Channel, error) { return wstore.GetChannels(ctx) },
		getChannelRuns: func(ctx context.Context, id string) ([]*waveobj.Run, error) {
			reads++
			if reads > 1 {
				return nil, errors.New("simulated channel read failure")
			}
			return wstore.GetChannelRuns(ctx, id)
		},
		scanSessions:    agentsessions.ScanSessions,
		gatherAttention: func(ctx context.Context) ([]wshrpc.AttentionItem, error) { return nil, nil },
		openVault:       func(ctx context.Context) (*wavevault.Vault, error) { return nil, errors.New("no vault") },
		loadDossier:     jarvisdossier.LoadDossier,
		loadDecision:    jarvisdossier.LoadDecision,
	})
	defer restore()
	st, err := FetchWorkState(ctx, "", 0)
	if err != nil {
		t.Fatalf("FetchWorkState: %v", err)
	}
	if st.Sources.Runs {
		t.Fatalf("sources=%+v want Runs unhealthy", st.Sources)
	}
	// the first channel's sealed run must survive the second channel's failure.
	var shippedFound bool
	for _, p := range st.Projects {
		for _, s := range p.Shipped {
			if s.RunOID == "r-new" {
				shippedFound = true
			}
		}
	}
	if !shippedFound {
		t.Fatalf("state=%+v want partial run data kept despite the failed channel read", st)
	}
}
```

The failure must come from a second channel (one channel alone reads clean): seed two channels and fail the second `getChannelRuns` call deterministically by read count.

```go
func TestFetchWorkStateMarksDossiersUnhealthyOnDossierLoadFailure(t *testing.T) {
	ctx := context.Background()
	v, err := wavevault.OpenVaultAtForTest(ctx, t.TempDir())
	if err != nil {
		t.Fatalf("open vault: %v", err)
	}
	if _, _, err := jarvisdossier.CreateDossier(v, jarvisdossier.DossierFacts{Objective: "good record", Status: "active"}); err != nil {
		t.Fatalf("create dossier: %v", err)
	}
	if _, err := jarvisdossier.AppendDecision(v, jarvisdossier.DecisionFacts{Summary: "chose sqlite"}); err != nil {
		t.Fatalf("append decision: %v", err)
	}
	restore := SetFetchSeamsForTest(fetchSeams{
		getChannels:     func(ctx context.Context) ([]*waveobj.Channel, error) { return nil, nil },
		getChannelRuns:  func(ctx context.Context, id string) ([]*waveobj.Run, error) { return nil, nil },
		scanSessions:    func(days, limit int) ([]agentsessions.SessionInfo, error) { return nil, nil },
		gatherAttention: func(ctx context.Context) ([]wshrpc.AttentionItem, error) { return nil, nil },
		openVault:       func(ctx context.Context) (*wavevault.Vault, error) { return v, nil },
		loadDossier: func(r *wavevault.Retriever, id string) (*jarvisdossier.Dossier, error) {
			d, err := jarvisdossier.LoadDossier(r, id)
			if d != nil && d.Objective == "good record" {
				return nil, errors.New("simulated dossier load failure")
			}
			return d, err
		},
		loadDecision: jarvisdossier.LoadDecision,
	})
	defer restore()
	st, err := FetchWorkState(ctx, "", 0)
	if err != nil {
		t.Fatalf("FetchWorkState: %v", err)
	}
	if st.Sources.Dossiers {
		t.Fatalf("sources=%+v want Dossiers unhealthy", st.Sources)
	}
	var blockerFound bool
	for _, p := range st.Projects {
		for _, a := range p.Active {
			if a.Kind == "blocker" {
				blockerFound = true
			}
		}
	}
	if !blockerFound {
		t.Fatalf("state=%+v want the healthy dossier's blocker kept despite the failed load", st)
	}
}

func TestFetchWorkStateAttentionErrorAndVolatile(t *testing.T) {
	ctx := context.Background()
	restoreErr := SetFetchSeamsForTest(fetchSeams{
		getChannels:     func(ctx context.Context) ([]*waveobj.Channel, error) { return nil, nil },
		getChannelRuns:  func(ctx context.Context, id string) ([]*waveobj.Run, error) { return nil, nil },
		scanSessions:    func(days, limit int) ([]agentsessions.SessionInfo, error) { return nil, nil },
		gatherAttention: func(ctx context.Context) ([]wshrpc.AttentionItem, error) { return nil, errors.New("attention broke") },
		openVault:       func(ctx context.Context) (*wavevault.Vault, error) { return nil, errors.New("no vault") },
		loadDossier:     jarvisdossier.LoadDossier,
		loadDecision:    jarvisdossier.LoadDecision,
	})
	st, err := FetchWorkState(ctx, "", 0)
	restoreErr()
	if err != nil {
		t.Fatalf("FetchWorkState: %v", err)
	}
	if st.Sources.Attention != "error" {
		t.Fatalf("attention=%q want error after GatherAttention failure", st.Sources.Attention)
	}
	restoreOK := SetFetchSeamsForTest(fetchSeams{
		getChannels:     func(ctx context.Context) ([]*waveobj.Channel, error) { return nil, nil },
		getChannelRuns:  func(ctx context.Context, id string) ([]*waveobj.Run, error) { return nil, nil },
		scanSessions:    func(days, limit int) ([]agentsessions.SessionInfo, error) { return nil, nil },
		gatherAttention: func(ctx context.Context) ([]wshrpc.AttentionItem, error) { return nil, nil },
		openVault:       func(ctx context.Context) (*wavevault.Vault, error) { return nil, errors.New("no vault") },
		loadDossier:     jarvisdossier.LoadDossier,
		loadDecision:    jarvisdossier.LoadDecision,
	})
	defer restoreOK()
	st, err = FetchWorkState(ctx, "", 0)
	if err != nil {
		t.Fatalf("FetchWorkState: %v", err)
	}
	if st.Sources.Attention != "volatile" {
		t.Fatalf("attention=%q want volatile on a successful (empty) read", st.Sources.Attention)
	}
}
```

Check the seam closures against the helper names in Step 4 before running — `fetchSeams` field names must match exactly.

- [ ] **Step 2: Run to verify they fail**

```bash
go test ./pkg/jarvisstate/ -run 'TestFetchWorkState' -v
```
Expected: FAIL — the tests do not compile (`fetchSeams`, `SetFetchSeamsForTest` undefined) and `TestFetchWorkStateWindowsShippedTimelineAndDelta` would fail on today's unbounded behavior.

- [ ] **Step 3: Add the seams to fetch.go**

```go
// fetchSeams names every leg reader FetchWorkState uses, so tests can point individual legs at
// boundary failures without a broken database or vault (same discipline as jarvisrecall.SetOpenVaultForTest).
type fetchSeams struct {
	getChannels     func(ctx context.Context) ([]*waveobj.Channel, error)
	getChannelRuns  func(ctx context.Context, channelId string) ([]*waveobj.Run, error)
	scanSessions    func(days, limit int) ([]agentsessions.SessionInfo, error)
	gatherAttention func(ctx context.Context) ([]wshrpc.AttentionItem, error)
	openVault       func(ctx context.Context) (*wavevault.Vault, error)
	loadDossier     func(r *wavevault.Retriever, id string) (*jarvisdossier.Dossier, error)
	loadDecision    func(r *wavevault.Retriever, id string) (*jarvisdossier.Decision, error)
}

var defaultSeams = fetchSeams{
	getChannels:     wstore.GetChannels,
	getChannelRuns:  wstore.GetChannelRuns,
	scanSessions:    agentsessions.ScanSessions,
	gatherAttention: jarvis.GatherAttention,
	openVault:       wavevault.OpenVault,
	loadDossier:     jarvisdossier.LoadDossier,
	loadDecision:    jarvisdossier.LoadDecision,
}

// SetFetchSeamsForTest replaces every leg reader; returns a restore func the caller defers.
func SetFetchSeamsForTest(s fetchSeams) func() {
	old := defaultSeams
	defaultSeams = s
	return func() { defaultSeams = old }
}
```

- [ ] **Step 4: Rewrite FetchWorkState**

Replace the body of `FetchWorkState` with the seam-routed, health-complete version. The vault leg becomes:

```go
	var runs []*waveobj.Run
	runsHealthy := true
	chans, err := defaultSeams.getChannels(ctx)
	if err != nil {
		runsHealthy = false
	} else {
		for _, ch := range chans {
			cr, cerr := defaultSeams.getChannelRuns(ctx, ch.OID)
			if cerr != nil {
				runsHealthy = false // one bad channel read voids completeness but keeps the rest
				continue
			}
			runs = append(runs, cr...)
		}
	}
	st.Sources.Runs = runsHealthy

	var sessions []agentsessions.SessionInfo
	if s, serr := defaultSeams.scanSessions(sessionWindowDays, sessionLimit); serr == nil {
		sessions = s
		st.Sources.Sessions = true
	}

	var attention []wshrpc.AttentionItem
	if a, aerr := defaultSeams.gatherAttention(ctx); aerr == nil {
		attention = a
	} else {
		st.Sources.Attention = "error"
	}

	var dossiers []jarvisdossier.Dossier
	var decisions []DecisionEntry
	dossiersHealthy := false
	if v, verr := defaultSeams.openVault(ctx); verr == nil {
		r := v.Retriever(wavevault.AllScope())
		if nodes, qerr := r.Query(wavevault.Filter{}); qerr == nil {
			dossiersHealthy = true
			for _, n := range nodes {
				switch n.Collection {
				case wavevault.CollTasks:
					if d, derr := defaultSeams.loadDossier(r, n.ID); derr == nil {
						dossiers = append(dossiers, *d)
					} else {
						dossiersHealthy = false // keep the healthy vault data; the leg is incomplete
					}
				case wavevault.CollDecisions:
					if d, derr := defaultSeams.loadDecision(r, n.ID); derr == nil {
						decisions = append(decisions, DecisionEntry{ID: d.ID, Summary: d.Summary, CreatedTs: d.Created})
					} else {
						dossiersHealthy = false
					}
				}
			}
		}
	}
	st.Sources.Dossiers = dossiersHealthy
```

And the derivation lines become windowed (the actual contract fix — `Shipped` and `Timeline` previously ignored `SinceMs`):

```go
	active := ActiveWork(runs, sessions, attention, dossiers)
	shipped := Shipped(runs, sinceMs)
	timeline := Timeline(runs, sessions, decisions, dossiers, sinceMs)
	delta := Delta(sinceMs, runs, sessions, decisions, attention, dossiers)
```

The per-project assembly below stays byte-for-byte unchanged.

- [ ] **Step 5: Run the package tests**

```bash
go test ./pkg/jarvisstate/ -v
```
Expected: PASS. Then the existing handler tests (windowed changes must not disturb the shipped ask):

```bash
go test ./pkg/wshrpc/wshserver/ -run 'TestJarvisState|TestJarvisAsk' -v
```
Expected: PASS (`TestJarvisStateCommandReturnsFixtureRun` passes `SinceMs=0`, which stays unbounded; `TestJarvisAskCommandAttachesLedgerFacts` uses the status route, window 0).

---

### Task 3: Briefing subject identity — kind, mark, do-not-persist selection

**Files:**
- Modify: `frontend/app/view/jarvis/subjects.ts`
- Modify: `frontend/app/view/jarvis/subjectrestore.ts`
- Modify: `frontend/app/view/jarvis/jarvissubjectstore.ts`
- Test: `frontend/app/view/jarvis/jarvissubjectstore.test.ts`

**Interfaces:**
- Produces: `BRIEFING_SUBJECT` (`{ kind: "briefing", id: "all" } as const`) and `SubjectKind` including `"briefing"` with mark `"◈"`. `selectSubject({ kind: "briefing", id: "all" })` becomes valid everywhere and never writes `persistedSubjectAtom`.
- Consumed by: Tasks 4–9 (all briefing code paths).

- [ ] **Step 1: Extend subjects.ts**

```ts
export type SubjectKind = "channel" | "dossier" | "conversation" | "briefing";
export type SubjectMark = "#" | "▤" | "~" | "◈";

// the pinned all-work subject: a real SubjectKind for selection and Stage composition, never a
// persisted content subject.
export const BRIEFING_SUBJECT = { kind: "briefing", id: "all" } as const;

const MARKS: Record<SubjectKind, SubjectMark> = {
    channel: "#",
    dossier: "▤",
    conversation: "~",
    briefing: "◈",
};
```

- [ ] **Step 2: Make restore briefing-safe**

In `subjectrestore.ts`, treat a stored briefing as absent (it is never persisted, but a defensive read costs one line and a forever-"wait" would strand the boot):

```ts
export function restoreDecision(stored: StoredSubject | null, lists: SubjectListState): RestoreAction {
    // briefing is never a stored subject; treat it as absent rather than waiting on a list that
    // will never load.
    if (stored == null || stored.kind === "briefing") {
        return { action: "clear" };
    }
    ...
```

- [ ] **Step 3: Briefing-safe selectSubject**

In `jarvissubjectstore.ts`, change `selectSubject` so the persisted-subject write and the per-kind dispatch both skip briefing:

```ts
    globalStore.set(activeSubjectAtom, subject);
    // Briefing is a synthetic subject: selecting it must not overwrite the last meaningful subject,
    // which is what the next launch restores.
    if (subject.kind !== "briefing") {
        globalStore.set(persistedSubjectAtom, subject);
    }
    if (subject.kind === "channel") {
        fireAndForget(() => selectChannel(subject.id));
        return;
    }
    globalStore.set(profileRailOpenAtom, false);
    if (subject.kind === "briefing") {
        return;
    }
    if (subject.kind === "dossier") {
```

- [ ] **Step 4: Add the failing tests**

Append to `frontend/app/view/jarvis/jarvissubjectstore.test.ts`:

```ts
    it("does not persist the briefing subject", () => {
        selectSubject({ kind: "briefing", id: "all" });
        expect(globalStore.get(activeSubjectAtom)).toEqual({ kind: "briefing", id: "all" });
        expect(globalStore.get(persistedSubjectAtom)).toBeNull();
    });

    it("persists an ordinary subject selected after briefing", () => {
        selectSubject({ kind: "briefing", id: "all" });
        selectSubject({ kind: "conversation", id: "c-after-briefing" });
        expect(globalStore.get(persistedSubjectAtom)).toEqual({ kind: "conversation", id: "c-after-briefing" });
    });
```

- [ ] **Step 5: Run the tests and typecheck**

```bash
npx vitest run frontend/app/view/jarvis/jarvissubjectstore.test.ts
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
```
Expected: PASS, exit 0.

---

### Task 4: briefingmodel.ts — the pure projection

**Files:**
- Create: `frontend/app/view/jarvis/briefingmodel.ts`
- Create: `frontend/app/view/jarvis/briefingmodel.test.ts`

**Interfaces:**
- Produces (consumed by briefingview.tsx Task 7, briefingstore.ts Task 5):

```ts
export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface BriefingModelInput {
    state: WorkState;          // the all-work response (project:"" )
    agents: AgentVM[];         // model.agentsAtom — merged roster incl. pending-launch overlays
    actualCursor: number;      // validated cursor, else sevenDaysAgo
    queryStartedAt: number;    // also the "now" for agent elapsed times
    sevenDaysAgo: number;
}

export interface RunRow { oref: string; goal: string; project: string; status: string; workerOrefs: string[]; ts: number; }
export interface BlockerRow { oref: string; objective: string; blockers: string; project: string | null; ts: number; }
export interface AgentRow { oref: string; id: string; name: string; task: string; runtime: string; project: string | null; state: "working" | "asking"; startedTs: number; }
export interface DeltaRow { key: string; ts: number; kind: string; title: string; wording: string; detail: string | null; oref: string | null; }
export interface ShippedRow { oref: string; goal: string; project: string; summary: string; completedTs: number; fresh: boolean; }
export interface AttentionSummary { count: number; }
export interface SourceHealthSummary { complete: boolean; missingLegs: string[]; attentionState: string; }

export interface BriefingModel {
    attention: AttentionSummary | null;
    activeRuns: RunRow[];
    blockers: BlockerRow[];
    directAgents: AgentRow[];
    delta: DeltaRow[];
    shipped: ShippedRow[];
    health: SourceHealthSummary;
    counts: { runs: number; agents: number; delta: number; shipped: number };
}

export function projectBriefing(input: BriefingModelInput): BriefingModel;
export function normalizeBriefingNav(oref: string | undefined | null): string | null;
```

- [ ] **Step 1: Write the failing tests**

Create `frontend/app/view/jarvis/briefingmodel.test.ts`. Fixture helpers first (module-local; the repo's pure-seam style):

```ts
import { describe, expect, it } from "vitest";
import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { projectBriefing, normalizeBriefingNav, SEVEN_DAYS_MS, type BriefingModelInput } from "./briefingmodel";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = 1_800_000_000_000;

const agent = (over: Partial<AgentVM>): AgentVM => ({
    id: "tab-1",
    name: "loom",
    task: "ship the briefing",
    state: "working",
    agent: "claude",
    project: "waveterm",
    activeMs: 5 * 60_000,
    ...over,
});

const workState = (projects: ProjectWork[]): WorkState => ({ projects, sources: { runs: true, sessions: true, dossiers: true, attention: "volatile" } });

const runItem = (over: Partial<ActiveWorkItem>): ActiveWorkItem => ({
    project: "/p/one",
    kind: "run",
    title: "ship ledger",
    detail: "status: executing",
    ts: T0 - DAY,
    navtarget: "run:r-1",
    ...over,
});
```

Tests (each its own `it`, per the spec's §15.2 list):

```ts
const input = (state: WorkState, agents: AgentVM[] = [], cursor = T0 - DAY): BriefingModelInput => ({
    state,
    agents,
    actualCursor: cursor,
    queryStartedAt: T0,
    sevenDaysAgo: T0 - 7 * DAY,
});

describe("briefing projection", () => {
    it("suppresses a live agent already represented by an active run, exactly by tab oref", () => {
        const state = workState([
            {
                project: "waveterm",
                active: [
                    runItem({ workerorefs: ["tab:a", "tab:b"] }),
                    runItem({ title: "other run", detail: "status: blocked", ts: T0 - 2 * DAY, navtarget: "run:r-2" }),
                ],
                shipped: [],
                events: [],
                delta: [],
            },
        ]);
        const roster = [
            agent({ id: "tab:a", name: "run worker", state: "working" }),
            agent({ id: "tab:x", name: "direct", state: "working", project: undefined }),
            agent({ id: "tab:term", name: "shell", state: "working", kind: "terminal" }),
            agent({ id: "tab:bg", name: "bg", state: "working", kind: "background" }),
            agent({ id: "tab:idle", name: "idle", state: "idle" }),
        ];
        const m = projectBriefing(input(state, roster));
        // tab:a and tab:b are suppressed (in r-1's workerorefs); tab:x remains a direct agent; terminal,
        // background and idle rows are excluded; pending-launch overlays (kind undefined) stay.
        expect(m.directAgents.map((a) => a.id)).toEqual(["tab-x"]);
        expect(m.counts.agents).toBe(1);
        expect(m.counts.runs).toBe(2);
    });

    it("includes pending-launch overlays as direct agents", () => {
        const state = workState([]);
        const m = projectBriefing(input(state, [agent({ id: "tab-p", state: "working", kind: undefined })]));
        expect(m.directAgents.map((a) => a.id)).toEqual(["tab-p"]);
    });

    it("sorts runs blocked-first then ts-desc then oref, agents asking-first then started desc", () => {
        const state = workState([
            {
                project: "waveterm",
                active: [
                    runItem({ title: "newer executing", ts: T0 - DAY, navtarget: "run:r-b", detail: "status: executing" }),
                    runItem({ title: "blocked", ts: T0 - 3 * DAY, navtarget: "run:r-a", detail: "status: blocked" }),
                    runItem({ title: "older executing", ts: T0 - 2 * DAY, navtarget: "run:r-c", detail: "status: executing" }),
                ],
                shipped: [], events: [], delta: [],
            },
        ]);
        const m = projectBriefing(input(state, [
            agent({ id: "tab-1", name: "w1", state: "working", activeMs: 10 * 60_000 }),
            agent({ id: "tab-2", name: "a1", state: "asking", blockedMs: 60_000 }),
            agent({ id: "tab-3", name: "w2", state: "working", activeMs: 60_000 }),
        ]));
        expect(m.activeRuns.map((r) => r.oref)).toEqual(["run:r-a", "run:r-b", "run:r-c"]);
        // asking first; then startedTs desc — w1 started earlier than w2, so w2 comes first
        expect(m.directAgents.map((a) => a.id)).toEqual(["tab-2", "tab-3", "tab-1"]);
    });

    it("windows delta to actualCursor and words events honestly", () => {
        const delta: TimelineEvent[] = [
            { ts: T0 - DAY, kind: "run-created", title: "g1", detail: "status: executing", navtarget: "run:r-1" },
            { ts: T0 - 2 * DAY, kind: "run-done", title: "g2", detail: "sealed", navtarget: "run:r-2" },
            { ts: T0 - 3 * DAY, kind: "decision", title: "chose sqlite" },
            { ts: T0 - 4 * DAY, kind: "dossier", title: "ship ledger", detail: "status: active", navtarget: "vault:d-1" },
            { ts: T0 - 10 * DAY, kind: "run-created", title: "stale", detail: "", navtarget: "run:r-9" },
            { ts: T0 - 5 * DAY, kind: "session", title: "a session", detail: "pi m" },
        ];
        const m = projectBriefing(input(workState([{ project: "waveterm", active: [], shipped: [], events: delta, delta }]), [], T0 - 6 * DAY));
        const kinds = m.delta.map((d) => d.kind);
        expect(kinds).not.toContain("session"); // session rows are excluded entirely
        expect(kinds).not.toContain("run-created"); // the 10-day-old one is outside the cursor window
        expect(m.delta.map((d) => d.wording)).toEqual([
            "Run started", "Run completed", "Decision recorded", "Record updated · current status: active",
        ]);
        expect(m.delta.find((d) => d.kind === "dossier")?.oref).toBe("task:d-1"); // vault: -> task:
    });

    it("promotes in-window completions to New shipped rows and keeps older completions in delta", () => {
        const shipped: ShippedItem[] = [
            { project: "waveterm", runoid: "r-new", goal: "new work", summary: "sealed", completedts: T0 - DAY, files: [], verifs: [] },
        ];
        const delta: TimelineEvent[] = [
            { ts: T0 - DAY, kind: "run-done", title: "new work", detail: "sealed", navtarget: "run:r-new" },
            { ts: T0 - 8 * DAY, kind: "run-done", title: "old work", detail: "sealed", navtarget: "run:r-old" },
        ];
        const m = projectBriefing(input(workState([{ project: "waveterm", active: [], shipped, events: delta, delta }]), [], T0 - 9 * DAY));
        expect(m.shipped.map((s) => s.oref)).toEqual(["run:r-new"]);
        expect(m.shipped[0].fresh).toBe(true);
        expect(m.delta.map((d) => d.kind)).toEqual(["run-done"]); // only the old completion remains
        expect(m.delta[0].title).toBe("old work");
    });

    it("builds the attention banner and removes current attention items from delta", () => {
        const active: ActiveWorkItem[] = [
            { project: "/p/one", kind: "attention", title: "the ask bridge", detail: "Review: check the diff", ts: T0 - DAY, navtarget: "run:r-1" },
        ];
        const delta: TimelineEvent[] = [
            { ts: T0 - DAY, kind: "attention", title: "the ask bridge", detail: "Review: check the diff", navtarget: "run:r-1" },
        ];
        const m = projectBriefing(input(workState([{ project: "waveterm", active, shipped: [], events: delta, delta }])));
        expect(m.attention?.count).toBe(1);
        expect(m.delta).toHaveLength(0);
        expect(m.activeRuns).toHaveLength(0); // attention is banner-only, never a row
    });

    it("labels unscoped blockers and normalizes their target", () => {
        const active: ActiveWorkItem[] = [
            { kind: "blocker", title: "ship ledger", detail: "needs decision on X", ts: T0 - DAY, navtarget: "vault:d-1" },
        ];
        const m = projectBriefing(input(workState([{ project: "", active, shipped: [], events: [], delta: [] }])));
        expect(m.blockers).toHaveLength(1);
        expect(m.blockers[0].project).toBeNull(); // view renders "Unscoped record"
        expect(m.blockers[0].oref).toBe("task:d-1");
    });

    it("reports complete vs partial source health", () => {
        const complete = projectBriefing(input(workState([])));
        expect(complete.health.complete).toBe(true);
        const partial = projectBriefing(input(workState([], [])));
        const p = workState([]);
        p.sources = { runs: false, sessions: true, dossiers: true, attention: "volatile" };
        const m = projectBriefing(input(p));
        expect(m.health.complete).toBe(false);
        expect(m.health.missingLegs).toEqual(["Runs"]);
    });

    it("excludes shipped rows outside the seven-day window", () => {
        const shipped: ShippedItem[] = [
            { project: "waveterm", runoid: "r-new", goal: "new", summary: "", completedts: T0 - DAY },
            { project: "waveterm", runoid: "r-old", goal: "old", summary: "", completedts: T0 - 8 * DAY },
        ];
        const m = projectBriefing(input(workState([{ project: "waveterm", active: [], shipped, events: [], delta: [] }])));
        expect(m.shipped.map((s) => s.oref)).toEqual(["run:r-new"]);
    });

    it("normalizes only the vault alias", () => {
        expect(normalizeBriefingNav("vault:d-1")).toBe("task:d-1");
        expect(normalizeBriefingNav("run:r-1")).toBe("run:r-1");
        expect(normalizeBriefingNav(undefined)).toBeNull();
        expect(normalizeBriefingNav("")).toBeNull();
    });
});
```

Adjust fixtures to the exact ambient types (`ProjectWork`, `TimelineEvent`, `ShippedItem`, `ActiveWorkItem` are ambient globals from gotypes.d.ts — no import). Note `ShippedItem` requires `files`/`verifs` optional — include `files: []`/`verifs: []` only where tsc demands (they are optional). `runItem`'s `oref`/`status` overrides in the suppression test are typos from drafting — remove them; `ActiveWorkItem` has no such fields (fix: use `workerorefs` only).

- [ ] **Step 2: Run to verify they fail**

```bash
npx vitest run frontend/app/view/jarvis/briefingmodel.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement briefingmodel.ts**

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Briefing's pure projection: WorkState + the live agent roster -> render-ready rows. All
// ordering, exact worker suppression, window filtering, wording and navigation normalization happens
// here; React components do not reinterpret wire kinds inline.

import type { AgentVM } from "@/app/view/agents/agentsviewmodel";

export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface BriefingModelInput {
    state: WorkState;
    agents: AgentVM[];
    actualCursor: number;
    queryStartedAt: number;
    sevenDaysAgo: number;
}

export interface RunRow {
    oref: string;
    goal: string;
    project: string;
    status: string;
    workerOrefs: string[];
    ts: number;
}
export interface BlockerRow {
    oref: string;
    objective: string;
    blockers: string;
    project: string | null;
    ts: number;
}
export interface AgentRow {
    oref: string;
    id: string;
    name: string;
    task: string;
    runtime: string;
    project: string | null;
    state: "working" | "asking";
    startedTs: number;
}
export interface DeltaRow {
    key: string;
    ts: number;
    kind: string;
    title: string;
    wording: string;
    detail: string | null;
    oref: string | null;
}
export interface ShippedRow {
    oref: string;
    goal: string;
    project: string;
    summary: string;
    completedTs: number;
    fresh: boolean;
}
export interface AttentionSummary {
    count: number;
}
export interface SourceHealthSummary {
    complete: boolean;
    missingLegs: string[];
    attentionState: string;
}
export interface BriefingModel {
    attention: AttentionSummary | null;
    activeRuns: RunRow[];
    blockers: BlockerRow[];
    directAgents: AgentRow[];
    delta: DeltaRow[];
    shipped: ShippedRow[];
    health: SourceHealthSummary;
    counts: { runs: number; agents: number; delta: number; shipped: number };
}

// The ledger's dossier/blocker targets arrive as vault:<id> while the native record subject is
// task:<id>. Briefing normalizes that one alias; it does not make vault: a global alias.
export function normalizeBriefingNav(oref: string | undefined | null): string | null {
    if (oref == null || oref === "") {
        return null;
    }
    return oref.startsWith("vault:") ? "task:" + oref.slice("vault:".length) : oref;
}

// the ledger retains no dossier status-transition history; "Record updated · current status: X" is
// the honest shape of a dossier's UpdatedTs event (detail arrives as "status: X").
function dossierWording(detail: string | undefined): string {
    if (detail != null && detail.startsWith("status: ")) {
        return "Record updated · current status: " + detail.slice("status: ".length);
    }
    return "Record updated";
}

const DELTA_WORDING: Record<string, string> = {
    "run-created": "Run started",
    "run-done": "Run completed",
    decision: "Decision recorded",
    dossier: "Record updated",
};

// exact identity only: a delta attention event and the current attention item come from the same
// GatherAttention read, so the (ts, title, detail) triple is exact, never fuzzy.
function matchesAttention(ev: TimelineEvent, items: ActiveWorkItem[]): boolean {
    return items.some(
        (a) =>
            a.kind === "attention" &&
            a.Ts === ev.Ts &&
            a.Title === ev.Title &&
            a.Detail === ev.Detail
    );
}

function sortBy<T>(rows: T[], score: (r: T) => number, tsOf: (r: T) => number, idOf: (r: T) => string): T[] {
    return [...rows].sort((a, b) => {
        const s = score(a) - score(b);
        if (s !== 0) {
            return s;
        }
        const t = tsOf(b) - tsOf(a); // timestamp descending
        if (t !== 0) {
            return t;
        }
        return idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0; // stable identity
    });
}

export function projectBriefing(input: BriefingModelInput): BriefingModel {
    const { state, agents, actualCursor, queryStartedAt } = input;
    const projects = state.projects ?? [];

    const attentionItems = projects.flatMap((p) => p.active ?? []).filter((a) => a.kind === "attention");
    const attention = attentionItems.length > 0 ? { count: attentionItems.length } : null;

    // active runs + blocked records
    const runItems = projects.flatMap((p) => p.active ?? []).filter((a) => a.kind === "run");
    const activeRuns: RunRow[] = sortBy(
        runItems.map((a) => ({
            oref: a.navtarget ?? "run:",
            goal: a.Title,
            project: a.Project,
            status: a.Detail.startsWith("status: ") ? a.Detail.slice("status: ".length) : a.Detail,
            workerOrefs: a.WorkerORefs ?? [],
            ts: a.Ts,
        })),
        (r) => (r.status === "blocked" ? 0 : 1),
        (r) => r.ts,
        (r) => r.oref
    );

    const blockerItems = projects.flatMap((p) => p.active ?? []).filter((a) => a.kind === "blocker");
    const blockers: BlockerRow[] = sortBy(
        blockerItems.map((a) => ({
            oref: normalizeBriefingNav(a.navtarget) ?? "",
            objective: a.Title,
            blockers: a.Detail,
            project: a.Project === "" ? null : a.Project,
            ts: a.Ts,
        })),
        () => 0,
        (b) => b.ts,
        (b) => b.oref
    );

    // direct agents: only working/asking roster rows, never terminal/background/idle; a row whose
    // tab oref belongs to an active run is represented by the Run only — no fallback dedup.
    const runWorkerOrefs = new Set(activeRuns.flatMap((r) => r.workerOrefs));
    const directAgents: AgentRow[] = sortBy(
        agents
            .filter(
                (a) =>
                    (a.state === "working" || a.state === "asking") &&
                    a.kind !== "terminal" &&
                    a.kind !== "background" &&
                    !runWorkerOrefs.has("tab:" + a.id)
            )
            .map((a) => ({
                oref: "agent:" + a.id,
                id: a.id,
                name: a.name,
                task: a.task ?? a.name,
                runtime: a.agent ?? "",
                project: a.project ?? null,
                state: a.state as "working" | "asking",
                startedTs: queryStartedAt - (a.state === "asking" ? (a.blockedMs ?? 0) : (a.activeMs ?? 0)),
            })),
        (a) => (a.state === "asking" ? 0 : 1),
        (a) => a.startedTs,
        (a) => a.id
    );

    // shipped: only the rolling seven-day window (the server may return more when the cursor is
    // older than seven days); `fresh` when the matching run-done event is in the client-side delta.
    const shippedItems = projects.flatMap((p) => p.shipped ?? []);
    const windowedShipped = shippedItems.filter((s) => s.completedts >= input.sevenDaysAgo);

    // delta: client-side window back to actualCursor (the server fetched since min(cursor, 7d)),
    // minus current-attention duplicates, minus completions promoted into the shipped section.
    const rawDelta = projects
        .flatMap((p) => p.delta ?? [])
        .filter((ev) => ev.Ts >= actualCursor && ev.Kind !== "session" && !matchesAttention(ev, attentionItems));
    const promotedOrefs = new Set(windowedShipped.map((s) => "run:" + s.runoid));
    const promoted = new Set(rawDelta.filter((ev) => ev.Kind === "run-done" && promotedOrefs.has(ev.NavTarget ?? "")).map((ev) => ev.Key ?? ev.Ts + ":" + ev.Title));
    const delta: DeltaRow[] = rawDelta
        .filter((ev) => ev.Kind !== "run-done" || !promotedOrefs.has(ev.NavTarget ?? ""))
        .map((ev) => {
            const wording = DELTA_WORDING[ev.Kind] ?? ev.Kind;
            const detail = ev.Kind === "dossier" ? dossierWording(ev.Detail) : ev.Detail ?? null;
            return {
                key: ev.Kind + ":" + ev.Ts + ":" + ev.Title,
                ts: ev.Ts,
                kind: ev.Kind,
                title: ev.Title,
                wording,
                detail,
                oref: normalizeBriefingNav(ev.NavTarget),
            };
        });

    const shipped: ShippedRow[] = windowedShipped.map((s) => ({
        oref: "run:" + s.runoid,
        goal: s.goal,
        project: s.project,
        summary: s.summary ?? "",
        completedTs: s.completedts,
        fresh: rawDelta.some((ev) => ev.Kind === "run-done" && ev.NavTarget === "run:" + s.runoid),
    }));

    const missingLegs: string[] = [];
    if (state.sources.runs !== true) {
        missingLegs.push("Runs");
    }
    if (state.sources.dossiers !== true) {
        missingLegs.push("Records");
    }

    return {
        attention,
        activeRuns,
        blockers,
        directAgents,
        delta,
        shipped,
        health: { complete: missingLegs.length === 0, missingLegs, attentionState: state.sources.attention },
        counts: { runs: activeRuns.length, agents: directAgents.length, delta: delta.length, shipped: shipped.length },
    };
}
```

Cleanup notes for the implementer: the `promoted`/`Key` line is dead (the filter uses `promotedOrefs` directly) — drop it; `DELTA_WORDING`'s dossier entry is overridden by `dossierWording` — drop the map entry or the branch, keeping one source of wording.

- [ ] **Step 4: Run the tests and typecheck**

```bash
npx vitest run frontend/app/view/jarvis/briefingmodel.test.ts
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
```
Expected: PASS, exit 0.

---

### Task 5: briefingstore.ts — cursor, load generations, snapshot, landing guard, inline ask

**Files:**
- Create: `frontend/app/view/jarvis/briefingstore.ts`
- Create: `frontend/app/view/jarvis/briefingstore.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 6–9):

```ts
export interface BriefingSnapshot {
    state: WorkState;
    queryStartedAt: number;
    actualCursor: number;
    complete: boolean;
    cursorSaved: boolean;
}
export interface BriefingLoadState { snapshot: BriefingSnapshot | null; loading: boolean; error: string | null; }

export const briefingStateAtom: Atom<BriefingLoadState>;              // read-only; fixture-aware in DEV
export const briefingCursorAtom: PrimitiveAtom<number | null>;        // atomWithStorage("jarvis.briefing.lastseen", ...)
export const briefingFixtureAtom: PrimitiveAtom<BriefingFixtureName | null>; // DEV-only

export function loadBriefing(): void;      // fire-and-forget; also used by Refresh and Retry
export async function loadBriefingAsync(): Promise<void>;
export function refreshBriefing(): void;

export function briefingLandingConsumed(): boolean;
export function consumeBriefingLanding(): void;

export type BriefingAskState = "idle" | "pending" | "answered" | "error";
export const briefingAskStateAtom: PrimitiveAtom<BriefingAskState>;
export const briefingAnswerAtom: PrimitiveAtom<{ answer: string; sources: JarvisConvoSourceRef[]; terminal: string } | null>;
export function askAcrossWork(prompt: string): void;
```

- [ ] **Step 1: Write the failing tests**

Create `frontend/app/view/jarvis/briefingstore.test.ts`. The localStorage mock must exist before the module initializes (`atomWithStorage` reads on init), so it lives in `vi.hoisted`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { JarvisStateCommand: vi.fn(), JarvisAskCommand: vi.fn() } }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

const lsMock = vi.hoisted(() => {
    const store = new Map<string, string>();
    const mock = {
        store,
        failWrites: false,
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => {
            if (mock.failWrites) {
                throw new Error("quota");
            }
            store.set(k, v);
        },
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear(),
    };
    (globalThis as any).localStorage = mock;
    return mock;
});

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { SEVEN_DAYS_MS } from "./briefingmodel";
import {
    askAcrossWorkAsync,
    briefingAnswerAtom,
    briefingAskStateAtom,
    briefingCursorAtom,
    briefingStateAtom,
    loadBriefingAsync,
} from "./briefingstore";

const T0 = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const completeState = (): WorkState => ({
    projects: [],
    sources: { runs: true, sessions: true, dossiers: true, attention: "volatile" },
});

const mockStateRpc = (state: WorkState) => {
    (RpcApi.JarvisStateCommand as ReturnType<typeof vi.fn>).mockResolvedValue({ state });
};

describe("briefing cursor", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        lsMock.clear();
        lsMock.failWrites = false;
        globalStore.set(briefingCursorAtom, null);
        globalStore.set(briefingAskStateAtom, "idle");
        globalStore.set(briefingAnswerAtom, null);
        vi.spyOn(Date, "now").mockReturnValue(T0);
        (RpcApi.JarvisStateCommand as ReturnType<typeof vi.fn>).mockReset();
        (RpcApi.JarvisAskCommand as ReturnType<typeof vi.fn>).mockReset();
    });

    it("first use falls back to seven days ago and stores the query start on success", async () => {
        mockStateRpc(completeState());
        await loadBriefingAsync();
        expect(RpcApi.JarvisStateCommand).toHaveBeenCalledWith(expect.anything(), { project: "", sincems: T0 - SEVEN_DAYS_MS });
        expect(globalStore.get(briefingCursorAtom)).toBe(T0);
        const st = globalStore.get(briefingStateAtom);
        expect(st.snapshot?.complete).toBe(true);
        expect(st.snapshot?.cursorSaved).toBe(true);
    });

    it.each([
        ["malformed", JSON.stringify("abc")],
        ["nonpositive", JSON.stringify(0)],
        ["negative", JSON.stringify(-5)],
        ["future", JSON.stringify(T0 + 1000)],
    ])("falls back to seven days ago for a %s cursor", async (_name, stored) => {
        lsMock.store.set("jarvis.briefing.lastseen", stored);
        mockStateRpc(completeState());
        await loadBriefingAsync();
        expect(RpcApi.JarvisStateCommand).toHaveBeenCalledWith(expect.anything(), { project: "", sincems: T0 - SEVEN_DAYS_MS });
    });

    it("advances from queryStartedAt, never response time", async () => {
        let resolve!: (v: CommandJarvisStateRtnData) => void;
        (RpcApi.JarvisStateCommand as ReturnType<typeof vi.fn>).mockReturnValue(new Promise((r) => (resolve = r)));
        const pending = loadBriefingAsync();
        vi.spyOn(Date, "now").mockReturnValue(T0 + 60_000); // the response lands a minute later
        resolve({ state: completeState() });
        await pending;
        expect(globalStore.get(briefingCursorAtom)).toBe(T0);
    });

    it("does not advance on RPC failure and keeps the previous snapshot", async () => {
        globalStore.set(briefingCursorAtom, T0 - DAY);
        (RpcApi.JarvisStateCommand as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("rpc broke"));
        await loadBriefingAsync();
        expect(globalStore.get(briefingCursorAtom)).toBe(T0 - DAY);
        expect(globalStore.get(briefingStateAtom).error).toBeTruthy();
    });

    it("does not advance on partial source health but still renders the snapshot", async () => {
        globalStore.set(briefingCursorAtom, T0 - DAY);
        const partial: WorkState = {
            projects: [],
            sources: { runs: false, sessions: true, dossiers: true, attention: "volatile" },
        };
        mockStateRpc(partial);
        await loadBriefingAsync();
        const st = globalStore.get(briefingStateAtom);
        expect(st.snapshot?.complete).toBe(false);
        expect(st.snapshot?.state.sources.runs).toBe(false);
        expect(globalStore.get(briefingCursorAtom)).toBe(T0 - DAY);
    });

    it("discards a stale generation's snapshot and cursor write", async () => {
        let resolveA!: (v: CommandJarvisStateRtnData) => void;
        (RpcApi.JarvisStateCommand as ReturnType<typeof vi.fn>).mockReturnValueOnce(new Promise((r) => (resolveA = r)));
        const a = loadBriefingAsync();
        mockStateRpc(completeState()); // generation B resolves immediately
        await loadBriefingAsync();
        resolveA({ state: completeState() }); // generation A lands late
        await a;
        expect(globalStore.get(briefingCursorAtom)).toBe(T0);
        expect(globalStore.get(briefingStateAtom).snapshot?.queryStartedAt).toBe(T0);
    });

    it("keeps the accepted snapshot and flags the unsaved marker when localStorage writes fail", async () => {
        lsMock.failWrites = true;
        try {
            mockStateRpc(completeState());
            await loadBriefingAsync();
            const st = globalStore.get(briefingStateAtom);
            expect(st.snapshot?.complete).toBe(true);
            expect(st.snapshot?.cursorSaved).toBe(false);
        } finally {
            lsMock.failWrites = false;
        }
    });

    it("never regresses a cursor another window already advanced", async () => {
        globalStore.set(briefingCursorAtom, T0 + 10_000);
        mockStateRpc(completeState());
        await loadBriefingAsync();
        expect(globalStore.get(briefingCursorAtom)).toBe(T0 + 10_000);
    });

    it("is pending while in flight, then answered with answer and sources", async () => {
        let resolve!: (v: CommandJarvisAskRtnData) => void;
        (RpcApi.JarvisAskCommand as ReturnType<typeof vi.fn>).mockReturnValue(new Promise((r) => (resolve = r)));
        const p = askAcrossWorkAsync("what is moving?");
        expect(globalStore.get(briefingAskStateAtom)).toBe("pending");
        resolve({
            answer: "the briefing run",
            sources: [{ oref: "run:r-1", sourcetype: "status", title: "the briefing run" }],
            terminal: "answered",
        });
        await p;
        expect(globalStore.get(briefingAskStateAtom)).toBe("answered");
        expect(globalStore.get(briefingAnswerAtom)?.answer).toBe("the briefing run");
        expect(RpcApi.JarvisAskCommand).toHaveBeenCalledWith(
            expect.anything(),
            { prompt: "what is moving?", cwd: "" },
            { timeout: 180_000 }
        );
    });

    it("renders the error state on RPC failure and keeps the prior answer", async () => {
        globalStore.set(briefingAnswerAtom, { answer: "prior", sources: [], terminal: "answered" });
        (RpcApi.JarvisAskCommand as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ask broke"));
        await askAcrossWorkAsync("status?");
        expect(globalStore.get(briefingAskStateAtom)).toBe("error");
        expect(globalStore.get(briefingAnswerAtom)?.answer).toBe("prior");
    });

    it("a newer ask supersedes a slower one", async () => {
        let resolveA!: (v: CommandJarvisAskRtnData) => void;
        (RpcApi.JarvisAskCommand as ReturnType<typeof vi.fn>).mockReturnValueOnce(new Promise((r) => (resolveA = r)));
        const a = askAcrossWorkAsync("first");
        (RpcApi.JarvisAskCommand as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            answer: "second answer",
            sources: [],
            terminal: "answered",
        });
        await askAcrossWorkAsync("second");
        resolveA({ answer: "first answer", sources: [], terminal: "answered" });
        await a;
        expect(globalStore.get(briefingAnswerAtom)?.answer).toBe("second answer");
    });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
npx vitest run frontend/app/view/jarvis/briefingstore.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement briefingstore.ts**

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Briefing load lifecycle: one RPC per entry, a validated persisted visit cursor, generation-guarded
// snapshot writes, the launch-local landing guard, and the stateless inline ask.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type Atom, type PrimitiveAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { SEVEN_DAYS_MS } from "./briefingmodel";

export interface BriefingSnapshot {
    state: WorkState;
    queryStartedAt: number;
    actualCursor: number;
    complete: boolean;
    cursorSaved: boolean;
}

export interface BriefingLoadState {
    snapshot: BriefingSnapshot | null;
    loading: boolean;
    error: string | null;
}

// The visit cursor: browser-profile-wide and all-project (Briefing ignores Space scope by design).
// getOnInit is load-bearing — the boot landing reads the stored value in the same tick it decides.
export const briefingCursorAtom = atomWithStorage<number | null>("jarvis.briefing.lastseen", null, undefined, {
    getOnInit: true,
});

const fetchedBriefingStateAtom = atom<BriefingLoadState>({ snapshot: null, loading: false, error: null }) as PrimitiveAtom<BriefingLoadState>;

// DEV/CDP fixture seam (mirrors jarvisstore's activeFixtureAtom): a selected fixture replaces the
// fetched load state. Compiled out of production builds.
const DEV_FIXTURES = import.meta.env.DEV;
export const briefingFixtureAtom = atom<BriefingFixtureName | null>(null) as PrimitiveAtom<BriefingFixtureName | null>;

export const briefingStateAtom: Atom<BriefingLoadState> = atom((get) => {
    if (DEV_FIXTURES) {
        const fixture = get(briefingFixtureAtom);
        if (fixture != null) {
            return BRIEFING_FIXTURES[fixture].load;
        }
    }
    return get(fetchedBriefingStateAtom);
});

// every load gets a generation; only the latest may write the snapshot or the cursor. Guards React
// remounts and rapid subject changes without a backend write or lock.
let loadGeneration = 0;

function validCursor(v: unknown, at: number): v is number {
    return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= at;
}

export async function loadBriefingAsync(): Promise<void> {
    const gen = ++loadGeneration;
    const queryStartedAt = Date.now();
    const sevenDaysAgo = queryStartedAt - SEVEN_DAYS_MS;
    const stored = globalStore.get(briefingCursorAtom);
    const actualCursor = validCursor(stored, queryStartedAt) ? stored : sevenDaysAgo;
    // min() serves both requirements in one request: the client filters Delta back to actualCursor,
    // while the response still carries the stable seven-day Shipped window when the cursor is newer.
    const fetchSince = Math.min(actualCursor, sevenDaysAgo);
    globalStore.set(fetchedBriefingStateAtom, {
        snapshot: globalStore.get(fetchedBriefingStateAtom).snapshot,
        loading: true,
        error: null,
    });
    try {
        const rtn = await RpcApi.JarvisStateCommand(TabRpcClient, { project: "", sincems: fetchSince });
        if (gen !== loadGeneration) {
            return; // superseded
        }
        const state = rtn.state;
        const complete = state.sources.runs === true && state.sources.dossiers === true;
        let cursorSaved = true;
        if (complete) {
            try {
                // re-read before the write: a slower second window must not regress a cursor another
                // window (or another Wave window) already advanced past its own query start.
                const cur = globalStore.get(briefingCursorAtom);
                globalStore.set(briefingCursorAtom, Math.max(validCursor(cur, queryStartedAt) ? cur : 0, queryStartedAt));
            } catch {
                // keep the accepted snapshot and say the marker was not saved; the safe consequence
                // is repetition on the next load, never a lost event.
                cursorSaved = false;
            }
        }
        globalStore.set(fetchedBriefingStateAtom, {
            snapshot: { state, queryStartedAt, actualCursor, complete, cursorSaved },
            loading: false,
            error: null,
        });
    } catch (err) {
        if (gen !== loadGeneration) {
            return;
        }
        // keep any previous snapshot visible; the view renders the failure banner from `error`.
        globalStore.set(fetchedBriefingStateAtom, {
            snapshot: globalStore.get(fetchedBriefingStateAtom).snapshot,
            loading: false,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

export function loadBriefing(): void {
    void loadBriefingAsync();
}

// Refresh uses the same load and cursor rules as reopening Briefing.
export function refreshBriefing(): void {
    loadBriefing();
}

// --- launch-local landing guard (once per Wave frontend load, survives surface unmounts) ----------
let landingConsumed = false;
export function briefingLandingConsumed(): boolean {
    return landingConsumed;
}
export function consumeBriefingLanding(): void {
    landingConsumed = true;
}

// --- inline all-work ask (stateless; launch-local; never a JarvisConversation) --------------------
export type BriefingAskState = "idle" | "pending" | "answered" | "error";
export const briefingAskStateAtom = atom<BriefingAskState>("idle") as PrimitiveAtom<BriefingAskState>;
export const briefingAnswerAtom = atom<{
    answer: string;
    sources: JarvisConvoSourceRef[];
    terminal: string;
} | null>(null) as PrimitiveAtom<{ answer: string; sources: JarvisConvoSourceRef[]; terminal: string } | null>;

let askGeneration = 0;
export async function askAcrossWorkAsync(prompt: string): Promise<void> {
    const gen = ++askGeneration;
    globalStore.set(briefingAskStateAtom, "pending");
    try {
        // cwd:"" is the shipped all-project scope; the raised timeout matches the CLI — the handler
        // runs a relevance judge and a TierMid synthesis synchronously.
        const rtn = await RpcApi.JarvisAskCommand(TabRpcClient, { prompt, cwd: "" }, { timeout: 180_000 });
        if (gen !== askGeneration) {
            return;
        }
        globalStore.set(briefingAnswerAtom, { answer: rtn.answer, sources: rtn.sources ?? [], terminal: rtn.terminal });
        globalStore.set(briefingAskStateAtom, "answered");
    } catch (err) {
        if (gen !== askGeneration) {
            return;
        }
        // keep the prior settled answer visible; the view renders the error note.
        globalStore.set(briefingAskStateAtom, "error");
    }
}

export function askAcrossWork(prompt: string): void {
    void askAcrossWorkAsync(prompt);
}
```

The `briefingfixtures.ts` module (Task 11) defines `BriefingFixtureName` and `BRIEFING_FIXTURES`; briefingstore imports them with `import type` for the name and a value import for `BRIEFING_FIXTURES` (briefingfixtures imports only types back from briefingstore, so the cycle is type-only and erased). To keep Task 5 green before Task 11 lands, create a minimal `briefingfixtures.ts` in this task holding just the type + empty record:

```ts
// DEV-only content lives here; Task 11 fills in the fixture states.
import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import type { BriefingLoadState } from "./briefingstore";

export type BriefingFixtureName = "normal" | "attention" | "empty" | "partial" | "failed";
export interface BriefingFixture {
    load: BriefingLoadState;
    agents: AgentVM[];
}
export const BRIEFING_FIXTURES: Record<BriefingFixtureName, BriefingFixture> = {
    normal: { load: { snapshot: null, loading: false, error: null }, agents: [] },
    attention: { load: { snapshot: null, loading: false, error: null }, agents: [] },
    empty: { load: { snapshot: null, loading: false, error: null }, agents: [] },
    partial: { load: { snapshot: null, loading: false, error: null }, agents: [] },
    failed: { load: { snapshot: null, loading: false, error: null }, agents: [] },
};
```

- [ ] **Step 4: Run the tests and typecheck**

```bash
npx vitest run frontend/app/view/jarvis/briefingstore.test.ts frontend/app/view/jarvis/briefingmodel.test.ts
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
```
Expected: PASS, exit 0.

---

### Task 6: Subjects column — pinned Briefing row, keyboard order, once-per-launch landing

**Files:**
- Modify: `frontend/app/view/jarvis/subjectscolumn.tsx`

**Interfaces:**
- Consumes: `BRIEFING_SUBJECT` (Task 3), `briefingLandingConsumed`/`consumeBriefingLanding`/`refreshBriefing` (Task 5), `pendingRunFocusAtom`/`pendingRunDraftAtom` (from `@/app/view/agents/runactions` — already imported by stage.tsx).
- Produces: the pinned row (data attribute `data-jarvis-subject-kind="briefing"`), `briefing:all` as the first entry of `navIds`, and the landing-guard branch of the restore effect.

- [ ] **Step 1: Add the imports**

```ts
import { pendingRunDraftAtom, pendingRunFocusAtom } from "@/app/view/agents/runactions";
import { briefingLandingConsumed, consumeBriefingLanding, refreshBriefing } from "./briefingstore";
import { BRIEFING_SUBJECT, ... } from "./subjects";
```

- [ ] **Step 2: Wire the landing guard into the restore effect**

Replace the head of the existing restore effect in `SubjectsColumn` so the guard owns the first entry:

```ts
    useEffect(() => {
        if (restoredRef.current || active != null) {
            // an explicitly selected subject owns the entry; the guard never lands Briefing on top.
            consumeBriefingLanding();
            return;
        }
        if (!briefingLandingConsumed()) {
            // pending run focus / radar draft are explicit navigation: consume the guard silently
            // and fall through to the ordinary restore — the Stage's own effects land them.
            const explicitPending =
                globalStore.get(pendingRunFocusAtom) != null || globalStore.get(pendingRunDraftAtom) != null;
            consumeBriefingLanding();
            if (!explicitPending) {
                // first neutral Jarvis entry of this launch: Briefing is the landing. There is no
                // Briefing flash — the guard is consumed at decision time, before any data loads.
                restoredRef.current = true;
                selectSubject({ kind: BRIEFING_SUBJECT.kind, id: BRIEFING_SUBJECT.id });
                return;
            }
        }
        const decision = restoreDecision(stored, {
            ...existing body unchanged...
```

- [ ] **Step 3: Add the pinned row and keyboard order**

In `SubjectsColumn` (wide form), between the `+ Channel / + Thread` block and the `activeSpace` banner, render the pinned row:

```tsx
            {/* the pinned Briefing row: always first, above the Space banner and every group, immune
                to Space scope, text filtering and group collapse. Clicking the row while it is
                already selected refreshes it. */}
            <div className="px-2 pt-2">
                <button
                    type="button"
                    data-jarvis-subject-kind="briefing"
                    aria-label="Briefing · All work"
                    onClick={() => {
                        commitRef.current?.cancel();
                        if (isBriefingActive) {
                            refreshBriefing();
                        } else {
                            selectSubject({ kind: BRIEFING_SUBJECT.kind, id: BRIEFING_SUBJECT.id });
                        }
                    }}
                    className={cn(
                        "flex w-full cursor-pointer items-center gap-2 rounded-[8px] px-2.5 py-[7px] text-left transition-colors duration-[140ms] hover:bg-surface-hover",
                        isBriefingActive && "bg-accentbg"
                    )}
                >
                    <span
                        className={cn(
                            "w-[9px] flex-none font-mono text-[12px]",
                            isBriefingActive ? "text-accent-soft" : "text-muted"
                        )}
                    >
                        {subjectMark("briefing")}
                    </span>
                    <span
                        className={cn(
                            "min-w-0 flex-1 truncate text-[12.5px]",
                            isBriefingActive ? "font-semibold text-primary" : "font-medium text-secondary"
                        )}
                    >
                        Briefing
                    </span>
                    <span className="flex-none font-mono text-[9.5px] text-muted">All work</span>
                </button>
            </div>
```

Compute `isBriefingActive` beside the existing `isActive` helper:

```ts
    const isBriefingActive = (cursorKey ?? activeKey) === "briefing:all";
```

Extend `navIds` so Briefing is the first item of the same `j`/`k` order (the commit scheduler already parses `kind:id` — `"briefing:all"` works):

```ts
    const navIds = useMemo(
        () => ["briefing:all", ...shown.flatMap((g) => g.items.map((s) => `${s.kind}:${s.id}`))],
        [shown]
    );
```

In `CollapsedSubjects` (icon form), prepend the same row as a square `◈` button (first item, `onBriefingClick` prop threaded from the parent with the same click behavior).

- [ ] **Step 4: Verify**

```bash
npx vitest run frontend/app/view/jarvis/briefingstore.test.ts
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
```
Expected: exit 0 (behavior is verified by the CDP scenario in Task 11; there is no jsdom render test in this repo).

---

### Task 7: BriefingView — the Tailwind-only Stage body

**Files:**
- Create: `frontend/app/view/jarvis/briefingview.tsx`

**Interfaces:**
- Consumes: `briefingStateAtom`, `briefingAskStateAtom`, `briefingAnswerAtom`, `loadBriefing`, `refreshBriefing` (Task 5); `projectBriefing`, `SEVEN_DAYS_MS`, `normalizeBriefingNav` (Task 4); `openORef`, `orefNavPlan` (existing `./openref`); `stageRailOpenAtom` (existing `./jarvisstore`).
- Produces: a `BriefingView({ model }: { model: AgentsViewModel })` component that stage.tsx (Task 8) renders for `comp.thread === "briefing"`.

- [ ] **Step 1: Write the component**

Structure (all Tailwind utilities with existing tokens; `STAGE_GUTTER`/`STAGE_SCROLLER` from `./stagemeasure`):

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Briefing Stage body: attention banner, active work, since-last-visit delta, seven-day shipped,
// and the inline all-work answer above the composer. Pure projection in briefingmodel.ts; this file
// only renders rows and never reinterprets wire kinds.

export function BriefingView({ model }: { model: AgentsViewModel }) {
    const { snapshot, loading, error } = useAtomValue(briefingStateAtom);
    const fixture = useAtomValue(briefingFixtureAtom);
    const liveAgents = useAtomValue(model.agentsAtom);
    const askState = useAtomValue(briefingAskStateAtom);
    const answer = useAtomValue(briefingAnswerAtom);
    const setRailOpen = useSetAtom(stageRailOpenAtom);

    // load on entry (mount == transitioned into Briefing); Refresh / Retry / pinned-row re-click
    // call refreshBriefing() directly.
    useEffect(() => {
        loadBriefing();
    }, []);

    const model_ = useMemo(() => {
        if (snapshot == null) {
            return null;
        }
        const agents = fixture != null ? BRIEFING_FIXTURES[fixture].agents : liveAgents;
        return projectBriefing({
            state: snapshot.state,
            agents,
            actualCursor: snapshot.actualCursor,
            queryStartedAt: snapshot.queryStartedAt,
            sevenDaysAgo: snapshot.queryStartedAt - SEVEN_DAYS_MS,
        });
    }, [snapshot, fixture, liveAgents]);

    const failedRefresh = error != null && snapshot != null;
    const firstLoad = snapshot == null && loading;
    const loadFailed = snapshot == null && error != null;
    ...
}
```

Render contract (in order):

1. **No snapshot + error** → bounded error state: `data-jarvis-briefing-error`, text "Couldn't load your work state." + a Retry button (`refreshBriefing()`).
2. **No snapshot + loading** → section-shaped placeholders (three muted `animate-pulse` blocks with the section labels visible — no zero counts before a healthy response exists).
3. **Snapshot present** → the five sections, plus:
   - `failedRefresh` banner: "Showing previous snapshot · refresh failed" + Retry.
   - `snapshot.cursorSaved === false` notice: "Visit marker not saved — the next load will repeat this window."
   - `model_.health.complete === false` notice: `Couldn't fully read: ${missingLegs.join(", ")}` — unavailable legs are named, never silently removed or shown as zero.
   - **Needs You banner** (`model_.attention != null`): one compact button (`data-jarvis-briefing-banner`) reading `Needs you · ${count}` (e.g. "Needs you · 2") that opens the rail: `setRailOpen(true)`. Absence renders nothing (never "all clear").
   - **Active work**: three subsections with headers `Runs · ${counts.runs}`, `Blocked records · ${counts.runs...}` — use `counts` from the model; each subsection gets `data-jarvis-briefing-section="runs|blockers|agents"`.
     - Run row (semantic button, `data-jarvis-briefing-row data-row-kind="run"`, `aria-label` = `goal, project, status`): goal (truncated), project (mono, muted), status chip. Click → `openORef(model, row.oref)`.
     - Blocker row: objective, blockers detail, "Unscoped record" chip when `project == null`. Click → `openORef(model, row.oref)`.
     - Agent row: name/task, runtime + project mono line, `working`/`asking` state chip (asking uses `bg-asking` tone). Click → `openORef(model, row.oref)`.
     - Healthy empty copy per subsection: "No active Wave runs.", "No blocked records.", "No direct agents working right now." — never "nothing needs attention".
   - **Since last visit** (`data-jarvis-briefing-section="delta"`): rows in model order, wording + title + detail; dossier events carry the current-status text from the model's `wording`; navigable rows are buttons (`openORef`), non-navigable facts are `<div>`s. Healthy empty: "No changes in this visit window."
   - **Recently shipped · 7 days** (`data-jarvis-briefing-section="shipped"`): goal, project, summary, `New` chip when `fresh` (text + color, `bg-success/12 text-success`), age via `formatAge(Date.now() - completedTs)`. Healthy empty: "No evidence-sealed Runs shipped in the last 7 days."
   - **Inline ask** (`data-jarvis-briefing-section="ask"`, `aria-live="polite"`): when `answer != null`, render the prose, then the sources — each source is a button (`openORef(model, normalized)`) only when `normalizeBriefingNav(s.oref)` is non-null and `orefNavPlan(normalized).kind !== "unsupported"`; otherwise the title renders as plain cited text. When `askState === "error"`, render "Ask failed — try again." and keep the prior answer visible. `weak`/`notfound` terminals need no extra copy — the backend's answer text already states them honestly (render the prose as-is).
4. The whole load-status region (banner/placeholders/error) is wrapped in `aria-live="polite"`.

- [ ] **Step 2: Verify**

```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
npx vitest run frontend/app/view/jarvis/briefingmodel.test.ts frontend/app/view/jarvis/briefingstore.test.ts
```
Expected: exit 0 (the view has no unit test — the repo's convention is pure `.ts` tests + CDP verification).

---

### Task 8: Stage + Stage header — briefing branch, band skip, snapshot time + Refresh

**Files:**
- Modify: `frontend/app/view/jarvis/stagecompose.ts`
- Modify: `frontend/app/view/jarvis/stage.tsx`
- Modify: `frontend/app/view/jarvis/stageheader.tsx`

**Interfaces:**
- Consumes: `BriefingView` (Task 7), `briefingStateAtom`/`refreshBriefing` (Task 5).
- Produces: `StageComposition` gains `showGraph: boolean`; `StageHeader` gains `snapshotTimeMs: number | null` and `onRefresh: (() => void) | null`.

- [ ] **Step 1: Extend stagecompose.ts**

Add the field and the table row:

```ts
export interface StageComposition {
    mark: SubjectMark;
    showAutonomy: boolean;
    showProfile: boolean;
    reachText: string | null;
    absenceChip: string | null;
    recordBand: "attributed" | "subject" | "mentions" | "none";
    showPipeline: boolean;
    thread: "run" | "record" | "turns" | "briefing";
    composerTarget: "worker-or-jarvis" | "jarvis-record" | "jarvis-thread" | "jarvis-briefing";
    showFleet: boolean;
    fleetTitle: string | null;
    showGraph: boolean;
}
```

Add `showGraph: true` to the channel/dossier/conversation rows and a briefing row:

```ts
    briefing: {
        showAutonomy: false,
        showProfile: false,
        reachText: null, // the header's subtitle carries the reach ("All work")
        absenceChip: null,
        recordBand: "none",
        showPipeline: false,
        thread: "briefing",
        composerTarget: "jarvis-briefing",
        showFleet: false,
        fleetTitle: null,
        showGraph: false,
    },
```

- [ ] **Step 2: stage.tsx — briefing branch, band skip, header props**

```ts
    const briefingSnapshot = useAtomValue(briefingStateAtom).snapshot;
    ...
    const title =
        subject.kind === "briefing"
            ? "Work briefing"
            : subject.kind === "channel"
              ? (channel?.name ?? "")
              : subject.kind === "dossier"
                ? (detail?.objective ?? "")
                : conversation.title;
    const subtitle = subject.kind === "channel" ? (channel?.projectpath ?? "") : subject.kind === "briefing" ? "All work" : "";
```

Render changes:

```tsx
            <StageHeader
                comp={comp}
                title={title}
                subtitle={subtitle}
                channelId={subject.kind === "channel" ? subject.id : null}
                tier={tier}
                mode={mode}
                onOpenGraph={() => setGraphOpen(true)}
                snapshotTimeMs={subject.kind === "briefing" ? (briefingSnapshot?.queryStartedAt ?? null) : null}
                onRefresh={subject.kind === "briefing" ? refreshBriefing : null}
            />
            {/* absent rather than empty: Briefing has no run and no record band */}
            {composing || comp.recordBand === "none" ? null : (
                <RecordBand ... existing ... />
            )}
```

And the thread slot gains the briefing branch:

```tsx
                {comp.thread === "run" ? (
                    ...
                ) : comp.thread === "record" ? (
                    <RecordThread detail={detail} model={model} />
                ) : comp.thread === "briefing" ? (
                    <BriefingView model={model} />
                ) : (
                    <div className={cn(STAGE_SCROLLER, "min-h-0 flex-1")}>
                        <ConversationView conversation={conversation} model={model} />
                    </div>
                )}
```

- [ ] **Step 3: stageheader.tsx — graph gating + snapshot time + Refresh**

Add the props and replace the always-on Graph button:

```tsx
    snapshotTimeMs,
    onRefresh,
}: {
    ...
    snapshotTimeMs: number | null;
    onRefresh: (() => void) | null;
}) {
```

```tsx
                {comp.showGraph ? (
                    <button
                        type="button"
                        onClick={onOpenGraph}
                        title="Peek the vault graph around this subject"
                        className="flex-none cursor-pointer rounded-[7px] border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-secondary hover:text-primary"
                    >
                        Graph
                    </button>
                ) : snapshotTimeMs != null ? (
                    <>
                        <span className="flex-none rounded-[7px] border border-border bg-surface px-2.5 py-1 font-mono text-[10.5px] text-muted">
                            As of{" "}
                            {new Date(snapshotTimeMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </span>
                        <button
                            type="button"
                            data-jarvis-briefing-refresh
                            onClick={onRefresh ?? undefined}
                            title="Reload the work briefing"
                            className="flex-none cursor-pointer rounded-[7px] border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-secondary hover:text-primary"
                        >
                            Refresh
                        </button>
                    </>
                ) : null}
```

- [ ] **Step 4: Verify**

```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
npx eslint frontend/app/view/jarvis/stage.tsx frontend/app/view/jarvis/stageheader.tsx frontend/app/view/jarvis/stagecompose.ts
```
Expected: exit 0.

---

### Task 9: Composer — the all-work ask face

**Files:**
- Modify: `frontend/app/view/jarvis/composertarget.ts`
- Modify: `frontend/app/view/jarvis/stagecomposer.tsx`
- Test: `frontend/app/view/jarvis/composertarget.test.ts`

**Interfaces:**
- Consumes: `askAcrossWork`, `briefingAskStateAtom`, `briefingStateAtom` (Task 5).
- Produces: composerTarget `"jarvis-briefing"` resolves to `{ audience: "jarvis", label: "All work", needsChannelPicker: false }`; the briefing face has placeholder `ALL WORK · Ask across your work…`, is disabled while an ask is pending, and disabled while the snapshot is known-partial.

- [ ] **Step 1: composertarget.ts**

Add the briefing case before the final label branch:

```ts
    if (input.composerTarget === "jarvis-briefing") {
        // a dispatch has no channel on Briefing; the box is a plain ask, and the syntax hint is
        // hidden — @quick/@run cannot do anything here.
        return { audience: "jarvis", label: "All work", needsChannelPicker: false };
    }
    const label = input.composerTarget === "jarvis-record" ? "Jarvis · scoped to this record" : "Jarvis · this thread";
```

- [ ] **Step 2: composertarget.test.ts**

Append:

```ts
    it("treats the briefing composer as a plain jarvis ask with no dispatch", () => {
        const t = resolveComposerTarget({ composerTarget: "jarvis-briefing", draft: "@quick fix it" });
        expect(t).toEqual({ audience: "jarvis", label: "All work", needsChannelPicker: false });
    });
```

- [ ] **Step 3: stagecomposer.tsx — the BriefingAsk face**

Add a small face beside `JarvisAsk` (keep `JarvisAsk`'s hint line optional so briefing can hide the misleading `@quick · @run` legend):

```tsx
// The Briefing face: one plain all-work ask. No dispatch legend — a dispatch needs a channel, and
// Briefing has none. Disabled while an ask is in flight or the work state is known-partial.
function BriefingAsk({
    draft,
    onChange,
    onSubmit,
    pending,
    disabled,
}: {
    draft: string;
    onChange: (next: string) => void;
    onSubmit: () => void;
    pending: boolean;
    disabled: boolean;
}) {
    return (
        <div className="flex items-center gap-2 rounded-[10px] border border-edge-mid bg-surface px-3.5 py-2.5">
            <input
                value={draft}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !disabled) {
                        e.preventDefault();
                        onSubmit();
                    }
                }}
                placeholder="ALL WORK · Ask across your work…"
                disabled={disabled}
                className="min-w-0 flex-1 bg-transparent text-[14px] text-secondary placeholder:text-muted focus:outline-none disabled:opacity-50"
            />
            {pending ? (
                <span className="flex-none rounded-[6px] border border-accent/40 bg-accentbg px-2 py-[3px] font-mono text-[10px] font-semibold text-accent-soft">
                    Answering…
                </span>
            ) : null}
        </div>
    );
}
```

In `StageComposer`, read the ask state + snapshot, and route `askJarvis`:

```ts
    const briefingAskState = useAtomValue(briefingAskStateAtom);
    const briefingSnapshot = useAtomValue(briefingStateAtom).snapshot;
    const briefingPending = briefingAskState === "pending";
    // known-partial work state disables the composer until a complete refresh succeeds
    const briefingDisabled = briefingSnapshot != null && !briefingSnapshot.complete;

    const askJarvis = () => {
        const text = draft.trim();
        if (text === "") {
            return;
        }
        if (target.needsChannelPicker) {
            setPicking(true);
            return;
        }
        setDraft("");
        if (comp.composerTarget === "jarvis-briefing") {
            askAcrossWork(text);
            return;
        }
        if (comp.composerTarget === "jarvis-record" && recordId != null) {
            ...
```

And the face branch (after the channel faces, before the plain `JarvisAsk`):

```tsx
            ) : comp.composerTarget === "jarvis-briefing" ? (
                <BriefingAsk
                    draft={draft}
                    onChange={setDraft}
                    onSubmit={askJarvis}
                    pending={briefingPending}
                    disabled={briefingPending || briefingDisabled}
                />
            ) : (
                <JarvisAsk
```

- [ ] **Step 4: Run the tests and typecheck**

```bash
npx vitest run frontend/app/view/jarvis/composertarget.test.ts
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
```
Expected: PASS, exit 0.

---

### Task 10: Stage rail — bounded zero-state copy

**Files:**
- Modify: `frontend/app/view/jarvis/stagerail.tsx`

**Interfaces:**
- Produces: the Needs-you zero-state copy becomes `No pending asks reported.` (the rail is visible beside Briefing, and a volatile attention source cannot prove an all-clear state). All other rail behavior for Briefing is already correct via `composeStage` (no fleet, no consults, no grounding, `ambientRailFor` returns null for unknown kinds) — verify, do not add.

- [ ] **Step 1: Change the copy**

```tsx
                        <span className="text-[12px] leading-[1.4] text-secondary">
                            No pending asks reported.
                        </span>
```

- [ ] **Step 2: Verify**

```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
```
Expected: exit 0.

---

### Task 11: DEV fixtures + the jarvis-briefing CDP scenario

**Files:**
- Modify: `frontend/app/view/jarvis/briefingfixtures.ts` (fill the Task 5 skeleton)
- Modify: `frontend/app/view/jarvis/jarvisfixturebar.tsx`
- Modify: `scripts/cdp/scenarios.mjs`

**Interfaces:**
- Produces: `BRIEFING_FIXTURES` with five load states (`normal`, `attention`, `empty`, `partial`, `failed`) each carrying a fixture `WorkState` + fixture `agents: AgentVM[]`; a dev-only `setBriefingAskFixtureForDev()` that sets `briefingAskStateAtom` to `"answered"` and `briefingAnswerAtom` to a sample answer with one button-capable source (`run:r-1`... use a real-format oref) and one cited-text source (`memory:m-1`); a second fixture bar row (`data-testid="jarvis-briefing-fixture-bar"`) whose buttons set the fixture atom and select Briefing.

- [ ] **Step 1: Fill the fixture content**

In `briefingfixtures.ts`, replace the empty record with five fixture states. Example shape (work the timestamps around a fixed `now` so the CDP shots are deterministic):

```ts
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

const normalState: WorkState = {
    projects: [
        {
            project: "waveterm",
            active: [
                { project: "waveterm", kind: "run", title: "Ship the landing briefing", detail: "status: executing", ts: NOW - 2 * DAY, navtarget: "run:r-briefing-1", workerorefs: ["tab:tab-run"] },
                { project: "waveterm", kind: "run", title: "Port the usage charts", detail: "status: blocked", ts: NOW - 3 * DAY, navtarget: "run:r-briefing-2" },
                { kind: "blocker", title: "Unify the vault scope model", detail: "needs decision on collection scoping", ts: NOW - DAY, navtarget: "vault:d-briefing-1" },
            ],
            shipped: [
                { project: "waveterm", runoid: "r-briefing-shipped", goal: "Memory recentralization", summary: "vault is the single source of truth", completedts: NOW - DAY },
            ],
            events: [],
            delta: [
                { ts: NOW - 2 * DAY, kind: "run-created", project: "waveterm", title: "Ship the landing briefing", detail: "status: executing", navtarget: "run:r-briefing-1" },
                { ts: NOW - DAY, kind: "run-done", project: "waveterm", title: "Memory recentralization", detail: "vault is the single source of truth", navtarget: "run:r-briefing-shipped" },
                { ts: NOW - 3 * DAY, kind: "decision", title: "chose sqlite over a second store" },
            ],
        },
    ],
    sources: { runs: true, sessions: true, dossiers: true, attention: "volatile" },
};
```

`attention` = `normalState` + one `kind:"attention"` active item (and its delta event, which the projection dedupes into the banner); `empty` = no projects, healthy sources; `partial` = `sources.runs === false` with one project present; `failed` = `{ snapshot: null, loading: false, error: "fixture failure" }` and an agents array. Each fixture's `agents` array supplies a working direct agent (e.g. `{ id: "tab-direct", name: "loom", task: "polish the composer", state: "working", agent: "claude", project: "waveterm", activeMs: 4 * 60_000 }`) so the Direct-agent section renders in CDP.

```ts
export function setBriefingAskFixtureForDev(): void {
    globalStore.set(briefingAskStateAtom, "answered");
    globalStore.set(briefingAnswerAtom, {
        answer: "Two runs are moving: the briefing itself is executing and the usage charts are blocked. The memory recentralization shipped yesterday [1].",
        sources: [
            { oref: "run:r-briefing-shipped", sourcetype: "shipped", title: "Memory recentralization" },
            { oref: "memory:m-briefing-1", sourcetype: "memory", title: "vault scoping note" },
        ],
        terminal: "answered",
    });
}
```

- [ ] **Step 2: Fixture bar row**

In `jarvisfixturebar.tsx`, below the existing row:

```tsx
            <div data-testid="jarvis-briefing-fixture-bar" className="flex flex-wrap items-center gap-1">
                <span className="mr-1 text-[10px] font-semibold uppercase tracking-wide text-muted">briefing</span>
                {(["normal", "attention", "empty", "partial", "failed"] as const).map((s) => (
                    <button
                        key={s}
                        type="button"
                        data-briefing-fixture={s}
                        onClick={() => {
                            globalStore.set(briefingFixtureAtom, s);
                            selectSubject({ kind: "briefing", id: "all" });
                        }}
                        className={cn(
                            "cursor-pointer rounded-[6px] px-2 py-0.5 text-[11px]",
                            active === s ? "bg-accentbg text-accent-soft" : "text-ink-mid hover:bg-surface-hover"
                        )}
                    >
                        {s}
                    </button>
                ))}
                <button
                    type="button"
                    data-briefing-fixture="ask"
                    onClick={() => {
                        setBriefingAskFixtureForDev();
                        selectSubject({ kind: "briefing", id: "all" });
                    }}
                    className="cursor-pointer rounded-[6px] px-2 py-0.5 text-[11px] text-ink-mid hover:bg-surface-hover"
                >
                    ask
                </button>
            </div>
```

- [ ] **Step 3: The CDP scenario**

In `scripts/cdp/scenarios.mjs`, add an entry alongside `jarvisStates` (same `{ name, surface, arrange, assert, teardown }` shape; `h.goto`, `h.ev`, `h.shot` as in `jarvisStates`):

```js
// --- jarvis: the landing briefing (once-per-launch pinned all-work subject) -----------------------
const jarvisBriefing = {
    name: "jarvis-briefing",
    surface: "jarvis",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        const briefingRow = `document.querySelector('[data-jarvis-subject-kind="briefing"]')`;
        const briefingActive = `(() => { const b = ${briefingRow}; return !!b && b.classList.contains('bg-accentbg'); })()`;
        // 1. first neutral Jarvis entry opens Briefing on a fresh profile
        await h.goto("cockpit");
        await h.ev("localStorage.clear(); return true;");
        await h.goto("jarvis");
        await h.ev("new Promise((r) => setTimeout(r, 400))");
        steps.push({ step: "first neutral entry opens Briefing", ok: (await h.ev(briefingActive)) === true });
        // 2. Briefing stays pinned under a nonmatching text filter
        await h.ev(`(() => {
            const input = document.querySelector('[data-jarvis-region="subjects"] input[type="text"]');
            if (!input) return false;
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(input, 'zzz-no-match');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        })()`);
        await h.ev("new Promise((r) => setTimeout(r, 150))");
        steps.push({
            step: "Briefing stays pinned under a nonmatching filter",
            ok: (await h.ev(`(() => { const b = ${briefingRow}; return !!b && b.parentElement !== null; })()`)) === true,
        });
        await h.ev(`(() => {
            const input = document.querySelector('[data-jarvis-region="subjects"] input[type="text"]');
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(input, '');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        })()`);
        // 3. fixture states render honestly
        for (const s of ["normal", "attention", "empty", "partial", "failed"]) {
            const clicked = await h.ev(`(() => {
                const b = [...document.querySelectorAll('[data-testid="jarvis-briefing-fixture-bar"] button')]
                    .find((x) => x.getAttribute('data-briefing-fixture') === ${JSON.stringify(s)});
                if (!b) return false;
                b.click();
                return true;
            })()`);
            await h.ev("new Promise((r) => setTimeout(r, 300))");
            const sections = await h.ev(
                `document.querySelectorAll('[data-jarvis-briefing-section]').length + (document.querySelector('[data-jarvis-briefing-error]') ? 1 : 0)`
            );
            steps.push({
                step: `briefing fixture "${s}" -> sections render`,
                ok: clicked === true && sections > 0,
                detail: `clicked=${clicked} sections=${sections}`,
            });
            await h.shot(`cdp-shots/jarvis-briefing-${s}.png`);
        }
        // 4. inline ask answer + source buttons (button-capable run oref, cited-text memory oref)
        await h.ev(`(() => {
            const b = [...document.querySelectorAll('[data-testid="jarvis-briefing-fixture-bar"] button')]
                .find((x) => x.getAttribute('data-briefing-fixture') === 'ask');
            if (b) b.click();
            return true;
        })()`);
        await h.ev("new Promise((r) => setTimeout(r, 200))");
        const askOk = await h.ev(`(() => {
            const ask = document.querySelector('[data-jarvis-briefing-section="ask"]');
            return ask ? { len: (ask.textContent || '').trim().length, buttons: ask.querySelectorAll('button').length } : null;
        })()`);
        steps.push({
            step: "inline ask renders answer + a source button",
            ok: askOk != null && askOk.len > 0 && askOk.buttons >= 1,
            detail: JSON.stringify(askOk),
        });
        // 5. a navigable row leaves Briefing for its subject
        const navOk = await h.ev(`(() => {
            const row = document.querySelector('[data-jarvis-briefing-row][data-row-kind="blocker"]');
            if (!row) return false;
            row.click();
            return true;
        })()`);
        await h.ev("new Promise((r) => setTimeout(r, 200))");
        steps.push({
            step: "navigable row leaves Briefing",
            ok: navOk === true && (await h.ev(briefingActive)) === false,
        });
        // 6. manual re-click of the pinned row returns to Briefing and refreshes
        await h.ev(`(() => { const b = ${briefingRow}; if (b) b.click(); return true; })()`);
        await h.ev("new Promise((r) => setTimeout(r, 200))");
        steps.push({ step: "pinned row re-selects Briefing", ok: (await h.ev(briefingActive)) === true });
        // 7. no Briefing-only control on ordinary subjects
        await h.ev(`(() => {
            const b = [...document.querySelectorAll('[data-testid="jarvis-fixture-bar"] button')]
                .find((x) => x.getAttribute('data-fixture') === 'active');
            if (b) b.click();
            return true;
        })()`);
        await h.ev("new Promise((r) => setTimeout(r, 200))");
        steps.push({
            step: "no Refresh control on ordinary subjects",
            ok: (await h.ev(`document.querySelector('[data-jarvis-briefing-refresh]') == null`)) === true,
        });
        await h.shot("cdp-shots/jarvis-briefing-ordinary-subject.png");
        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit");
    },
};
```

Register it in the scenario export list beside `jarvisStates`. Notes: the Space-scope pinning property is structural (the pinned row renders outside the Space-scoped groups derivation), so the scenario pins the filter case and the row's DOM position; a full active-Space case needs backend space state and is deliberately not scripted. `localStorage.clear()` wipes the visit cursor, giving the deterministic "first use" fallback.

- [ ] **Step 4: Verify**

```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
```
Expected: exit 0. Live check (dev app running on :9222): `task verify:ui -- jarvis-briefing` — see Task 12.

---

### Task 12: Full verification sweep

**Files:**
- None (verification only).

- [ ] **Step 1: Regenerate + backend**

```bash
task generate
go test ./pkg/jarvisstate/... ./pkg/wshrpc/wshserver/...
```
Expected: PASS. (If a broader package command is needed, use the CGO include guidance: `CGO_CFLAGS=-IC:\Users\kael02\IdeaProjects\waveterm\pkg\jarvisembed\csrc` from PowerShell.)

- [ ] **Step 2: Frontend**

```bash
npx vitest run frontend/app/view/jarvis/
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
npx eslint frontend/app/view/jarvis/
npx prettier --check frontend/app/view/jarvis/
```
Expected: all exit 0.

- [ ] **Step 3: Build**

```bash
task build:backend
```
Expected: builds `wavesrv` + `wsh` into `dist/bin/`.

- [ ] **Step 4: Live UI**

With the dev app running (WebView2 on :9222):

```bash
task verify:ui -- jarvis-briefing
```
Expected: all steps green; contact sheet in `cdp-shots/index.html` shows the five fixture states, the ask answer, and the ordinary-subject control absence.

- [ ] **Step 5: Self-review the diff**

`git status` must show only this plan's files (+ the pre-existing unrelated dirty files listed in Global Constraints — untouched). Re-read the diff for: no commented-out code, no debug statements, no raw hex colors, no SCSS additions.

---

## Self-Review

**Spec coverage:**
- §6.1 pinned subject / singleton identity / do-not-persist → Tasks 3, 6.
- §6.2 once-per-launch guard, explicit-navigation bypass, no flash, guard survives unmounts → Task 6.
- §6.3 Stage hierarchy, header naming/reach/snapshot/Refresh, absent controls, rail zero-state copy → Tasks 7, 8, 10.
- §6.4 row behavior + `vault:`→`task:` normalization → Tasks 4, 7.
- §7.1–7.4 attention banner/delta dedupe, source-explicit rows, wording, Shipped promotion/New, no session rows → Task 4.
- §8.1 `project:""`, `fetchSince = min(...)`, windowed backend → Tasks 2, 5.
- §8.2 worker-oref suppression, agentsAtom join, no fallback dedupe → Tasks 1, 4.
- §8.3 pure projection, separate counts, no arbitrary caps → Task 4.
- §9 cursor validation/advancement/races/localStorage-failure → Task 5.
- §10 source-health corrections → Task 2.
- §11 new files + all integration points → Tasks 1–11.
- §12 inline ask, `cwd:""`, 180s timeout, launch-local state, source-button rule → Tasks 5, 7, 9.
- §13 loading/empty/partial/failed states → Task 7.
- §14 a11y + Tailwind → Tasks 6, 7, 9.
- §15.1 Go tests → Tasks 1, 2. §15.2 pure frontend tests → Tasks 4, 5. §15.3 commands → Task 12. §15.4 CDP → Task 11.
- §16 reversibility: no migrations; localStorage key is the only durable state → Tasks 5, 12.

**Placeholder scan:** no TBDs; every task's steps carry concrete code, exact test fixtures, and exact seam closures.

**Type consistency:** `BRIEFING_SUBJECT` (Task 3) is used by Tasks 6/7/11; `BriefingSnapshot`/`BriefingLoadState` (Task 5) by Tasks 7/9; `projectBriefing`/`SEVEN_DAYS_MS`/`normalizeBriefingNav` (Task 4) by Tasks 5/7; `composerTarget: "jarvis-briefing"` (Task 8) by Task 9; `showGraph`/`recordBand:"none"` (Task 8) by Tasks 7/8.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-13-jarvis-landing-briefing.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
