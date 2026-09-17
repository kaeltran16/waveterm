# Cross-Surface Resource Linking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** every address a producer emits opens its target the same way from every caller, and an address that cannot open says why instead of doing nothing.

**Architecture:** Go producers emit one canonical address dialect, built for vault nodes by one function in `pkg/wavevault`; a grounding card gains an `anchor`. On the frontend one pure `parseAddress` (`view/jarvis/address.ts`) is the only reader of legacy strings, and one `openTarget`/`openAddress` (`view/jarvis/openref.ts`) loads what proves the target exists, writes the destination's selection, then switches surface — or reports why it cannot. Every caller migrates onto it, and the side channels it replaces (`pendingRunFocusAtom`, `normalizeBriefingNav`, `terminalTargetAtom`, `openORef`) are deleted.

**Tech Stack:** Go (`pkg/wavevault`, `pkg/jarvisrecall`, `pkg/jarvisvolunteer`, `pkg/jarvisstate`, `pkg/waveobj`), React 19 + TypeScript + jotai, vitest, the CDP `verify:ui` harness.

**Spec:** `docs/superpowers/specs/2026-09-15-cross-surface-resource-linking-design.md` (approved 2026-09-17). Read it before any task; this plan argues from it and does not restate its reasoning.

**Verify:** `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/wavevault/ ./pkg/jarvisvolunteer/ ./pkg/jarvisrecall/ ./pkg/jarvisstate/ && npx vitest run frontend/app/view/jarvis frontend/app/view/agents frontend/app/view/orchestrate frontend/app/cockpit && node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`

## Decisions that differ from the spec's wording

Each is a consequence the spec did not spell out. Say so at approval if one is wrong.

1. **Dedupe keys include the anchor.** A decision now addresses its record (`task:<parent>`), so a record and its decision share `navTarget`. `jarvisrecall.assembleCandidates` and the Brief's `drewOn` both dedupe on `navTarget` today and would silently fold the decision into its record. Both key on address plus anchor instead; an unaddressed candidate (a decision with no record) is never deduped.
2. **A missing channel is `unavailable`, "That channel no longer exists".** The spec's channel row says "fails to load" without a message; `loadAndPinWaveObject` resolves `null` for a deleted channel rather than throwing, and `selectChannel` would otherwise open a sheet on it.
3. **Records and memory notes refresh their list once on a miss.** The spec checks the loaded list (and loads memory only when unloaded). Both lists load once per surface visit, so a record or note created since — exactly what a fresh volunteer utterance cites — would read as deleted. The landing reloads once before calling it gone.
4. **`OpenResult`'s ok arm carries an optional `notice`.** The spec's failure table reports "That finding is no longer in this report" on a landing that succeeds, and `{ ok: true }` has nowhere to put it. The default reporter shows a notice as an info toast.
5. **`openAddress` takes the same optional `report` as `openTarget`.** The Pet calls `openAddress` with its own reporter (spec §4 migration table).
6. **`superseded` guards writes after the proof load and before the surface switch.** `openChannelSheet`'s own `selectChannel` writes the active channel while it loads its streams; the token cannot hold that back, but it does stop the stale landing from switching surface or opening the sheet over the newer one.
7. **A click on an address the parser rejects still counts as the newest open**, so an earlier slow landing cannot land over the toast the user just saw.
8. **The Pet keeps its peek open when an Open fails.** Today it closes the peek before escorting; the failure it now records on the act would be invisible behind a closed peek.
9. **`openTaskWorker` drops its `channelId` parameter.** The run landing reads the channel off the Run.
10. **One `resource-linking` CDP scenario covers the spec's four checks**, seeded through a DEV-only hook: a citation chip otherwise exists only after a live (billed, slow) synthesis. The chips point at real objects read from the profile, so a profile with nothing to cite fails that step and says what to seed. Two `data-*` hooks are added for its asserts.
11. **`jarvisturn.tsx` and `ProactiveCard` are orphaned** (`docs/open-issues.md` B5 table) but still compile, so they migrate like any caller.

## Global Constraints

- No emojis. Comments lower case, "why" only, and only where the surrounding code would comment.
- **Never hand-edit generated files** (`frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`, `pkg/wshrpc/wshclient/wshclient.go`). After changing a `waveobj` type run `task generate`.
- **Go tests need the CGO header:** from Git Bash at the repo root, `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test <pkgs>`. A POSIX `-I/c/...` path fails with the same `sqlite3.h` error as no flag.
- **Typecheck with** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (plain `npx tsc` stack-overflows). The baseline is exit 0.
- **The tree compiles and its tests pass at every task boundary.** Task 5 keeps thin legacy exports in `openref.ts` for callers Tasks 6 and 7 have not migrated yet; Task 7 deletes them.
- **Formatting:** HEAD is not formatter-clean. A TS/TSX file this plan **creates or replaces wholesale** may be `npx prettier --write`-ed. A file it **edits** is only `npx prettier --check`-ed, and you hand-fix your own hunks (compare with `npx prettier <file> | diff <file> -`), because `--write` would also reformat drift you did not write. Go files: `gofmt -l`, then fix your hunks. Never `prettier --write` a `scripts/*.mjs` file (it reindents to 2 spaces) — hand-format those at 4 spaces.
- **Colors and UI:** no styling changes in this plan. The two `data-*` attributes in Task 8 are test hooks only.
- **Git:** do not commit per task. The whole slice is one commit at the end (Task 9), carrying the spec and this plan, made only after the user approves it, with no `Co-Authored-By` or session trailer.

---

### Task 1: One vault-addressing function in `pkg/wavevault`

**Depends on:** none

**Files:**
- Create: `pkg/wavevault/address.go`
- Create: `pkg/wavevault/address_test.go`
- Modify: `pkg/jarvisvolunteer/recall.go:58-97`
- Test (unchanged, must stay green): `pkg/jarvisvolunteer/recall_test.go`

**Interfaces:**
- Produces:
  - `func wavevault.Address(collection, id string, parent func(decisionID string) string) (address, anchor string)` — `CollTasks` → `"task:<id>", ""`; `CollMemory` → `"memnote:<id>", ""`; `CollDecisions` → `"task:<parent(id)>", id`, or `"", ""` when `parent` is nil or returns `""`; any other collection → `"", ""`.
  - `func (r *wavevault.Retriever) ParentRecord(decisionID string) string` — id of the `CollTasks` node whose links include `decisionID`, else `""`.

- [ ] **Step 1: Write the failing tests**

Create `pkg/wavevault/address_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wavevault

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestAddressByCollection(t *testing.T) {
	parent := func(id string) string {
		if id == "d-owned" {
			return "t-1"
		}
		return ""
	}
	cases := []struct {
		name, collection, id, wantAddress, wantAnchor string
	}{
		{"a record addresses itself", CollTasks, "t-1", "task:t-1", ""},
		{"a memory node is a memory note", CollMemory, "m-1", "memnote:m-1", ""},
		{"a decision lands on its record, anchored", CollDecisions, "d-owned", "task:t-1", "d-owned"},
		{"a decision with no record has no address", CollDecisions, "d-orphan", "", ""},
		{"an attachment has no surface", CollAttachments, "a-1", "", ""},
	}
	for _, tc := range cases {
		gotAddress, gotAnchor := Address(tc.collection, tc.id, parent)
		if gotAddress != tc.wantAddress || gotAnchor != tc.wantAnchor {
			t.Errorf("%s: Address(%q, %q) = (%q, %q), want (%q, %q)",
				tc.name, tc.collection, tc.id, gotAddress, gotAnchor, tc.wantAddress, tc.wantAnchor)
		}
	}
}

func TestAddressWithNoParentLookupDropsADecision(t *testing.T) {
	if address, anchor := Address(CollDecisions, "d-1", nil); address != "" || anchor != "" {
		t.Fatalf("Address with a nil parent = (%q, %q), want no address", address, anchor)
	}
}

// a memory note can link a decision too; only a record owns one
func TestParentRecordIsTheRecordLinkingTheDecision(t *testing.T) {
	v, err := openVaultAt(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	write := func(rel, content string) {
		if err := os.WriteFile(filepath.Join(v.Root, rel), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("memory/m-1.md", "---\nid: m-1\n---\n\nMentions [[d-1]] as well.\n")
	write("tasks/active/t-1.md", "---\nid: t-1\nstatus: active\n---\n\nRefs: [[d-1]]\n")
	write("decisions/d-1.md", "---\nid: d-1\n---\n\nWe chose it.\n")

	r := v.Retriever(AllScope())
	if got := r.ParentRecord("d-1"); got != "t-1" {
		t.Fatalf("ParentRecord(d-1) = %q, want t-1", got)
	}
	if got := r.ParentRecord("d-unlinked"); got != "" {
		t.Fatalf("ParentRecord(d-unlinked) = %q, want none", got)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/wavevault/ -run 'TestAddress|TestParentRecord'`
Expected: build failure, `undefined: Address` and `r.ParentRecord undefined`.

- [ ] **Step 3: Implement**

Create `pkg/wavevault/address.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wavevault

// Address is the cockpit's navigation address for a vault node, plus the sub-object to land on within it.
// A decision has no surface of its own — the frontend renders it inside its parent record's thread — so it
// addresses that record and names itself as the anchor. parent finds the record; when it finds none the
// address is dropped rather than faked, because an Open that lands on a record id that does not exist is
// worse than no Open at all.
func Address(collection, id string, parent func(decisionID string) string) (address, anchor string) {
	switch collection {
	case CollTasks:
		return "task:" + id, ""
	case CollMemory:
		return "memnote:" + id, ""
	case CollDecisions:
		owner := ""
		if parent != nil {
			owner = parent(id)
		}
		if owner == "" {
			return "", ""
		}
		return "task:" + owner, id
	default:
		return "", ""
	}
}

// ParentRecord is the task record whose refs wikilink decisionID; AppendDecision writes that link on both
// sides. It reads this retriever's loaded graph, so a caller addressing many decisions reads the vault once.
// Empty when the scope holds no such record or the vault cannot be read.
func (r *Retriever) ParentRecord(decisionID string) string {
	owners, err := r.Query(Filter{HasLink: decisionID})
	if err != nil {
		return ""
	}
	for _, n := range owners {
		if n.Collection == CollTasks {
			return n.ID
		}
	}
	return ""
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/wavevault/`
Expected: `ok`.

- [ ] **Step 5: Route `jarvisvolunteer` through it**

In `pkg/jarvisvolunteer/recall.go`, replace everything from the `// address builds the frontend navigation address` comment (line 58) to the end of the file with:

```go
// address builds the frontend navigation address for a vault node, plus the sub-object to land on within
// it. wavevault.Address owns the rule, so a volunteered utterance and a recall citation address a node the
// same way; this only maps the suggestion's source type back to the collection it came from.
func (p *RecallProducer) address(ctx context.Context, sourceType, nodeID string) (ref, anchor string) {
	parent := func(decisionID string) string {
		if p.parentRecord == nil {
			return ""
		}
		return p.parentRecord(ctx, decisionID)
	}
	return wavevault.Address(collectionFor(sourceType), nodeID, parent)
}

// collectionFor inverts jarvisproactive.sourceTypeFor. An unknown source type has no collection, and so no
// address.
func collectionFor(sourceType string) string {
	switch sourceType {
	case "dossier":
		return wavevault.CollTasks
	case "decision":
		return wavevault.CollDecisions
	case "memory":
		return wavevault.CollMemory
	default:
		return ""
	}
}

// liveParentRecord opens the vault for the one decision a trigger can volunteer. Empty on any failure — the
// caller drops the address rather than emitting a broken one.
func liveParentRecord(ctx context.Context, decisionID string) string {
	v, err := wavevault.OpenVault(ctx)
	if err != nil {
		return ""
	}
	return v.Retriever(wavevault.Scope{Collections: []string{wavevault.CollTasks}}).ParentRecord(decisionID)
}
```

- [ ] **Step 6: Run the volunteer tests through the shared function**

Run: `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/jarvisvolunteer/ ./pkg/wavevault/ && go vet ./pkg/jarvisvolunteer/ ./pkg/wavevault/`
Expected: both `ok`, vet silent. `TestRecallRoutesEachSourceType` and `TestRecallResolvesDecisionToItsParentRecord` now exercise `wavevault.Address`.

- [ ] **Step 7: Format check**

Run: `gofmt -l pkg/wavevault/address.go pkg/wavevault/address_test.go pkg/jarvisvolunteer/recall.go`
Expected: no output.

---

### Task 2: Recall and ledger producers emit canonical addresses; cards carry an anchor

**Depends on:** Task 1

**Files:**
- Modify: `pkg/waveobj/jarvisconvo.go:47-55` (card gains `Anchor`)
- Modify: `pkg/jarvisrecall/cards.go` (`candidate`, `assembleCandidates`, `radarCandidate`, `memoryCandidate`, `buildCards`)
- Modify: `pkg/jarvisrecall/retrieve.go:253-274` (`nodeCandidate`)
- Modify: `pkg/jarvisrecall/recall.go:163` (the one `nodeCandidate` call)
- Modify: `pkg/jarvisstate/jarvisstate.go:89,163`
- Modify: `pkg/wshrpc/wshrpctypes_jarvis.go:447` (comment only)
- Regenerate: `frontend/types/gotypes.d.ts` via `task generate`
- Test: `pkg/jarvisrecall/cards_test.go`, `pkg/jarvisrecall/retrieve_test.go`, `pkg/jarvisstate/jarvisstate_test.go`

**Interfaces:**
- Consumes: `wavevault.Address`, `(*wavevault.Retriever).ParentRecord` (Task 1).
- Produces:
  - `waveobj.JarvisConvoGroundingCard.Anchor string` (`json:"anchor,omitempty"`) → TS `JarvisConvoGroundingCard.anchor?: string`.
  - `func nodeCandidate(n wavevault.Node, body string, seedRank int, parent func(decisionID string) string) candidate` (package-private).
  - Recall emits `task:` / `memnote:` for vault nodes, `memnote:` for memory notes, `radarreport:<oid>` + finding anchor for Radar; the ledger emits `task:<id>` for blockers and dossier events.

- [ ] **Step 1: Write the failing Go tests**

In `pkg/jarvisrecall/retrieve_test.go`, change the call in `TestNodeCandidateCarriesScopeAsProject` from `nodeCandidate(n, "body text", 0)` to `nodeCandidate(n, "body text", 0, nil)`, then add after that test:

```go
func TestNodeCandidateAddressesByCollection(t *testing.T) {
	parent := func(id string) string {
		if id == "dec-owned" {
			return "task-owner"
		}
		return ""
	}
	cases := []struct {
		collection, id, wantType, wantNav, wantAnchor string
	}{
		{wavevault.CollTasks, "task-a", "dossier", "task:task-a", ""},
		{wavevault.CollMemory, "mem-a", "memory", "memnote:mem-a", ""},
		{wavevault.CollDecisions, "dec-owned", "decision", "task:task-owner", "dec-owned"},
		{wavevault.CollDecisions, "dec-orphan", "decision", "", ""},
	}
	for _, tc := range cases {
		got := nodeCandidate(wavevault.Node{ID: tc.id, Collection: tc.collection}, "", 0, parent)
		if got.sourceType != tc.wantType || got.navTarget != tc.wantNav || got.anchor != tc.wantAnchor {
			t.Errorf("%s %s = (%q, %q, %q), want (%q, %q, %q)", tc.collection, tc.id,
				got.sourceType, got.navTarget, got.anchor, tc.wantType, tc.wantNav, tc.wantAnchor)
		}
	}
}

// AppendDecision links the decision from its record's refs, so recall's own retriever finds the record a
// decision citation lands on.
func TestNodeCandidateResolvesADecisionsRecordFromTheVault(t *testing.T) {
	v, dossierID := seedVault(t)
	r := v.Retriever(wavevault.AllScope())
	nodes, err := r.Query(wavevault.Filter{})
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	for _, n := range nodes {
		if n.Collection != wavevault.CollDecisions {
			continue
		}
		got := nodeCandidate(n, "", 0, r.ParentRecord)
		if got.navTarget != "task:"+dossierID || got.anchor != n.ID {
			t.Fatalf("decision candidate = (%q, %q), want (%q, %q)", got.navTarget, got.anchor, "task:"+dossierID, n.ID)
		}
		return
	}
	t.Fatal("seedVault wrote no decision node")
}
```

In `pkg/jarvisrecall/cards_test.go`, add after `TestAssembleCandidatesDedupesByNavTarget`:

```go
// a record and each of its decisions share one address, and are still different sources
func TestAssembleCandidatesKeepsARecordAndItsDecisionApart(t *testing.T) {
	scoped := []candidate{
		{navTarget: "task:t1", title: "record"},
		{navTarget: "task:t1", anchor: "dec-1", title: "decision"},
		{navTarget: "task:t1", anchor: "dec-1", title: "the same decision again"},
		{title: "a decision with no record"},
		{title: "another decision with no record"},
	}
	out := assembleCandidates(nil, scoped, maxCandidates)
	if len(out) != 4 {
		t.Fatalf("len = %d, want 4 (only the repeated decision dropped): %+v", len(out), out)
	}
}

func TestMemoryCandidateAddressesTheNote(t *testing.T) {
	c := memoryCandidate(memvault.Note{ID: "mem-1", Title: "a note"})
	if c.navTarget != "memnote:mem-1" {
		t.Fatalf("navTarget = %q, want memnote:mem-1", c.navTarget)
	}
}

func TestRadarCandidateAnchorsTheFinding(t *testing.T) {
	c := radarCandidate(&waveobj.RadarReport{OID: "rr-1", ProjectName: "p"}, waveobj.RadarFinding{ID: "f-1", Risk: "r", Why: "w"})
	if c.navTarget != "radarreport:rr-1" || c.anchor != "f-1" {
		t.Fatalf("radar candidate = (%q, %q), want (radarreport:rr-1, f-1)", c.navTarget, c.anchor)
	}
}

func TestBuildCardsCarriesTheAnchor(t *testing.T) {
	cards := buildCards([]candidate{{sourceType: "radar", navTarget: "radarreport:rr-1", anchor: "f-1"}}, 0)
	if cards[0].Anchor != "f-1" {
		t.Fatalf("Anchor = %q, want f-1", cards[0].Anchor)
	}
}
```

In `pkg/jarvisstate/jarvisstate_test.go`: in `TestActiveWorkIncludesLiveSessionsAndBlockers` change `blocker.NavTarget != "vault:d1"` to `blocker.NavTarget != "task:d1"`; in `TestTimelineMergesAndSortsDesc` change

```go
	if evs[0].Kind != "dossier" || evs[0].Title != "ship ledger" {
```

to

```go
	if evs[0].Kind != "dossier" || evs[0].Title != "ship ledger" || evs[0].NavTarget != "task:dd" {
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/jarvisrecall/ ./pkg/jarvisstate/`
Expected: jarvisrecall fails to build (`too many arguments in call to nodeCandidate`, `unknown field anchor`, `cards[0].Anchor undefined`); jarvisstate FAILs on `task:d1` / `task:dd`.

- [ ] **Step 3: Add the card field**

In `pkg/waveobj/jarvisconvo.go`, the card struct becomes:

```go
type JarvisConvoGroundingCard struct {
	N          int    `json:"n"`
	SourceType string `json:"sourcetype"`
	Title      string `json:"title"`
	Project    string `json:"project"`
	AgeMs      int64  `json:"agems"`
	Freshness  string `json:"freshness"`
	NavTarget  string `json:"navtarget"`
	Anchor     string `json:"anchor,omitempty"` // the sub-object to land on within NavTarget: a decision in its record, a finding in its report
}
```

- [ ] **Step 4: Update the recall candidates**

In `pkg/jarvisrecall/cards.go`:

1. Add `anchor string` to `candidate`, after `navTarget`, and extend its doc comment's first sentence with: `anchor names the sub-object within navTarget to land on (a decision in its record, a finding in its report).` The struct:

```go
type candidate struct {
	sourceType string
	title      string
	project    string
	ts         int64
	freshness  string
	navTarget  string
	anchor     string
	snippet    string
	seedRank   int
}
```

2. Replace `assembleCandidates` with:

```go
// assembleCandidates keeps every pinned candidate, then fills the remaining cap with scoped candidates.
func assembleCandidates(pinned, scoped []candidate, max int) []candidate {
	out := make([]candidate, 0, max)
	seen := make(map[string]bool, len(pinned)+len(scoped))
	repeated := func(c candidate) bool {
		k := sourceKey(c)
		if k == "" {
			return false
		}
		if seen[k] {
			return true
		}
		seen[k] = true
		return false
	}
	for _, c := range pinned {
		if !repeated(c) {
			out = append(out, c)
		}
	}
	for _, c := range scoped {
		if len(out) >= max {
			break
		}
		if !repeated(c) {
			out = append(out, c)
		}
	}
	return out
}

// sourceKey is the identity a candidate is deduped on: its address and the anchor within it, because a
// record and each of its decisions share one address. An unaddressed candidate has no key — it is a vault
// node whose decision found no record, and the walk reaches each node once.
func sourceKey(c candidate) string {
	if c.navTarget == "" {
		return ""
	}
	return c.navTarget + "#" + c.anchor
}
```

3. In `radarCandidate`, add `anchor: f.ID,` after the `navTarget:` line.
4. In `memoryCandidate`, replace `navTarget:  "memory:" + n.ID, // NOT a parseable ORef; real nav is Plan 4` with `navTarget:  "memnote:" + n.ID,`.
5. In `buildCards`, add `Anchor:     c.anchor,` after `NavTarget:  c.navTarget,`.

In `pkg/jarvisrecall/retrieve.go`, replace `nodeCandidate` and its comment with:

```go
// nodeCandidate maps a vault node + its body into a grounding candidate. Vault nodes are the canonical
// source, so freshness is always "fresh". The address comes from wavevault.Address, with parent finding a
// decision's record. seedRank is 0 for a node reached only by expansion.
func nodeCandidate(n wavevault.Node, body string, seedRank int, parent func(decisionID string) string) candidate {
	st := "memory"
	switch n.Collection {
	case wavevault.CollTasks:
		st = "dossier"
	case wavevault.CollDecisions:
		st = "decision"
	}
	navTarget, anchor := wavevault.Address(n.Collection, n.ID, parent)
	return candidate{
		sourceType: st,
		title:      nodeTitle(n),
		project:    n.Scope, // a mirrored hub note is another project's — say so rather than imply it is this one's
		ts:         n.UpdatedTs,
		freshness:  "fresh",
		navTarget:  navTarget,
		anchor:     anchor,
		snippet:    truncate(strings.TrimSpace(body), 240),
		seedRank:   seedRank,
	}
}
```

In `pkg/jarvisrecall/recall.go:163`, change `nodeCandidate(n, body, seedRank[n.ID])` to `nodeCandidate(n, body, seedRank[n.ID], r.ParentRecord)`.

- [ ] **Step 5: The ledger emits `task:`**

In `pkg/jarvisstate/jarvisstate.go`, change both `NavTarget: "vault:" + d.ID` (lines 89 and 163) to `NavTarget: "task:" + d.ID`.

In `pkg/wshrpc/wshrpctypes_jarvis.go:447`, change the trailing comment `// "run:<oid>" | "vault:<id>"` to `// "run:<oid>" | "task:<id>"`.

- [ ] **Step 6: Run the Go tests to verify they pass**

Run: `CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/jarvisrecall/ ./pkg/jarvisstate/ ./pkg/jarvisvolunteer/ ./pkg/wavevault/`
Expected: all `ok`.

- [ ] **Step 7: Regenerate bindings and confirm the only TS change**

Run: `task generate && git diff --stat -- frontend/types pkg/wshrpc/wshclient frontend/app/store/wshclientapi.ts && git diff -- frontend/types/gotypes.d.ts`
Expected: `gotypes.d.ts` gains exactly `anchor?: string;` inside `JarvisConvoGroundingCard` (and nothing else changes; if another type moved, stop — the generator picked up someone else's uncommitted Go change).

- [ ] **Step 8: Build and typecheck**

Run: `go build ./... && node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && gofmt -l pkg/waveobj/jarvisconvo.go pkg/jarvisrecall/cards.go pkg/jarvisrecall/retrieve.go pkg/jarvisrecall/recall.go pkg/jarvisrecall/cards_test.go pkg/jarvisrecall/retrieve_test.go pkg/jarvisstate/jarvisstate.go pkg/jarvisstate/jarvisstate_test.go`
Expected: build and tsc exit 0; gofmt lists nothing (if it lists a file, `gofmt -d` it and fix only your hunks).

---

### Task 3: Retire `terminalTargetAtom`

**Depends on:** none

**Files:**
- Modify: `frontend/app/view/agents/agents.tsx:74-75,158-165`
- Modify: `frontend/app/view/agents/channelsprimitives.tsx:38-42`
- Modify: `frontend/app/view/agents/cockpitsurface.tsx:283-285`
- Modify: `frontend/app/view/agents/sessionssurface.tsx:77-80`

**Interfaces:**
- Produces: `AgentsViewModel` no longer has `terminalTargetAtom`; `jumpToAgent(model, id)` writes only `focusIdAtom` and `surfaceAtom`. The router in Task 5 relies on this (its test model stub has no `terminalTargetAtom`).

Nothing reads the atom (spec §Problem, "Agent"), so this is a deletion with no behavior to test; the typecheck is the test.

- [ ] **Step 1: Delete the atom and its writes**

`agents.tsx` — delete these two lines:

```ts
    // the term blockId the Agent surface renders; undefined = no terminal open
    terminalTargetAtom = atom<string | undefined>(undefined) as PrimitiveAtom<string | undefined>;
```

and replace `openTerminal` with its comment:

```ts
    // openTerminal routes to the Agent surface (spec §6): focus the agent and switch surface. The Agent surface
    // renders the focused agent's live terminal; the controller starts on render.
    openTerminal(agentId: string) {
        globalStore.set(this.focusIdAtom, agentId);
        globalStore.set(this.surfaceAtom, "agent");
    }
```

`channelsprimitives.tsx` — `jumpToAgent` becomes:

```ts
export function jumpToAgent(model: AgentsViewModel, id: string) {
    globalStore.set(model.focusIdAtom, id);
    globalStore.set(model.surfaceAtom, "agent");
}
```

`cockpitsurface.tsx` — replace

```ts
    // open the agent in the Agent surface: clear any open terminal, set focus, switch surface
    const openFocus = (id: string, reply: boolean) => {
        globalStore.set(model.terminalTargetAtom, undefined);
        globalStore.set(model.focusIdAtom, id);
```

with

```ts
    // open the agent in the Agent surface: set focus, switch surface
    const openFocus = (id: string, reply: boolean) => {
        globalStore.set(model.focusIdAtom, id);
```

`sessionssurface.tsx` — in `runSessionPrimary`, delete the line `globalStore.set(model.terminalTargetAtom, undefined);`.

- [ ] **Step 2: Verify nothing references it and the tree typechecks**

Run: `grep -rn "terminalTargetAtom" frontend scripts; node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: grep prints nothing; tsc exit 0.

- [ ] **Step 3: Run the agents tests**

Run: `npx vitest run frontend/app/view/agents`
Expected: PASS (same count as before the change).

---

### Task 4: `parseAddress`, the one reader of addresses

**Depends on:** none

**Files:**
- Create: `frontend/app/view/jarvis/address.ts`
- Create: `frontend/app/view/jarvis/address.test.ts`

**Interfaces:**
- Produces (all exported from `frontend/app/view/jarvis/address.ts`):

```ts
export type OpenTarget =
    | { kind: "channel"; channelId: string; runId?: string }
    | { kind: "run"; runId: string }
    | { kind: "agent"; tabId: string }
    | { kind: "record"; dossierId: string; anchor?: string; view: "peek" | "vault" }
    | { kind: "memory-note"; noteId: string }
    | { kind: "effort"; effortId: string }
    | { kind: "radar"; reportId: string; findingId?: string };
export type Unsupported = { kind: "unsupported"; message: string };
export type AddressHint = { sourceType?: string; anchor?: string };
export const CANNOT_OPEN = "This item can't be opened";
export const CANNOT_LOCATE_RECORD = "This citation can't locate its record";
export function parseAddress(address: string, hint?: AddressHint): OpenTarget | Unsupported;
```

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/jarvis/address.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    CANNOT_LOCATE_RECORD,
    CANNOT_OPEN,
    parseAddress,
    type AddressHint,
    type OpenTarget,
} from "./address";

describe("parseAddress", () => {
    it.each<[string, AddressHint | undefined, OpenTarget]>([
        ["run:r-1", undefined, { kind: "run", runId: "r-1" }],
        ["channel:c-1", undefined, { kind: "channel", channelId: "c-1" }],
        ["tab:t-1", undefined, { kind: "agent", tabId: "t-1" }],
        // effort WorkRefs persist the older agent: spelling
        ["agent:t-1", undefined, { kind: "agent", tabId: "t-1" }],
        ["task:d-1", undefined, { kind: "record", dossierId: "d-1", view: "peek" }],
        [
            "task:d-1",
            { sourceType: "decision", anchor: "dec-1" },
            { kind: "record", dossierId: "d-1", anchor: "dec-1", view: "peek" },
        ],
        // an empty anchor is no anchor, not a highlight of nothing
        ["task:d-1", { anchor: "" }, { kind: "record", dossierId: "d-1", view: "peek" }],
        ["memnote:m-1", undefined, { kind: "memory-note", noteId: "m-1" }],
        // recall's pre-canonical memory citations, still in persisted conversation turns
        ["memory:m-1", undefined, { kind: "memory-note", noteId: "m-1" }],
        ["effort:e-1", undefined, { kind: "effort", effortId: "e-1" }],
        ["radarreport:rr-1", undefined, { kind: "radar", reportId: "rr-1" }],
        [
            "radarreport:rr-1",
            { sourceType: "radar", anchor: "f-1" },
            { kind: "radar", reportId: "rr-1", findingId: "f-1" },
        ],
    ])("reads %s with hint %j", (address, hint, want) => {
        expect(parseAddress(address, hint)).toEqual(want);
    });

    // a pre-canonical vault: citation named a node without its collection; the card's source type recovers it
    describe("the legacy vault: dialect", () => {
        it("opens a dossier, or a card with no source type, as a record", () => {
            expect(parseAddress("vault:d-1", { sourceType: "dossier" })).toEqual({
                kind: "record",
                dossierId: "d-1",
                view: "peek",
            });
            expect(parseAddress("vault:d-1")).toEqual({ kind: "record", dossierId: "d-1", view: "peek" });
        });

        it("opens a memory node as its note", () => {
            expect(parseAddress("vault:m-1", { sourceType: "memory" })).toEqual({ kind: "memory-note", noteId: "m-1" });
        });

        // the card never recorded which record the decision sits in, so there is nowhere honest to land
        it("refuses a decision it has no record for", () => {
            expect(parseAddress("vault:dec-1", { sourceType: "decision" })).toEqual({
                kind: "unsupported",
                message: CANNOT_LOCATE_RECORD,
            });
        });

        it("does not guess at any other source type", () => {
            expect(parseAddress("vault:x", { sourceType: "status" })).toEqual({
                kind: "unsupported",
                message: CANNOT_OPEN,
            });
        });
    });

    // radar: is the attachment namespace (resolveAttached), not an address
    it.each(["commit:abc", "session:s-1", "radar:f-1", "decision:dec-1"])("leaves %s unsupported", (address) => {
        expect(parseAddress(address)).toEqual({ kind: "unsupported", message: CANNOT_OPEN });
    });

    it("is total on malformed input (never throws)", () => {
        const malformed = ["", "nope", "run:", ":x", "run:a:b", undefined, null] as unknown as string[];
        for (const address of malformed) {
            expect(parseAddress(address).kind).toBe("unsupported");
        }
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run frontend/app/view/jarvis/address.test.ts`
Expected: FAIL — `Failed to resolve import "./address"`.

- [ ] **Step 3: Implement**

Create `frontend/app/view/jarvis/address.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Cockpit addresses: the strings a card, citation, palette row, graph node or pet act points at, and the one
// place a string becomes a destination. Go emits the canonical dialect. The legacy strings are read here only
// because persisted conversation turns and effort WorkRefs still carry them. Pure and total: malformed input
// is unsupported, never a throw.

export type OpenTarget =
    | { kind: "channel"; channelId: string; runId?: string }
    | { kind: "run"; runId: string }
    | { kind: "agent"; tabId: string }
    | { kind: "record"; dossierId: string; anchor?: string; view: "peek" | "vault" }
    | { kind: "memory-note"; noteId: string }
    | { kind: "effort"; effortId: string }
    | { kind: "radar"; reportId: string; findingId?: string };

export type Unsupported = { kind: "unsupported"; message: string };

// what a citation knows beyond its address: the source type, and the sub-object to land on within it
export type AddressHint = { sourceType?: string; anchor?: string };

export const CANNOT_OPEN = "This item can't be opened";
export const CANNOT_LOCATE_RECORD = "This citation can't locate its record";

export function parseAddress(address: string, hint?: AddressHint): OpenTarget | Unsupported {
    const parts = (address ?? "").split(":");
    if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
        return { kind: "unsupported", message: CANNOT_OPEN };
    }
    const [kind, id] = parts;
    const anchor = hint?.anchor || undefined;
    switch (kind) {
        case "run":
            return { kind: "run", runId: id };
        case "channel":
            return { kind: "channel", channelId: id };
        case "tab":
        case "agent":
            return { kind: "agent", tabId: id };
        case "task":
            return { kind: "record", dossierId: id, anchor, view: "peek" };
        case "memnote":
        case "memory":
            return { kind: "memory-note", noteId: id };
        case "effort":
            return { kind: "effort", effortId: id };
        case "radarreport":
            return { kind: "radar", reportId: id, findingId: anchor };
        case "vault":
            return parseVaultNode(id, hint?.sourceType);
        default:
            return { kind: "unsupported", message: CANNOT_OPEN };
    }
}

// vault:<id> named a node without its collection. The card's source type recovers the collection — except for
// a decision, whose record the card never recorded.
function parseVaultNode(id: string, sourceType: string | undefined): OpenTarget | Unsupported {
    if (sourceType == null || sourceType === "" || sourceType === "dossier") {
        return { kind: "record", dossierId: id, view: "peek" };
    }
    if (sourceType === "memory") {
        return { kind: "memory-note", noteId: id };
    }
    if (sourceType === "decision") {
        return { kind: "unsupported", message: CANNOT_LOCATE_RECORD };
    }
    return { kind: "unsupported", message: CANNOT_OPEN };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run frontend/app/view/jarvis/address.test.ts`
Expected: PASS.

- [ ] **Step 5: Format (both files are new)**

Run: `npx prettier --write frontend/app/view/jarvis/address.ts frontend/app/view/jarvis/address.test.ts && npx vitest run frontend/app/view/jarvis/address.test.ts`
Expected: PASS after formatting.

---

### Task 5: `openTarget` and `openAddress` — the landings

**Depends on:** Task 3, Task 4

**Files:**
- Modify: `frontend/app/view/jarvis/tasksstore.ts:19-29` (awaitable refresh)
- Modify: `frontend/app/view/agents/radarstore.ts:59-125` (`scopeOfReport`, per-path load guard)
- Rewrite: `frontend/app/view/jarvis/openref.ts`
- Rewrite: `frontend/app/view/jarvis/openref.test.ts`

**Interfaces:**
- Consumes: `parseAddress`, `OpenTarget`, `AddressHint` (Task 4); `jumpToAgent` without `terminalTargetAtom` (Task 3).
- Produces:
  - `export async function refreshTaskList(): Promise<void>` in `tasksstore.ts` (failures land in `tasksErrorAtom`, never thrown).
  - `export function scopeOfReport(report: RadarReport): RadarScope` in `radarstore.ts`.
  - In `openref.ts`:
    - `export type OpenResult = { ok: true; notice?: string } | { ok: false; reason: "unsupported" | "unavailable" | "failed" | "superseded"; message: string };`
    - `export type ReportOpen = (result: OpenResult) => void;`
    - `export async function openTarget(model: AgentsViewModel, target: OpenTarget, report?: ReportOpen): Promise<OpenResult>`
    - `export async function openAddress(model: AgentsViewModel, address: string, hint?: AddressHint, report?: ReportOpen): Promise<OpenResult>`
    - `export async function openChannelSheet(channelId: string, runId: string | null): Promise<void>` (unchanged, still exported for Jarvis's own flows)
    - Legacy, deleted in Task 7: `orefNavPlan(oref): { kind: string }`, `openORef(model, oref, anchor?)`, `openQueueTarget(model, target)`, and `openRecordInVault(model, dossierId)` still exported.

- [ ] **Step 1: Write the failing landing tests**

Replace `frontend/app/view/jarvis/openref.test.ts` entirely with:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({
    GetDossierCommand: vi.fn(),
    ListTaskDossiersCommand: vi.fn(),
    ListRadarReportsCommand: vi.fn(),
    MemoryScanCommand: vi.fn(),
    MemoryReadCommand: vi.fn(),
    GetChannelRunsCommand: vi.fn(),
    GetChannelMessagesCommand: vi.fn(),
    SetChannelReadCommand: vi.fn(),
}));
const loadAndPin = vi.hoisted(() => vi.fn());
const pushToast = vi.hoisted(() => vi.fn());

vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: rpc }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/wos", async () => {
    const { atom } = await import("jotai");
    return {
        loadAndPinWaveObject: (...a: unknown[]) => loadAndPin(...a),
        makeORef: (otype: string, oid: string) => `${otype}:${oid}`,
        getWaveObjectAtom: () => atom(null),
    };
});
vi.mock("@/app/cockpit/notificationstore", () => ({ pushToast: (...a: unknown[]) => pushToast(...a) }));

import { globalStore } from "@/app/store/jotaiStore";
import { atom } from "jotai";
import type { AgentsViewModel, SurfaceKey } from "../agents/agents";
import type { AgentVM } from "../agents/agentsviewmodel";
import { memLoadedAtom, memNotesAtom, memSelectedIdAtom } from "../agents/memstore";
import type { MemNote } from "../agents/memtypes";
import {
    currentReportIdAtom,
    loadReports,
    radarReportsAtom,
    radarScopeAtom,
    radarSelectedIdAtom,
} from "../agents/radarstore";
import { vaultRecordIdAtom, vaultRecordPaneAtom, vaultTabAtom } from "../agents/vaultstore";
import { briefPeekRecordAtom, briefSheetOpenAtom } from "./jarvisstore";
import { activeRunIdAtom, activeSubjectAtom, recordDetailAtom } from "./jarvissubjectstore";
import { openAddress, openTarget } from "./openref";
import { pendingDecisionAnchorAtom } from "./petstore";
import { taskListAtom, tasksErrorAtom } from "./tasksstore";

const objects = new Map<string, unknown>();

function makeModel(roster: string[] = []): AgentsViewModel {
    const agents = roster.map((id) => ({ id, name: id, task: "", state: "working" }) as AgentVM);
    return {
        surfaceAtom: atom<SurfaceKey>("cockpit"),
        focusIdAtom: atom<string | undefined>(undefined),
        agentsAtom: atom(agents),
        terminalsAtom: atom<AgentVM[]>([]),
    } as unknown as AgentsViewModel;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
}

function report(oid: string, path: string, startedts: number, findingIds: string[] = []): RadarReport {
    return {
        oid,
        projectname: path.slice(1),
        projectpath: path,
        startedts,
        findings: findingIds.map((id) => ({ id })),
    } as unknown as RadarReport;
}

const REPORTS_B = [report("rb-new", "/b", 2, ["f-1"]), report("rb-old", "/b", 1, ["f-1"])];

function seedReports(): void {
    for (const r of REPORTS_B) {
        objects.set(`radarreport:${r.oid}`, r);
    }
}

function note(id: string): MemNote {
    return {
        id,
        title: id,
        description: "",
        type: "",
        scope: "shared",
        source: "vault",
        path: `/m/${id}.md`,
        links: [],
        updatedts: 1,
        reviewed: true,
    } as unknown as MemNote;
}

beforeEach(() => {
    vi.resetAllMocks();
    objects.clear();
    loadAndPin.mockImplementation((oref: string) => Promise.resolve(objects.get(oref) ?? null));
    rpc.GetChannelRunsCommand.mockResolvedValue({ runs: [] });
    rpc.GetChannelMessagesCommand.mockResolvedValue({ messages: [] });
    rpc.SetChannelReadCommand.mockResolvedValue(undefined);
    rpc.MemoryReadCommand.mockResolvedValue({ body: "", note: { updatedts: 1 } });
    globalStore.set(taskListAtom, null);
    globalStore.set(tasksErrorAtom, null);
    globalStore.set(memNotesAtom, []);
    globalStore.set(memLoadedAtom, false);
    globalStore.set(memSelectedIdAtom, null);
    globalStore.set(radarScopeAtom, null);
    globalStore.set(radarReportsAtom, null);
    globalStore.set(currentReportIdAtom, undefined);
    globalStore.set(radarSelectedIdAtom, undefined);
    globalStore.set(briefPeekRecordAtom, null);
    globalStore.set(briefSheetOpenAtom, false);
    globalStore.set(pendingDecisionAnchorAtom, null);
    globalStore.set(activeSubjectAtom, null);
    globalStore.set(activeRunIdAtom, {});
    globalStore.set(recordDetailAtom, {});
    globalStore.set(vaultRecordIdAtom, null);
    globalStore.set(vaultRecordPaneAtom, "list");
    globalStore.set(vaultTabAtom, "memory");
});

describe("run and channel landings", () => {
    it("lands a run on its channel's sheet, on that run", async () => {
        const model = makeModel();
        objects.set("run:r1", { oid: "r1", channeloid: "c1" });
        objects.set("channel:c1", { oid: "c1" });
        expect(await openTarget(model, { kind: "run", runId: "r1" })).toEqual({ ok: true });
        expect(globalStore.get(activeSubjectAtom)).toEqual({ kind: "channel", id: "c1" });
        expect(globalStore.get(activeRunIdAtom)["c1"]).toBe("r1");
        expect(globalStore.get(briefSheetOpenAtom)).toBe(true);
        expect(globalStore.get(model.surfaceAtom)).toBe("jarvis");
    });

    it("reports a missing run and leaves the user where they were", async () => {
        const model = makeModel();
        const result = await openTarget(model, { kind: "run", runId: "r-gone" });
        expect(result).toEqual({ ok: false, reason: "unavailable", message: "That run no longer exists" });
        expect(globalStore.get(model.surfaceAtom)).toBe("cockpit");
        expect(pushToast).toHaveBeenCalledWith({ title: "That run no longer exists", message: "", level: "warn" });
    });

    it("reports a run that has no channel to open it in", async () => {
        const model = makeModel();
        objects.set("run:r1", { oid: "r1", channeloid: "" });
        expect(await openTarget(model, { kind: "run", runId: "r1" })).toEqual({
            ok: false,
            reason: "unavailable",
            message: "That run has no channel to open it in",
        });
        expect(globalStore.get(briefSheetOpenAtom)).toBe(false);
    });

    it("reports a channel that no longer exists", async () => {
        const model = makeModel();
        expect(await openTarget(model, { kind: "channel", channelId: "c-gone" })).toEqual({
            ok: false,
            reason: "unavailable",
            message: "That channel no longer exists",
        });
        expect(rpc.GetChannelRunsCommand).not.toHaveBeenCalled();
    });

    it("names the target when a load throws", async () => {
        const model = makeModel();
        loadAndPin.mockRejectedValue(new Error("db closed"));
        expect(await openTarget(model, { kind: "run", runId: "r1" })).toEqual({
            ok: false,
            reason: "failed",
            message: "Couldn't open run r1: db closed",
        });
        expect(pushToast).toHaveBeenCalledWith({ title: "Couldn't open run r1: db closed", message: "", level: "error" });
    });
});

describe("agent landing", () => {
    it("focuses an agent still in the roster", async () => {
        const model = makeModel(["t1"]);
        expect(await openAddress(model, "tab:t1")).toEqual({ ok: true });
        expect(globalStore.get(model.focusIdAtom)).toBe("t1");
        expect(globalStore.get(model.surfaceAtom)).toBe("agent");
    });

    it("reports an agent that has left the roster", async () => {
        const model = makeModel(["t1"]);
        expect(await openAddress(model, "agent:t2")).toEqual({
            ok: false,
            reason: "unavailable",
            message: "That agent session has ended",
        });
        expect(globalStore.get(model.surfaceAtom)).toBe("cockpit");
    });
});

describe("record landing", () => {
    it("opens a decision's record in the peek with the decision anchored", async () => {
        const model = makeModel();
        globalStore.set(taskListAtom, [{ id: "task-a" } as SpaceSummary]);
        expect(await openAddress(model, "task:task-a", { sourceType: "decision", anchor: "dec-1" })).toEqual({ ok: true });
        expect(globalStore.get(briefPeekRecordAtom)).toBe("task-a");
        expect(globalStore.get(pendingDecisionAnchorAtom)).toBe("dec-1");
        expect(globalStore.get(model.surfaceAtom)).toBe("jarvis");
        expect(rpc.ListTaskDossiersCommand).not.toHaveBeenCalled();
    });

    it("loads the record list before calling a record gone, and says so", async () => {
        const model = makeModel();
        rpc.ListTaskDossiersCommand.mockResolvedValue({ dossiers: [{ id: "other" }] });
        expect(await openAddress(model, "task:task-a")).toEqual({
            ok: false,
            reason: "unavailable",
            message: "That record no longer exists",
        });
        expect(rpc.ListTaskDossiersCommand).toHaveBeenCalled();
        expect(globalStore.get(briefPeekRecordAtom)).toBeNull();
        expect(globalStore.get(model.surfaceAtom)).toBe("cockpit");
    });

    // the list loads once per Brief mount, so a record created since is not in it yet
    it("refreshes a loaded list once before calling a record gone", async () => {
        const model = makeModel();
        globalStore.set(taskListAtom, [{ id: "old" } as SpaceSummary]);
        rpc.ListTaskDossiersCommand.mockResolvedValue({ dossiers: [{ id: "old" }, { id: "task-new" }] });
        expect(await openAddress(model, "task:task-new")).toEqual({ ok: true });
        expect(globalStore.get(briefPeekRecordAtom)).toBe("task-new");
    });

    it("reports a list that failed to load as a failure, not as a missing record", async () => {
        const model = makeModel();
        rpc.ListTaskDossiersCommand.mockRejectedValue(new Error("vault locked"));
        const result = await openAddress(model, "task:task-a");
        expect(result.ok).toBe(false);
        expect(result.ok ? null : result.reason).toBe("failed");
        expect(result.ok ? "" : result.message).toContain("record task-a");
    });

    it("opens a record in the Vault, on the detail pane, without leaving the peek behind", async () => {
        const model = makeModel();
        globalStore.set(taskListAtom, [{ id: "task-a" } as SpaceSummary]);
        globalStore.set(briefPeekRecordAtom, "task-a");
        rpc.GetDossierCommand.mockResolvedValue({ id: "task-a", status: "active", decisions: [] });
        expect(await openTarget(model, { kind: "record", dossierId: "task-a", view: "vault" })).toEqual({ ok: true });
        expect(globalStore.get(vaultRecordIdAtom)).toBe("task-a");
        expect(globalStore.get(vaultRecordPaneAtom)).toBe("detail");
        expect(globalStore.get(vaultTabAtom)).toBe("records");
        expect(globalStore.get(briefPeekRecordAtom)).toBeNull();
        expect(globalStore.get(model.surfaceAtom)).toBe("vault");
        await vi.waitFor(() => expect(globalStore.get(recordDetailAtom)["task-a"]).toBeDefined());
    });
});

describe("memory note landing", () => {
    it("scans memory before judging a note, then opens it in the Vault", async () => {
        const model = makeModel();
        rpc.MemoryScanCommand.mockResolvedValue({ notes: [note("n1")], edges: [] });
        expect(await openAddress(model, "memnote:n1")).toEqual({ ok: true });
        expect(rpc.MemoryScanCommand).toHaveBeenCalledTimes(1);
        expect(globalStore.get(memSelectedIdAtom)).toBe("n1");
        expect(globalStore.get(vaultTabAtom)).toBe("memory");
        expect(globalStore.get(model.surfaceAtom)).toBe("vault");
    });

    it("reports a note that is gone after the scan", async () => {
        const model = makeModel();
        rpc.MemoryScanCommand.mockResolvedValue({ notes: [note("n1")], edges: [] });
        expect(await openAddress(model, "memory:n2")).toEqual({
            ok: false,
            reason: "unavailable",
            message: "That memory note no longer exists",
        });
        expect(globalStore.get(model.surfaceAtom)).toBe("cockpit");
    });
});

describe("radar landing", () => {
    it("owns the report's project before selecting the report, so the project's newest does not win", async () => {
        const model = makeModel();
        seedReports();
        rpc.ListRadarReportsCommand.mockResolvedValue({ reports: REPORTS_B });
        expect(await openAddress(model, "radarreport:rb-old", { anchor: "f-1" })).toEqual({ ok: true });
        expect(rpc.ListRadarReportsCommand).toHaveBeenCalledWith(expect.anything(), { projectpath: "/b" });
        expect(globalStore.get(radarScopeAtom)).toEqual({ name: "b", path: "/b" });
        expect(globalStore.get(currentReportIdAtom)).toBe("rb-old");
        expect(globalStore.get(radarSelectedIdAtom)).toBe("f-1");
        expect(globalStore.get(model.surfaceAtom)).toBe("radar");
    });

    it("lands on the report and says so when the finding is no longer in it", async () => {
        const model = makeModel();
        seedReports();
        rpc.ListRadarReportsCommand.mockResolvedValue({ reports: REPORTS_B });
        expect(await openAddress(model, "radarreport:rb-old", { anchor: "f-gone" })).toEqual({
            ok: true,
            notice: "That finding is no longer in this report",
        });
        expect(globalStore.get(currentReportIdAtom)).toBe("rb-old");
        expect(globalStore.get(radarSelectedIdAtom)).toBeUndefined();
        expect(pushToast).toHaveBeenCalledWith({
            title: "That finding is no longer in this report",
            message: "",
            level: "info",
        });
    });

    it("reports a deleted report", async () => {
        const model = makeModel();
        expect(await openAddress(model, "radarreport:rr-gone")).toEqual({
            ok: false,
            reason: "unavailable",
            message: "That scan report no longer exists",
        });
    });

    it("is not overwritten by another project's report load still in flight", async () => {
        const model = makeModel();
        seedReports();
        globalStore.set(radarScopeAtom, { name: "a", path: "/a" });
        const slowA = deferred<{ reports: RadarReport[] }>();
        rpc.ListRadarReportsCommand.mockImplementation((_client: unknown, data: { projectpath: string }) =>
            data.projectpath === "/a" ? slowA.promise : Promise.resolve({ reports: REPORTS_B })
        );
        const loadingA = loadReports("/a");

        expect(await openAddress(model, "radarreport:rb-old", { anchor: "f-1" })).toEqual({ ok: true });

        slowA.resolve({ reports: [report("ra-new", "/a", 9)] });
        await loadingA;
        expect(globalStore.get(currentReportIdAtom)).toBe("rb-old");
        expect(globalStore.get(radarReportsAtom)?.map((r) => r.oid)).toEqual(["rb-new", "rb-old"]);
    });
});

describe("effort landing", () => {
    it("opens the initiative's sheet", async () => {
        const model = makeModel();
        expect(await openAddress(model, "effort:e-1")).toEqual({ ok: true });
        expect(globalStore.get(activeSubjectAtom)).toEqual({ kind: "effort", id: "e-1" });
        expect(globalStore.get(briefSheetOpenAtom)).toBe(true);
        expect(globalStore.get(model.surfaceAtom)).toBe("jarvis");
    });
});

describe("a newer open", () => {
    it("supersedes a landing still loading, which then writes and reports nothing", async () => {
        const model = makeModel(["t1"]);
        const slow = deferred<unknown>();
        objects.set("channel:c1", { oid: "c1" });
        loadAndPin.mockImplementation((oref: string) =>
            oref === "run:r-slow" ? slow.promise : Promise.resolve(objects.get(oref) ?? null)
        );
        const first = openTarget(model, { kind: "run", runId: "r-slow" });
        expect(await openTarget(model, { kind: "agent", tabId: "t1" })).toEqual({ ok: true });

        slow.resolve({ oid: "r-slow", channeloid: "c1" });
        expect(await first).toEqual({ ok: false, reason: "superseded", message: "" });
        expect(globalStore.get(model.surfaceAtom)).toBe("agent");
        expect(globalStore.get(briefSheetOpenAtom)).toBe(false);
        expect(rpc.GetChannelRunsCommand).not.toHaveBeenCalled();
        expect(pushToast).not.toHaveBeenCalled();
    });

    it("includes a click on an address nothing can open", async () => {
        const model = makeModel();
        const slow = deferred<unknown>();
        loadAndPin.mockImplementation(() => slow.promise);
        const first = openTarget(model, { kind: "run", runId: "r-slow" });
        await openAddress(model, "bogus:x");
        slow.resolve({ oid: "r-slow", channeloid: "c1" });
        expect(await first).toEqual({ ok: false, reason: "superseded", message: "" });
        expect(globalStore.get(model.surfaceAtom)).toBe("cockpit");
    });
});

describe("unsupported addresses", () => {
    it("reports an address nothing can open, and stays put", async () => {
        const model = makeModel();
        expect(await openAddress(model, "bogus:x")).toEqual({
            ok: false,
            reason: "unsupported",
            message: "This item can't be opened",
        });
        expect(pushToast).toHaveBeenCalledWith({ title: "This item can't be opened", message: "", level: "warn" });
        expect(globalStore.get(model.surfaceAtom)).toBe("cockpit");
    });

    it("hands the result to a caller that renders failure itself, instead of toasting", async () => {
        const model = makeModel();
        const report = vi.fn();
        await openAddress(model, "vault:dec-1", { sourceType: "decision" }, report);
        expect(report).toHaveBeenCalledWith({
            ok: false,
            reason: "unsupported",
            message: "This citation can't locate its record",
        });
        expect(pushToast).not.toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run frontend/app/view/jarvis/openref.test.ts`
Expected: FAIL — `openTarget`/`openAddress` are not exported (`is not a function`), and `loadReports`-related asserts fail.

- [ ] **Step 3: Make the record list awaitable**

In `frontend/app/view/jarvis/tasksstore.ts`, replace `loadTaskList` with:

```ts
export function loadTaskList(): void {
    fireAndForget(refreshTaskList);
}

// awaitable for a caller that has to know the list before it acts; a failure lands in tasksErrorAtom
export async function refreshTaskList(): Promise<void> {
    try {
        const rtn = await RpcApi.ListTaskDossiersCommand(TabRpcClient);
        globalStore.set(taskListAtom, rtn?.dossiers ?? []);
        globalStore.set(tasksErrorAtom, null);
    } catch (e) {
        globalStore.set(tasksErrorAtom, String(e));
    }
}
```

- [ ] **Step 4: Scope a report to its own project, and guard report loads per path**

In `frontend/app/view/agents/radarstore.ts`:

1. Add above `findNewestScannedProject`:

```ts
// A report names its own project, so a scope built from it needs no registry — which is what lets Radar land
// on a report before the project registry has loaded.
export function scopeOfReport(report: RadarReport): RadarScope {
    return { name: report.projectname || report.projectpath, path: report.projectpath };
}
```

2. In `findNewestScannedProject`, replace `return { name: newest.projectname || newest.projectpath, path: newest.projectpath };` with `return scopeOfReport(newest);`.

3. Replace `let loading = false;` and `loadReports` with:

```ts
// In-flight report loads, by path. A repeat for the same path is dropped; a load for another path is not,
// because a landing that re-scopes Radar has to get its own list rather than return with none.
const loadingPaths = new Set<string>();

// loadReports fetches the report list for a path (newest-first) and selects the newest.
export async function loadReports(path: string): Promise<void> {
    if (loadingPaths.has(path)) {
        return;
    }
    loadingPaths.add(path);
    try {
        const rtn = await RpcApi.ListRadarReportsCommand(TabRpcClient, { projectpath: path });
        // the scope moved while this was in flight: its newest report would land over the scope that replaced it
        if (globalStore.get(radarScopeAtom)?.path !== path) {
            return;
        }
        const list = (rtn.reports ?? []).slice().sort((a, b) => b.startedts - a.startedts);
        globalStore.set(radarReportsAtom, list);
        if (list.length > 0) {
            await selectReport(list[0].oid);
        } else {
            globalStore.set(currentReportIdAtom, undefined);
        }
    } catch (err) {
        console.error("loading radar reports failed", err);
        if (globalStore.get(radarScopeAtom)?.path === path) {
            globalStore.set(radarReportsAtom, []);
        }
    } finally {
        loadingPaths.delete(path);
    }
}
```

Both callers of `loadReports` pass the owned scope's path (`initRadarScope` sets the scope first; `startScan` is called with `scope.path` from `radarsurface.tsx:227` and `radarscanstatepanel.tsx:83`), so the new check never drops a load that should land.

- [ ] **Step 5: Rewrite the router**

Replace `frontend/app/view/jarvis/openref.ts` entirely with:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The cockpit's one router. A caller holding a string goes through openAddress (parseAddress, then
// openTarget); a caller holding an id builds the target. A landing loads what proves its target exists,
// writes the destination's selection, then switches surface, so the destination renders the item on its first
// frame and a click never flashes the wrong one. A landing that cannot open says why and leaves the user where
// they were — a silent no-op is the failure this module exists to remove.

import { pushToast } from "@/app/cockpit/notificationstore";
import { globalStore } from "@/app/store/global";
import * as WOS from "@/app/store/wos";
import { fireAndForget } from "@/util/util";
import type { AgentsViewModel } from "../agents/agents";
import { jumpToAgent } from "../agents/channelsprimitives";
import { selectChannel } from "../agents/channelsstore";
import { loadMemory, memErrorAtom, memNotesAtom, selectNote } from "../agents/memstore";
import { initRadarScope, radarScopeAtom, radarSelectedIdAtom, scopeOfReport, selectReport } from "../agents/radarstore";
import { vaultFocusAtom, vaultRecordIdAtom, vaultRecordPaneAtom, vaultTabAtom } from "../agents/vaultstore";
import { parseAddress, type AddressHint, type OpenTarget } from "./address";
import type { QueueOpenTarget } from "./briefingmodel";
import { briefPeekRecordAtom, briefSheetOpenAtom } from "./jarvisstore";
import { loadRecordDetail, selectSubject, setActiveRunId } from "./jarvissubjectstore";
import { pendingDecisionAnchorAtom } from "./petstore";
import { refreshTaskList, taskListAtom, tasksErrorAtom } from "./tasksstore";

export type OpenResult =
    | { ok: true; notice?: string }
    | { ok: false; reason: "unsupported" | "unavailable" | "failed" | "superseded"; message: string };

export type ReportOpen = (result: OpenResult) => void;

type RecordTarget = Extract<OpenTarget, { kind: "record" }>;
type MemoryNoteTarget = Extract<OpenTarget, { kind: "memory-note" }>;
type RadarTarget = Extract<OpenTarget, { kind: "radar" }>;

const OK: OpenResult = { ok: true };
const SUPERSEDED: OpenResult = { ok: false, reason: "superseded", message: "" };

function unavailable(message: string): OpenResult {
    return { ok: false, reason: "unavailable", message };
}

function failed(target: OpenTarget, why: string): OpenResult {
    return { ok: false, reason: "failed", message: `Couldn't open ${targetName(target)}: ${why}` };
}

function targetName(target: OpenTarget): string {
    switch (target.kind) {
        case "channel":
            return `channel ${target.channelId}`;
        case "run":
            return `run ${target.runId}`;
        case "agent":
            return `agent ${target.tabId}`;
        case "record":
            return `record ${target.dossierId}`;
        case "memory-note":
            return `memory note ${target.noteId}`;
        case "effort":
            return `initiative ${target.effortId}`;
        case "radar":
            return `scan report ${target.reportId}`;
    }
}

// A landing waits on its load, so a second click can start before the first lands. Each open takes the next
// number, and a landing that finds the counter moved on during an await is superseded and writes nothing more.
let openSeq = 0;

export async function openTarget(
    model: AgentsViewModel,
    target: OpenTarget,
    report: ReportOpen = toast
): Promise<OpenResult> {
    const token = ++openSeq;
    const current = () => token === openSeq;
    let result: OpenResult;
    try {
        result = await land(model, target, current);
    } catch (e) {
        result = current() ? failed(target, e instanceof Error ? e.message : String(e)) : SUPERSEDED;
    }
    deliver(result, report);
    return result;
}

export async function openAddress(
    model: AgentsViewModel,
    address: string,
    hint?: AddressHint,
    report: ReportOpen = toast
): Promise<OpenResult> {
    const parsed = parseAddress(address, hint);
    if (parsed.kind !== "unsupported") {
        return openTarget(model, parsed, report);
    }
    // a click on a dead address is still the user's latest; a slower landing must not arrive over its toast
    ++openSeq;
    const result: OpenResult = { ok: false, reason: "unsupported", message: parsed.message };
    deliver(result, report);
    return result;
}

// superseded is never reported: the open that replaced it is the one the user is waiting on
function deliver(result: OpenResult, report: ReportOpen): void {
    if (result.ok ? result.notice != null : result.reason !== "superseded") {
        report(result);
    }
}

function toast(result: OpenResult): void {
    if (result.ok) {
        pushToast({ title: result.notice ?? "", message: "", level: "info" });
        return;
    }
    pushToast({ title: result.message, message: "", level: result.reason === "failed" ? "error" : "warn" });
}

async function land(model: AgentsViewModel, target: OpenTarget, current: () => boolean): Promise<OpenResult> {
    switch (target.kind) {
        case "channel":
            return landChannel(model, target.channelId, target.runId, current);
        case "run":
            return landRun(model, target.runId, current);
        case "agent":
            return landAgent(model, target.tabId);
        case "record":
            return landRecord(model, target, current);
        case "memory-note":
            return landMemoryNote(model, target, current);
        case "effort":
            openEffortSheet(target.effortId);
            globalStore.set(model.surfaceAtom, "jarvis");
            return OK;
        case "radar":
            return landRadar(model, target, current);
    }
}

async function landChannel(
    model: AgentsViewModel,
    channelId: string,
    runId: string | undefined,
    current: () => boolean
): Promise<OpenResult> {
    const channel = await WOS.loadAndPinWaveObject<Channel>(WOS.makeORef("channel", channelId));
    if (!current()) {
        return SUPERSEDED;
    }
    if (channel == null) {
        return unavailable("That channel no longer exists");
    }
    await openChannelSheet(channelId, runId ?? null);
    if (!current()) {
        return SUPERSEDED;
    }
    globalStore.set(model.surfaceAtom, "jarvis");
    return OK;
}

// A run is not a subject kind of its own: it resolves from its channel plus the selected run id, which is what
// stageRunAtom reads. The channel comes off the run's own object, because a run row projected from WorkState
// carries no channel.
async function landRun(model: AgentsViewModel, runId: string, current: () => boolean): Promise<OpenResult> {
    const run = await WOS.loadAndPinWaveObject<Run>(WOS.makeORef("run", runId));
    if (!current()) {
        return SUPERSEDED;
    }
    if (run == null) {
        return unavailable("That run no longer exists");
    }
    if (!run.channeloid) {
        return unavailable("That run has no channel to open it in");
    }
    return landChannel(model, run.channeloid, runId, current);
}

function landAgent(model: AgentsViewModel, tabId: string): OpenResult {
    // the Agent surface shows a background terminal as readily as an agent, so both count as the roster
    const roster = [...globalStore.get(model.agentsAtom), ...globalStore.get(model.terminalsAtom)];
    if (!roster.some((a) => a.id === tabId)) {
        return unavailable("That agent session has ended");
    }
    jumpToAgent(model, tabId);
    return OK;
}

// The peek renders nothing until the record's detail loads, so it cannot say a record is gone; the list can.
// The list loads once per Brief mount, so a record created since is refreshed in before it is called missing.
async function landRecord(model: AgentsViewModel, target: RecordTarget, current: () => boolean): Promise<OpenResult> {
    const listed = () => globalStore.get(taskListAtom)?.some((d) => d.id === target.dossierId) === true;
    if (!listed()) {
        await refreshTaskList();
        if (!current()) {
            return SUPERSEDED;
        }
        if (!listed()) {
            const loadError = globalStore.get(tasksErrorAtom);
            return loadError != null ? failed(target, loadError) : unavailable("That record no longer exists");
        }
    }
    if (target.view === "vault") {
        openRecordInVault(model, target.dossierId);
        return OK;
    }
    globalStore.set(pendingDecisionAnchorAtom, target.anchor ?? null);
    globalStore.set(briefPeekRecordAtom, target.dossierId);
    globalStore.set(model.surfaceAtom, "jarvis");
    return OK;
}

// The same refresh on a miss as a record: memory is scanned when the Vault is visited, so a note learned since
// is not in the list yet.
async function landMemoryNote(
    model: AgentsViewModel,
    target: MemoryNoteTarget,
    current: () => boolean
): Promise<OpenResult> {
    const listed = () => globalStore.get(memNotesAtom).some((n) => n.id === target.noteId);
    if (!listed()) {
        await loadMemory();
        if (!current()) {
            return SUPERSEDED;
        }
        if (!listed()) {
            return globalStore.get(memErrorAtom)
                ? failed(target, "the memory scan failed")
                : unavailable("That memory note no longer exists");
        }
    }
    fireAndForget(() => selectNote(target.noteId));
    // the memory collection's saved detail, not merely the Vault surface: the note detail is only reachable there
    globalStore.set(vaultTabAtom, "memory");
    globalStore.set(vaultFocusAtom, "saved");
    globalStore.set(model.surfaceAtom, "vault");
    return OK;
}

// initRadarScope selects its project's newest report, and Radar's first mount derives a scope unless one is
// already owned — so the report's own project is owned first and the report selected after it. selectReport,
// not radarSelectedIdAtom, pins the report: that atom holds the selected FINDING.
async function landRadar(model: AgentsViewModel, target: RadarTarget, current: () => boolean): Promise<OpenResult> {
    const report = await WOS.loadAndPinWaveObject<RadarReport>(WOS.makeORef("radarreport", target.reportId));
    if (!current()) {
        return SUPERSEDED;
    }
    if (report == null) {
        return unavailable("That scan report no longer exists");
    }
    const scope = scopeOfReport(report);
    if (globalStore.get(radarScopeAtom)?.path !== scope.path) {
        await initRadarScope(scope);
        if (!current()) {
            return SUPERSEDED;
        }
    }
    await selectReport(target.reportId);
    if (!current()) {
        return SUPERSEDED;
    }
    const findingId = target.findingId;
    const found = findingId != null && (report.findings ?? []).some((f) => f.id === findingId);
    globalStore.set(radarSelectedIdAtom, found ? findingId : undefined);
    globalStore.set(model.surfaceAtom, "radar");
    return findingId != null && !found ? { ok: true, notice: "That finding is no longer in this report" } : OK;
}

// The Brief's detail sheet, opened on a channel. Selecting the channel is what LOADS it: the sheet's body
// resolves its run from the active channel's list (stageRunAtom), so a sheet opened on a channel that was never
// selected had a null run and read "Reading this channel…" forever. Exported for Jarvis's own flows (restore,
// the investigation draft, the new-run control), not for cross-surface callers — those open a target.
export async function openChannelSheet(channelId: string, runId: string | null): Promise<void> {
    await selectChannel(channelId);
    selectSubject({ kind: "channel", id: channelId });
    if (runId != null) {
        setActiveRunId(channelId, runId);
    }
    globalStore.set(briefSheetOpenAtom, true);
}

function openEffortSheet(effortId: string): void {
    selectSubject({ kind: "effort", id: effortId });
    globalStore.set(briefSheetOpenAtom, true);
}

// The Vault's record landing. The peek means "show me this record"; this means "go to where it lives", and a
// record target names the view it wants rather than one quietly replacing the other.
//
// Selection and pane are set BEFORE the surface flips so the Vault mounts on the record rather than on an empty
// index, and the peek is cleared so the modal does not reappear over the surface the user asked for.
export function openRecordInVault(model: AgentsViewModel, dossierId: string): void {
    globalStore.set(vaultRecordIdAtom, dossierId);
    globalStore.set(vaultRecordPaneAtom, "detail");
    loadRecordDetail(dossierId);
    globalStore.set(briefPeekRecordAtom, null);
    globalStore.set(vaultTabAtom, "records");
    globalStore.set(model.surfaceAtom, "vault");
}

// ---- legacy entry points: Task 7 of the resource-linking plan deletes this block with their last callers ----

export function orefNavPlan(oref: string): { kind: string } {
    return parseAddress(oref);
}

export async function openORef(model: AgentsViewModel, oref: string, anchor?: string): Promise<void> {
    await openAddress(model, oref, { anchor });
}

export function openQueueTarget(model: AgentsViewModel, target: QueueOpenTarget): void {
    fireAndForget(() =>
        target.kind === "channel"
            ? openTarget(model, { kind: "channel", channelId: target.channelId, runId: target.runId ?? undefined })
            : openAddress(model, target.oref)
    );
}
```

- [ ] **Step 6: Run the landing tests to verify they pass**

Run: `npx vitest run frontend/app/view/jarvis/openref.test.ts frontend/app/view/jarvis/tasksstore.test.ts frontend/app/view/agents/radarstore.test.ts`
Expected: PASS. If an import fails with `No "<name>" export is defined on the "@/app/store/wos" mock`, add that name to the `vi.mock("@/app/store/wos", ...)` factory as a `vi.fn()` — do not unmock WOS.

- [ ] **Step 7: Typecheck and run the neighbouring suites**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && npx vitest run frontend/app/view/jarvis frontend/app/view/agents frontend/app/view/orchestrate`
Expected: tsc exit 0; all PASS. (Callers still use `openORef`, `orefNavPlan`, `openQueueTarget`, `openRecordInVault` through the legacy block.)

- [ ] **Step 8: Format**

`openref.ts` and `openref.test.ts` were replaced wholesale; the two stores were edited.

Run: `npx prettier --write frontend/app/view/jarvis/openref.ts frontend/app/view/jarvis/openref.test.ts && npx prettier --check frontend/app/view/jarvis/tasksstore.ts frontend/app/view/agents/radarstore.ts && npx vitest run frontend/app/view/jarvis/openref.test.ts`
Expected: the check passes (or fails only outside your hunks) and the tests still PASS.

---

### Task 6: Citations carry their hint

**Depends on:** Task 2, Task 5

**Files:**
- Modify: `frontend/app/view/jarvis/jarviscontract.ts:49-58` (`GroundingCard.anchor`)
- Modify: `frontend/app/view/jarvis/recallderive.ts:68-78` (`mapWireCard`)
- Modify: `frontend/app/view/jarvis/briefingstore.ts:13,257-264` (ask grounding)
- Modify: `frontend/app/view/jarvis/briefdrew.ts` (`DrewRow`, `drewOn`)
- Modify: `frontend/app/view/jarvis/briefsurface.tsx:162,523-557,581,594` (`SourceChip`, cite and drew chips)
- Modify: `frontend/app/view/jarvis/jarvisturn.tsx:13,110`
- Test: `frontend/app/view/jarvis/recallderive.test.ts`, `frontend/app/view/jarvis/briefdrew.test.ts`, `frontend/app/view/jarvis/briefingstore.test.ts`

**Interfaces:**
- Consumes: `JarvisConvoGroundingCard.anchor?: string` (Task 2 generate); `openAddress`, `parseAddress`, `AddressHint` (Tasks 4-5).
- Produces:
  - `GroundingCard.anchor?: string`
  - `DrewRow` gains `navTarget: string` and `anchor?: string`; `key` becomes `navTarget` or `navTarget#anchor`.
  - `SourceChip` takes `hint?: AddressHint`.

- [ ] **Step 1: Write the failing tests**

`recallderive.test.ts` — append at the end of the file:

```ts
describe("mapWireCard", () => {
    it("carries the anchor a citation lands on within its address", () => {
        const card = mapWireCard({
            n: 1,
            sourcetype: "decision",
            title: "a",
            project: "p",
            agems: 0,
            freshness: "fresh",
            navtarget: "task:d-1",
            anchor: "dec-1",
        });
        expect(card.navTarget).toBe("task:d-1");
        expect(card.anchor).toBe("dec-1");
    });
});
```

`briefdrew.test.ts` — inside `describe("drewOn", ...)`, directly after the test that ends `expect(out.rows.map((r) => r.sourceType)).toEqual(["task", "memory"]);` and its `});`, add:

```ts
    // a decision is addressed through its record, so the address alone would fold the two into one source
    it("keeps a record and a decision within it as two sources, each with its own target", () => {
        const out = drewOn(
            convo([
                [
                    card({ navTarget: "task:a", sourceType: "task" }),
                    card({ navTarget: "task:a", anchor: "dec-1", sourceType: "decision" }),
                ],
            ])
        );
        expect(out.rows.map((r) => [r.navTarget, r.anchor])).toEqual([
            ["task:a", undefined],
            ["task:a", "dec-1"],
        ]);
    });
```

`briefingstore.test.ts` — replace the whole test that begins with the comment `// the ledger cites a dossier as a vault: oref, which only routes as task:.` (two comment lines plus `it("normalizes a vault citation to its routable form", ...)`) with:

```ts
    // the router is the one reader of a legacy address, so the store keeps a card as the wire sent it
    it("keeps a citation's address and anchor as the wire sent them", async () => {
        (RpcApi.JarvisAskCommand as ReturnType<typeof vi.fn>).mockResolvedValue({
            answer: "a",
            grounding: [wireCard({ sourcetype: "decision", navtarget: "task:d-1", anchor: "dec-1" })],
            terminal: "answered",
        });
        await askAcrossWorkAsync("q");
        const card = globalStore.get(briefingAnswerAtom)?.grounding[0];
        expect(card?.navTarget).toBe("task:d-1");
        expect(card?.anchor).toBe("dec-1");
    });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run frontend/app/view/jarvis/recallderive.test.ts frontend/app/view/jarvis/briefdrew.test.ts frontend/app/view/jarvis/briefingstore.test.ts`
Expected: FAIL — `card.anchor` is undefined, and the drew rows have no `navTarget`.

- [ ] **Step 3: Carry the anchor through the card model**

`jarviscontract.ts` — in `GroundingCard`, after `navTarget: string; // ORef opened in the native surface`, add:

```ts
    anchor?: string; // the sub-object to land on within navTarget: a decision in its record, a finding in its report
```

`recallderive.ts` — in `mapWireCard`, after `navTarget: w.navtarget,` add `anchor: w.anchor,`.

`briefingstore.ts` — replace

```ts
            // navTarget is normalized here so the atom holds nav-ready targets and no consumer has to
            // remember to do it — the ledger cites dossiers as vault: orefs, which only route as task:.
            grounding: (rtn.grounding ?? []).map((c) => {
                const card = mapWireCard(c);
                return { ...card, navTarget: normalizeBriefingNav(card.navTarget) ?? "" };
            }),
```

with

```ts
            grounding: (rtn.grounding ?? []).map(mapWireCard),
```

and change the import `import { normalizeBriefingNav, SEVEN_DAYS_MS } from "./briefingmodel";` to `import { SEVEN_DAYS_MS } from "./briefingmodel";`.

`briefdrew.ts` — replace the `DrewRow` interface and the first part of the card loop:

```ts
export interface DrewRow {
    key: string; // the source's identity and the dedupe key: its address, plus the anchor within it
    navTarget: string;
    anchor?: string;
    sourceType: SourceType;
    title: string;
    project: string;
    freshness: Freshness;
    ageMs: number;
    citations: number;
}
```

and in `drewOn` replace

```ts
            const key = card.navTarget ?? "";
            if (key === "") {
                continue; // a card with no target names no source we could open
            }
            cited += 1;
            const prior = byKey.get(key);
            if (prior == null) {
                byKey.set(key, {
                    key,
                    sourceType: card.sourceType,
```

with

```ts
            const navTarget = card.navTarget ?? "";
            if (navTarget === "") {
                continue; // a card with no target names no source we could open
            }
            // a record and a decision within it share an address and are still two sources
            const key = card.anchor ? `${navTarget}#${card.anchor}` : navTarget;
            cited += 1;
            const prior = byKey.get(key);
            if (prior == null) {
                byKey.set(key, {
                    key,
                    navTarget,
                    anchor: card.anchor,
                    sourceType: card.sourceType,
```

- [ ] **Step 4: Chips open through the router with their hint**

`briefsurface.tsx`:

1. Change `import { openChannelSheet, openORef, openQueueTarget, orefNavPlan } from "./openref";` to `import { openAddress, openChannelSheet, openORef, openQueueTarget } from "./openref";`, and add `import { parseAddress, type AddressHint } from "./address";` as the first of the `./` imports.
2. Replace the `SourceChip` comment and function (from `// A citation opens its source, so it is bordered;` through the function's closing `}`) with:

```tsx
// A citation opens its source, so it is bordered; one the router would refuse is a label, because there is
// nothing to open. The gate reads the same hint the click passes, so the two cannot disagree. `unavailable`
// and unopenable stay separate reads: a converse thread can report a source stale or gone while its address
// still opens, and that row must still be clickable.
function SourceChip({
    hook,
    target,
    hint,
    model,
    children,
}: {
    hook: string;
    target: string;
    hint?: AddressHint;
    model: AgentsViewModel;
    children: ReactNode;
}) {
    const shell =
        "flex max-w-[300px] min-w-0 items-center gap-[7px] rounded-[6px] px-[9px] py-1 font-mono text-[10px] text-muted";
    if (parseAddress(target, hint).kind === "unsupported") {
        return (
            <span data-jarvis-brief-row={hook} className={shell}>
                {children}
            </span>
        );
    }
    return (
        <button
            type="button"
            data-jarvis-brief-row={hook}
            onClick={() => fireAndForget(() => openAddress(model, target, hint))}
            className={cn(
                shell,
                "cursor-pointer border border-border bg-surface hover:border-accent/40 hover:text-ink-mid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            )}
        >
            {children}
        </button>
    );
}
```

3. The cite chip: change `<SourceChip key={c.n} hook="cite" target={c.navTarget} model={model}>` to

```tsx
                        <SourceChip
                            key={c.n}
                            hook="cite"
                            target={c.navTarget}
                            hint={{ sourceType: c.sourceType, anchor: c.anchor }}
                            model={model}
                        >
```

4. The drew chip: change `<SourceChip hook="drew" target={row.key} model={model}>` to

```tsx
        <SourceChip
            hook="drew"
            target={row.navTarget}
            hint={{ sourceType: row.sourceType, anchor: row.anchor }}
            model={model}
        >
```

`jarvisturn.tsx` — change `import { openORef } from "./openref";` to `import { openAddress } from "./openref";`, and replace

```tsx
                            onClick={() => {
                                if (card) void openORef(model, card.navTarget);
                            }}
```

with

```tsx
                            onClick={() => {
                                if (card) {
                                    void openAddress(model, card.navTarget, {
                                        sourceType: card.sourceType,
                                        anchor: card.anchor,
                                    });
                                }
                            }}
```

- [ ] **Step 5: Run the tests to verify they pass, then typecheck**

Run: `npx vitest run frontend/app/view/jarvis && node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: PASS; tsc exit 0.

- [ ] **Step 6: Format check**

Run: `npx prettier --check frontend/app/view/jarvis/jarviscontract.ts frontend/app/view/jarvis/recallderive.ts frontend/app/view/jarvis/recallderive.test.ts frontend/app/view/jarvis/briefingstore.ts frontend/app/view/jarvis/briefingstore.test.ts frontend/app/view/jarvis/briefdrew.ts frontend/app/view/jarvis/briefdrew.test.ts frontend/app/view/jarvis/briefsurface.tsx frontend/app/view/jarvis/jarvisturn.tsx`
Expected: pass, or failures only in hunks that predate this task (`npx prettier <file> | diff <file> -` shows which).

---

### Task 7: Migrate the remaining callers and delete the side channels

**Depends on:** Task 6

**Files:**
- Modify: `frontend/app/view/jarvis/openref.ts` (delete the legacy block; `openRecordInVault` private)
- Modify: `frontend/app/view/jarvis/briefsurface.tsx` (imports, pending-focus effect, `openLine`, two comments)
- Modify: `frontend/app/view/jarvis/briefingmodel.ts:369-378,447,507` and `briefingmodel.test.ts`
- Modify: `frontend/app/view/jarvis/briefingfixtures.ts:102`
- Modify: `frontend/app/cockpit/command-palette.tsx:30,327-329,361-372`
- Modify: `frontend/app/view/agents/proactiveviews.tsx:10,27`, `frontend/app/view/agents/proactive.ts:64-67`
- Modify: `frontend/app/view/jarvis/graphpeek.tsx:30,138`
- Modify: `frontend/app/view/jarvis/briefpeekview.tsx:35,101,259`
- Modify: `frontend/app/view/agents/radarfindingdetail.tsx:28,84-90`
- Modify: `frontend/app/view/orchestrate/taskcorrelate.ts`, `daggraph.tsx`, `dagoverview.tsx`
- Modify: `frontend/app/view/agents/runactions.ts:24-34`
- Modify: `frontend/app/view/jarvis/petactrun.ts`, `petactrun.test.ts`
- Modify (comments only): `petacts.ts:20,131`, `petsources.tsx:177-178`, `petjoin.ts:113`, `petstore.ts:151-154`, `frontend/app/view/agents/memstore.ts:37-39`

**Interfaces:**
- Consumes: `openTarget`, `openAddress`, `OpenResult` (Task 5).
- Produces: `openTaskWorker(view: TaskWorkerView, model: AgentsViewModel): void` (no `channelId`). After this task `openORef`, `orefNavPlan`, `openQueueTarget`, `openRunSheet`, `normalizeBriefingNav`, `pendingRunFocusAtom` and `PendingRunFocus` no longer exist.

- [ ] **Step 1: Write the failing Pet tests**

In `petactrun.test.ts`:

1. Replace `const openORef = vi.fn();` with `const openAddress = vi.fn();` and the mock line with `vi.mock("./openref", () => ({ openAddress: (...a: any[]) => openAddress(...a) }));`.
2. Replace the test `"closes the peek before navigating, so an anchored overlay is not stranded"` with:

```ts
    it("closes the peek once the landing succeeds, so an anchored overlay is not stranded", async () => {
        globalStore.set(petPeekOpenAtom, true);
        openAddress.mockResolvedValue({ ok: true });
        const act: PetAct = {
            id: "x",
            verb: "open",
            label: "Open",
            target: { kind: "oref", ref: "memnote:abc" },
        };
        await runAct(model, act);
        expect(globalStore.get(petPeekOpenAtom)).toBe(false);
        expect(openAddress).toHaveBeenCalledWith(model, "memnote:abc", { anchor: undefined }, expect.any(Function));
    });

    // the landing leaves the user where they were, so the act that asked is where its failure is read
    it("keeps the peek open and reports a failed landing on the act", async () => {
        globalStore.set(petPeekOpenAtom, true);
        openAddress.mockImplementation(
            async (_model: unknown, _address: string, _hint: unknown, report: (r: unknown) => void) => {
                const result = { ok: false, reason: "unavailable", message: "That memory note no longer exists" };
                report(result);
                return result;
            }
        );
        const act: PetAct = { id: "gone", verb: "open", label: "Open", target: { kind: "oref", ref: "memnote:gone" } };
        await runAct(model, act);
        expect(globalStore.get(petPeekOpenAtom)).toBe(true);
        expect(globalStore.get(petActStateAtom)["gone"]).toEqual({
            status: "error",
            text: "That memory note no longer exists",
        });
    });
```

3. In the memory-upkeep test, change `expect(openORef).not.toHaveBeenCalled();` to `expect(openAddress).not.toHaveBeenCalled();`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run frontend/app/view/jarvis/petactrun.test.ts`
Expected: FAIL — `openAddress` is never called (the runner still calls `openORef`).

- [ ] **Step 3: The Pet opens through `openAddress` with its own reporter**

In `petactrun.ts`, change `import { openORef } from "./openref";` to `import { openAddress } from "./openref";`, then replace the `escort` comment and function and the `open` branch of `runAct`:

```ts
// The peek closes before a surface escort: an overlay anchored to the creature, left open over a surface it just
// navigated away from, is stranded (the same reasoning petpeek.tsx already applies to its Open buttons). An
// address escort closes it only once the landing succeeds — a landing that cannot open leaves the user where
// they were, and its failure is set on the act, which only an open peek shows.
async function escort(model: AgentsViewModel, act: PetAct & { verb: "open" }): Promise<void> {
    const target = act.target;
    if (target.kind === "oref") {
        const result = await openAddress(model, target.ref, { anchor: target.anchor }, (r) => {
            if (!r.ok) {
                setActState(act.id, { status: "error", text: r.message });
            }
        });
        if (result.ok) {
            globalStore.set(petPeekOpenAtom, false);
        }
        return;
    }
    globalStore.set(petPeekOpenAtom, false);
    if (target.kind === "memory-upkeep") {
        // the memory collection in list view, not merely the Vault surface: the upkeep panes live under
        // the memory tab and are not mounted in graph view, so a bare switch can land where the queue
        // does not exist
        globalStore.set(memViewAtom, "list");
        globalStore.set(vaultTabAtom, "memory");
        globalStore.set(pendingMemoryFocusAtom, "upkeep");
        globalStore.set(model.surfaceAtom, "vault");
        return;
    }
    globalStore.set(pendingSettingsSectionAtom, SETTINGS_SECTION_EMBEDDINGS);
    globalStore.set(model.surfaceAtom, "settings");
}
```

and in `runAct`:

```ts
    if (act.verb === "open") {
        await escort(model, act);
        return;
    }
```

(the `globalStore.set(petPeekOpenAtom, false);` line that preceded `await escort(...)` is removed).

Run: `npx vitest run frontend/app/view/jarvis/petactrun.test.ts`
Expected: PASS.

- [ ] **Step 4: Migrate the Brief**

`briefsurface.tsx`:

1. Imports: delete `pendingRunFocusAtom,` from the `@/app/view/agents/runactions` import; change the channelsstore import to `import { activeChannelAtom, channelsAtom, loadChannels } from "@/app/view/agents/channelsstore";`; change the jarvissubjectstore import to `import { activeSubjectAtom, persistedSubjectAtom, stageRunAtom } from "./jarvissubjectstore";`; change the openref import to `import { openAddress, openChannelSheet, openTarget } from "./openref";`.
2. Replace the pending-focus block — from the comment `// Two landings moved off the Stage with the panes it drew: a "Open run" focus request and a Radar` through the effect ending `}, [pendingFocus, subject, landingRuns, setPendingFocus]);` — with:

```tsx
    // A Radar draft moved off the Stage with the panes it drew. It is one-shot — `landed` bounds it to a single
    // attempt, because a channel that never resolves must not re-fire on every change and yank the user back.
    const pendingDraft = useAtomValue(pendingRunDraftAtom);
    const setPendingDraft = useSetAtom(pendingRunDraftAtom);
    const channels = useAtomValue(channelsAtom);
```

3. Replace `openLine`:

```tsx
    const openLine = useCallback(
        (target: LineTarget) => {
            if (target == null) {
                return;
            }
            if ("queue" in target) {
                const queue = target.queue;
                fireAndForget(() =>
                    queue.kind === "channel"
                        ? openTarget(model, {
                              kind: "channel",
                              channelId: queue.channelId,
                              runId: queue.runId ?? undefined,
                          })
                        : openAddress(model, queue.oref)
                );
                return;
            }
            fireAndForget(() => openAddress(model, target.oref));
        },
        [model]
    );
```

4. Comments: `{/* the Brief's destination for a record oref: openref.ts's task arm sets the atom this reads.` → `{/* the Brief's destination for a record address: openref.ts's record landing sets the atom this reads.`; and `now that a run has a destination: openORef's run arm opens the channel's detail sheet, which` → `now that a run has a destination: openref.ts's run landing opens the channel's detail sheet, which`.

`briefingmodel.ts`: delete the two-line comment `// The ledger's dossier/blocker targets arrive as vault:<id> ...` and the whole `normalizeBriefingNav` function (and the blank line after it); change `oref: normalizeBriefingNav(a.navtarget) ?? "",` to `oref: a.navtarget ?? "",`; change `oref: normalizeBriefingNav(ev.navtarget),` to `oref: ev.navtarget || null,`.

`briefingmodel.test.ts`:
- delete `normalizeBriefingNav,` from the import list;
- delete the test `it("normalizes only the vault alias", ...)`;
- in `"windows delta to actualCursor and words events honestly"`, change the dossier event's `navtarget: "vault:d-1",` to `navtarget: "task:d-1",` and change `expect(m.delta.find((d) => d.kind === "dossier")?.oref).toBe("task:d-1"); // vault: -> task:` to drop the trailing comment;
- replace `it("labels unscoped blockers and normalizes their target", () => {` with `it("labels unscoped blockers and keeps their target", () => {`, and inside it change `navtarget: "vault:d-1",` to `navtarget: "task:d-1",`.

`briefingfixtures.ts:102`: `navtarget: "vault:d-briefing-1",` → `navtarget: "task:d-briefing-1",`.

- [ ] **Step 5: Migrate the palette, proactive card, graph peek and record peek**

`command-palette.tsx`:
- import: `import { openAddress, openTarget } from "@/app/view/jarvis/openref";`
- channel row `run`:

```tsx
                    run: () => {
                        fireAndForget(() => openTarget(model, { kind: "channel", channelId: c.oid }));
                        close();
                    },
```

- `openBriefRow` and its comment:

```tsx
    // Selection navigates through the seams that already exist. A record and an initiative are addresses, so
    // openAddress lands them (and flips the surface itself); a thread has no address — it is only ever a Stage
    // subject, which is the same seam the Ask Jarvis row above uses. Sessions are not sourced here (see
    // BRIEF_GROUP_KINDS), so "thread" is the only remaining kind.
    const openBriefRow = (row: BriefRow) => {
        if (row.kind === "record") {
            fireAndForget(() => openAddress(model, `task:${row.id}`));
            return;
        }
        if (row.kind === "effort") {
            fireAndForget(() => openAddress(model, row.id)); // an effort row's id is already an address
            return;
        }
        selectSubject({ kind: "conversation", id: row.id });
        globalStore.set(model.surfaceAtom, "jarvis");
    };
```

`proactiveviews.tsx`: import `openAddress` instead of `openORef`; `onClick={oref != null ? () => void openAddress(model, oref) : undefined}`.

`proactive.ts:64-67` comment becomes:

```ts
// maps a suggestion to the address openAddress lands on; null = not navigable. The address
// vocabulary lives in address.ts; a decision has no address of its own (it lands on its parent
// record with an anchor, which this payload does not carry) — so it maps to null, never an error.
```

`graphpeek.tsx`: import `openAddress`; `fireAndForget(() => openAddress(model, runORef));`.

`briefpeekview.tsx`: import `import { openAddress, openTarget } from "./openref";`; `onClick={() => void openAddress(model, "run:" + row.runId)}`; and the Open in Vault button's handler:

```tsx
                                    onClick={() => {
                                        if (recordId != null) {
                                            void openTarget(model, { kind: "record", dossierId: recordId, view: "vault" });
                                        }
                                    }}
```

- [ ] **Step 6: Radar's Open run and the DAG fallback land on the run**

`radarfindingdetail.tsx`: change `import { pendingRunDraftAtom, pendingRunFocusAtom } from "./runactions";` to `import { pendingRunDraftAtom } from "./runactions";`, add `import { openTarget } from "@/app/view/jarvis/openref";` after the `@/app/view/jarvis/contextualentry` import, and replace `openRun`:

```tsx
    const openRun = () => {
        if (!inv) {
            return;
        }
        fireAndForget(() => openTarget(model, { kind: "run", runId: inv.runid }));
    };
```

`taskcorrelate.ts`: replace the imports and `openTaskWorker`:

```ts
import { fireAndForget } from "@/util/util";
import type { AgentsViewModel } from "../agents/agents";
import type { AgentVM } from "../agents/agentsviewmodel";
import { jumpToAgent } from "../agents/channelsprimitives";
import { openTarget } from "../jarvis/openref";
```

```ts
// openTaskWorker routes a resolved worker view: dispatched jumps to the agent tab; unavailable opens the
// child run on its own channel's sheet (pending has no navigable target and does nothing).
export function openTaskWorker(view: TaskWorkerView, model: AgentsViewModel): void {
    if (view.state === "dispatched" && view.tabId) {
        jumpToAgent(model, view.tabId);
        return;
    }
    const runId = view.runId;
    if (view.state === "unavailable" && runId) {
        fireAndForget(() => openTarget(model, { kind: "run", runId }));
    }
}
```

`daggraph.tsx`: in `SelectedTaskWorker`, delete `channelId,` from the destructured props and `channelId: string;` from their type; change both `openTaskWorker(worker, model, channelId);` to `openTaskWorker(worker, model);`; at the `<SelectedTaskWorker` usage (around line 321) delete the `channelId={group.channelid}` prop.

`dagoverview.tsx`: change the three `openTaskWorker(worker, nav.model, nav.channelId)` calls to `openTaskWorker(worker, nav.model)`.

`runactions.ts`: delete the comment block `// A one-shot request to focus a specific run (e.g. from Radar's "Open run")...`, the `PendingRunFocus` interface and `pendingRunFocusAtom` (and the blank line after it).

- [ ] **Step 7: Delete the router's legacy block and stale comments**

`openref.ts`: delete from the line `// ---- legacy entry points: Task 7 of the resource-linking plan deletes this block with their last callers ----` to the end of the file; delete `import type { QueueOpenTarget } from "./briefingmodel";`; change `export function openRecordInVault(` to `function openRecordInVault(`.

Comments that name the deleted routes:
- `petacts.ts:20` — `// Where an escort lands. An oref goes through the existing openORef; the two surface targets exist because` → `// Where an escort lands. An oref goes through openAddress; the two surface targets exist because`
- `petacts.ts:131` — `continue; // known absent: openORef would no-op, and a dead click target is worse than none` → `continue; // known absent: the landing would only report it, and hiding a dead Open beats offering one`
- `petsources.tsx:177-180` — replace the four-line comment beginning ``// `agent:<tabId>` is the oref openORef routes to openTerminal`` with:

```tsx
                // `agent:<tabId>` is an address openAddress lands on the agent (address.ts reads it as an
                // alias of tab:); askAboutSource tolerates the unknown sourceType (generic chip, never a wrong
                // destination — jarvissubjectstore.ts:305). A roster-less ask still speaks, just with
                // no open affordance — the same rule as a volunteer with no ref.
```

- `petjoin.ts:113` — `openORef routes it` → `openAddress lands it`
- `petstore.ts` — `// navigation lands on the record and this names the card. Cleared by the consumer once honoured, the` / `// same shape as pendingRunFocusAtom.` → `// navigation lands on the record and this names the card. Cleared by the consumer once honoured.`
- `memstore.ts:37-39` →

```ts
// Where a deep link into Memory should land. Consumed once on mount by the section that owns it: the cleanup
// queue is collapsed by default and its open flag is component state, so an escort that only switched surface
// would land on a section the user still has to find.
```

- [ ] **Step 8: Verify nothing references a deleted name**

Run: `grep -rn "openORef\|orefNavPlan\|openQueueTarget\|openRunSheet\|normalizeBriefingNav\|pendingRunFocus\|PendingRunFocus" frontend scripts`
Expected: no output.

- [ ] **Step 9: Typecheck and run the suites**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && npx vitest run frontend/app/view/jarvis frontend/app/view/agents frontend/app/view/orchestrate frontend/app/cockpit`
Expected: tsc exit 0; all PASS.

- [ ] **Step 10: Format check on the touched TS/TSX files**

Run: `git diff --name-only -- frontend | grep -E '\.(ts|tsx)$' | xargs npx prettier --check`
Expected: pass, or failures only in hunks you did not write (check with `npx prettier <file> | diff <file> -`).

---

### Task 8: Live verification — the `resource-linking` scenario

**Depends on:** Task 7

**Files:**
- Create: `frontend/app/view/jarvis/linkingdevhooks.ts`
- Modify: `frontend/app/view/jarvis/briefsurface.tsx` (DEV install effect)
- Modify: `frontend/app/view/agents/radarfindingdetail.tsx` (root `data-*` hooks)
- Modify: `frontend/app/view/agents/vaultrail.tsx` (`NoteMode` root `data-*` hook)
- Modify: `scripts/cdp/scenarios.mjs` (new scenario + `SCENARIOS` entry)

**Interfaces:**
- Consumes: `openAddress` (Task 5), `briefThreadAtom` (`briefingstore.ts`), the `data-jarvis-brief-row="cite"` chips (Task 6).
- Produces (DEV builds only): `window.__seedBriefCitations(cards: GroundingCard[])`, `window.__openAddress(address: string): Promise<OpenResult>`; DOM hooks `data-radar-finding-detail=<findingId>` + `data-radar-report=<reportId>` on the finding detail root, `data-vault-note-detail=<noteId>` on the memory note detail root.

- [ ] **Step 1: The DEV seams**

Create `frontend/app/view/jarvis/linkingdevhooks.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// DEV-ONLY seams for the resource-linking CDP scenario, installed by BriefSurface and never imported in a
// production build. A citation chip exists only after a live synthesis, so __seedBriefCitations puts one
// answered exchange on the Brief's thread with grounding the scenario supplies — the chip click under test is
// still the real one. __openAddress reaches the one case no chip can: an address the parser rejects renders as
// plain text.

import { globalStore } from "@/app/store/jotaiStore";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { briefThreadAtom } from "./briefingstore";
import type { GroundingCard } from "./jarviscontract";
import { openAddress } from "./openref";

const SEEDED_PROSE = "Seeded for verification.";

export function installLinkingDevHooks(model: AgentsViewModel): void {
    const w = window as unknown as {
        __seedBriefCitations?: (cards: GroundingCard[]) => void;
        __openAddress?: (address: string) => Promise<unknown>;
    };
    w.__seedBriefCitations = (cards) => {
        const ts = Date.now();
        globalStore.set(briefThreadAtom, [
            { key: `dev-cite-q:${ts}`, ts, turn: { role: "user", text: "Seeded citations", attachments: [] } },
            {
                key: `dev-cite-a:${ts}`,
                ts,
                turn: {
                    role: "jarvis",
                    workingSteps: [],
                    segments: [{ text: SEEDED_PROSE }],
                    grounding: cards,
                    terminal: "answered",
                },
                answer: { answer: SEEDED_PROSE, grounding: cards, terminal: "answered" },
            },
        ]);
    };
    w.__openAddress = (address) => openAddress(model, address);
}
```

In `briefsurface.tsx`, directly after

```tsx
    useEffect(() => {
        loadBriefing();
    }, []);
```

add

```tsx
    // DEV-only: the resource-linking scenario's seams (linkingdevhooks.ts)
    useEffect(() => {
        if (import.meta.env.DEV) {
            void import("./linkingdevhooks").then((m) => m.installLinkingDevHooks(model));
        }
    }, [model]);
```

- [ ] **Step 2: The two DOM hooks**

`radarfindingdetail.tsx` — replace

```tsx
    return (
        <div className="flex min-w-0 flex-1 flex-col gap-6 overflow-y-auto p-6">
```

with

```tsx
    return (
        <div
            data-radar-finding-detail={finding.id}
            data-radar-report={report.oid}
            className="flex min-w-0 flex-1 flex-col gap-6 overflow-y-auto p-6"
        >
```

`vaultrail.tsx` — in `NoteMode`, replace

```tsx
            else setEditing(false);
        });

    return (
        <div className="flex flex-col gap-[18px]">
```

with

```tsx
            else setEditing(false);
        });

    return (
        <div data-vault-note-detail={sel.id} className="flex flex-col gap-[18px]">
```

Run: `npx prettier --write frontend/app/view/jarvis/linkingdevhooks.ts && npx prettier --check frontend/app/view/jarvis/briefsurface.tsx frontend/app/view/agents/radarfindingdetail.tsx frontend/app/view/agents/vaultrail.tsx && node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: the check passes (or fails only outside your hunks); tsc exit 0.

- [ ] **Step 3: Write the scenario**

In `scripts/cdp/scenarios.mjs`, add this block immediately before `export const SCENARIOS = [` (hand-formatted at 4 spaces; do not run prettier on this file):

```js
// --- resource linking: an address opens what it names --------------------------------------------------------
// The router's live check. A citation chip exists only after a live synthesis, so the DEV hook in
// linkingdevhooks.ts seeds one answered exchange and the click under test is the real chip's. The chips point at
// real objects read from this profile, because every landing proves its target exists first — invented ids
// would only ever exercise the failure path. Nothing here writes. A profile missing a kind (no record holding a
// decision, no memory, no investigated finding) fails that step and names what to seed, rather than passing on
// a landing it never made.
const resourceLinking = {
    name: "resource-linking",
    surface: "jarvis",
    async arrange(h) {
        const dossiers = (await h.rpc("listtaskdossiers", null))?.dossiers ?? [];
        let decided = null;
        for (const d of dossiers.slice(0, 25)) {
            const detail = await h.rpc("getdossier", { dossierid: d.id }).catch(() => null);
            const decision = detail?.decisions?.[0];
            if (decision) {
                decided = { dossierId: d.id, objective: d.objective, decisionId: decision.id };
                break;
            }
        }
        const note = ((await h.rpc("memoryscan", null))?.notes ?? [])[0] ?? null;
        const reports = (await h.rpc("listradarreports", { projectpath: "" }))?.reports ?? [];
        const newest = new Map();
        for (const r of reports) {
            const prior = newest.get(r.projectpath);
            if (!prior || r.startedts > prior.startedts) newest.set(r.projectpath, r);
        }
        const scanned = reports.filter((r) => (r.findings ?? []).length > 0);
        // an older report is the case the Radar landing exists for: initRadarScope selects the NEWEST, so only
        // an older one tells a landing that held apart from one that was overwritten
        const cited = scanned.find((r) => newest.get(r.projectpath)?.oid !== r.oid) ?? scanned[0] ?? null;
        let investigated = null;
        for (const r of reports) {
            const f = (r.findings ?? []).find((x) => x.investigation && x.investigation.status !== "orphaned");
            if (f) {
                investigated = { reportId: r.oid, findingId: f.id };
                break;
            }
        }
        return {
            dossier: dossiers[0] ? { id: dossiers[0].id, objective: dossiers[0].objective } : null,
            decided,
            note: note ? { id: note.id, title: note.title } : null,
            radar: cited
                ? {
                      reportId: cited.oid,
                      findingId: cited.findings[0].id,
                      newest: newest.get(cited.projectpath)?.oid === cited.oid,
                  }
                : null,
            investigated,
        };
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const settle = (ms) => h.ev(`new Promise((r) => setTimeout(r, ${ms}))`);
        const waitFor = async (expr, ms) => {
            for (let waited = 0; waited < ms; waited += 250) {
                if ((await h.ev(expr)) === true) return true;
                await settle(250);
            }
            return false;
        };
        const present = (selector) => `!!document.querySelector(${JSON.stringify(selector)})`;
        const toastText = () =>
            h.ev(`[...document.querySelectorAll('[data-notification-toast]')].map((t) => t.innerText).join(' | ')`);
        const card = (n, sourceType, title, navTarget, anchor) => ({
            n,
            sourceType,
            title,
            project: "",
            ageMs: 0,
            freshness: "fresh",
            navTarget,
            anchor,
        });
        const cards = [];
        if (ctx.dossier) cards.push(card(1, "dossier", ctx.dossier.objective, `task:${ctx.dossier.id}`));
        if (ctx.decided) {
            cards.push(card(2, "decision", "a decision", `task:${ctx.decided.dossierId}`, ctx.decided.decisionId));
        }
        if (ctx.note) cards.push(card(3, "memory", ctx.note.title, `memnote:${ctx.note.id}`));
        if (ctx.radar) {
            cards.push(card(4, "radar", "a finding", `radarreport:${ctx.radar.reportId}`, ctx.radar.findingId));
        }
        if (ctx.investigated) {
            const { reportId, findingId } = ctx.investigated;
            cards.push(card(5, "radar", "an investigated finding", `radarreport:${reportId}`, findingId));
        }
        // the hooks install when the Brief mounts, and a reload undoes them; seeding again before every click also
        // means a peek or thread collapse from the previous step cannot take the chips with it
        const seed = async () => {
            await h.goto("jarvis");
            if (!(await waitFor(`typeof window.__seedBriefCitations === 'function'`, 5000))) return false;
            await h.ev(`window.__seedBriefCitations(${JSON.stringify(cards)})`);
            return waitFor(
                `document.querySelectorAll('button[data-jarvis-brief-row="cite"]').length >= ${cards.length}`,
                3000
            );
        };
        const clickCite = (n) =>
            h.ev(`(() => {
                const chip = [...document.querySelectorAll('button[data-jarvis-brief-row="cite"]')]
                    .find((b) => (b.innerText || '').trim().startsWith('[${n}]'));
                if (!chip) return false;
                chip.click();
                return true;
            })()`);
        const peekShows = (objective) =>
            waitFor(
                `(document.querySelector('[data-jarvis-brief-band="peek"]')?.innerText || '').includes(${JSON.stringify(
                    (objective || "").slice(0, 40)
                )})`,
                5000
            );
        // Escape closes the peek (and the run sheet in step 6); waiting on the peek band keeps the next step from
        // reading the previous step's overlay
        const dismissOverlay = async () => {
            await h.ev(
                `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))`
            );
            await waitFor(`!document.querySelector('[data-jarvis-brief-band="peek"]')`, 2000);
        };

        rec(
            "1. the DEV hook seeds a citation chip per kind this profile holds",
            (await seed()) === true,
            `chips=${cards.map((c) => c.n).join(",")}`
        );

        if (!ctx.dossier) {
            rec(
                "2. a record citation opens the record's peek",
                false,
                "no record in this profile - seed one before reading this as a pass"
            );
        } else {
            const clicked = (await seed()) && (await clickCite(1));
            const shown = await peekShows(ctx.dossier.objective);
            rec(
                "2. a record citation opens the record's peek",
                clicked && shown,
                JSON.stringify({ clicked, shown, toasts: await toastText() })
            );
            await dismissOverlay();
        }

        if (!ctx.decided) {
            rec(
                "3. a decision citation opens its record's peek",
                false,
                "no record with a decision among the first 25 - seed one before reading this as a pass"
            );
        } else {
            const clicked = (await seed()) && (await clickCite(2));
            const shown = await peekShows(ctx.decided.objective);
            rec(
                "3. a decision citation opens its record's peek",
                clicked && shown,
                JSON.stringify({ clicked, shown, toasts: await toastText() })
            );
            await dismissOverlay();
        }

        if (!ctx.note) {
            rec("4. a memory citation opens the note in the Vault", false, "no memory notes in this profile");
        } else {
            const clicked = (await seed()) && (await clickCite(3));
            const shown = await waitFor(present(`[data-vault-note-detail="${ctx.note.id}"]`), 6000);
            const surface = await h.activeSurfaceLabel();
            rec(
                "4. a memory citation opens the note in the Vault",
                clicked && shown && surface === SURFACE_LABEL.vault,
                JSON.stringify({ clicked, shown, surface, toasts: await toastText() })
            );
        }

        if (!ctx.radar) {
            rec(
                "5. a finding citation lands on that finding on a first Radar visit",
                false,
                "no scan report with findings in this profile"
            );
        } else {
            // a reload is what makes this Radar's first visit: its scope lives in module state
            await h.ev("location.reload()");
            await settle(2800);
            const clicked = (await seed()) && (await clickCite(4));
            const selector = `[data-radar-finding-detail="${ctx.radar.findingId}"][data-radar-report="${ctx.radar.reportId}"]`;
            const shown = await waitFor(present(selector), 8000);
            const surface = await h.activeSurfaceLabel();
            rec(
                "5. a finding citation lands on that finding on a first Radar visit",
                clicked && shown && surface === SURFACE_LABEL.radar,
                JSON.stringify({ clicked, shown, surface, olderThanNewest: !ctx.radar.newest, toasts: await toastText() })
            );
        }

        if (!ctx.investigated) {
            rec(
                "6. Radar's Open run lands on the run's sheet",
                false,
                "no investigated finding in this profile - start an investigation from Radar before reading this as a pass"
            );
        } else {
            const clicked = (await seed()) && (await clickCite(5));
            const detail = `[data-radar-finding-detail="${ctx.investigated.findingId}"]`;
            const onFinding = await waitFor(present(detail), 8000);
            const opened =
                onFinding &&
                (await h.ev(`(() => {
                    const b = [...document.querySelectorAll(${JSON.stringify(`${detail} button`)})]
                        .find((x) => (x.textContent || '').trim() === 'Open run');
                    if (!b) return false;
                    b.click();
                    return true;
                })()`));
            const runBody = await waitFor(
                present('[data-jarvis-brief-sheet="channel"] [data-jarvis-brief-sheet-face="settings"]'),
                10000
            );
            const surface = await h.activeSurfaceLabel();
            rec(
                "6. Radar's Open run lands on the run's sheet",
                clicked && opened && runBody && surface === SURFACE_LABEL.jarvis,
                JSON.stringify({ clicked, onFinding, opened, runBody, surface, toasts: await toastText() })
            );
            await dismissOverlay();
        }

        await h.goto("jarvis");
        await waitFor(`typeof window.__openAddress === 'function'`, 5000);
        const result = await h.ev(`window.__openAddress("bogus:resource-linking-probe")`);
        await settle(400);
        const toasts = await toastText();
        const surface = await h.activeSurfaceLabel();
        rec(
            "7. an address nothing can open shows the toast and leaves the surface where it was",
            result?.reason === "unsupported" &&
                toasts.includes("This item can't be opened") &&
                surface === SURFACE_LABEL.jarvis,
            JSON.stringify({ result, toasts, surface })
        );
        await h.shot("cdp-shots/resource-linking.png");
        return steps;
    },
    async teardown(h) {
        await h.goto("jarvis");
        // the seeded exchange is launch-local, but a later scenario reading the Brief should not find it
        await h.ev(`(() => {
            const b = [...document.querySelectorAll('[data-jarvis-brief-thread] button')]
                .find((x) => (x.textContent || '').includes('Collapse'));
            if (b) b.click();
            return true;
        })()`);
        await h.goto("cockpit");
    },
};

```

and add `resourceLinking,` as the last entry of `SCENARIOS` (after `briefInlineTracker,`).

Run: `node --check scripts/cdp/scenarios.mjs`
Expected: no output (syntax OK).

- [ ] **Step 4: Run it against the dev app**

The Go changes need a rebuilt backend and the frontend changes need the DEV build, so restart the dev app: stop any running `task dev`, then start it (`task dev`, background) and wait for the Vite dev server on `:5174` and CDP on `:9222`. Do not kill a `wavesrv.x64.exe` whose path is not the dev build without asking the user.

Run: `task verify:ui -- resource-linking surface-smoke brief-peek`
Expected: `resource-linking` steps 1-5 and 7 PASS. Step 6 PASSes only if the profile has an investigated finding; if it FAILs with the "no investigated finding" detail, report that to the user as unverified rather than a pass. `surface-smoke` and `brief-peek` show no new failures against their known profile-dependent ones (see the memory notes on `brief-peek` step 3). Open `cdp-shots/index.html` and look at `resource-linking.png`.

If a step fails, read its detail JSON: `toasts` names what the router reported, which separates a landing bug from a missing hook.

---

### Task 9: Whole-slice verification, deferrals, and the one commit

**Depends on:** Task 8

**Files:**
- Modify: `docs/deferred.md` (new entry at the top)
- Modify: `docs/open-issues.md` §4 (one bullet)

- [ ] **Step 1: Full checks**

Run, from Git Bash at the repo root:

```bash
CGO_CFLAGS="-O2 -g -I$(pwd -W)/pkg/jarvisembed/csrc" go test ./pkg/wavevault/ ./pkg/jarvisvolunteer/ ./pkg/jarvisrecall/ ./pkg/jarvisproactive/ ./pkg/jarvisstate/ ./pkg/wshrpc/wshserver/ \
  && go vet ./pkg/wavevault/ ./pkg/jarvisvolunteer/ ./pkg/jarvisrecall/ ./pkg/jarvisstate/ \
  && task build:backend \
  && npx vitest run \
  && node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```

Expected: every Go package `ok`; `task build:backend` succeeds; vitest all PASS; tsc exit 0. Baseline on `main` at `859a8334` (2026-09-17, before this plan): `wavevault`, `jarvisvolunteer`, `jarvisrecall`, `jarvisstate` all `ok`; vitest 252 files / 3183 tests passed, 1 file and 2 tests skipped. Any failure is this slice's unless it reproduces on that commit.

- [ ] **Step 2: Self-review the diff**

Run: `git diff --stat && git diff -- pkg frontend scripts | grep -nE "^\+.*(console\.log|debugger|TODO|FIXME|XXX)" ; grep -rn '"vault:"\|"memory:" +' pkg --include=*.go | grep -v _test.go`
Expected: the first grep prints nothing; the second prints no producer still emitting a `vault:` or `memory:` navigation address (`resolveAttached`'s `case "memory":` does not match — attachment orefs are out of scope).

- [ ] **Step 3: Record the deferrals**

Insert this entry at the top of `docs/deferred.md`, directly under the intro block (before `## Cross-surface Back history, its context strip, and a Space filter on the Brief (2026-09-17)`):

```markdown
## Resource linking beyond navigation: relationships, trail, structured refs, wider targets (2026-09-17)

The resource-linking slice shipped canonical addresses, one parser and one `openTarget`
(`docs/superpowers/specs/2026-09-15-cross-surface-resource-linking-design.md`). The spec was cut to that core at
review; everything else it designed waits for evidence, with each settled decision kept in the spec's
"Deferred until evidence" section so it is not re-derived.

- **What was deferred:**
  - Related Work: forward links and backlinks derived from authoritative Run/DAG/Radar/effort data and
    attribution edges, no persisted link table, inferred edges showing `jarvisattrib`'s own provenance. Needs a
    mockup per `DESIGN.md`.
  - The Work Trail strip: explicit lineage only (finding → Run → task → worker → files), stopping at a branch.
  - Structured resource refs on the wire (file revisions, nested parents) — nothing persists a file revision yet.
  - File, diff, commit and session targets in `openTarget`; `openInCode` and `openDiff` stay the landings.
  - A shared contextual-action builder across buttons, menus and the palette.
  - Usage-to-work links, which need per-session or per-run attribution in the usage scanner first.
  - Unifying the attachment oref namespace (`resolveAttached`'s `run:`/`memory:`/`radar:`) with addresses.
  - Cross-surface Back is the entry below.
- **Why:** no flow has yet shown the need; each item names its trigger in the spec.
- **Where to pick it up:** the spec's "Deferred until evidence" section; the router is
  `frontend/app/view/jarvis/openref.ts` and the parser `frontend/app/view/jarvis/address.ts`. A new target kind
  is a union member in `address.ts`, a landing in `openref.ts`, and a row in `openref.test.ts`.
```

In `docs/open-issues.md` §4, directly after the `- **Cross-surface navigation:** ...` bullet (ending `(2026-09-17).`), add:

```markdown
- **Resource linking beyond navigation:** Related Work, the Work Trail strip, structured refs, file/diff/commit/
  session targets, a shared action builder, usage-to-work links, one oref namespace — revive each on the trigger
  the spec names. Rationale in `docs/deferred.md` (2026-09-17); the navigation core shipped.
```

- [ ] **Step 4: Stop and ask for commit approval**

Report to the user: what landed (per task), the verification output (Go, vitest, tsc, backend build, `verify:ui` table including any step 6 data gap), and the proposed single commit. Do not commit until they approve.

- [ ] **Step 5: Commit (only after approval)**

```bash
git add docs/superpowers/specs/2026-09-15-cross-surface-resource-linking-design.md \
        docs/superpowers/plans/2026-09-17-cross-surface-resource-linking.md \
        docs/deferred.md docs/open-issues.md \
        pkg/wavevault/address.go pkg/wavevault/address_test.go \
        pkg/jarvisvolunteer/recall.go \
        pkg/waveobj/jarvisconvo.go pkg/jarvisrecall/cards.go pkg/jarvisrecall/cards_test.go \
        pkg/jarvisrecall/retrieve.go pkg/jarvisrecall/retrieve_test.go pkg/jarvisrecall/recall.go \
        pkg/jarvisstate/jarvisstate.go pkg/jarvisstate/jarvisstate_test.go pkg/wshrpc/wshrpctypes_jarvis.go \
        frontend/types/gotypes.d.ts \
        frontend/app/cockpit/command-palette.tsx \
        frontend/app/view/jarvis/address.ts frontend/app/view/jarvis/address.test.ts \
        frontend/app/view/jarvis/openref.ts frontend/app/view/jarvis/openref.test.ts \
        frontend/app/view/jarvis/linkingdevhooks.ts frontend/app/view/jarvis/tasksstore.ts \
        frontend/app/view/jarvis/jarviscontract.ts frontend/app/view/jarvis/recallderive.ts \
        frontend/app/view/jarvis/recallderive.test.ts frontend/app/view/jarvis/briefingstore.ts \
        frontend/app/view/jarvis/briefingstore.test.ts frontend/app/view/jarvis/briefdrew.ts \
        frontend/app/view/jarvis/briefdrew.test.ts frontend/app/view/jarvis/briefsurface.tsx \
        frontend/app/view/jarvis/jarvisturn.tsx frontend/app/view/jarvis/briefingmodel.ts \
        frontend/app/view/jarvis/briefingmodel.test.ts frontend/app/view/jarvis/briefingfixtures.ts \
        frontend/app/view/jarvis/graphpeek.tsx frontend/app/view/jarvis/briefpeekview.tsx \
        frontend/app/view/jarvis/petactrun.ts frontend/app/view/jarvis/petactrun.test.ts \
        frontend/app/view/jarvis/petacts.ts frontend/app/view/jarvis/petsources.tsx \
        frontend/app/view/jarvis/petjoin.ts frontend/app/view/jarvis/petstore.ts \
        frontend/app/view/agents/radarstore.ts frontend/app/view/agents/agents.tsx \
        frontend/app/view/agents/channelsprimitives.tsx frontend/app/view/agents/cockpitsurface.tsx \
        frontend/app/view/agents/sessionssurface.tsx frontend/app/view/agents/proactiveviews.tsx \
        frontend/app/view/agents/proactive.ts frontend/app/view/agents/radarfindingdetail.tsx \
        frontend/app/view/agents/runactions.ts frontend/app/view/agents/memstore.ts \
        frontend/app/view/agents/vaultrail.tsx \
        frontend/app/view/orchestrate/taskcorrelate.ts frontend/app/view/orchestrate/daggraph.tsx \
        frontend/app/view/orchestrate/dagoverview.tsx \
        scripts/cdp/scenarios.mjs
git status --short
git commit -m "feat(linking): open every cockpit address through one router that lands on the item or says why it cannot" \
  -m "Go emits canonical addresses (task:, memnote:, radarreport: with a finding anchor) through one wavevault.Address; grounding cards carry an anchor. parseAddress is the only reader of legacy strings, and openTarget loads, selects, then switches surface, reporting unsupported/unavailable/failed through the cockpit toast. pendingRunFocusAtom, normalizeBriefingNav, terminalTargetAtom and openORef are gone."
```

Before `git commit`, read `git status --short`: every staged path should be one this slice changed, and every modified path this slice changed should be staged (a file missing from the list above means a task touched something the plan did not name — find out why before adding it). Other sessions edit this working tree, so a listed file can also hold someone else's hunks; `git diff --cached <path>` shows them. No `Co-Authored-By` or session trailer.
