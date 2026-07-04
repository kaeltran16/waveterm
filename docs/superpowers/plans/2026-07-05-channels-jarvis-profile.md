# Channels Jarvis Profile (Piece 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a two-part (playbook + principles), two-layer (global file + per-project override) Jarvis profile: resolved server-side, driving the Run playbook, with an in-app editor for the per-project override.

**Architecture:** Two data types live in `pkg/waveobj` (beside `Run`/`RunPhase`); the resolve/load/override logic lives in a new `pkg/jarvis/profile.go`. Two wshrpc commands read (`GetJarvisProfile`) and write (`SetChannelProfile`) the override; `CreateRun` resolves the profile server-side and uses its playbook. The frontend gets a `CollapsibleRail` slide-in editor. Principles are stored/edited/resolved but **not consumed** by any model in this piece (Piece 4).

**Tech Stack:** Go (backend, `encoding/json`, testing), React 19 + jotai + Tailwind 4 (frontend), vitest, wshrpc typed client (`RpcApi`/`TabRpcClient`), Task codegen.

**Design spec:** `docs/superpowers/specs/2026-07-05-channels-jarvis-profile-design.md`.

## Global Constraints

- **Never hand-edit generated files** (`frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`). Edit the Go definitions, then run `task generate`.
- **Typecheck command (tsc stack-overflows normally):** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. Baseline is clean (exit 0); any error it reports is yours.
- **Go tests:** `go test ./pkg/jarvis/` (single package). **Frontend tests:** `npx vitest run <file>`.
- **No unit-test render harness exists** for the cockpit. Pure `.ts` logic is unit-tested with vitest; React components are verified with `tsc` + a CDP screenshot against the live dev app (`node scripts/cdp-shot.mjs out.png`), never a render test.
- **Scope boundary:** playbook is live (feeds `CreateRun`); principles are stored/edited/resolved but **inert**. Do **not** modify `pkg/jarvis/classify.go` or `BuildPhasePrompt` — that is Piece 4.
- **Section-level resolution:** `resolved.section = override.section ?? global.section`, independently for `playbook` and `principles`. Do not deep-merge.
- **Value constants (copy verbatim):** meta key `"jarvis:profile"`; global file name `jarvis-profile.json`; phase kinds `brainstorm | plan | execute | custom`; phase state default `pending`.
- **Commits:** this repo requires explicit human approval before any `git commit`. Each task ends with a "Commit" step; when executing, stage the listed files and **present** the commit for approval rather than committing unattended.

---

## File Structure

- `pkg/waveobj/wtype.go` (**modify**) — add `JarvisProfile`, `ProfileOverride` data types beside `Run`/`RunPhase`.
- `pkg/jarvis/profile.go` (**new**) — `MetaKey_JarvisProfile`, `DefaultPrinciples`, `BuiltinProfile`, `LoadGlobalProfile`, `ResolveProfile`, `ResolvePlaybook`, `OverrideFromMeta`.
- `pkg/jarvis/profile_test.go` (**new**) — Go unit tests for the above.
- `pkg/wshrpc/wshrpctypes.go` (**modify**) — 2 command decls + 3 data types.
- `pkg/wshrpc/wshserver/wshserver.go` (**modify**) — implement both commands; resolve the playbook in `CreateRunCommand`.
- generated: `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts` (via `task generate`).
- `frontend/app/view/agents/profilemodel.ts` (**new**) + `profilemodel.test.ts` (**new**) — pure FE helpers.
- `frontend/app/view/agents/runactions.ts` (**modify**) — `getJarvisProfile`, `setChannelProfile`.
- `frontend/app/view/agents/profilepanel.tsx` (**new**) — the editor + `profileRailOpenAtom`.
- `frontend/app/view/agents/runssurface.tsx` (**modify**) — Profile toggle button + mount the panel.

---

## Task 1: Backend data types + profile logic (Go, TDD)

Pure Go types and functions: the two data types in `waveobj`, and the load/resolve/override logic in `jarvis`. Fully unit-tested. No RPC, no DB.

**Files:**
- Create: `pkg/jarvis/profile.go`
- Test: `pkg/jarvis/profile_test.go`
- Modify: `pkg/waveobj/wtype.go`

**Interfaces:**
- Produces: `waveobj.JarvisProfile{ Playbook []RunPhase; Principles string }`, `waveobj.ProfileOverride{ Playbook *[]RunPhase; Principles *string }`; `jarvis.MetaKey_JarvisProfile string`, `jarvis.DefaultPrinciples string`, `jarvis.BuiltinProfile() waveobj.JarvisProfile`, `jarvis.LoadGlobalProfile() waveobj.JarvisProfile`, `jarvis.ResolveProfile(global waveobj.JarvisProfile, override *waveobj.ProfileOverride) waveobj.JarvisProfile`, `jarvis.ResolvePlaybook(global waveobj.JarvisProfile, override *waveobj.ProfileOverride) []waveobj.RunPhase`, `jarvis.OverrideFromMeta(ch *waveobj.Channel) *waveobj.ProfileOverride`.
- Consumes: existing `jarvis.DefaultPlaybook()`, `waveobj.RunPhase`, `waveobj.Channel`, `waveobj.MetaMapType`, `wavebase.GetWaveConfigDir()`.

- [ ] **Step 1: Add the data types to `waveobj/wtype.go`**

Insert directly after the `Run` struct (currently ends at line ~233, before `type Channel struct`):

```go
// JarvisProfile is a resolved (or the global) Jarvis profile: the playbook (phase pipeline) and the
// principles (free-text judgment; consumed in Piece 4, stored/resolved only for now). Playbook reuses
// RunPhase so a resolved profile feeds NewRun directly (runtime fields are set at run creation).
type JarvisProfile struct {
	Playbook   []RunPhase `json:"playbook"`
	Principles string     `json:"principles,omitempty"`
}

// ProfileOverride is a channel's per-project override, stored as JSON on channel meta. Pointer fields:
// nil = inherit the global section, non-nil = replace it (section-level resolution).
type ProfileOverride struct {
	Playbook   *[]RunPhase `json:"playbook,omitempty"`
	Principles *string     `json:"principles,omitempty"`
}
```

- [ ] **Step 2: Write the failing tests**

Create `pkg/jarvis/profile_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func ptrPhases(p []waveobj.RunPhase) *[]waveobj.RunPhase { return &p }
func ptrStr(s string) *string                            { return &s }

func TestResolveProfileNilOverride(t *testing.T) {
	g := waveobj.JarvisProfile{Playbook: DefaultPlaybook(), Principles: "gp"}
	got := ResolveProfile(g, nil)
	if got.Principles != "gp" || len(got.Playbook) != len(DefaultPlaybook()) {
		t.Fatalf("nil override should equal global, got %+v", got)
	}
}

func TestResolveProfilePrinciplesOnly(t *testing.T) {
	g := waveobj.JarvisProfile{Playbook: DefaultPlaybook(), Principles: "gp"}
	got := ResolveProfile(g, &waveobj.ProfileOverride{Principles: ptrStr("op")})
	if got.Principles != "op" {
		t.Fatalf("principles should be overridden, got %q", got.Principles)
	}
	if len(got.Playbook) != len(DefaultPlaybook()) {
		t.Fatalf("playbook should inherit global, got %d phases", len(got.Playbook))
	}
}

func TestResolveProfilePlaybookOnly(t *testing.T) {
	g := waveobj.JarvisProfile{Playbook: DefaultPlaybook(), Principles: "gp"}
	pb := []waveobj.RunPhase{{Kind: PhaseKind_Custom, State: PhaseState_Pending}}
	got := ResolveProfile(g, &waveobj.ProfileOverride{Playbook: ptrPhases(pb)})
	if len(got.Playbook) != 1 || got.Principles != "gp" {
		t.Fatalf("playbook overridden + principles inherited expected, got %+v", got)
	}
}

func TestResolvePlaybookFallsBackWhenEmpty(t *testing.T) {
	g := waveobj.JarvisProfile{Playbook: []waveobj.RunPhase{}, Principles: "gp"}
	got := ResolvePlaybook(g, &waveobj.ProfileOverride{Playbook: ptrPhases([]waveobj.RunPhase{})})
	if len(got) != len(DefaultPlaybook()) {
		t.Fatalf("empty resolved playbook should fall back to default, got %d", len(got))
	}
}

func TestResolvePlaybookHonorsOverride(t *testing.T) {
	g := waveobj.JarvisProfile{Playbook: DefaultPlaybook()}
	pb := []waveobj.RunPhase{{Kind: PhaseKind_Execute, State: PhaseState_Pending}}
	got := ResolvePlaybook(g, &waveobj.ProfileOverride{Playbook: ptrPhases(pb)})
	if len(got) != 1 || got[0].Kind != PhaseKind_Execute {
		t.Fatalf("override playbook should be used, got %+v", got)
	}
}

func TestBuiltinProfile(t *testing.T) {
	b := BuiltinProfile()
	if len(b.Playbook) != len(DefaultPlaybook()) {
		t.Fatalf("builtin playbook should match default")
	}
	if b.Principles == "" {
		t.Fatalf("builtin principles should be non-empty")
	}
}

func TestLoadGlobalProfileMissing(t *testing.T) {
	old := wavebase.ConfigHome_VarCache
	t.Cleanup(func() { wavebase.ConfigHome_VarCache = old })
	wavebase.ConfigHome_VarCache = t.TempDir() // empty dir → no file
	if LoadGlobalProfile().Principles != DefaultPrinciples {
		t.Fatalf("missing file should fall back to builtin")
	}
}

func TestLoadGlobalProfileMalformed(t *testing.T) {
	dir := t.TempDir()
	old := wavebase.ConfigHome_VarCache
	t.Cleanup(func() { wavebase.ConfigHome_VarCache = old })
	wavebase.ConfigHome_VarCache = dir
	if err := os.WriteFile(filepath.Join(dir, globalProfileFileName), []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if LoadGlobalProfile().Principles != DefaultPrinciples {
		t.Fatalf("malformed file should fall back to builtin")
	}
}

func TestLoadGlobalProfileValid(t *testing.T) {
	dir := t.TempDir()
	old := wavebase.ConfigHome_VarCache
	t.Cleanup(func() { wavebase.ConfigHome_VarCache = old })
	wavebase.ConfigHome_VarCache = dir
	body := []byte(`{"playbook":[{"kind":"execute","state":"pending"}],"principles":"custom"}`)
	if err := os.WriteFile(filepath.Join(dir, globalProfileFileName), body, 0o644); err != nil {
		t.Fatal(err)
	}
	got := LoadGlobalProfile()
	if got.Principles != "custom" || len(got.Playbook) != 1 {
		t.Fatalf("valid file should parse, got %+v", got)
	}
}

func TestOverrideFromMetaAbsent(t *testing.T) {
	ch := &waveobj.Channel{Meta: waveobj.MetaMapType{}}
	if OverrideFromMeta(ch) != nil {
		t.Fatalf("absent key should be nil")
	}
}

func TestOverrideFromMetaPresent(t *testing.T) {
	// generic map, as after a DB round-trip
	ch := &waveobj.Channel{Meta: waveobj.MetaMapType{MetaKey_JarvisProfile: map[string]any{"principles": "op"}}}
	ov := OverrideFromMeta(ch)
	if ov == nil || ov.Principles == nil || *ov.Principles != "op" {
		t.Fatalf("present key should parse, got %+v", ov)
	}
}

func TestOverrideFromMetaMalformed(t *testing.T) {
	ch := &waveobj.Channel{Meta: waveobj.MetaMapType{MetaKey_JarvisProfile: "not-an-object"}}
	if OverrideFromMeta(ch) != nil {
		t.Fatalf("malformed override should degrade to nil")
	}
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `go test ./pkg/jarvis/ -run TestResolveProfile`
Expected: FAIL — build error (`profile.go` doesn't exist yet; `ResolveProfile` undefined).

- [ ] **Step 4: Implement `profile.go`**

Create `pkg/jarvis/profile.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// MetaKey_JarvisProfile stores a channel's per-project ProfileOverride (JSON) on channel meta.
const MetaKey_JarvisProfile = "jarvis:profile"

const globalProfileFileName = "jarvis-profile.json"

// DefaultPrinciples seeds the builtin global profile's judgment text. Stored/resolved only in Piece 3;
// consumed by the classifier + phase prompts in Piece 4.
const DefaultPrinciples = `Prefer simple, direct solutions over enterprise over-engineering.
Apply SOLID, KISS, YAGNI, DRY. Single source of truth for every piece of knowledge.
No premature optimization or abstraction. Handle errors at boundaries; never swallow them.`

// BuiltinProfile is the fallback global profile when no global file exists: the default playbook plus
// the default principles. DefaultPlaybook stays the single source of the default pipeline.
func BuiltinProfile() waveobj.JarvisProfile {
	return waveobj.JarvisProfile{Playbook: DefaultPlaybook(), Principles: DefaultPrinciples}
}

// LoadGlobalProfile reads the global profile file from the config home, falling back to BuiltinProfile
// on a missing or malformed file (logged, never fatal).
func LoadGlobalProfile() waveobj.JarvisProfile {
	path := filepath.Join(wavebase.GetWaveConfigDir(), globalProfileFileName)
	data, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("jarvis profile: reading %s: %v (using builtin)", path, err)
		}
		return BuiltinProfile()
	}
	var p waveobj.JarvisProfile
	if err := json.Unmarshal(data, &p); err != nil {
		log.Printf("jarvis profile: malformed %s: %v (using builtin)", path, err)
		return BuiltinProfile()
	}
	return p
}

// ResolveProfile applies a per-project override onto the global profile, section by section: a non-nil
// override section replaces the global's; a nil section inherits. Pure; the single home of the merge rule.
func ResolveProfile(global waveobj.JarvisProfile, override *waveobj.ProfileOverride) waveobj.JarvisProfile {
	out := global
	if override != nil {
		if override.Playbook != nil {
			out.Playbook = *override.Playbook
		}
		if override.Principles != nil {
			out.Principles = *override.Principles
		}
	}
	return out
}

// ResolvePlaybook returns the playbook a new run should use: the resolved profile's playbook, or the
// default playbook when that is empty (a run always has phases).
func ResolvePlaybook(global waveobj.JarvisProfile, override *waveobj.ProfileOverride) []waveobj.RunPhase {
	pb := ResolveProfile(global, override).Playbook
	if len(pb) == 0 {
		return DefaultPlaybook()
	}
	return pb
}

// OverrideFromMeta extracts a channel's ProfileOverride from meta, or nil when absent or malformed (a
// bad blob degrades to pure-global, never a crash). Round-trips through JSON because meta values arrive
// as generic map[string]any after a DB read.
func OverrideFromMeta(ch *waveobj.Channel) *waveobj.ProfileOverride {
	if ch == nil || !ch.Meta.HasKey(MetaKey_JarvisProfile) {
		return nil
	}
	raw, err := json.Marshal(ch.Meta[MetaKey_JarvisProfile])
	if err != nil {
		log.Printf("jarvis profile: marshaling override meta: %v", err)
		return nil
	}
	var ov waveobj.ProfileOverride
	if err := json.Unmarshal(raw, &ov); err != nil {
		log.Printf("jarvis profile: bad override meta, ignoring: %v", err)
		return nil
	}
	return &ov
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test ./pkg/jarvis/`
Expected: PASS (all cases, including the pre-existing run-engine tests).

- [ ] **Step 6: Commit** (present for approval)

```bash
git add pkg/waveobj/wtype.go pkg/jarvis/profile.go pkg/jarvis/profile_test.go
git commit -m "feat(runs): Jarvis profile types, loader, and section-level resolver"
```

---

## Task 2: wshrpc commands + CreateRun wiring + codegen (Go)

Add the read/write commands, wire the resolved playbook into `CreateRun`, and regenerate the TS bindings. No new unit tests (thin RPC marshaling over the Task 1 logic, matching the repo pattern for `SetChannelTierCommand`); verified by `go build`, the Task 1 tests, and later CDP.

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes.go`
- Modify: `pkg/wshrpc/wshserver/wshserver.go`
- Generated: `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`

**Interfaces:**
- Consumes: `jarvis.LoadGlobalProfile`, `jarvis.OverrideFromMeta`, `jarvis.ResolveProfile`, `jarvis.ResolvePlaybook`, `jarvis.MetaKey_JarvisProfile`, `waveobj.JarvisProfile`, `waveobj.ProfileOverride` (Task 1).
- Produces: `GetJarvisProfileCommand(data CommandGetJarvisProfileData) (*CommandGetJarvisProfileRtnData, error)`, `SetChannelProfileCommand(data CommandSetChannelProfileData) error`; generated `RpcApi.GetJarvisProfileCommand`, `RpcApi.SetChannelProfileCommand` and TS types `CommandGetJarvisProfileRtnData`, `CommandSetChannelProfileData`, `JarvisProfile`, `ProfileOverride`.

- [ ] **Step 1: Add the command declarations to the `WshRpcInterface`**

In `pkg/wshrpc/wshrpctypes.go`, after the `CancelRunCommand` line (~125), add:

```go
	GetJarvisProfileCommand(ctx context.Context, data CommandGetJarvisProfileData) (*CommandGetJarvisProfileRtnData, error) // read a channel's Jarvis profile (global + per-project override + resolved)
	SetChannelProfileCommand(ctx context.Context, data CommandSetChannelProfileData) error                                   // write a channel's per-project profile override (empty clears it)
```

- [ ] **Step 2: Add the data types**

In `pkg/wshrpc/wshrpctypes.go`, after `CommandCancelRunData` (search for it; it sits just after `CommandAdvanceRunData` ~line 778), add:

```go
type CommandGetJarvisProfileData struct {
	ChannelId string `json:"channelid"`
}

type CommandGetJarvisProfileRtnData struct {
	Global   waveobj.JarvisProfile    `json:"global"`
	Override *waveobj.ProfileOverride `json:"override"`
	Resolved waveobj.JarvisProfile    `json:"resolved"`
}

type CommandSetChannelProfileData struct {
	ChannelId string                   `json:"channelid"`
	Override  *waveobj.ProfileOverride `json:"override"`
}
```

- [ ] **Step 3: Implement both commands in `wshserver.go`**

In `pkg/wshrpc/wshserver/wshserver.go`, after `CancelRunCommand` (search for `func (ws *WshServer) CancelRunCommand`), add:

```go
func (ws *WshServer) GetJarvisProfileCommand(ctx context.Context, data wshrpc.CommandGetJarvisProfileData) (*wshrpc.CommandGetJarvisProfileRtnData, error) {
	if data.ChannelId == "" {
		return nil, fmt.Errorf("channelid is required")
	}
	ch, err := wstore.DBMustGet[*waveobj.Channel](ctx, data.ChannelId)
	if err != nil {
		return nil, fmt.Errorf("loading channel: %w", err)
	}
	global := jarvis.LoadGlobalProfile()
	override := jarvis.OverrideFromMeta(ch)
	return &wshrpc.CommandGetJarvisProfileRtnData{
		Global:   global,
		Override: override,
		Resolved: jarvis.ResolveProfile(global, override),
	}, nil
}

func (ws *WshServer) SetChannelProfileCommand(ctx context.Context, data wshrpc.CommandSetChannelProfileData) error {
	if data.ChannelId == "" {
		return fmt.Errorf("channelid is required")
	}
	empty := data.Override == nil || (data.Override.Playbook == nil && data.Override.Principles == nil)
	err := wstore.DBUpdateFn(ctx, data.ChannelId, func(ch *waveobj.Channel) {
		if ch.Meta == nil {
			ch.Meta = make(waveobj.MetaMapType)
		}
		if empty {
			delete(ch.Meta, jarvis.MetaKey_JarvisProfile)
		} else {
			ch.Meta[jarvis.MetaKey_JarvisProfile] = data.Override
		}
	})
	if err != nil {
		return fmt.Errorf("updating channel profile: %w", err)
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
	return nil
}
```

- [ ] **Step 4: Wire the resolved playbook into `CreateRunCommand`**

In `pkg/wshrpc/wshserver/wshserver.go`, replace the single line at ~1776:

```go
	run := jarvis.NewRun(data.Goal, data.WorkspaceId, ch.ProjectPath, jarvis.DefaultPlaybook(), time.Now().UnixMilli())
```

with:

```go
	playbook := jarvis.ResolvePlaybook(jarvis.LoadGlobalProfile(), jarvis.OverrideFromMeta(ch))
	run := jarvis.NewRun(data.Goal, data.WorkspaceId, ch.ProjectPath, playbook, time.Now().UnixMilli())
```

- [ ] **Step 5: Build the backend**

Run: `go build ./...`
Expected: exit 0. (Confirms the interface, the two impls, and the CreateRun edit all compile. If the generated client stub for the new commands is not yet present it does not affect the Go build — that is regenerated next.)

- [ ] **Step 6: Regenerate the TS bindings**

Run: `task generate`
Expected: exit 0; `git status` shows modified `frontend/types/gotypes.d.ts` and `frontend/app/store/wshclientapi.ts`. Confirm `gotypes.d.ts` now declares `type JarvisProfile`, `type ProfileOverride`, `type CommandGetJarvisProfileRtnData`, `type CommandSetChannelProfileData`, and that `wshclientapi.ts` has `GetJarvisProfileCommand` and `SetChannelProfileCommand`.

- [ ] **Step 7: Re-run Go tests**

Run: `go test ./pkg/jarvis/`
Expected: PASS (unchanged from Task 1 — this task adds no jarvis tests but must not break them).

- [ ] **Step 8: Commit** (present for approval)

```bash
git add pkg/wshrpc/wshrpctypes.go pkg/wshrpc/wshserver/wshserver.go frontend/types/gotypes.d.ts frontend/app/store/wshclientapi.ts
git commit -m "feat(runs): profile get/set RPCs; CreateRun uses the resolved playbook"
```

---

## Task 3: Frontend pure helpers + action wrappers (TS, TDD)

The pure `profilemodel.ts` (unit-tested) and the two impure `runactions.ts` wrappers (no unit test — thin marshaling, matches the existing run-action pattern).

**Files:**
- Create: `frontend/app/view/agents/profilemodel.ts`
- Test: `frontend/app/view/agents/profilemodel.test.ts`
- Modify: `frontend/app/view/agents/runactions.ts`

**Interfaces:**
- Consumes: ambient generated types `ProfileOverride`, `RunPhase`, `CommandGetJarvisProfileRtnData` (Task 2); `RpcApi`, `TabRpcClient`.
- Produces: `sectionSource(override: ProfileOverride | null | undefined): { playbook: "global"|"project"; principles: "global"|"project" }`, `isDirty(a: ProfileOverride, b: ProfileOverride): boolean`; `getJarvisProfile(channelId: string): Promise<CommandGetJarvisProfileRtnData>`, `setChannelProfile(channelId: string, override: ProfileOverride): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/app/view/agents/profilemodel.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isDirty, sectionSource } from "./profilemodel";

describe("sectionSource", () => {
    it("is global for null/undefined and empty override", () => {
        expect(sectionSource(null)).toEqual({ playbook: "global", principles: "global" });
        expect(sectionSource({})).toEqual({ playbook: "global", principles: "global" });
    });
    it("is project for the section that is present", () => {
        expect(sectionSource({ principles: "x" })).toEqual({ playbook: "global", principles: "project" });
        expect(sectionSource({ playbook: [] })).toEqual({ playbook: "project", principles: "global" });
    });
    it("treats an empty-string principles override as present (project)", () => {
        expect(sectionSource({ principles: "" }).principles).toBe("project");
    });
});

describe("isDirty", () => {
    it("is false for equal overrides", () => {
        expect(isDirty({}, {})).toBe(false);
        expect(isDirty({ principles: "a" }, { principles: "a" })).toBe(false);
    });
    it("is true when any section differs", () => {
        expect(isDirty({}, { principles: "a" })).toBe(true);
        expect(isDirty({ principles: "a" }, { principles: "b" })).toBe(true);
        expect(isDirty({ playbook: [] }, {})).toBe(true);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/profilemodel.test.ts`
Expected: FAIL — `Cannot find module './profilemodel'`.

- [ ] **Step 3: Implement `profilemodel.ts`**

Create `frontend/app/view/agents/profilemodel.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure helpers for the Jarvis profile editor: which layer each section resolves from (for the badge)
// and a dirty check for the Save button. The merge rule itself lives only in Go (ResolveProfile) — the
// editor reads the resolved profile from the backend and never re-derives it here.

export type SectionSource = "global" | "project";

// A section is "project" when the override carries it (non-null), else "global". Uses != null so an
// explicit empty override (empty principles string / empty playbook array) still counts as project.
export function sectionSource(override: ProfileOverride | null | undefined): {
    playbook: SectionSource;
    principles: SectionSource;
} {
    return {
        playbook: override?.playbook != null ? "project" : "global",
        principles: override?.principles != null ? "project" : "global",
    };
}

// Structural equality is enough here — the override is a small JSON-serializable object.
export function isDirty(a: ProfileOverride, b: ProfileOverride): boolean {
    return JSON.stringify(a) !== JSON.stringify(b);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/profilemodel.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the action wrappers to `runactions.ts`**

Append to `frontend/app/view/agents/runactions.ts`:

```ts
export async function getJarvisProfile(channelId: string): Promise<CommandGetJarvisProfileRtnData> {
    return RpcApi.GetJarvisProfileCommand(TabRpcClient, { channelid: channelId });
}

export async function setChannelProfile(channelId: string, override: ProfileOverride): Promise<void> {
    await RpcApi.SetChannelProfileCommand(TabRpcClient, { channelid: channelId, override });
}
```

- [ ] **Step 6: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. (Confirms `CommandGetJarvisProfileRtnData`, `ProfileOverride`, and the two generated `RpcApi` methods all resolve.)

- [ ] **Step 7: Commit** (present for approval)

```bash
git add frontend/app/view/agents/profilemodel.ts frontend/app/view/agents/profilemodel.test.ts frontend/app/view/agents/runactions.ts
git commit -m "feat(runs): profile FE helpers + get/set action wrappers"
```

---

## Task 4: Profile editor panel + mount in the Runs view (TSX)

The `CollapsibleRail` slide-in editor (playbook + principles, per-section badge / customize / reset-to-global / save) and its wiring into `RunsView` (a Profile toggle button + the panel as a right rail). Verified by `tsc` + CDP.

**Files:**
- Create: `frontend/app/view/agents/profilepanel.tsx`
- Modify: `frontend/app/view/agents/runssurface.tsx`

**Interfaces:**
- Consumes: `getJarvisProfile`, `setChannelProfile` (Task 3); `sectionSource` unused here (badge derived inline from the draft); `isDirty` (Task 3); `CollapsibleRail`, `RailSection`; ambient `JarvisProfile`, `ProfileOverride`, `RunPhase`.
- Produces: `ProfilePanel({ channelId }: { channelId: string })`, `profileRailOpenAtom: PrimitiveAtom<boolean>`.

- [ ] **Step 1: Create `profilepanel.tsx`**

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Jarvis profile editor: a CollapsibleRail slide-in that edits a channel's per-project profile
// override (playbook + principles). Loads the resolved profile from the backend (getJarvisProfile) on
// open; each section shows a global/project badge with Customize (copy the inherited global section into
// the editable override) and Reset-to-global (drop the override section). Save persists via
// setChannelProfile. Principles are editable but not yet consumed by any model (Piece 4).

import { CollapsibleRail, type RailSection } from "@/app/element/collapsiblerail";
import { fireAndForget } from "@/util/util";
import { atom, useAtomValue, type PrimitiveAtom } from "jotai";
import { useEffect, useState } from "react";
import { getJarvisProfile, setChannelProfile } from "./runactions";
import { isDirty } from "./profilemodel";

export const profileRailOpenAtom: PrimitiveAtom<boolean> = atom(false);

const PHASE_KINDS = ["brainstorm", "plan", "execute", "custom"] as const;

type Loaded = { global: JarvisProfile; override: ProfileOverride };

function omit(d: ProfileOverride, key: keyof ProfileOverride): ProfileOverride {
    const next = { ...d };
    delete next[key];
    return next;
}

function movePhase(phases: RunPhase[], i: number, dir: -1 | 1): RunPhase[] {
    const j = i + dir;
    if (j < 0 || j >= phases.length) {
        return phases;
    }
    const next = [...phases];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
}

function overrideIsEmpty(o: ProfileOverride): boolean {
    return o.playbook == null && o.principles == null;
}

function Badge({ source }: { source: "global" | "project" }) {
    return (
        <span
            className={
                "rounded-[4px] px-1.5 py-px font-mono text-[9px] font-semibold uppercase tracking-[.08em] " +
                (source === "project" ? "bg-accentbg/50 text-accent-soft" : "border border-edge-mid text-muted")
            }
        >
            {source}
        </span>
    );
}

function PhaseEditor({
    phase,
    onChange,
    onRemove,
    onMove,
}: {
    phase: RunPhase;
    onChange: (p: RunPhase) => void;
    onRemove: () => void;
    onMove: (dir: -1 | 1) => void;
}) {
    return (
        <div className="rounded-[8px] border border-edge-mid bg-surface p-2">
            <div className="flex items-center gap-1.5">
                <select
                    value={phase.kind}
                    onChange={(e) => onChange({ ...phase, kind: e.target.value })}
                    className="rounded-[6px] border border-edge-mid bg-background px-1.5 py-1 text-[11px] text-primary"
                >
                    {PHASE_KINDS.map((k) => (
                        <option key={k} value={k}>
                            {k}
                        </option>
                    ))}
                </select>
                <button type="button" onClick={() => onMove(-1)} className="px-1 text-[11px] text-muted hover:text-secondary">
                    ↑
                </button>
                <button type="button" onClick={() => onMove(1)} className="px-1 text-[11px] text-muted hover:text-secondary">
                    ↓
                </button>
                <button type="button" onClick={onRemove} className="ml-auto px-1 text-[11px] text-muted hover:text-error">
                    ✕
                </button>
            </div>
            <input
                value={phase.skill ?? ""}
                onChange={(e) => onChange({ ...phase, skill: e.target.value })}
                placeholder="skill (e.g. superpowers:writing-plans)"
                className="mt-1.5 w-full rounded-[6px] border border-edge-mid bg-background px-1.5 py-1 font-mono text-[11px] text-primary placeholder:text-muted focus:outline-none"
            />
            <div className="mt-1.5 flex gap-3">
                <label className="flex cursor-pointer items-center gap-1 text-[10.5px] text-secondary">
                    <input type="checkbox" checked={!!phase.gate} onChange={(e) => onChange({ ...phase, gate: e.target.checked })} />
                    GATE
                </label>
                <label className="flex cursor-pointer items-center gap-1 text-[10.5px] text-secondary">
                    <input
                        type="checkbox"
                        checked={!!phase.freshctx}
                        onChange={(e) => onChange({ ...phase, freshctx: e.target.checked })}
                    />
                    FRESH-CTX
                </label>
            </div>
        </div>
    );
}

function PlaybookSection({
    global,
    draft,
    setDraft,
}: {
    global: JarvisProfile;
    draft: ProfileOverride;
    setDraft: React.Dispatch<React.SetStateAction<ProfileOverride>>;
}) {
    const overridden = draft.playbook != null;
    const phases = draft.playbook ?? global.playbook ?? [];
    const setPhases = (next: RunPhase[]) => setDraft((d) => ({ ...d, playbook: next }));
    return (
        <div>
            <div className="mb-1.5 flex items-center gap-2">
                <span className="text-[12px] font-semibold text-primary">Playbook</span>
                <Badge source={overridden ? "project" : "global"} />
                <div className="flex-1" />
                {overridden ? (
                    <button
                        type="button"
                        onClick={() => setDraft((d) => omit(d, "playbook"))}
                        className="text-[10px] text-muted hover:text-secondary"
                    >
                        reset to global
                    </button>
                ) : (
                    <button
                        type="button"
                        onClick={() => setPhases((global.playbook ?? []).map((p) => ({ ...p })))}
                        className="text-[10px] text-accent-soft hover:text-accent"
                    >
                        customize
                    </button>
                )}
            </div>
            {overridden ? (
                <div className="flex flex-col gap-2">
                    {phases.map((p, i) => (
                        <PhaseEditor
                            key={i}
                            phase={p}
                            onChange={(np) => setPhases(phases.map((x, j) => (j === i ? np : x)))}
                            onRemove={() => setPhases(phases.filter((_, j) => j !== i))}
                            onMove={(dir) => setPhases(movePhase(phases, i, dir))}
                        />
                    ))}
                    <button
                        type="button"
                        onClick={() => setPhases([...phases, { kind: "custom", state: "pending" }])}
                        className="rounded-[7px] border border-dashed border-edge-mid py-1 text-[11px] text-muted hover:text-secondary"
                    >
                        + add phase
                    </button>
                </div>
            ) : (
                <div className="flex flex-col gap-1">
                    {phases.map((p, i) => (
                        <div key={i} className="flex items-center gap-2 text-[11px] text-secondary">
                            <span className="font-semibold">{p.kind}</span>
                            {p.skill ? <span className="font-mono text-muted">{p.skill}</span> : null}
                            {p.gate ? <span className="font-mono text-[9px] text-asking">GATE</span> : null}
                            {p.freshctx ? <span className="font-mono text-[9px] text-muted">FRESH</span> : null}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

function PrinciplesSection({
    global,
    draft,
    setDraft,
}: {
    global: JarvisProfile;
    draft: ProfileOverride;
    setDraft: React.Dispatch<React.SetStateAction<ProfileOverride>>;
}) {
    const overridden = draft.principles != null;
    const value = draft.principles ?? global.principles ?? "";
    return (
        <div>
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <span className="text-[12px] font-semibold text-primary">Principles</span>
                <Badge source={overridden ? "project" : "global"} />
                <span className="font-mono text-[9px] text-muted">(not yet applied · Piece 4)</span>
                <div className="flex-1" />
                {overridden ? (
                    <button
                        type="button"
                        onClick={() => setDraft((d) => omit(d, "principles"))}
                        className="text-[10px] text-muted hover:text-secondary"
                    >
                        reset to global
                    </button>
                ) : (
                    <button
                        type="button"
                        onClick={() => setDraft((d) => ({ ...d, principles: global.principles ?? "" }))}
                        className="text-[10px] text-accent-soft hover:text-accent"
                    >
                        customize
                    </button>
                )}
            </div>
            {overridden ? (
                <textarea
                    value={value}
                    onChange={(e) => setDraft((d) => ({ ...d, principles: e.target.value }))}
                    rows={6}
                    className="w-full rounded-[8px] border border-edge-mid bg-background p-2 text-[11.5px] leading-[1.5] text-primary focus:outline-none"
                />
            ) : (
                <div className="whitespace-pre-wrap rounded-[8px] border border-edge-mid bg-surface p-2 text-[11px] leading-[1.5] text-muted">
                    {value || "—"}
                </div>
            )}
        </div>
    );
}

export function ProfilePanel({ channelId }: { channelId: string }) {
    const open = useAtomValue(profileRailOpenAtom);
    const [loaded, setLoaded] = useState<Loaded | null>(null);
    const [draft, setDraft] = useState<ProfileOverride>({});
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!open) {
            return;
        }
        fireAndForget(async () => {
            const p = await getJarvisProfile(channelId);
            setLoaded({ global: p.global, override: p.override ?? {} });
            setDraft(p.override ?? {});
        });
    }, [open, channelId]);

    const save = () => {
        if (!loaded) {
            return;
        }
        setSaving(true);
        fireAndForget(async () => {
            try {
                await setChannelProfile(channelId, draft);
                setLoaded((l) => (l ? { ...l, override: overrideIsEmpty(draft) ? {} : draft } : l));
            } finally {
                setSaving(false);
            }
        });
    };

    const body = loaded ? (
        <div className="flex flex-col gap-5">
            <div className="text-[10px] font-semibold uppercase tracking-[.08em] text-muted">
                Jarvis profile · merged (global + this project)
            </div>
            <PlaybookSection global={loaded.global} draft={draft} setDraft={setDraft} />
            <PrinciplesSection global={loaded.global} draft={draft} setDraft={setDraft} />
        </div>
    ) : (
        <div className="text-[12px] text-muted">Loading…</div>
    );

    const footer = loaded ? (
        <button
            type="button"
            disabled={saving || !isDirty(draft, loaded.override)}
            onClick={save}
            className="w-full rounded-[8px] bg-accent py-2 text-[12px] font-semibold text-background hover:bg-accenthover disabled:opacity-40"
        >
            {saving ? "Saving…" : "Save"}
        </button>
    ) : null;

    const sections: RailSection[] = [
        { id: "profile", icon: <span className="text-[16px]">⚙</span>, label: "Profile", content: body },
    ];
    return <CollapsibleRail openAtom={profileRailOpenAtom} ariaLabel="Jarvis profile" sections={sections} footer={footer} />;
}
```

- [ ] **Step 2: Mount the panel + Profile toggle in `runssurface.tsx`**

Add imports near the other `./` imports:

```tsx
import { useSetAtom } from "jotai";
import { ProfilePanel, profileRailOpenAtom } from "./profilepanel";
```

(If `runssurface.tsx` already imports something from `jotai`, add `useSetAtom` to that existing import instead of a second line.)

In `RunsView`, add the toggle setter with the other hooks (near `const [draft, setDraft] = useState("")`):

```tsx
const toggleProfile = useSetAtom(profileRailOpenAtom);
```

In the run-tabs bar — the `<div className="sc flex flex-none gap-2 overflow-x-auto border-b border-border bg-background px-[22px] py-2.5">` — after the `+ New run` button and before the bar's closing `</div>`, add a spacer + Profile button:

```tsx
<div className="flex-1" />
<button
    type="button"
    onClick={() => toggleProfile((o) => !o)}
    className="flex-none rounded-[9px] border border-edge-mid px-3 py-2 text-[12px] font-semibold text-muted hover:text-secondary"
>
    ⚙ Profile
</button>
```

Wrap the whole returned fragment so the panel is a right rail. Change the outermost `return (` / `<>` … `</>` of `RunsView` to:

```tsx
return (
    <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
            {/* existing run-tabs bar, content div, and start-run composer — unchanged */}
        </div>
        <ProfilePanel channelId={channel.oid} />
    </div>
);
```

(Move the existing three children — the run-tabs bar `<div>`, the content `<div className="sc min-h-0 flex-1 …">`, and the start-run composer `<div className="flex-none …">` — verbatim inside the new inner `<div className="flex min-w-0 flex-1 flex-col">`. Do not alter their internals beyond the Profile button added above.)

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Run the frontend test suite for the agents view**

Run: `npx vitest run frontend/app/view/agents/profilemodel.test.ts frontend/app/view/agents/runmodel.test.ts`
Expected: PASS (confirms no import-graph breakage from the new files).

- [ ] **Step 5: Visual + interaction verification (CDP)**

Dev app running (`task dev`; Vite HMR picks up frontend changes — the Go/RPC changes from Task 2 require the dev backend to have been rebuilt, which `cargo tauri dev` does on the next backend build).

- Create a channel + run with the existing harness: `node scripts/cdp-e2e-runs.mjs C:/Users/cktra/AppData/Local/Temp/claude/runs-ui-profile` — note the channel id it prints.
- In the app, open that channel → **Runs** → click **⚙ Profile**. Confirm the rail slides in showing the **Playbook** section (three phases: brainstorm, plan[GATE], execute[FRESH]) and the **Principles** section, both badged **global**.
- Click **customize** on Principles, edit the text, click **Save**. Reopen the panel (collapse/expand) and confirm the badge is now **project** and the edited text persisted (proves `setChannelProfile` + `getJarvisProfile` round-trip).
- Click **reset to global** on Principles, **Save**, reopen → badge back to **global** (proves the empty-override clears the meta key).
- Screenshot: `node scripts/cdp-shot.mjs C:/Users/cktra/AppData/Local/Temp/claude/scratch-profile.png` and confirm the layout renders (rail beside the runs content, no horizontal page scroll).
- Optional end-to-end: customize the Playbook (remove the execute phase), Save, then start a **new run** in that channel from the composer and confirm the new run's phases match the edited playbook (proves the `CreateRun` resolution wiring from Task 2).

- [ ] **Step 6: Commit** (present for approval)

```bash
git add frontend/app/view/agents/profilepanel.tsx frontend/app/view/agents/runssurface.tsx
git commit -m "feat(runs): Jarvis profile editor panel + Runs-view mount"
```

---

## Self-Review

**Spec coverage:**
- Profile data model (playbook + principles; global + override) → Task 1 (`waveobj` types + `jarvis` logic). ✓
- Dedicated global JSON file, hardcoded builtin default, no CLAUDE.md parsing → `LoadGlobalProfile` / `BuiltinProfile` / `DefaultPrinciples` (Task 1). ✓
- Section-level resolve (`?? per section`) → `ResolveProfile` (Task 1). ✓
- Override on channel meta (`"jarvis:profile"`), no migration → `OverrideFromMeta` + `SetChannelProfileCommand` writing `ch.Meta` (Tasks 1–2). ✓
- Resolved playbook drives `CreateRun`, empty → `DefaultPlaybook` fallback → `ResolvePlaybook` + CreateRun wiring (Tasks 1–2). ✓
- `GetJarvisProfileCommand` returns `{global, override, resolved}`; `SetChannelProfileCommand` (empty clears) → Task 2. ✓
- FE action wrappers + pure helpers → Task 3. ✓
- `CollapsibleRail` slide-in editor: playbook (kind/skill/GATE/FRESH-CTX/add/remove/reorder), principles textarea, per-section badge + Customize + Reset-to-global, Save; toggled from the Runs header → Task 4. ✓
- Scope boundary: principles inert, classifier untouched → no task modifies `classify.go`/`BuildPhasePrompt`; the Principles section is labeled "not yet applied · Piece 4". ✓
- Error handling: missing/malformed global → builtin; malformed override → nil; empty resolved playbook → default; legacy channels → pure global → Task 1 tests + `ResolvePlaybook`. ✓
- Testing: Go unit (`profile_test.go`), TS unit (`profilemodel.test.ts`), component via tsc + CDP → Tasks 1, 3, 4. ✓

**Placeholder scan:** No "TBD"/"handle appropriately". The Principles "(not yet applied · Piece 4)" label is intentional scope signaling, not deferred work. The CDP step names concrete scripts and expected results.

**Type consistency:** `JarvisProfile{Playbook, Principles}` and `ProfileOverride{Playbook *[]RunPhase, Principles *string}` are used identically in Go (Tasks 1–2) and, via codegen, as ambient TS types (Tasks 3–4). `ResolveProfile(global, override)` / `ResolvePlaybook(global, override)` / `OverrideFromMeta(ch)` signatures match between definition (Task 1) and call sites (Task 2). `getJarvisProfile` returns `CommandGetJarvisProfileRtnData` (`{global, override, resolved}`) consumed as `{global, override}` in `ProfilePanel` (Task 4). `profileRailOpenAtom` defined in `profilepanel.tsx` and imported by `runssurface.tsx` (Task 4). `setChannelProfile(channelId, override)` consistent across Tasks 3–4.
