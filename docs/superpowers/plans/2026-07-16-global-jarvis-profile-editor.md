# Global Jarvis Profile Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users edit the whole global Jarvis profile (Playbook + Principles + Run defaults) and persist it to `jarvis-profile.json`, so edits become defaults across all projects.

**Architecture:** Add a backend write path (`SaveGlobalProfile` + two wshrpc commands `Get/SetGlobalProfile`) mirroring the existing read path. In the frontend, the per-channel profile panel gains a `Global defaults · This project` scope toggle: project scope is today's per-project-override UI unchanged; global scope edits a `JarvisProfile` directly and saves to the global file.

**Tech Stack:** Go (wavesrv, wshrpc), React 19 + jotai + Tailwind 4 (frontend), Task (`task generate`), vitest (FE tests), `go test` (Go tests).

## Global Constraints

- **Never hand-edit generated files.** `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, and `frontend/types/gotypes.d.ts` are produced by `task generate`. Edit the Go source (`wshrpctypes.go`, `wshserver.go`, `waveobj`) then regenerate.
- **Typecheck command:** bare `npx tsc` stack-overflows on this repo. Use `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. Baseline is clean (exit 0); any error it reports is yours.
- **Pre-existing Go test failure:** `go test ./pkg/tsgen/` fails on `TestGenerateWaveEventTypes` on a clean baseline (stale fixture). That is the only expected Go test failure — ignore it, fix nothing else.
- **Colors:** never hardcode hex/rgba. Reuse existing Tailwind `@theme` utility classes already used in `profilepanel.tsx` / `principleseditor.tsx` (`text-accent-soft`, `border-edge-mid`, `bg-surface`, `text-muted`, `text-error`, etc.).
- **Git policy (STRICT, overrides the skill's per-task commit steps):** do NOT commit or push without explicit user approval. Do NOT add a co-author. Batch all changes into ONE commit at the end (Task 7), and only after the user approves. The spec doc folds into that same feature commit. Per-task steps end at "tests pass" — stage nothing until the final gate.

---

## File Structure

**Backend**
- `pkg/jarvis/profile.go` (modify) — add `SaveGlobalProfile`.
- `pkg/jarvis/profile_test.go` (modify) — `SaveGlobalProfile` unit tests.
- `pkg/wshrpc/wshrpctypes.go` (modify) — interface methods + `CommandSetGlobalProfileData`.
- `pkg/wshrpc/wshserver/wshserver.go` (modify) — `GetGlobalProfileCommand`, `SetGlobalProfileCommand`.
- `pkg/wshrpc/wshserver/wshserver_profile_test.go` (modify) — command-level tests.
- Generated (via `task generate`, do not hand-edit): `wshclient.go`, `wshclientapi.ts`, `gotypes.d.ts`.

**Frontend**
- `frontend/app/view/agents/profilemodel.ts` (modify) — `reduceGlobalPrinciples` + `GlobalPrincipleAction` + `globalProfileIsDirty`.
- `frontend/app/view/agents/profilemodel.test.ts` (modify) — reducer tests.
- `frontend/app/view/agents/runactions.ts` (modify) — `getGlobalProfile` / `setGlobalProfile` wrappers.
- `frontend/app/view/agents/profilepanel.tsx` (modify) — `GlobalPrinciplesEditor` + `GlobalProfileEditor` (in-file, reuse the local `PhaseEditor` to avoid a circular import) + scope toggle wiring.

---

## Task 1: Backend — `SaveGlobalProfile` writer

**Files:**
- Modify: `pkg/jarvis/profile.go`
- Test: `pkg/jarvis/profile_test.go`

**Interfaces:**
- Consumes: `waveobj.JarvisProfile`, `ValidateGlobalPrinciples` (existing), `wavebase.GetWaveConfigDir` (existing), `globalProfileFileName` const (existing), `withConfigHome(t, dir)` test helper (existing, `profile_test.go:219`).
- Produces: `func SaveGlobalProfile(profile waveobj.JarvisProfile) error` — validates principles + playbook phase kinds, then atomically writes `jarvis-profile.json` to the config dir. Counterpart to `LoadGlobalProfile`.

- [ ] **Step 1: Write the failing tests**

Add to `pkg/jarvis/profile_test.go` (the file already imports `os`, `path/filepath`, `strings`, `testing`, `github.com/wavetermdev/waveterm/pkg/waveobj`):

```go
func TestSaveGlobalProfileRoundTrip(t *testing.T) {
	dir := t.TempDir()
	withConfigHome(t, dir)
	profile := BuiltinProfile()
	profile.Principles = append(waveobj.PrincipleList(nil), profile.Principles...)
	profile.Principles[0].Text = "Custom global principle."
	profile.DefaultMode = "orchestrator"
	if err := SaveGlobalProfile(profile); err != nil {
		t.Fatalf("save: %v", err)
	}
	got := LoadGlobalProfile()
	if len(got.Principles) == 0 || got.Principles[0].Text != "Custom global principle." {
		t.Fatalf("principle not persisted: %+v", got.Principles)
	}
	if got.DefaultMode != "orchestrator" {
		t.Fatalf("defaultmode not persisted: %q", got.DefaultMode)
	}
}

func TestSaveGlobalProfileRejectsBlankPrinciple(t *testing.T) {
	dir := t.TempDir()
	withConfigHome(t, dir)
	profile := BuiltinProfile()
	profile.Principles = waveobj.PrincipleList{{ID: "p1", Text: "   "}}
	if err := SaveGlobalProfile(profile); err == nil {
		t.Fatal("expected validation error for blank text")
	}
	if _, err := os.Stat(filepath.Join(dir, globalProfileFileName)); !os.IsNotExist(err) {
		t.Fatal("must not write the file on validation failure")
	}
}

func TestSaveGlobalProfileRejectsBlankPhaseKind(t *testing.T) {
	dir := t.TempDir()
	withConfigHome(t, dir)
	profile := BuiltinProfile()
	profile.Playbook = []waveobj.RunPhase{{Kind: "   ", State: "pending"}}
	if err := SaveGlobalProfile(profile); err == nil {
		t.Fatal("expected validation error for blank phase kind")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/jarvis/ -run TestSaveGlobalProfile -v`
Expected: FAIL — `undefined: SaveGlobalProfile`.

- [ ] **Step 3: Implement `SaveGlobalProfile`**

Add to `pkg/jarvis/profile.go` (all imports needed — `encoding/json`, `fmt`, `os`, `path/filepath`, `strings`, `wavebase` — are already present). Place it right after `LoadGlobalProfile`:

```go
// SaveGlobalProfile validates and atomically writes the global profile to jarvis-profile.json in the
// config dir. It is the write counterpart to LoadGlobalProfile; the first save creates the file.
func SaveGlobalProfile(profile waveobj.JarvisProfile) error {
	if err := ValidateGlobalPrinciples(profile.Principles); err != nil {
		return fmt.Errorf("invalid principles: %w", err)
	}
	for i, phase := range profile.Playbook {
		if strings.TrimSpace(phase.Kind) == "" {
			return fmt.Errorf("playbook phase %d has a blank kind", i)
		}
	}
	data, err := json.MarshalIndent(profile, "", "  ")
	if err != nil {
		return fmt.Errorf("marshaling profile: %w", err)
	}
	dir := wavebase.GetWaveConfigDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("creating config dir: %w", err)
	}
	path := filepath.Join(dir, globalProfileFileName)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return fmt.Errorf("writing profile: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("finalizing profile: %w", err)
	}
	return nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/jarvis/ -run TestSaveGlobalProfile -v`
Expected: PASS (all three).

---

## Task 2: Backend — `Get/SetGlobalProfile` wshrpc commands + codegen

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes.go`
- Modify: `pkg/wshrpc/wshserver/wshserver.go`
- Test: `pkg/wshrpc/wshserver/wshserver_profile_test.go`
- Generated (via `task generate`): `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`

**Interfaces:**
- Consumes: `jarvis.SaveGlobalProfile` (Task 1), `jarvis.LoadGlobalProfile` (existing), `waveobj.JarvisProfile`.
- Produces:
  - `GetGlobalProfileCommand(ctx) (*waveobj.JarvisProfile, error)` → wshrpc string `"getglobalprofile"`; TS `RpcApi.GetGlobalProfileCommand(client): Promise<JarvisProfile>`.
  - `SetGlobalProfileCommand(ctx, CommandSetGlobalProfileData) error` → wshrpc string `"setglobalprofile"`; TS `RpcApi.SetGlobalProfileCommand(client, {profile}): Promise<void>`.
  - `type CommandSetGlobalProfileData struct { Profile waveobj.JarvisProfile ` + "`json:\"profile\"`" + ` }`.

- [ ] **Step 1: Write the failing command tests**

Add to `pkg/wshrpc/wshserver/wshserver_profile_test.go`. Add `"github.com/wavetermdev/waveterm/pkg/wavebase"` to its import block, then:

```go
func withConfigHome(t *testing.T, dir string) {
	t.Helper()
	old := wavebase.ConfigHome_VarCache
	t.Cleanup(func() { wavebase.ConfigHome_VarCache = old })
	wavebase.ConfigHome_VarCache = dir
}

func TestGetGlobalProfileCommandReturnsBuiltinWhenUnset(t *testing.T) {
	withConfigHome(t, t.TempDir())
	got, err := (&WshServer{}).GetGlobalProfileCommand(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Principles) != len(jarvis.DefaultPrinciples) {
		t.Fatalf("expected builtin principles, got %d", len(got.Principles))
	}
}

func TestSetGlobalProfileCommandPersists(t *testing.T) {
	withConfigHome(t, t.TempDir())
	profile := jarvis.BuiltinProfile()
	profile.Principles = append(waveobj.PrincipleList(nil), profile.Principles...)
	profile.Principles[0].Text = "Edited global principle."
	profile.DefaultMode = "orchestrator"
	if err := (&WshServer{}).SetGlobalProfileCommand(context.Background(), wshrpc.CommandSetGlobalProfileData{Profile: profile}); err != nil {
		t.Fatal(err)
	}
	got, err := (&WshServer{}).GetGlobalProfileCommand(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got.Principles[0].Text != "Edited global principle." {
		t.Fatalf("edited principle not persisted: %q", got.Principles[0].Text)
	}
	if got.DefaultMode != "orchestrator" {
		t.Fatalf("defaultmode not persisted: %q", got.DefaultMode)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail to compile**

Run: `go test ./pkg/wshrpc/wshserver/ -run TestSetGlobalProfileCommandPersists`
Expected: FAIL — `undefined: (*WshServer).GetGlobalProfileCommand` / `wshrpc.CommandSetGlobalProfileData`.

- [ ] **Step 3: Add the interface methods + data type**

In `pkg/wshrpc/wshrpctypes.go`, add these two lines to the `WshRpcInterface` immediately after the `SetChannelProfileCommand` line (currently line 139):

```go
	GetGlobalProfileCommand(ctx context.Context) (*waveobj.JarvisProfile, error)                                           // read the global Jarvis profile (builtins if unset)
	SetGlobalProfileCommand(ctx context.Context, data CommandSetGlobalProfileData) error                                  // write the global Jarvis profile to jarvis-profile.json
```

And add the data type immediately after the `CommandSetChannelProfileData` struct (around line 843):

```go
type CommandSetGlobalProfileData struct {
	Profile waveobj.JarvisProfile `json:"profile"`
}
```

- [ ] **Step 4: Implement the commands**

In `pkg/wshrpc/wshserver/wshserver.go`, add immediately after `SetChannelProfileCommand` (ends line 2136):

```go
func (ws *WshServer) GetGlobalProfileCommand(ctx context.Context) (*waveobj.JarvisProfile, error) {
	profile := jarvis.LoadGlobalProfile()
	return &profile, nil
}

func (ws *WshServer) SetGlobalProfileCommand(ctx context.Context, data wshrpc.CommandSetGlobalProfileData) error {
	return jarvis.SaveGlobalProfile(data.Profile)
}
```

- [ ] **Step 5: Regenerate bindings**

Run: `task generate`
Expected: exit 0. Confirm the generator picked up both commands:

Run: `grep -c "getglobalprofile\|setglobalprofile" pkg/wshrpc/wshclient/wshclient.go frontend/app/store/wshclientapi.ts`
Expected: non-zero counts in both files (`GetGlobalProfileCommand` and `SetGlobalProfileCommand` entries added).

- [ ] **Step 6: Run the Go tests to verify they pass**

Run: `go test ./pkg/wshrpc/wshserver/ -run "TestGetGlobalProfileCommandReturnsBuiltinWhenUnset|TestSetGlobalProfileCommandPersists" -v`
Expected: PASS (both).

Run: `go build ./...`
Expected: exit 0 (WshServer still satisfies the interface).

---

## Task 3: Frontend — `reduceGlobalPrinciples` reducer

**Files:**
- Modify: `frontend/app/view/agents/profilemodel.ts`
- Test: `frontend/app/view/agents/profilemodel.test.ts`

**Interfaces:**
- Consumes: global ambient type `Principle` (from `gotypes.d.ts`).
- Produces:
  - `type GlobalPrincipleAction = {type:"add"; principle: Principle} | {type:"update"; id: string; text: string} | {type:"delete"; id: string} | {type:"move"; id: string; dir: -1 | 1}`
  - `function reduceGlobalPrinciples(list: Principle[], action: GlobalPrincipleAction): Principle[]` — pure; "add" appends a caller-built principle (caller generates the id, matching `PrinciplesEditor`).
  - `function globalProfileIsDirty(a: JarvisProfile, b: JarvisProfile): boolean` — structural compare.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/app/view/agents/profilemodel.test.ts` (match the existing import style in that file — it already imports from `./profilemodel` and uses vitest globals or explicit imports; add `reduceGlobalPrinciples` to the existing `./profilemodel` import):

```ts
describe("reduceGlobalPrinciples", () => {
    const base: Principle[] = [
        { id: "a", text: "A" },
        { id: "b", text: "B" },
    ];
    test("add appends a caller-built principle", () => {
        expect(reduceGlobalPrinciples(base, { type: "add", principle: { id: "c", text: "" } })).toEqual([
            { id: "a", text: "A" },
            { id: "b", text: "B" },
            { id: "c", text: "" },
        ]);
    });
    test("update changes text by id only", () => {
        const out = reduceGlobalPrinciples(base, { type: "update", id: "a", text: "A2" });
        expect(out[0].text).toBe("A2");
        expect(out[1].text).toBe("B");
    });
    test("delete removes by id", () => {
        expect(reduceGlobalPrinciples(base, { type: "delete", id: "a" })).toEqual([{ id: "b", text: "B" }]);
    });
    test("move swaps neighbors", () => {
        expect(reduceGlobalPrinciples(base, { type: "move", id: "b", dir: -1 }).map((p) => p.id)).toEqual(["b", "a"]);
    });
    test("move out of bounds is a no-op", () => {
        expect(reduceGlobalPrinciples(base, { type: "move", id: "a", dir: -1 })).toEqual(base);
    });
});
```

If `profilemodel.test.ts` does not already import `describe/test/expect`, add `import { describe, expect, test } from "vitest";` at the top (check the file first; do not duplicate an existing import).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/profilemodel.test.ts -t "reduceGlobalPrinciples"`
Expected: FAIL — `reduceGlobalPrinciples is not a function` / import error.

- [ ] **Step 3: Implement the reducer + dirty helper**

Add to `frontend/app/view/agents/profilemodel.ts` (end of file):

```ts
export type GlobalPrincipleAction =
    | { type: "add"; principle: Principle }
    | { type: "update"; id: string; text: string }
    | { type: "delete"; id: string }
    | { type: "move"; id: string; dir: -1 | 1 };

// Global-scope principles are a plain flat list (no override/disable/inherit — those only make sense
// against a global baseline). Pure; "add" appends a caller-built principle so the reducer stays deterministic.
export function reduceGlobalPrinciples(list: Principle[], action: GlobalPrincipleAction): Principle[] {
    switch (action.type) {
        case "add":
            return [...list, action.principle];
        case "update":
            return list.map((p) => (p.id === action.id ? { ...p, text: action.text } : p));
        case "delete":
            return list.filter((p) => p.id !== action.id);
        case "move": {
            const i = list.findIndex((p) => p.id === action.id);
            const j = i + action.dir;
            if (i < 0 || j < 0 || j >= list.length) {
                return list;
            }
            const next = [...list];
            [next[i], next[j]] = [next[j], next[i]];
            return next;
        }
    }
}

// Structural dirty check for the whole global profile (plain data; key order is stable across edits).
export function globalProfileIsDirty(a: JarvisProfile, b: JarvisProfile): boolean {
    return JSON.stringify(a) !== JSON.stringify(b);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/profilemodel.test.ts -t "reduceGlobalPrinciples"`
Expected: PASS (all five).

---

## Task 4: Frontend — `getGlobalProfile` / `setGlobalProfile` wrappers

**Files:**
- Modify: `frontend/app/view/agents/runactions.ts`

**Interfaces:**
- Consumes: generated `RpcApi.GetGlobalProfileCommand` / `RpcApi.SetGlobalProfileCommand` (Task 2), `TabRpcClient` (already imported), global ambient type `JarvisProfile`.
- Produces:
  - `async function getGlobalProfile(): Promise<JarvisProfile>`
  - `async function setGlobalProfile(profile: JarvisProfile): Promise<void>`

- [ ] **Step 1: Add the wrappers**

Add to `frontend/app/view/agents/runactions.ts`, immediately after the existing `setChannelProfile` function (ends line 124):

```ts
export async function getGlobalProfile(): Promise<JarvisProfile> {
    return RpcApi.GetGlobalProfileCommand(TabRpcClient);
}

export async function setGlobalProfile(profile: JarvisProfile): Promise<void> {
    await RpcApi.SetGlobalProfileCommand(TabRpcClient, { profile });
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. (Confirms the generated `RpcApi` methods exist with the expected signatures.)

---

## Task 5: Frontend — scope toggle + global editor in `ProfilePanel`

**Files:**
- Modify: `frontend/app/view/agents/profilepanel.tsx`

**Interfaces:**
- Consumes: `getGlobalProfile` / `setGlobalProfile` (Task 4), `getJarvisProfile` / `setChannelProfile` (existing), `reduceGlobalPrinciples` / `globalProfileIsDirty` / `isDirty` / `principlePatchIsEmpty` (Tasks 3 + existing), local `PhaseEditor` / `movePhase` / `PHASE_KINDS` (existing in this file), global ambient types `JarvisProfile` / `Principle` / `RunPhase`.
- Produces: an updated `ProfilePanel` with a `Global defaults · This project` toggle; global scope renders `GlobalProfileEditor` and saves via `setGlobalProfile`.

- [ ] **Step 1: Add imports**

In `frontend/app/view/agents/profilepanel.tsx`, update the two relevant import lines:

```ts
import { getGlobalProfile, getJarvisProfile, setChannelProfile, setGlobalProfile } from "./runactions";
import { globalProfileIsDirty, isDirty, principlePatchIsEmpty, reduceGlobalPrinciples } from "./profilemodel";
```

- [ ] **Step 2: Add the `GlobalPrinciplesEditor` component**

Add near the other section components in `profilepanel.tsx` (e.g. after `PhaseEditor`, before `PlaybookSection`). It reuses the shared button/box class names already defined via inline strings in this file's siblings; declare local consts to match `principleseditor.tsx` styling:

```tsx
const gDangerBtn = "text-[10px] text-muted hover:text-error";
const gEditBox =
    "mt-1 w-full rounded border border-edge-mid bg-background p-2 text-[11.5px] leading-[1.5] text-primary placeholder:text-muted focus:outline-none";

function GlobalPrinciplesEditor({
    principles,
    onChange,
}: {
    principles: Principle[];
    onChange: (list: Principle[]) => void;
}) {
    const dispatch = (action: Parameters<typeof reduceGlobalPrinciples>[1]) =>
        onChange(reduceGlobalPrinciples(principles, action));
    return (
        <div className="flex flex-col gap-2">
            {principles.map((p) => (
                <div key={p.id} className="rounded border border-edge-mid bg-surface p-2">
                    <div className="flex items-center gap-1.5">
                        <button
                            type="button"
                            onClick={() => dispatch({ type: "move", id: p.id, dir: -1 })}
                            className="px-1 text-[11px] text-muted hover:text-secondary"
                        >
                            ↑
                        </button>
                        <button
                            type="button"
                            onClick={() => dispatch({ type: "move", id: p.id, dir: 1 })}
                            className="px-1 text-[11px] text-muted hover:text-secondary"
                        >
                            ↓
                        </button>
                        <div className="flex-1" />
                        <button type="button" onClick={() => dispatch({ type: "delete", id: p.id })} className={gDangerBtn}>
                            delete
                        </button>
                    </div>
                    <textarea
                        value={p.text}
                        onChange={(e) => dispatch({ type: "update", id: p.id, text: e.target.value })}
                        rows={2}
                        placeholder="Global principle…"
                        className={gEditBox}
                    />
                </div>
            ))}
            <button
                type="button"
                onClick={() => dispatch({ type: "add", principle: { id: `custom-${crypto.randomUUID()}`, text: "" } })}
                className="rounded-[7px] border border-dashed border-edge-mid py-1 text-[11px] text-muted hover:text-secondary"
            >
                + add principle
            </button>
        </div>
    );
}
```

- [ ] **Step 3: Add the `GlobalProfileEditor` component**

Add immediately after `GlobalPrinciplesEditor`. It reuses the file's existing `PhaseEditor`, `movePhase`, and `PHASE_KINDS`:

```tsx
function GlobalProfileEditor({
    profile,
    onChange,
}: {
    profile: JarvisProfile;
    onChange: (next: JarvisProfile) => void;
}) {
    const phases = profile.playbook ?? [];
    const setPhases = (next: RunPhase[]) => onChange({ ...profile, playbook: next });
    const mode = profile.defaultmode ?? "pipeline";
    const gate = profile.defaultplangate ?? true;
    return (
        <div className="flex flex-col gap-5">
            <div>
                <div className="mb-1.5 text-[12px] font-semibold text-primary">Playbook</div>
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
            </div>
            <div>
                <div className="mb-1.5 text-[12px] font-semibold text-primary">Principles</div>
                <GlobalPrinciplesEditor
                    principles={profile.principles ?? []}
                    onChange={(list) => onChange({ ...profile, principles: list })}
                />
            </div>
            <div>
                <div className="mb-1.5 text-[12px] font-semibold text-primary">Run defaults</div>
                <div className="flex items-center gap-2">
                    <select
                        value={mode}
                        onChange={(e) => onChange({ ...profile, defaultmode: e.target.value })}
                        className="rounded-sm border border-edge-mid bg-background px-1.5 py-1 text-[11px] text-primary"
                    >
                        <option value="pipeline">pipeline</option>
                        <option value="orchestrator">orchestrator</option>
                    </select>
                    {mode === "orchestrator" ? (
                        <label className="flex cursor-pointer items-center gap-1 text-[11px] text-secondary">
                            <input
                                type="checkbox"
                                checked={gate}
                                onChange={(e) => onChange({ ...profile, defaultplangate: e.target.checked })}
                            />
                            plan gate on by default
                        </label>
                    ) : null}
                </div>
            </div>
        </div>
    );
}
```

- [ ] **Step 4: Rewire the `ProfilePanel` body — state, load, save, toggle**

Replace the body of `ProfilePanel` (currently lines 281-367) with the version below. Changes: add `scope`, `globalLoaded`, `globalDraft` state; branch the load effect on `channelId`; branch `save` and the dirty check on `scope`; render the scope toggle and the global editor.

```tsx
export function ProfilePanel({ channelId }: { channelId: string }) {
    const open = useAtomValue(profileRailOpenAtom);
    const [scope, setScope] = useState<"project" | "global">("project");
    const [loaded, setLoaded] = useState<Loaded | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [draft, setDraft] = useState<ProfileOverride>({});
    const [globalLoaded, setGlobalLoaded] = useState<JarvisProfile | null>(null);
    const [globalDraft, setGlobalDraft] = useState<JarvisProfile | null>(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!open) {
            return;
        }
        // reset per open/channel so a stale load never lingers; a failed load surfaces instead of
        // sticking on "Loading…" forever (e.g. the channel was deleted out from under the drawer).
        setLoaded(null);
        setError(null);
        setGlobalLoaded(null);
        setGlobalDraft(null);
        fireAndForget(async () => {
            try {
                if (channelId) {
                    const p = await getJarvisProfile(channelId);
                    setLoaded({ global: p.global, override: p.override ?? {}, diagnostics: p.principlediagnostics ?? [] });
                    setDraft(p.override ?? {});
                    // p.global is LoadGlobalProfile()'s result — seed global scope without a second call.
                    setGlobalLoaded(p.global);
                    setGlobalDraft(p.global);
                } else {
                    // no active channel: project scope is unavailable, fall back to editing global directly.
                    const g = await getGlobalProfile();
                    setGlobalLoaded(g);
                    setGlobalDraft(g);
                    setScope("global");
                }
            } catch (e) {
                setError(String(e));
            }
        });
    }, [open, channelId]);

    const save = () => {
        setSaving(true);
        fireAndForget(async () => {
            try {
                if (scope === "global") {
                    if (!globalDraft) {
                        return;
                    }
                    await setGlobalProfile(globalDraft);
                    setGlobalLoaded(globalDraft);
                } else {
                    if (!loaded) {
                        return;
                    }
                    await setChannelProfile(channelId, draft);
                    setLoaded((l) => (l ? { ...l, override: overrideIsEmpty(draft) ? {} : draft } : l));
                }
            } finally {
                setSaving(false);
            }
        });
    };

    const dirty =
        scope === "global"
            ? !!globalLoaded && !!globalDraft && globalProfileIsDirty(globalDraft, globalLoaded)
            : !!loaded && isDirty(draft, loaded.override);
    const ready = scope === "global" ? globalLoaded != null && globalDraft != null : loaded != null;

    const toggle = (
        <div className="flex gap-1 rounded-[7px] border border-edge-mid p-0.5">
            {(["global", "project"] as const).map((s) => (
                <button
                    key={s}
                    type="button"
                    disabled={s === "project" && !channelId}
                    onClick={() => setScope(s)}
                    className={
                        "flex-1 rounded-[5px] px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-40 " +
                        (scope === s ? "bg-accentbg/50 text-accent-soft" : "text-muted hover:text-secondary")
                    }
                >
                    {s === "global" ? "Global defaults" : "This project"}
                </button>
            ))}
        </div>
    );

    const body = (
        <div className="flex flex-col gap-5">
            {toggle}
            {error ? (
                <div className="text-[12px] leading-[1.5] text-error">Couldn't load the profile. {error}</div>
            ) : !ready ? (
                <div className="text-[12px] text-muted">Loading…</div>
            ) : scope === "global" ? (
                <>
                    <div className="text-[10px] font-semibold uppercase tracking-[.08em] text-muted">
                        Jarvis profile · global defaults (all projects)
                    </div>
                    <GlobalProfileEditor profile={globalDraft!} onChange={setGlobalDraft} />
                </>
            ) : (
                <>
                    <div className="text-[10px] font-semibold uppercase tracking-[.08em] text-muted">
                        Jarvis profile · merged (global + this project)
                    </div>
                    <PlaybookSection global={loaded!.global} draft={draft} setDraft={setDraft} />
                    <PrinciplesSection
                        global={loaded!.global}
                        draft={draft}
                        setDraft={setDraft}
                        diagnostics={loaded!.diagnostics}
                    />
                    <DefaultsSection global={loaded!.global} draft={draft} setDraft={setDraft} />
                </>
            )}
        </div>
    );

    const footer = ready ? (
        <button
            type="button"
            disabled={saving || !dirty}
            onClick={save}
            className="w-full rounded bg-accent py-2 text-[12px] font-semibold text-background hover:bg-accenthover disabled:opacity-40"
        >
            {saving ? "Saving…" : scope === "global" ? "Save global defaults" : "Save"}
        </button>
    ) : null;

    const sections: RailSection[] = [
        { id: "profile", icon: <span className="text-[16px]">⚙</span>, label: "Profile", content: body },
    ];
    // no collapsed strip of its own: the ⚙ trigger lives in the channel context rail's collapsed strip
    // (see ChannelsSurface), so profile stays its own drawer without doubling up the right-edge column.
    return (
        <CollapsibleRail
            openAtom={profileRailOpenAtom}
            ariaLabel="Jarvis profile"
            sections={sections}
            footer={footer}
            hideWhenCollapsed
        />
    );
}
```

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 6: Run the frontend unit tests**

Run: `npx vitest run frontend/app/view/agents/profilemodel.test.ts`
Expected: PASS (existing tests + the new `reduceGlobalPrinciples` block).

---

## Task 6: Verification — full suites + live CDP visual check

**Files:** none (verification only).

- [ ] **Step 1: Go tests for the touched packages**

Run: `go test ./pkg/jarvis/ ./pkg/wshrpc/wshserver/`
Expected: PASS. (If you run the whole `./pkg/...`, `pkg/tsgen` `TestGenerateWaveEventTypes` fails on baseline — that is pre-existing and not ours.)

- [ ] **Step 2: Frontend typecheck + tests**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && npx vitest run frontend/app/view/agents/`
Expected: exit 0 and PASS.

- [ ] **Step 3: Live visual verification over CDP**

Start the dev app if not running (`tail -f /dev/null | task dev`, per the repo's dev gotcha), then with the app up:
1. `node scripts/cdp-shot.mjs` — confirm it attaches on `:9222`.
2. Open the ⚙ profile drawer in a channel. Confirm the `Global defaults · This project` toggle renders and defaults to `This project` with today's UI unchanged.
3. Switch to `Global defaults`. Edit a principle's text, reorder two principles, add a principle, and set Run defaults → `orchestrator`. Click `Save global defaults`.
4. Close and reopen the drawer (and/or switch channels). Reopen in `Global defaults` scope and confirm the edits persisted.
5. Confirm on disk: `jarvis-profile.json` now exists in the dev config dir (`dev.arc.app-dev` config home) and contains the edited principle + `"defaultmode":"orchestrator"`.

Expected: the edited global profile round-trips and the file is written. Capture a screenshot for the change record.

---

## Task 7: Commit (gated on user approval)

**Files:** all changes from Tasks 1-5 + the spec doc.

- [ ] **Step 1: Self-review the diff**

Run: `git status && git --no-pager diff`
Confirm: no debug statements, no commented-out code, generated files (`wshclient.go`, `wshclientapi.ts`, `gotypes.d.ts`) changed only via `task generate`, no unrelated edits.

- [ ] **Step 2: Ask the user for explicit approval to commit.**

Do NOT proceed without it (per the strict git policy). Once approved:

- [ ] **Step 3: Stage and commit (single feature commit, spec folded in, no co-author)**

```bash
git add pkg/jarvis/profile.go pkg/jarvis/profile_test.go \
        pkg/wshrpc/wshrpctypes.go pkg/wshrpc/wshserver/wshserver.go \
        pkg/wshrpc/wshserver/wshserver_profile_test.go \
        pkg/wshrpc/wshclient/wshclient.go frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts \
        frontend/app/view/agents/profilemodel.ts frontend/app/view/agents/profilemodel.test.ts \
        frontend/app/view/agents/runactions.ts frontend/app/view/agents/profilepanel.tsx \
        docs/superpowers/specs/2026-07-16-global-jarvis-profile-editor-design.md \
        docs/superpowers/plans/2026-07-16-global-jarvis-profile-editor.md
git commit -m "feat(jarvis): editable global profile with per-scope profile panel"
```

---

## Self-Review

**Spec coverage:**
- Whole-profile global editing (Playbook + Principles + Run defaults) → Task 5 `GlobalProfileEditor` covers all three sections; Task 1/2 persist the full `JarvisProfile`. ✓
- Scope toggle, default `This project`, project scope unchanged → Task 5 `toggle` + branch keeps `PlaybookSection`/`PrinciplesSection`/`DefaultsSection` untouched. ✓
- Global scope ignores `channelId` / works with no channel → Task 5 load effect `else` branch + `getGlobalProfile` (Task 4). ✓
- Flat-list principles editor (add/edit/delete/reorder) → Task 3 reducer + Task 5 `GlobalPrinciplesEditor`. ✓
- Backend `SaveGlobalProfile` (validate + atomic write) + `Get/SetGlobalProfileCommand` → Tasks 1-2. ✓
- Refetch-on-open propagation (v1) → panel updates own state on save (Task 5); other surfaces already refetch `getJarvisProfile` on channel switch (no code needed). ✓
- Testing: Go round-trip + validation (Tasks 1-2), FE reducer unit tests (Task 3), CDP visual (Task 6). ✓

**Placeholder scan:** No TBD/TODO/"handle errors appropriately" — all steps carry concrete code and commands. ✓

**Type consistency:** `SaveGlobalProfile(waveobj.JarvisProfile) error`, `CommandSetGlobalProfileData{Profile}`, `GetGlobalProfileCommand(ctx)(*waveobj.JarvisProfile,error)` used identically across Tasks 1-2 and mirrored in FE wrappers (Task 4) and consumers (Task 5). `reduceGlobalPrinciples` / `GlobalPrincipleAction` / `globalProfileIsDirty` signatures match between Task 3 (definition) and Task 5 (use). ✓
