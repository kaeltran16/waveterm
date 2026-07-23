# Jarvis F — conversation backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote the Plan-2 stateless recall shim into the real Jarvis conversation backend — multi-turn, persisted as a `JarvisConvo` WaveObj, with attached-scope retrieval fixed — behind the G⇄F contract G already renders.

**Architecture:** Approach A (see the [spec](../specs/2026-07-23-jarvis-f-conversation-backend-design.md)). The backend owns a `JarvisConvo` WaveObj (SQLite, WOS-mirrored); `JarvisConverseCommand` reads prior turns from the record it owns and streams the live turn over the existing RPC channel; it persists the user turn at the start and the answer turn at the terminal on a fresh context. Retrieval stays the shim's per-question recency+scope logic plus a new attached-ORef resolver; prior-turn context is threaded into the synthesis prompt only. One model (tiering deferred).

**Tech Stack:** Go 1.x (`pkg/waveobj`, `pkg/wstore`, `pkg/wshrpc`, `pkg/jarvisrecall`), SQLite via `wstore`, the `consult` CLI harness for the model call, React 19 + jotai + Vitest on the FE, the repo's CDP scenario harness (`scripts/cdp/`). Codegen via Task (`task generate`).

## Global Constraints

Every task's requirements implicitly include these. Values copied verbatim from CLAUDE.md, the spec, and the codebase.

- **Model runtime = `consult.Run` (headless `claude` CLI). Never `aiusechat`** (on the removal path). Single model — tiering is deferred (recorded in `docs/deferred.md`, "Jarvis sub-project F — model tiering deferred").
- **Go is the source of truth for wire + object types.** After changing any `waveobj` / `wshrpc` type, run `task generate` (regenerates `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, and Go/TS type files). **Never hand-edit generated files.**
- **wshrpc codegen bootstrap:** removing a wshrpc type/command breaks `task generate` if a reference remains. Update every Go reference to a removed/renamed type **before** regenerating, and `go build ./...` clean before `task generate`.
- **New WaveObj type needs a migration.** `db/migrations-wstore/000015_jarvisconversation.{up,down}.sql` (next free number is `000015`). The dev app needs `task build:backend --force` to pick it up; `go test ./pkg/...` recompiles and re-embeds the migrations automatically.
- **A registered WaveObj type without its table errors "no such table"** — the migration (Task 2) must land with the registration (Task 1) before any DB call.
- **Conversation OIDs are UUIDs** (`crypto.randomUUID()` on the FE) so `WOS.makeORef("jarvisconversation", id)` + `loadAndPinWaveObject` resolve; `ParseORef` requires a UUID oid.
- **Do NOT promote the FE view-model to a WaveObj.** The persisted Go type is named **`JarvisConvo`** (otype string `"jarvisconversation"`); the FE view-model `JarvisConversation` in `jarviscontract.ts` and its fixtures stay untouched. A mapper bridges persisted → view-model.
- **Go tests:** `go test ./pkg/waveobj/`, `go test ./pkg/wstore/`, `go test ./pkg/jarvisrecall/`, `go test ./pkg/wshrpc/wshserver/`. Run with `-race` where goroutines are involved.
- **FE typecheck:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` stack-overflows). Baseline is clean; any error is yours.
- **FE single test:** `node node_modules/vitest/vitest.mjs run <path>`. No jsdom render tests (standing decision) — rendering/wiring is verified live via `task verify:ui`.
- **`prettier --write` gotcha:** never on `scripts/cdp/*.mjs` (`.editorconfig` omits `.mjs` → 2-space reindent). Hand-match 4-space style.
- **Git (per CLAUDE.md):** commits need explicit human approval and are batched — do NOT auto-commit or push. Each task's final step is **"stage + checkpoint for review."** The spec, this plan, and the `docs/deferred.md` entry fold into F's one feature commit at the end — never a docs-only commit.
- **Meta-spec tracking table:** do **not** edit `2026-07-23-jarvis-second-brain-meta-spec.md` during this plan — a concurrent agent (G Plan 4) is editing that same file. The F-row link is added at F's feature-commit time.

## File Structure

**New (Go):**
| File | Responsibility |
|---|---|
| `pkg/waveobj/jarvisconvo.go` | The `JarvisConvo` WaveObj + durable `JarvisConvoTurn` / `JarvisConvoGroundingCard` / `JarvisConvoSourceRef` types + `GetOType`. |
| `pkg/waveobj/jarvisconvo_test.go` | otype + JSON round-trip (both turn roles, grounding, prose). |
| `db/migrations-wstore/000015_jarvisconversation.up.sql` / `.down.sql` | The `db_jarvisconversation` table (mirror `000013`). |
| `pkg/wstore/wstore_jarvisconversation.go` | CRUD: create / get / list-newest-first / append-turn / delete (mirror `wstore_radarreport.go`). |
| `pkg/wstore/wstore_jarvisconversation_test.go` | schema-exists, registration, CRUD + ordering. |

**Modified (Go):**
| File | Change |
|---|---|
| `pkg/waveobj/wtype.go` | Register `OType_JarvisConversation` (const + `ValidOTypes` + `AllWaveObjTypes()`). |
| `pkg/wshrpc/wshrpctypes_jarvis.go` | `JarvisConverseChunk.Grounding` → `*waveobj.JarvisConvoGroundingCard`; drop `JarvisGroundingCard`/`JarvisWorkingStep` duplication as noted; add `ListJarvisConversationsCommand` + its types. |
| `pkg/wshrpc/wshserver/wshserver_jarvis.go` | `JarvisConverseCommand` gains load/create + persist user/answer turns; add `ListJarvisConversationsCommand`. |
| `pkg/jarvisrecall/recall.go` | `Converse(scope, priorTurns, prompt, emit) → answerTurn`; `synthesize` seam; attached resolution; emit `waveobj` card. |
| `pkg/jarvisrecall/cards.go` | `ScopeArgs`; `buildCards` emits `waveobj.JarvisConvoGroundingCard`; `assembleCandidates`, `priorContext` pure helpers; `scopeProject`/`inScope` take `ScopeArgs`. |
| `pkg/jarvisrecall/cards_test.go` | Adapt to `ScopeArgs`; add `assembleCandidates` + `priorContext` tests. |

**Modified (FE — mostly regenerated):**
| File | Change |
|---|---|
| `frontend/app/view/jarvis/recallderive.ts` (+ `.test.ts`) | `mapWireCard` param → generated `JarvisConvoGroundingCard`; add `mapConvoRecord(record) → JarvisConversation`. |
| `frontend/app/view/jarvis/jarvisstore.ts` | UUID ids; rehydrate rail from `ListJarvisConversationsCommand`; hydrate full turns on selection via WOS. |
| `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts` | Regenerated (do not hand-edit). |
| `scripts/cdp/scenarios.mjs` | New `jarvis-multiturn` scenario. |

---

### Task 1: The `JarvisConvo` WaveObj type + registration

**Files:**
- Create: `pkg/waveobj/jarvisconvo.go`, `pkg/waveobj/jarvisconvo_test.go`
- Modify: `pkg/waveobj/wtype.go`

**Interfaces:**
- Produces: `waveobj.JarvisConvo` (WaveObj), `waveobj.JarvisConvoTurn`, `waveobj.JarvisConvoGroundingCard`, `waveobj.JarvisConvoSourceRef`, `waveobj.OType_JarvisConversation = "jarvisconversation"`.

- [ ] **Step 1: Write the failing test**

Create `pkg/waveobj/jarvisconvo_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package waveobj

import (
	"reflect"
	"testing"
)

func TestJarvisConvoOType(t *testing.T) {
	if got := (&JarvisConvo{}).GetOType(); got != OType_JarvisConversation {
		t.Fatalf("GetOType() = %q, want %q", got, OType_JarvisConversation)
	}
	if !ValidOTypes[OType_JarvisConversation] {
		t.Fatalf("OType_JarvisConversation not in ValidOTypes")
	}
}

func TestJarvisConvoRoundTrip(t *testing.T) {
	RegisterType(reflect.TypeOf(&JarvisConvo{}))
	convo := &JarvisConvo{
		OID:           "11111111-1111-1111-1111-111111111111",
		Title:         "why did we drop worktrees",
		ScopeMode:     "all",
		AttachedORefs: []string{"run:r1"},
		Turns: []JarvisConvoTurn{
			{Role: "user", Text: "why did we drop worktrees?", Attachments: []JarvisConvoSourceRef{{ORef: "run:r1", SourceType: "run", Title: "the run"}}},
			{Role: "jarvis", Prose: "We dropped them [1].", Terminal: "answered", Grounding: []JarvisConvoGroundingCard{
				{N: 1, SourceType: "run", Title: "the run", Project: "waveterm", AgeMs: 1000, Freshness: "fresh", NavTarget: "run:r1"},
			}},
		},
		CreatedTs: 5, UpdatedTs: 6,
		Meta: make(MetaMapType),
	}
	data, err := ToJson(convo)
	if err != nil {
		t.Fatalf("ToJson: %v", err)
	}
	back, err := FromJson(data)
	if err != nil {
		t.Fatalf("FromJson: %v", err)
	}
	got, ok := back.(*JarvisConvo)
	if !ok {
		t.Fatalf("FromJson returned %T, want *JarvisConvo", back)
	}
	if got.Title != "why did we drop worktrees" || len(got.Turns) != 2 {
		t.Fatalf("round-trip header/turns mismatch: %+v", got)
	}
	if got.Turns[0].Role != "user" || got.Turns[0].Text != "why did we drop worktrees?" || len(got.Turns[0].Attachments) != 1 {
		t.Fatalf("user turn mismatch: %+v", got.Turns[0])
	}
	if got.Turns[1].Role != "jarvis" || got.Turns[1].Prose != "We dropped them [1]." || got.Turns[1].Terminal != "answered" || len(got.Turns[1].Grounding) != 1 {
		t.Fatalf("jarvis turn mismatch: %+v", got.Turns[1])
	}
	if got.Turns[1].Grounding[0].NavTarget != "run:r1" {
		t.Fatalf("grounding mismatch: %+v", got.Turns[1].Grounding[0])
	}
}
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `go test ./pkg/waveobj/ -run TestJarvisConvo`
Expected: FAIL — `JarvisConvo` / `OType_JarvisConversation` undefined.

- [ ] **Step 3: Register the otype in `wtype.go`**

In `pkg/waveobj/wtype.go`, add to the `const (...)` block (after `OType_ChannelMessage`):
```go
	OType_JarvisConversation = "jarvisconversation"
```
Add to `ValidOTypes` (after `OType_ChannelMessage: true,`):
```go
	OType_JarvisConversation: true,
```
Add to `AllWaveObjTypes()` (after `reflect.TypeOf(&ChannelMessage{}),`):
```go
		reflect.TypeOf(&JarvisConvo{}),
```

- [ ] **Step 4: Write `pkg/waveobj/jarvisconvo.go`**

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package waveobj

// JarvisConvo is a persisted Jarvis recall conversation (sub-project F). Named JarvisConvo (not
// JarvisConversation) to avoid colliding with the FE view-model interface of that name in jarviscontract.ts;
// the otype string is "jarvisconversation". Working-steps are transient (streamed over RPC) and never
// persisted. The answer turn stores raw model prose; the FE derives display segments via parseCitations.
type JarvisConvo struct {
	OID           string            `json:"oid"`
	Version       int               `json:"version"`
	Title         string            `json:"title"`
	ScopeMode     string            `json:"scopemode"` // object | project | all | attached
	ProjectPath   string            `json:"projectpath,omitempty"`
	AttachedORefs []string          `json:"attachedorefs,omitempty"`
	Turns         []JarvisConvoTurn `json:"turns"`
	CreatedTs     int64             `json:"createdts"`
	UpdatedTs     int64             `json:"updatedts"`
	Meta          MetaMapType       `json:"meta"`
}

func (*JarvisConvo) GetOType() string {
	return OType_JarvisConversation
}

// JarvisConvoTurn is one persisted turn, discriminated by Role. User: Text + Attachments. Jarvis: Prose
// (raw model output with inline [n]) + Grounding + Terminal.
type JarvisConvoTurn struct {
	Role        string                     `json:"role"` // user | jarvis
	Text        string                     `json:"text,omitempty"`
	Attachments []JarvisConvoSourceRef     `json:"attachments,omitempty"`
	Prose       string                     `json:"prose,omitempty"`
	Grounding   []JarvisConvoGroundingCard `json:"grounding,omitempty"`
	Terminal    string                     `json:"terminal,omitempty"` // answered | weak | notfound
}

type JarvisConvoSourceRef struct {
	ORef       string `json:"oref"`
	SourceType string `json:"sourcetype"`
	Title      string `json:"title"`
}

// JarvisConvoGroundingCard is one retrieved source, built deterministically in Go. This is the single
// definition of the grounding card (the wshrpc streaming chunk references it — see Task 3), so there is
// no duplicate card type across the wire and persistence layers.
type JarvisConvoGroundingCard struct {
	N          int    `json:"n"`
	SourceType string `json:"sourcetype"`
	Title      string `json:"title"`
	Project    string `json:"project"`
	AgeMs      int64  `json:"agems"`
	Freshness  string `json:"freshness"`
	NavTarget  string `json:"navtarget"`
}
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `go test ./pkg/waveobj/ -run TestJarvisConvo`
Expected: PASS.

- [ ] **Step 6: Full package build + stage**

Run: `go build ./pkg/waveobj/` → exit 0. Then stage + checkpoint (`git add pkg/waveobj/jarvisconvo.go pkg/waveobj/jarvisconvo_test.go pkg/waveobj/wtype.go`; do not commit).

---

### Task 2: Migration + `wstore` CRUD

**Files:**
- Create: `db/migrations-wstore/000015_jarvisconversation.up.sql`, `db/migrations-wstore/000015_jarvisconversation.down.sql`, `pkg/wstore/wstore_jarvisconversation.go`, `pkg/wstore/wstore_jarvisconversation_test.go`

**Interfaces:**
- Consumes: `waveobj.JarvisConvo`, `waveobj.OType_JarvisConversation` (Task 1); `DBInsert`, `DBMustGet`, `DBGetAllObjsByType`, `DBUpdateFn`, `DBDelete` (existing generics).
- Produces: `wstore.CreateJarvisConversation(ctx, oid, title, scopeMode, projectPath string, attachedORefs []string) (*waveobj.JarvisConvo, error)`, `GetJarvisConversation(ctx, id) (*waveobj.JarvisConvo, error)`, `GetJarvisConversations(ctx) ([]*waveobj.JarvisConvo, error)` (newest-first by `UpdatedTs`), `AppendJarvisTurn(ctx, id string, turn waveobj.JarvisConvoTurn) error`, `DeleteJarvisConversation(ctx, id) error`.

- [ ] **Step 1: Write the migration**

Create `db/migrations-wstore/000015_jarvisconversation.up.sql`:
```sql
CREATE TABLE IF NOT EXISTS db_jarvisconversation (
    oid varchar(36) PRIMARY KEY,
    version int NOT NULL,
    data json NOT NULL
);
```
Create `db/migrations-wstore/000015_jarvisconversation.down.sql`:
```sql
DROP TABLE IF EXISTS db_jarvisconversation;
```

- [ ] **Step 2: Write the failing test**

Create `pkg/wstore/wstore_jarvisconversation_test.go`:
```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wstore

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestJarvisConversationSchemaAndRegistration(t *testing.T) {
	ctx := context.Background()
	got, err := WithReadTxRtn(ctx, func(tx *TxWrap) (string, error) {
		return tx.GetString("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'db_jarvisconversation'"), nil
	})
	if err != nil {
		t.Fatalf("query sqlite_master: %v", err)
	}
	if got != "db_jarvisconversation" {
		t.Fatalf("db_jarvisconversation table missing (got %q) — did migration 000015 run?", got)
	}
	if ot := getOTypeGen[*waveobj.JarvisConvo](); ot != waveobj.OType_JarvisConversation {
		t.Fatalf("JarvisConvo otype = %q, want %q", ot, waveobj.OType_JarvisConversation)
	}
	if tn := tableNameGen[*waveobj.JarvisConvo](); tn != "db_jarvisconversation" {
		t.Fatalf("JarvisConvo table = %q, want db_jarvisconversation", tn)
	}
}

func TestJarvisConversationCRUD(t *testing.T) {
	ctx := context.Background()
	a, err := CreateJarvisConversation(ctx, "aaaaaaaa-0000-0000-0000-000000000001", "first", "all", "", nil)
	if err != nil {
		t.Fatalf("create a: %v", err)
	}
	b, err := CreateJarvisConversation(ctx, "bbbbbbbb-0000-0000-0000-000000000002", "second", "project", "/repo", []string{"run:r1"})
	if err != nil {
		t.Fatalf("create b: %v", err)
	}

	got, err := GetJarvisConversation(ctx, a.OID)
	if err != nil || got.Title != "first" || got.ScopeMode != "all" {
		t.Fatalf("get a mismatch: %+v err=%v", got, err)
	}

	if err := AppendJarvisTurn(ctx, a.OID, waveobj.JarvisConvoTurn{Role: "user", Text: "q1"}); err != nil {
		t.Fatalf("append turn: %v", err)
	}
	got, _ = GetJarvisConversation(ctx, a.OID)
	if len(got.Turns) != 1 || got.Turns[0].Text != "q1" {
		t.Fatalf("append not persisted: %+v", got.Turns)
	}

	// deterministic newest-first: set explicit UpdatedTs, a > b.
	_ = DBUpdateFn(ctx, a.OID, func(c *waveobj.JarvisConvo) { c.UpdatedTs = 2000 })
	_ = DBUpdateFn(ctx, b.OID, func(c *waveobj.JarvisConvo) { c.UpdatedTs = 1000 })
	list, err := GetJarvisConversations(ctx)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) < 2 || list[0].OID != a.OID {
		t.Fatalf("expected newest-first with a (%s) leading, got %v", a.OID, oidsOf(list))
	}

	if err := DeleteJarvisConversation(ctx, b.OID); err != nil {
		t.Fatalf("delete b: %v", err)
	}
	if _, err := GetJarvisConversation(ctx, b.OID); err == nil {
		t.Fatalf("expected b to be gone after delete")
	}
}

func oidsOf(list []*waveobj.JarvisConvo) []string {
	out := make([]string, len(list))
	for i, c := range list {
		out[i] = c.OID
	}
	return out
}
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `go test ./pkg/wstore/ -run TestJarvisConversation`
Expected: FAIL — `CreateJarvisConversation` etc. undefined (and/or table missing until Step 4 lands with the recompiled migration embed).

- [ ] **Step 4: Write `pkg/wstore/wstore_jarvisconversation.go`**

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wstore

import (
	"context"
	"sort"
	"time"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func CreateJarvisConversation(ctx context.Context, oid, title, scopeMode, projectPath string, attachedORefs []string) (*waveobj.JarvisConvo, error) {
	now := time.Now().UnixMilli()
	convo := &waveobj.JarvisConvo{
		OID:           oid,
		Title:         title,
		ScopeMode:     scopeMode,
		ProjectPath:   projectPath,
		AttachedORefs: attachedORefs,
		Turns:         []waveobj.JarvisConvoTurn{},
		CreatedTs:     now,
		UpdatedTs:     now,
		Meta:          make(waveobj.MetaMapType),
	}
	if err := DBInsert(ctx, convo); err != nil {
		return nil, err
	}
	return convo, nil
}

func GetJarvisConversation(ctx context.Context, id string) (*waveobj.JarvisConvo, error) {
	return DBMustGet[*waveobj.JarvisConvo](ctx, id)
}

// GetJarvisConversations returns all conversations, newest-first by UpdatedTs.
func GetJarvisConversations(ctx context.Context) ([]*waveobj.JarvisConvo, error) {
	all, err := DBGetAllObjsByType[*waveobj.JarvisConvo](ctx, waveobj.OType_JarvisConversation)
	if err != nil {
		return nil, err
	}
	sort.SliceStable(all, func(i, j int) bool { return all[i].UpdatedTs > all[j].UpdatedTs })
	return all, nil
}

// AppendJarvisTurn appends a turn and bumps UpdatedTs. Turns are immutable/append-only.
func AppendJarvisTurn(ctx context.Context, id string, turn waveobj.JarvisConvoTurn) error {
	return DBUpdateFn(ctx, id, func(c *waveobj.JarvisConvo) {
		c.Turns = append(c.Turns, turn)
		c.UpdatedTs = time.Now().UnixMilli()
	})
}

func DeleteJarvisConversation(ctx context.Context, id string) error {
	return DBDelete(ctx, waveobj.OType_JarvisConversation, id)
}
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `go test ./pkg/wstore/ -run TestJarvisConversation`
Expected: PASS (the recompile re-embeds migration 000015, which `TestMain`/`InitWStore` applies to the test DB).

- [ ] **Step 6: Stage + checkpoint** (`git add` the migration + store + test; do not commit).

---

### Task 3: Relocate the grounding card to `waveobj` + regenerate

Point the streaming chunk at the single `waveobj.JarvisConvoGroundingCard`, delete the duplicate `wshrpc.JarvisGroundingCard`, update the shim to emit it, regenerate bindings, and adapt the FE card mapper. No behavior change — a type move.

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_jarvis.go`, `pkg/jarvisrecall/cards.go`, `pkg/jarvisrecall/recall.go`, `frontend/app/view/jarvis/recallderive.ts`, `frontend/app/view/jarvis/recallderive.test.ts`
- Regenerated: `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`

**Interfaces:**
- Consumes: `waveobj.JarvisConvoGroundingCard` (Task 1).
- Produces: `JarvisConverseChunk.Grounding *waveobj.JarvisConvoGroundingCard`; `buildCards(...) []waveobj.JarvisConvoGroundingCard`; FE `mapWireCard(w: JarvisConvoGroundingCard) → GroundingCard`.

- [ ] **Step 1: Update the wire type**

In `pkg/wshrpc/wshrpctypes_jarvis.go`:
- Delete the `JarvisGroundingCard` struct.
- Change the chunk field:
```go
type JarvisConverseChunk struct {
	Kind      string                          `json:"kind"`
	Step      *JarvisWorkingStep              `json:"step,omitempty"`
	Grounding *waveobj.JarvisConvoGroundingCard `json:"grounding,omitempty"`
	Text      string                          `json:"text,omitempty"`
	Terminal  string                          `json:"terminal,omitempty"`
}
```
(`waveobj` is already imported in this file.)

- [ ] **Step 2: Update the shim to emit the `waveobj` card**

In `pkg/jarvisrecall/cards.go`, change `buildCards`'s return type and element type:
```go
func buildCards(cands []candidate, nowMs int64) []waveobj.JarvisConvoGroundingCard {
	cards := make([]waveobj.JarvisConvoGroundingCard, 0, len(cands))
	for i, c := range cands {
		cards = append(cards, waveobj.JarvisConvoGroundingCard{
			N:          i + 1,
			SourceType: c.sourceType,
			Title:      c.title,
			Project:    c.project,
			AgeMs:      nowMs - c.ts,
			Freshness:  c.freshness,
			NavTarget:  c.navTarget,
		})
	}
	return cards
}
```
In `pkg/jarvisrecall/recall.go`, the grounding-emit loop's `&c` now takes the address of a `waveobj.JarvisConvoGroundingCard` — matches the chunk field. No other change in this task.

- [ ] **Step 3: Build Go to confirm no dangling references**

Run: `go build ./...`
Expected: exit 0. (If a reference to `wshrpc.JarvisGroundingCard` remains, fix it before regenerating — the codegen bootstrap breaks otherwise.)

- [ ] **Step 4: Regenerate bindings**

Run: `task generate`
Expected: success; `frontend/types/gotypes.d.ts` now declares `JarvisConvoGroundingCard` and `JarvisConverseChunk.grounding` points at it; `JarvisGroundingCard` is gone.

- [ ] **Step 5: Write the failing FE test**

In `frontend/app/view/jarvis/recallderive.test.ts`, update/add the `mapWireCard` test to use the generated type shape (field names are unchanged):
```ts
import { mapWireCard } from "./recallderive";

describe("mapWireCard", () => {
    it("maps a generated JarvisConvoGroundingCard to the view-model card", () => {
        const w = { n: 2, sourcetype: "run", title: "the run", project: "waveterm", agems: 1000, freshness: "fresh", navtarget: "run:r1" } as JarvisConvoGroundingCard;
        expect(mapWireCard(w)).toEqual({ n: 2, sourceType: "run", title: "the run", project: "waveterm", ageMs: 1000, freshness: "fresh", navTarget: "run:r1" });
    });
});
```

- [ ] **Step 6: Update `mapWireCard`'s parameter type**

In `frontend/app/view/jarvis/recallderive.ts`, change the signature only (body unchanged — fields are identical):
```ts
export function mapWireCard(w: JarvisConvoGroundingCard): GroundingCard {
```

- [ ] **Step 7: Run FE test + typecheck**

Run: `node node_modules/vitest/vitest.mjs run frontend/app/view/jarvis/recallderive.test.ts` → PASS.
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0.
Run: `go test ./pkg/jarvisrecall/` → PASS (existing card tests adapt to the new element type; if `cards_test.go` asserts `wshrpc.JarvisGroundingCard`, update it to `waveobj.JarvisConvoGroundingCard`).

- [ ] **Step 8: Stage + checkpoint** (include the regenerated files).

---

### Task 4: Pure recall helpers — `assembleCandidates` + `priorContext`

The two pure, DB-free helpers Task 5 depends on: pinned-first candidate assembly (attached sources exempt from the recency cap) and bounded prior-turn context.

**Files:**
- Modify: `pkg/jarvisrecall/cards.go`, `pkg/jarvisrecall/cards_test.go`

**Interfaces:**
- Produces: `assembleCandidates(pinned, scoped []candidate, max int) []candidate`; `priorContext(turns []waveobj.JarvisConvoTurn, maxTurns int) string`; `const maxContextTurns = 6`.

- [ ] **Step 1: Write the failing test**

Add to `pkg/jarvisrecall/cards_test.go`:
```go
func TestAssembleCandidatesPinsAttached(t *testing.T) {
	pinned := []candidate{{navTarget: "run:p1"}, {navTarget: "run:p2"}}
	scoped := make([]candidate, 20)
	for i := range scoped {
		scoped[i] = candidate{navTarget: "run:s" + strconv.Itoa(i)}
	}
	out := assembleCandidates(pinned, scoped, maxCandidates)
	if len(out) != maxCandidates {
		t.Fatalf("len = %d, want %d", len(out), maxCandidates)
	}
	if out[0].navTarget != "run:p1" || out[1].navTarget != "run:p2" {
		t.Fatalf("pinned not first: %v", out[0].navTarget)
	}
}

func TestAssembleCandidatesKeepsAllPinnedBeyondMax(t *testing.T) {
	pinned := make([]candidate, maxCandidates+3)
	for i := range pinned {
		pinned[i] = candidate{navTarget: "run:p" + strconv.Itoa(i)}
	}
	out := assembleCandidates(pinned, nil, maxCandidates)
	if len(out) != maxCandidates+3 {
		t.Fatalf("pinned truncated: len = %d, want %d", len(out), maxCandidates+3)
	}
}

func TestAssembleCandidatesDedupesByNavTarget(t *testing.T) {
	pinned := []candidate{{navTarget: "run:x"}}
	scoped := []candidate{{navTarget: "run:x"}, {navTarget: "run:y"}}
	out := assembleCandidates(pinned, scoped, maxCandidates)
	if len(out) != 2 {
		t.Fatalf("expected dedupe to 2, got %d", len(out))
	}
}

func TestPriorContextCapsAndFormats(t *testing.T) {
	if priorContext(nil, maxContextTurns) != "" {
		t.Fatalf("empty turns should yield empty context")
	}
	turns := []waveobj.JarvisConvoTurn{}
	for i := 0; i < 10; i++ {
		turns = append(turns, waveobj.JarvisConvoTurn{Role: "user", Text: "q" + strconv.Itoa(i)})
	}
	got := priorContext(turns, 3)
	if strings.Contains(got, "q6") || !strings.Contains(got, "q7") || !strings.Contains(got, "q9") {
		t.Fatalf("expected only the last 3 turns (q7..q9), got:\n%s", got)
	}
}
```
(Ensure `strconv` is imported in the test file — `cards.go` already imports it, but the test file needs its own import.)

- [ ] **Step 2: Run it to confirm it fails**

Run: `go test ./pkg/jarvisrecall/ -run 'TestAssemble|TestPriorContext'`
Expected: FAIL — `assembleCandidates` / `priorContext` / `maxContextTurns` undefined.

- [ ] **Step 3: Implement the helpers**

Add to `pkg/jarvisrecall/cards.go`:
```go
// maxContextTurns bounds how many prior turns are threaded into the synthesis prompt. No cheap-model
// compaction (tiering deferred) — a fixed cap is the lever.
const maxContextTurns = 6

// assembleCandidates keeps every pinned candidate (attached sources — exempt from the recency cap), then
// fills remaining slots with scoped candidates up to max. Pinned come first; dedupe is by navTarget.
func assembleCandidates(pinned, scoped []candidate, max int) []candidate {
	out := make([]candidate, 0, max)
	seen := map[string]bool{}
	for _, c := range pinned {
		if seen[c.navTarget] {
			continue
		}
		seen[c.navTarget] = true
		out = append(out, c)
	}
	for _, c := range scoped {
		if len(out) >= max {
			break
		}
		if seen[c.navTarget] {
			continue
		}
		seen[c.navTarget] = true
		out = append(out, c)
	}
	return out
}

// priorContext renders the last maxTurns turns as a compact block prepended to the synthesis prompt. The
// model is told to cite the numbered Sources below, not this block. Empty when there are no prior turns.
func priorContext(turns []waveobj.JarvisConvoTurn, maxTurns int) string {
	if len(turns) == 0 {
		return ""
	}
	start := 0
	if len(turns) > maxTurns {
		start = len(turns) - maxTurns
	}
	var b strings.Builder
	b.WriteString("Conversation so far (context only — cite the numbered Sources below, never this):\n")
	for _, t := range turns[start:] {
		if t.Role == "user" {
			b.WriteString("Q: " + strings.TrimSpace(t.Text) + "\n")
		} else {
			b.WriteString("A: " + strings.TrimSpace(t.Prose) + "\n")
		}
	}
	b.WriteString("\n")
	return b.String()
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `go test ./pkg/jarvisrecall/ -run 'TestAssemble|TestPriorContext'`
Expected: PASS.

- [ ] **Step 5: Stage + checkpoint.**

---

### Task 5: Converse backend — multi-turn, attached, persistence

Rewrite `Converse` to take a scope + prior turns, resolve attached ORefs, thread prior context, stream, and return the assembled answer turn; add the `synthesize` seam; wire `JarvisConverseCommand` to load/create the record and persist both turns on a fresh context. This is one deliverable (the backend now converses statefully) and leaves the tree compiling.

**Files:**
- Modify: `pkg/jarvisrecall/recall.go`, `pkg/jarvisrecall/cards.go`, `pkg/wshrpc/wshserver/wshserver_jarvis.go`
- Create: `pkg/jarvisrecall/converse_test.go`

**Interfaces:**
- Consumes: `assembleCandidates`, `priorContext`, `maxContextTurns` (Task 4); `wstore.CreateJarvisConversation`/`GetJarvisConversation`/`AppendJarvisTurn` (Task 2); `waveobj.JarvisConvo*` (Task 1); `consult.SpecFor`/`consult.Run`.
- Produces: `jarvisrecall.ScopeArgs{Mode, ProjectPath string; AttachedORefs []string}`; `Converse(ctx, scope ScopeArgs, priorTurns []waveobj.JarvisConvoTurn, prompt string, emit Emit) (waveobj.JarvisConvoTurn, error)`; `SetSynthesizeForTest(fn) (old)`.

- [ ] **Step 1: Write the failing test**

Create `pkg/jarvisrecall/converse_test.go`:
```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisrecall

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestConverseThreadsPriorContextAndTerminal(t *testing.T) {
	var seenPrompt string
	old := SetSynthesizeForTest(func(ctx context.Context, cwd, prompt string, onChunk func(string)) (string, error) {
		seenPrompt = prompt
		onChunk("because of [1]")
		return "because of [1]", nil
	})
	defer SetSynthesizeForTest(old)

	prior := []waveobj.JarvisConvoTurn{{Role: "user", Text: "what changed?"}, {Role: "jarvis", Prose: "we dropped worktrees"}}
	var terminals []string
	emit := func(c wshrpc.JarvisConverseChunk) {
		if c.Kind == "terminal" {
			terminals = append(terminals, c.Terminal)
		}
	}
	// scope "all" with no attached: retrieval returns whatever the test DB holds; if empty, terminal is
	// notfound (no model call). Force at least one candidate by stubbing retrieve via an attached run in
	// the wshserver-level test; here assert the prior-context threading path when candidates exist is
	// covered by TestConversePinsAttached below. This case asserts notfound short-circuit on empty scope.
	turn, err := Converse(context.Background(), ScopeArgs{Mode: "all"}, prior, "why?", emit)
	if err != nil {
		t.Fatalf("Converse: %v", err)
	}
	if turn.Role != "jarvis" {
		t.Fatalf("answer turn role = %q", turn.Role)
	}
	if len(terminals) != 1 {
		t.Fatalf("want exactly one terminal, got %v", terminals)
	}
	_ = seenPrompt // asserted in TestConversePinsAttached where candidates exist
}
```

> Note: this first case may resolve to `notfound` (empty test DB) — that is the deterministic path. The prior-context-in-prompt and attached-pinning assertions live in the next step's DB-backed test, which guarantees a candidate.

Append the attached-pinning + prior-context assertion (DB-backed) to the same file:
```go
func TestConversePinsAttachedAndThreadsContext(t *testing.T) {
	ctx := context.Background()
	run := &waveobj.Run{OID: "cccccccc-0000-0000-0000-000000000001", ID: "cccccccc-0000-0000-0000-000000000001", Goal: "ship worktrees removal", Status: "done"}
	if err := wstoreInsertRunForTest(ctx, run); err != nil {
		t.Fatalf("insert run: %v", err)
	}
	var seenPrompt string
	old := SetSynthesizeForTest(func(ctx context.Context, cwd, prompt string, onChunk func(string)) (string, error) {
		seenPrompt = prompt
		onChunk("answer [1]")
		return "answer [1]", nil
	})
	defer SetSynthesizeForTest(old)

	prior := []waveobj.JarvisConvoTurn{{Role: "user", Text: "what changed?"}}
	scope := ScopeArgs{Mode: "attached", AttachedORefs: []string{"run:cccccccc-0000-0000-0000-000000000001"}}
	turn, err := Converse(ctx, scope, prior, "why?", func(wshrpc.JarvisConverseChunk) {})
	if err != nil {
		t.Fatalf("Converse: %v", err)
	}
	if !strings.Contains(seenPrompt, "what changed?") {
		t.Fatalf("prior context not threaded into prompt:\n%s", seenPrompt)
	}
	if !strings.Contains(seenPrompt, "ship worktrees removal") {
		t.Fatalf("attached run not pinned into prompt sources:\n%s", seenPrompt)
	}
	if turn.Terminal != "answered" || turn.Prose != "answer [1]" || len(turn.Grounding) == 0 {
		t.Fatalf("answer turn mismatch: %+v", turn)
	}
}
```

> `wstoreInsertRunForTest` is a thin test helper you add in this file that calls `wstore.DBInsert(ctx, run)` — import `pkg/wstore`. (The `jarvisrecall` package already imports `wstore`.) If the `jarvisrecall` test package cannot import `wstore` without a cycle, insert the run through `wstore` in a `wstore`-package helper instead; verify by building the test.

- [ ] **Step 2: Run it to confirm it fails**

Run: `go test ./pkg/jarvisrecall/ -run TestConverse`
Expected: FAIL — `SetSynthesizeForTest` / new `Converse` signature / `ScopeArgs` undefined.

- [ ] **Step 3: Introduce `ScopeArgs` + the `synthesize` seam + rewrite `Converse`**

In `pkg/jarvisrecall/cards.go`, change `scopeProject`/`inScope`/(new) to take `ScopeArgs`:
```go
type ScopeArgs struct {
	Mode          string
	ProjectPath   string
	AttachedORefs []string
}

func scopeProject(scope ScopeArgs) string {
	if scope.Mode == "project" {
		return scope.ProjectPath
	}
	return ""
}

func inScope(scope ScopeArgs, sourceType, project string) bool {
	if scope.Mode != "project" {
		return true
	}
	return normPath(project) == normPath(scope.ProjectPath)
}

func scopeCwd(scope ScopeArgs) string {
	if scope.ProjectPath != "" {
		return scope.ProjectPath
	}
	return wavebase.GetHomeDir()
}
```
(Move the `wavebase` import into `cards.go` if `scopeCwd` lives there, or keep `synthCwd` in `recall.go` renamed — keep one. This plan puts `scopeCwd` in `cards.go`.)

In `pkg/jarvisrecall/recall.go`, replace `synthCwd` usage, add the seam, and rewrite `Converse` and `retrieve`:
```go
const notFoundProse = "Not found. No Wave source in scope references this."

var errNoClaude = fmt.Errorf("recall requires the claude CLI, which is not available")

// synthesize runs one model synthesis, streaming chunks via onChunk. A package var so tests can stub the
// model (the real impl shells out to the claude CLI — untestable in CI). Single model; tiering deferred.
var synthesize = func(ctx context.Context, cwd, prompt string, onChunk func(string)) (string, error) {
	spec, ok := consult.SpecFor("claude")
	if !ok {
		return "", errNoClaude
	}
	return consult.Run(ctx, spec, cwd, prompt, onChunk)
}

// SetSynthesizeForTest swaps the model seam and returns the previous value (defer to restore).
func SetSynthesizeForTest(fn func(ctx context.Context, cwd, prompt string, onChunk func(string)) (string, error)) func(ctx context.Context, cwd, prompt string, onChunk func(string)) (string, error) {
	old := synthesize
	synthesize = fn
	return old
}

func Converse(ctx context.Context, scope ScopeArgs, priorTurns []waveobj.JarvisConvoTurn, prompt string, emit Emit) (waveobj.JarvisConvoTurn, error) {
	emit(stepChunk("retrieve", "Searching runs, radar, and memory", "active"))
	cands, err := retrieve(ctx, scope)
	if err != nil {
		return waveobj.JarvisConvoTurn{}, err
	}
	emit(stepChunk("retrieve", "Searched runs, radar, and memory", "done"))

	cards := buildCards(cands, time.Now().UnixMilli())
	for i := range cards {
		c := cards[i]
		emit(wshrpc.JarvisConverseChunk{Kind: "grounding", Grounding: &c})
	}

	if len(cards) == 0 {
		emit(wshrpc.JarvisConverseChunk{Kind: "text", Text: notFoundProse})
		emit(wshrpc.JarvisConverseChunk{Kind: "terminal", Terminal: "notfound"})
		return waveobj.JarvisConvoTurn{Role: "jarvis", Prose: notFoundProse, Terminal: "notfound"}, nil
	}

	emit(stepChunk("synthesize", "Synthesizing a grounded answer", "active"))
	fullPrompt := priorContext(priorTurns, maxContextTurns) + buildPrompt(prompt, cands)
	runCtx, cancel := context.WithTimeout(ctx, synthTimeout)
	defer cancel()
	var full strings.Builder
	_, runErr := synthesize(runCtx, scopeCwd(scope), fullPrompt, func(chunk string) {
		full.WriteString(chunk)
		select {
		case <-runCtx.Done():
		default:
			emit(wshrpc.JarvisConverseChunk{Kind: "text", Text: chunk})
		}
	})
	emit(stepChunk("synthesize", "Synthesized a grounded answer", "done"))
	prose := full.String()
	if runErr != nil {
		emit(wshrpc.JarvisConverseChunk{Kind: "terminal", Terminal: "weak"})
		return waveobj.JarvisConvoTurn{Role: "jarvis", Prose: prose, Grounding: cards, Terminal: "weak"}, runErr
	}
	terminal := selectTerminal(len(cards), countCitations(prose, len(cards)))
	emit(wshrpc.JarvisConverseChunk{Kind: "terminal", Terminal: terminal})
	return waveobj.JarvisConvoTurn{Role: "jarvis", Prose: prose, Grounding: cards, Terminal: terminal}, nil
}

// retrieve resolves attached ORefs into pinned candidates, loads the scope-filtered recency slice, and
// assembles them (pinned first, exempt from the cap).
func retrieve(ctx context.Context, scope ScopeArgs) ([]candidate, error) {
	pinned := resolveAttached(ctx, scope.AttachedORefs)
	scoped, err := retrieveScoped(ctx, scope)
	if err != nil {
		return nil, err
	}
	sortByRecency(scoped)
	return assembleCandidates(pinned, scoped, maxCandidates), nil
}

// retrieveScoped is the former shim retrieve body, now scope-typed.
func retrieveScoped(ctx context.Context, scope ScopeArgs) ([]candidate, error) {
	var cands []candidate
	runs, err := wstore.DBGetAllObjsByType[*waveobj.Run](ctx, waveobj.OType_Run)
	if err != nil {
		return nil, err
	}
	for _, r := range runs {
		if inScope(scope, "run", r.ProjectPath) {
			cands = append(cands, runCandidate(r))
		}
	}
	reports, err := wstore.GetRadarReports(ctx, scopeProject(scope))
	if err != nil {
		return nil, err
	}
	for _, rep := range reports {
		for _, f := range rep.Findings {
			if f.Group == "nolonger" || f.Group == "dismissed" || f.Group == "suppressed" {
				continue
			}
			cands = append(cands, radarCandidate(rep, f))
		}
	}
	if graph, gerr := memvault.ScanVault(memvault.VaultRoots()); gerr == nil && graph != nil {
		for _, n := range graph.Notes {
			if inScope(scope, "memory", n.Scope) {
				cands = append(cands, memoryCandidate(n))
			}
		}
	}
	return cands, nil
}

// resolveAttached loads each attached oref into a pinned candidate. Unresolvable orefs are skipped (an
// attachment that no longer exists must not sink the query). Handles the sourceType forms the contextual
// entries produce: run:<uuid>, memory:<id>, radar:<findingid>.
func resolveAttached(ctx context.Context, orefs []string) []candidate {
	var out []candidate
	for _, ref := range orefs {
		parts := strings.SplitN(ref, ":", 2)
		if len(parts) != 2 || parts[1] == "" {
			continue
		}
		switch parts[0] {
		case "run":
			if r, err := wstore.DBMustGet[*waveobj.Run](ctx, parts[1]); err == nil {
				out = append(out, runCandidate(r))
			}
		case "memory":
			if graph, gerr := memvault.ScanVault(memvault.VaultRoots()); gerr == nil && graph != nil {
				for _, n := range graph.Notes {
					if n.ID == parts[1] {
						out = append(out, memoryCandidate(n))
						break
					}
				}
			}
		case "radar":
			if reports, rerr := wstore.GetRadarReports(ctx, ""); rerr == nil {
				for _, rep := range reports {
					for _, f := range rep.Findings {
						if f.ID == parts[1] {
							out = append(out, radarCandidate(rep, f))
						}
					}
				}
			}
		}
	}
	return out
}
```
Remove the now-unused `synthCwd` and the old `retrieve(ctx, data)`; delete `recall.go`'s direct `consult.SpecFor`/`consult.Run` in `Converse` (now inside `synthesize`). Verify `RadarFinding` has an `ID` field (`waveobj.RadarFinding`); if the field name differs, use the actual field.

- [ ] **Step 4: Rewrite `JarvisConverseCommand` (load/create + persist)**

In `pkg/wshrpc/wshserver/wshserver_jarvis.go`, replace the body of `JarvisConverseCommand` and add helpers:
```go
func (ws *WshServer) JarvisConverseCommand(ctx context.Context, data wshrpc.CommandJarvisConverseData) chan wshrpc.RespOrErrorUnion[wshrpc.JarvisConverseChunk] {
	rtn := make(chan wshrpc.RespOrErrorUnion[wshrpc.JarvisConverseChunk])
	go func() {
		defer func() { panichandler.PanicHandler("JarvisConverseCommand", recover()) }()
		defer close(rtn)
		emit := func(chunk wshrpc.JarvisConverseChunk) {
			select {
			case rtn <- wshrpc.RespOrErrorUnion[wshrpc.JarvisConverseChunk]{Response: chunk}:
			case <-ctx.Done():
			}
		}
		convo, err := wstore.GetJarvisConversation(ctx, data.ConversationId)
		if err != nil {
			convo, err = wstore.CreateJarvisConversation(ctx, data.ConversationId, firstLine(data.Prompt), data.ScopeMode, data.ProjectPath, data.AttachedORefs)
			if err != nil {
				rtn <- wshrpc.RespOrErrorUnion[wshrpc.JarvisConverseChunk]{Error: err}
				return
			}
		}
		priorTurns := convo.Turns
		persistJarvisTurn(convo.OID, waveobj.JarvisConvoTurn{
			Role:        "user",
			Text:        strings.TrimSpace(data.Prompt),
			Attachments: attachmentsFromORefs(convo.AttachedORefs),
		})
		scope := jarvisrecall.ScopeArgs{Mode: convo.ScopeMode, ProjectPath: convo.ProjectPath, AttachedORefs: convo.AttachedORefs}
		answerTurn, cErr := jarvisrecall.Converse(ctx, scope, priorTurns, data.Prompt, emit)
		if cErr != nil {
			log.Printf("jarvis converse: %v", cErr)
		}
		persistJarvisTurn(convo.OID, answerTurn)
	}()
	return rtn
}

// persistJarvisTurn appends a turn on a FRESH context (a slow synthesis routinely outlives the RPC ctx) and
// live-updates the pinned conversation atom. A persist failure degrades durability for that one turn only.
func persistJarvisTurn(convoId string, turn waveobj.JarvisConvoTurn) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := wstore.AppendJarvisTurn(ctx, convoId, turn); err != nil {
		log.Printf("jarvis: persist turn: %v", err)
		return
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_JarvisConversation, convoId))
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if len(s) > 120 {
		s = s[:120]
	}
	if s == "" {
		return "New conversation"
	}
	return s
}

// attachmentsFromORefs builds minimal persisted source refs (title unknown at this layer — the FE showed it
// at attach time; the rehydrated chip renders oref + type).
func attachmentsFromORefs(orefs []string) []waveobj.JarvisConvoSourceRef {
	if len(orefs) == 0 {
		return nil
	}
	out := make([]waveobj.JarvisConvoSourceRef, 0, len(orefs))
	for _, ref := range orefs {
		st := ref
		if i := strings.IndexByte(ref, ':'); i > 0 {
			st = ref[:i]
		}
		out = append(out, waveobj.JarvisConvoSourceRef{ORef: ref, SourceType: st})
	}
	return out
}
```
Add `"github.com/wavetermdev/waveterm/pkg/waveobj"` and `"github.com/wavetermdev/waveterm/pkg/wcore"` to imports if not present (both already are). Remove the old `jarvisrecall.Converse(ctx, data, emit)` call.

- [ ] **Step 5: Add the wshserver-level persistence test**

Create `pkg/wshrpc/wshserver/wshserver_jarvis_test.go`:
```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvisrecall"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestJarvisConverseCreatesAndPersistsTurns(t *testing.T) {
	old := jarvisrecall.SetSynthesizeForTest(func(ctx context.Context, cwd, prompt string, onChunk func(string)) (string, error) {
		onChunk("grounded answer [1]")
		return "grounded answer [1]", nil
	})
	defer jarvisrecall.SetSynthesizeForTest(old)

	ctx := context.Background()
	ws := &WshServer{}
	data := wshrpc.CommandJarvisConverseData{ConversationId: "dddddddd-0000-0000-0000-000000000001", Prompt: "why?", ScopeMode: "all", RequestId: "r1"}
	for range ws.JarvisConverseCommand(ctx, data) {
		// drain the stream
	}
	convo, err := wstore.GetJarvisConversation(ctx, data.ConversationId)
	if err != nil {
		t.Fatalf("conversation not created/persisted: %v", err)
	}
	if len(convo.Turns) != 2 {
		t.Fatalf("want 2 persisted turns (user + jarvis), got %d: %+v", len(convo.Turns), convo.Turns)
	}
	if convo.Turns[0].Role != "user" || convo.Turns[0].Text != "why?" {
		t.Fatalf("user turn mismatch: %+v", convo.Turns[0])
	}
	if convo.Turns[1].Role != "jarvis" {
		t.Fatalf("answer turn role = %q", convo.Turns[1].Role)
	}
	// empty test DB -> notfound is acceptable; assert the turn persisted with a terminal verdict.
	if convo.Turns[1].Terminal == "" {
		t.Fatalf("answer turn has no terminal verdict: %+v", convo.Turns[1])
	}
	if convo.Title != "why?" {
		t.Fatalf("title = %q, want first prompt", convo.Title)
	}
}
```

- [ ] **Step 6: Run + verify**

Run: `go test ./pkg/jarvisrecall/ ./pkg/wshrpc/wshserver/ -run 'TestConverse|TestJarvisConverse' -race`
Expected: PASS. Then `go build ./...` → exit 0.

- [ ] **Step 7: Stage + checkpoint.**

---

### Task 6: `ListJarvisConversationsCommand` + history-rail rehydration

The rail must show conversations persisted across sessions. Add the list command and render its summaries in the rail.

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_jarvis.go`, `pkg/wshrpc/wshserver/wshserver_jarvis.go`, `frontend/app/view/jarvis/jarvisstore.ts`
- Regenerated: `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`

**Interfaces:**
- Produces (Go): `ListJarvisConversationsCommand(ctx) (*CommandListJarvisConversationsRtnData, error)`; `type JarvisConversationSummary struct { Id, Title, ScopeMode string; UpdatedTs int64 }`; `type CommandListJarvisConversationsRtnData struct { Conversations []JarvisConversationSummary }`.
- Produces (FE): `persistedSummariesAtom`, `loadJarvisConversations()`.

- [ ] **Step 1: Add the wire types + interface entry**

In `pkg/wshrpc/wshrpctypes_jarvis.go`, add to the `JarvisCommands` interface:
```go
	ListJarvisConversationsCommand(ctx context.Context) (*CommandListJarvisConversationsRtnData, error) // list persisted recall conversations, newest-first (history rail)
```
And the types:
```go
type JarvisConversationSummary struct {
	Id        string `json:"id"`
	Title     string `json:"title"`
	ScopeMode string `json:"scopemode"`
	UpdatedTs int64  `json:"updatedts"`
}

type CommandListJarvisConversationsRtnData struct {
	Conversations []JarvisConversationSummary `json:"conversations"`
}
```

- [ ] **Step 2: Implement it in wshserver**

In `pkg/wshrpc/wshserver/wshserver_jarvis.go`:
```go
func (ws *WshServer) ListJarvisConversationsCommand(ctx context.Context) (*wshrpc.CommandListJarvisConversationsRtnData, error) {
	convos, err := wstore.GetJarvisConversations(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]wshrpc.JarvisConversationSummary, 0, len(convos))
	for _, c := range convos {
		out = append(out, wshrpc.JarvisConversationSummary{Id: c.OID, Title: c.Title, ScopeMode: c.ScopeMode, UpdatedTs: c.UpdatedTs})
	}
	return &wshrpc.CommandListJarvisConversationsRtnData{Conversations: out}, nil
}
```

- [ ] **Step 3: Build + regenerate**

Run: `go build ./...` → exit 0 (interface + impl in sync). Then `task generate`.
Expected: `RpcApi.ListJarvisConversationsCommand` exists in `wshclientapi.ts`; `JarvisConversationSummary` in `gotypes.d.ts`.

- [ ] **Step 4: Write the failing FE test**

Add to a new `frontend/app/view/jarvis/jarvisstore.test.ts` (pure logic only — no rendering):
```ts
import { describe, expect, it } from "vitest";
import { summaryToRailConversation } from "./jarvisstore";

describe("summaryToRailConversation", () => {
    it("maps a summary to a minimal history-rail conversation (no turns yet)", () => {
        const conv = summaryToRailConversation({ id: "abc", title: "why worktrees", scopemode: "all", updatedts: 5 } as JarvisConversationSummary);
        expect(conv.id).toBe("abc");
        expect(conv.title).toBe("why worktrees");
        expect(conv.turns).toEqual([]);
        expect(conv.scope.mode).toBe("all");
    });
});
```

- [ ] **Step 5: Implement the rail rehydration**

In `frontend/app/view/jarvis/jarvisstore.ts`:
- Add a summaries atom + loader + the pure mapper:
```ts
// persisted conversation summaries loaded from the backend (history rail across sessions). Full turns are
// hydrated lazily on selection (Task 7). Module atom — survives the surface unmount.
export const persistedSummariesAtom = atom<JarvisConversationSummary[]>([]);

export function summaryToRailConversation(s: JarvisConversationSummary): JarvisConversation {
    return {
        id: s.id,
        title: s.title,
        turns: [],
        scope: { mode: s.scopemode as JarvisScope["mode"], chips: [], attached: [] },
    };
}

export function loadJarvisConversations(): void {
    fireAndForget(async () => {
        const res = await RpcApi.ListJarvisConversationsCommand(TabRpcClient);
        globalStore.set(persistedSummariesAtom, res?.conversations ?? []);
    });
}
```
- Extend `conversationsAtom` so the rail shows persisted conversations that are not already live in `conversationsByIdAtom`, then live ones, then fixtures:
```ts
export const conversationsAtom = atom<JarvisConversation[]>((get) => {
    const byId = get(conversationsByIdAtom);
    const live = Object.values(byId).reverse();
    const liveIds = new Set(Object.keys(byId));
    const persisted = get(persistedSummariesAtom)
        .filter((s) => !liveIds.has(s.id))
        .map(summaryToRailConversation);
    const fixtures = FIXTURE_STATES.filter((s) => s !== "narrow").map((s) => FIXTURES[s]);
    return [...live, ...persisted, ...fixtures];
});
```
- Call `loadJarvisConversations()` when the Jarvis surface mounts (from `jarvissurface.tsx`'s existing mount effect, or a one-line `useEffect(() => loadJarvisConversations(), [])`). Import the types from `@/app/view/jarvis/jarviscontract` (view-model) and the generated `JarvisConversationSummary` global.

- [ ] **Step 6: Run + typecheck**

Run: `node node_modules/vitest/vitest.mjs run frontend/app/view/jarvis/jarvisstore.test.ts` → PASS.
Run: `go test ./pkg/wshrpc/wshserver/ -run TestJarvisConverse` → still PASS.
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0.

- [ ] **Step 7: Stage + checkpoint** (include regenerated files).

---

### Task 7: FE — UUID ids + hydrate full turns on selection

Give conversations valid ORef ids and load a persisted conversation's turns when its rail row is selected.

**Files:**
- Modify: `frontend/app/view/jarvis/jarvisstore.ts`, `frontend/app/view/jarvis/recallderive.ts`, `frontend/app/view/jarvis/recallderive.test.ts`

**Interfaces:**
- Consumes: `WOS.makeORef` / `WOS.loadAndPinWaveObject` (`@/app/store/wos`); generated `JarvisConvo` global; `mapWireCard`, `parseCitations` (`recallderive`).
- Produces: `recallderive.mapConvoRecord(record: JarvisConvo): JarvisConversation`.

- [ ] **Step 1: Write the failing test**

Add to `frontend/app/view/jarvis/recallderive.test.ts`:
```ts
import { mapConvoRecord } from "./recallderive";

describe("mapConvoRecord", () => {
    it("maps a persisted JarvisConvo to the view-model, deriving segments from prose", () => {
        const record = {
            oid: "abc",
            title: "why worktrees",
            scopemode: "all",
            turns: [
                { role: "user", text: "why?", attachments: [{ oref: "run:r1", sourcetype: "run", title: "the run" }] },
                {
                    role: "jarvis",
                    prose: "because of [1] mostly",
                    terminal: "answered",
                    grounding: [{ n: 1, sourcetype: "run", title: "the run", project: "waveterm", agems: 1000, freshness: "fresh", navtarget: "run:r1" }],
                },
            ],
        } as unknown as JarvisConvo;
        const vm = mapConvoRecord(record);
        expect(vm.id).toBe("abc");
        expect(vm.turns).toHaveLength(2);
        expect(vm.turns[0]).toMatchObject({ role: "user", text: "why?" });
        const answer = vm.turns[1] as JarvisAnswerTurn;
        expect(answer.role).toBe("jarvis");
        expect(answer.terminal).toBe("answered");
        expect(answer.workingSteps).toEqual([]);
        expect(answer.grounding).toHaveLength(1);
        // prose "because of [1] mostly" -> [text, citation(1), text]
        expect(answer.segments).toEqual([{ text: "because of " }, { citationRef: 1 }, { text: " mostly" }]);
    });
});
```
(Import `JarvisAnswerTurn` from `./jarviscontract`.)

- [ ] **Step 2: Run it to confirm it fails**

Run: `node node_modules/vitest/vitest.mjs run frontend/app/view/jarvis/recallderive.test.ts`
Expected: FAIL — `mapConvoRecord` is not exported.

- [ ] **Step 3: Implement `mapConvoRecord`**

Add to `frontend/app/view/jarvis/recallderive.ts`:
```ts
import type { JarvisConversation, JarvisScope, JarvisTurn, SourceRef, SourceType } from "./jarviscontract";

// mapConvoRecord converts a persisted JarvisConvo (generated, lowercase JSON keys) into the render view-model.
// The answer turn stores raw prose; display segments are derived here via parseCitations (single parser).
// Working-steps are transient and are always empty on a rehydrated turn.
export function mapConvoRecord(record: JarvisConvo): JarvisConversation {
    const turns: JarvisTurn[] = (record.turns ?? []).map((t) => {
        if (t.role === "user") {
            return {
                role: "user",
                text: t.text ?? "",
                attachments: (t.attachments ?? []).map(
                    (a): SourceRef => ({ oref: a.oref, sourceType: a.sourcetype as SourceType, title: a.title })
                ),
            };
        }
        const cards = (t.grounding ?? []).map(mapWireCard);
        return {
            role: "jarvis",
            workingSteps: [],
            segments: parseCitations(t.prose ?? "", cards),
            grounding: cards,
            terminal: (t.terminal ?? "answered") as JarvisAnswerTurn["terminal"],
        };
    });
    const scope: JarvisScope = { mode: (record.scopemode as JarvisScope["mode"]) ?? "all", chips: [], attached: [] };
    return { id: record.oid, title: record.title, turns, scope };
}
```
(Import `JarvisAnswerTurn` too. Confirm the generated `JarvisConvo` field names match the Go json tags: `oid/title/scopemode/turns/…`.)

- [ ] **Step 4: Hydrate on selection + UUID ids in `jarvisstore.ts`**

- Change `startConversation`'s id generation:
```ts
export function startConversation(scope: JarvisScope): string {
    const id = crypto.randomUUID();
    setConversation({ id, title: "New conversation", turns: [], scope });
    globalStore.set(activeConversationIdAtom, id);
    return id;
}
```
- Extend `selectConversation` so selecting a persisted summary row that is not yet in `conversationsByIdAtom` loads the record via WOS and maps it:
```ts
export function selectConversation(id: string): void {
    if (globalStore.get(conversationsByIdAtom)[id]) {
        globalStore.set(activeConversationIdAtom, id);
        return;
    }
    if ((FIXTURE_STATES as string[]).includes(id)) {
        globalStore.set(activeFixtureAtom, id as FixtureState);
        globalStore.set(activeConversationIdAtom, null);
        return;
    }
    // a persisted-only conversation: hydrate its full turns from the WaveObj, then activate.
    globalStore.set(activeConversationIdAtom, id);
    fireAndForget(async () => {
        const oref = WOS.makeORef("jarvisconversation", id);
        if (!oref) return;
        const record = (await WOS.loadAndPinWaveObject(oref)) as JarvisConvo | null;
        if (record) setConversation(mapConvoRecord(record));
    });
}
```
Add imports: `import * as WOS from "@/app/store/wos";` and `import { mapConvoRecord } from "./recallderive";`.

- [ ] **Step 5: Run + typecheck**

Run: `node node_modules/vitest/vitest.mjs run frontend/app/view/jarvis/recallderive.test.ts` → PASS.
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0.

- [ ] **Step 6: Stage + checkpoint.**

---

### Task 8: CDP — multi-turn + persistence live check

Verify the whole path in the dev app: the migration applied, a follow-up resolves prior context, and a conversation survives reload in the history rail.

**Files:**
- Modify: `scripts/cdp/scenarios.mjs`

- [ ] **Step 1: Apply the migration in the running dev app**

Rebuild the backend so migration 000015 lands: `task build:backend --force`, then let `task dev` rebuild (or restart it). Confirm no "no such table: db_jarvisconversation" in the dev log.

- [ ] **Step 2: Add the `jarvis-multiturn` scenario**

Append to the `SCENARIOS` array in `scripts/cdp/scenarios.mjs` (hand-match 4-space style; do not `prettier --write`):
```js
// --- jarvis multi-turn + persistence: ask, follow up (prior context), reload -> rail persists (Plan F) ---
const jarvisMultiturn = {
    name: "jarvis-multiturn",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        await h.goto("jarvis");
        // ask the first question via the composer.
        const asked = await h.ev(`(() => {
            const inp = document.querySelector('input[placeholder="Ask Jarvis…"]');
            if (!inp) return false;
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(inp, 'what changed in the worktree work');
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            return true;
        })()`);
        await h.ev("new Promise((r) => setTimeout(r, 4000))");
        const firstTurn = await h.ev(`(() => (document.body.innerText || '').includes('what changed in the worktree work'))()`);
        steps.push({ step: "first question renders as a user turn", ok: asked && firstTurn === true, detail: `firstTurn=${firstTurn}` });

        // reload; the conversation must reappear in the history rail (persisted WaveObj).
        await h.ev("location.reload()");
        await h.ev("new Promise((r) => setTimeout(r, 2500))");
        await h.goto("jarvis");
        const persisted = await h.ev(`(() => (document.body.innerText || '').includes('what changed in the worktree work'))()`);
        steps.push({ step: "conversation persists across reload (history rail)", ok: persisted === true, detail: `persisted=${persisted}` });

        await h.shot("cdp-shots/jarvis-multiturn.png");
        return steps;
    },
    async teardown(h) {
        await h.goto("cockpit");
    },
};
```
Append `jarvisMultiturn` to `SCENARIOS`.

> The composer selector and Enter-to-submit are the per-build unknowns. Confirm against `composer.tsx`; if the placeholder differs, use the real one. The follow-up-context assertion is intentionally omitted from CDP (the model's answer text is timing-sensitive and non-deterministic) — prior-context threading is covered deterministically by `TestConversePinsAttachedAndThreadsContext` (Task 5). The durable CDP checks are "renders as a user turn" and "survives reload".

- [ ] **Step 3: Run the scenario**

Run: `task verify:ui -- jarvis-multiturn`
Expected: PASS (both steps). If ECONNREFUSED on :9222, another session's edit may have crashed `task dev` — check the dev log before retrying.

- [ ] **Step 4: Full regression + stage**

Run: `go test ./pkg/...` and `node node_modules/vitest/vitest.mjs run` → all PASS. `task verify:ui -- jarvis-states jarvis-ask` (preserve prior Jarvis scenarios) → PASS.
Then stage + checkpoint. This is the final task — at this point the whole F feature (spec + this plan + `docs/deferred.md` + all code) is staged for the single feature commit, pending your explicit approval to commit.

---

## Self-Review

**1. Spec coverage:**
- Multi-turn (spec §3) → Task 4 (`priorContext`) + Task 5 (threaded into prompt). ✓
- Persistence as `JarvisConvo` WaveObj (spec §1, §2) → Tasks 1, 2, 5. ✓
- Attached-scope fix (spec §4) → Task 4 (`assembleCandidates`) + Task 5 (`resolveAttached`). ✓
- Card relocation, layering, dedupe (spec §1) → Task 3. ✓
- History rail / list (spec §3) → Task 6. ✓
- Load-time rehydration (spec §5) → Tasks 6 (rail) + 7 (selection). ✓
- Name-collision + fixture safety (spec §1) → `JarvisConvo` used throughout; view-model untouched. ✓
- Prose-not-segments refinement (spec §1) → Task 1 type + Task 7 `parseCitations`. ✓
- F⇄E seam is documentation-only (spec §6) → no task, by design. ✓
- Error handling (spec §7) → Task 5 (weak on model error / notfound short-circuit; persist on fresh ctx; create-if-absent). ✓
- Tiering deferred (spec §Deferred) → single `synthesize`; recorded in `deferred.md`. ✓

**2. Placeholder scan:** No "TBD"/"add error handling"/"similar to Task N" — every code step carries full code. The one heuristic value (`maxContextTurns = 6`) is a concrete constant, tested.

**3. Type consistency:** `JarvisConvo`, `JarvisConvoTurn`, `JarvisConvoGroundingCard`, `JarvisConvoSourceRef`, `ScopeArgs`, `synthesize`/`SetSynthesizeForTest`, `Converse(scope, priorTurns, prompt, emit) → JarvisConvoTurn`, `mapWireCard`/`mapConvoRecord`/`parseCitations`, `CreateJarvisConversation`/`GetJarvisConversation`/`GetJarvisConversations`/`AppendJarvisTurn`/`DeleteJarvisConversation`, `ListJarvisConversationsCommand`/`JarvisConversationSummary`/`CommandListJarvisConversationsRtnData` — used identically across tasks.

**Verify-while-implementing:** `waveobj.RadarFinding.ID` field name (Task 5 `resolveAttached`); the composer input placeholder (`Ask Jarvis…`) and Enter-submit (Tasks 6/8); `WOS.loadAndPinWaveObject`'s return type (Task 7 cast). Each is flagged inline.
