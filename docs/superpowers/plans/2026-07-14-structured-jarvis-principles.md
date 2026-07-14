# Structured Jarvis Principles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace Jarvis's whole-string principle override with a structured global list plus per-channel additions, replacements, and disables, while preserving legacy data and the existing Run-snapshot/Gatekeeper-live semantics.

**Architecture:** Go remains the single source of truth for JSON normalization, validation, resolution, diagnostics, and prompt rendering. The frontend edits only a `PrinciplePatch`; it never materializes the resolved global list into channel metadata. New Runs snapshot the resolved structured list, while Gatekeeper resolves the current profile for every ask.

**Tech Stack:** Go, JSON-backed Wave objects, wshrpc code generation, React 19, TypeScript, jotai, Tailwind CSS 4 with existing `@theme` tokens, Vitest, CDP/WebView2.

## Global Constraints

- Follow the approved design in `docs/superpowers/specs/2026-07-14-structured-jarvis-principles-design.md`.
- Keep the existing playbook, default mode, and plan-gate contracts unchanged.
- Use Tailwind utilities backed by existing `@theme` tokens only. Do not add raw hex/RGB/RGBA values, arbitrary color utilities, inline literal colors, new SCSS, or one-off CSS selectors.
- Reuse the current `ProfilePanel`, `CollapsibleRail`, button, input, disclosure, and badge visual language. Do not create a parallel profile-editor design system.
- Do not hand-edit generated Go or TypeScript bindings; run `task generate` after changing Go wire types.
- The shared working tree is dirty. In particular, `pkg/wshrpc/wshserver/wshserver.go` is already modified by another workstream. Re-read it immediately before editing and limit changes to the Jarvis profile handlers.
- Do not touch or stage the unrelated cancel-run documents or `docs/agents/runs-pipeline-known-issues.md`.
- Do not commit or push during task execution. After verification, show the scoped file list, summary, and proposed `feat(jarvis): structure profile principles` message, then wait for explicit approval.

---

### Task 1: Add structured wire types and legacy JSON decoding

**Files:**
- Create: `pkg/waveobj/principles.go`
- Create: `pkg/waveobj/principles_test.go`
- Modify: `pkg/waveobj/wtype.go`

- [ ] **Step 1: Write failing JSON compatibility tests**

Add table-driven tests covering structured and legacy inputs:

```go
func TestPrincipleListUnmarshalJSON(t *testing.T) {
    tests := []struct {
        name string
        raw  string
        want PrincipleList
    }{
        {
            name: "structured",
            raw:  `[{"id":"simple","text":"Prefer simple solutions."}]`,
            want: PrincipleList{{ID: "simple", Text: "Prefer simple solutions."}},
        },
        {
            name: "legacy string",
            raw:  `"preserve\nthis exact text"`,
            want: PrincipleList{{ID: LegacyGlobalPrincipleID, Text: "preserve\nthis exact text"}},
        },
    }
    // unmarshal, compare, then marshal and assert the output is always an array
}

func TestPrinciplePatchUnmarshalLegacyString(t *testing.T) {
    var patch PrinciplePatch
    require.NoError(t, json.Unmarshal([]byte(`"project-only text"`), &patch))
    text, ok := patch.LegacyReplacement()
    require.True(t, ok)
    require.Equal(t, "project-only text", text)
}
```

Also assert that structured patch JSON round-trips without a legacy marker and that marshaling never emits the legacy string shape.

- [ ] **Step 2: Run the tests and confirm the red state**

Run:

```powershell
go test ./pkg/waveobj -run 'TestPrinciple(List|Patch)' -count=1
```

Expected: compile failure because `Principle`, `PrincipleList`, and `PrinciplePatch` do not exist.

- [ ] **Step 3: Implement the minimal wire types and boundary decoders**

In `pkg/waveobj/principles.go`, add:

```go
const (
    LegacyGlobalPrincipleID  = "legacy-global"
    LegacyProjectPrincipleID = "legacy-project"
)

type Principle struct {
    ID   string `json:"id"`
    Text string `json:"text"`
}

type PrincipleList []Principle

type PrinciplePatch struct {
    Additions    []Principle      `json:"additions,omitempty"`
    Replacements map[string]string `json:"replacements,omitempty"`
    Disabled     []string         `json:"disabled,omitempty"`

    legacyReplacement *string
}

func (p PrinciplePatch) LegacyReplacement() (string, bool) {
    if p.legacyReplacement == nil {
        return "", false
    }
    return *p.legacyReplacement, true
}
```

Implement `UnmarshalJSON` on `PrincipleList` to accept either a string or `[]Principle`. Legacy strings become one `legacy-global` entry without splitting or trimming the text. Implement `UnmarshalJSON` on `PrinciplePatch` to accept either a string or the object shape; keep the legacy string in the private marker so Go can preserve full-replacement semantics. Implement `MarshalJSON` for `PrinciplePatch` using an alias so only the structured object is emitted.

In `pkg/waveobj/wtype.go`, change only these fields:

```go
type JarvisProfile struct {
    Playbook        []RunPhase
    Principles      PrincipleList
    DefaultMode     string
    DefaultPlanGate *bool
}

type ProfileOverride struct {
    Playbook        *[]RunPhase
    Principles      *PrinciplePatch
    DefaultMode     *string
    DefaultPlanGate *bool
}
```

Change `Run.Principles` from `string` to `PrincipleList`. Because `PrincipleList.UnmarshalJSON` accepts a string, existing persisted Runs continue loading without a database migration.

- [ ] **Step 4: Run the focused wire tests**

Run:

```powershell
go test ./pkg/waveobj -run 'TestPrinciple(List|Patch)' -count=1
```

Expected: PASS.

---

### Task 2: Implement validation, normalization, deterministic resolution, and rendering

**Files:**
- Modify: `pkg/jarvis/profile.go`
- Modify: `pkg/jarvis/profile_test.go`

- [ ] **Step 1: Replace string-resolution tests with structured behavior tests**

Add helpers and table-driven tests for:

```go
func principles(items ...waveobj.Principle) waveobj.PrincipleList { return items }

func TestResolvePrinciples(t *testing.T) {
    global := principles(
        waveobj.Principle{ID: "simple", Text: "Prefer simple solutions."},
        waveobj.Principle{ID: "errors", Text: "Handle errors at boundaries."},
        waveobj.Principle{ID: "measure", Text: "Measure before optimizing."},
    )
    patch := &waveobj.PrinciplePatch{
        Additions: []waveobj.Principle{{ID: "project-api", Text: "Keep the public API stable."}},
        Replacements: map[string]string{"errors": "Return contextual boundary errors."},
        Disabled: []string{"measure"},
    }

    got, diagnostics := ResolvePrinciples(global, patch)
    require.Equal(t, principles(
        waveobj.Principle{ID: "simple", Text: "Prefer simple solutions."},
        waveobj.Principle{ID: "errors", Text: "Return contextual boundary errors."},
        waveobj.Principle{ID: "project-api", Text: "Keep the public API stable."},
    ), got)
    require.Empty(t, diagnostics)
}
```

Add separate cases proving:

- additions append in stored order;
- replacements keep the global position;
- disabled wins over replacement;
- missing replacement and disabled IDs are omitted and each produce a diagnostic;
- the resolver does not mutate global or patch inputs;
- blank IDs/text, duplicate global IDs, duplicate addition IDs, and addition/global collisions fail validation;
- blank replacement text fails validation;
- a legacy project string resolves to exactly one `legacy-project` principle and suppresses the entire current global list;
- `RenderPrinciples` emits Markdown bullets for structured lists but returns the exact original text for a single legacy principle;
- malformed/invalid global files fall back to `BuiltinProfile`.

- [ ] **Step 2: Run the profile tests and confirm the red state**

Run:

```powershell
go test ./pkg/jarvis -run 'Test(ResolvePrinciples|ValidatePrinciples|RenderPrinciples|LoadGlobalProfile)' -count=1
```

Expected: compile or assertion failures because structured resolution is not implemented.

- [ ] **Step 3: Implement the pure profile functions**

Add a small diagnostic wire type in `pkg/waveobj/principles.go`:

```go
type PrincipleDiagnostic struct {
    Code        string `json:"code"`
    PrincipleID string `json:"principleid"`
}
```

Use only these diagnostic codes:

```go
const (
    DiagnosticMissingReplacement = "missing-replacement"
    DiagnosticMissingDisabled    = "missing-disabled"
)
```

In `pkg/jarvis/profile.go`, implement:

```go
func ValidateGlobalPrinciples(items waveobj.PrincipleList) error
func ValidatePrinciplePatch(global waveobj.PrincipleList, patch *waveobj.PrinciplePatch) error
func NormalizePrinciplePatch(global waveobj.PrincipleList, patch *waveobj.PrinciplePatch) *waveobj.PrinciplePatch
func ResolvePrinciples(global waveobj.PrincipleList, patch *waveobj.PrinciplePatch) (waveobj.PrincipleList, []waveobj.PrincipleDiagnostic)
func ResolveProfileWithDiagnostics(global waveobj.JarvisProfile, override *waveobj.ProfileOverride) (waveobj.JarvisProfile, []waveobj.PrincipleDiagnostic)
func RenderPrinciples(items waveobj.PrincipleList) string
```

Keep the current simple call shape for existing consumers:

```go
func ResolveProfile(global waveobj.JarvisProfile, override *waveobj.ProfileOverride) waveobj.JarvisProfile {
    resolved, _ := ResolveProfileWithDiagnostics(global, override)
    return resolved
}
```

`NormalizePrinciplePatch` must convert a legacy project replacement into a structured view for the frontend: disable every current global ID and add one `legacy-project` principle with the exact text. `ResolveProfileWithDiagnostics` must recognize the private legacy marker before ordinary validation so an unsaved legacy override retains full-replacement behavior even if the global list later grows.

Replace `DefaultPrinciples` with explicit builtin entries:

```go
var DefaultPrinciples = waveobj.PrincipleList{
    {ID: "simple-solutions", Text: "Prefer simple, direct solutions over enterprise over-engineering."},
    {ID: "engineering-principles", Text: "Apply SOLID, KISS, YAGNI, and DRY. Keep a single source of truth."},
    {ID: "measure-first", Text: "Measure before optimizing. Do not abstract for a single implementation."},
    {ID: "boundary-errors", Text: "Handle errors at boundaries and never silently swallow them."},
}
```

`LoadGlobalProfile` must validate the decoded list and return `BuiltinProfile` on malformed JSON or invalid structured principles. Preserve the existing logging/fallback behavior.

- [ ] **Step 4: Run all Jarvis profile tests**

Run:

```powershell
go test ./pkg/jarvis -run 'Test(ResolveProfile|ResolvePrinciples|ValidatePrinciples|RenderPrinciples|BuiltinProfile|LoadGlobalProfile|OverrideFromMeta)' -count=1
```

Expected: PASS.

---

### Task 3: Preserve Run snapshots and Gatekeeper live resolution

**Files:**
- Modify: `pkg/jarvis/run.go`
- Modify: `pkg/jarvis/run_test.go`
- Modify: `pkg/jarvis/runexec.go`
- Modify: `pkg/jarvis/runexec_test.go`
- Modify: `pkg/jarvis/classify.go`
- Modify: `pkg/jarvis/classify_test.go`
- Modify: `pkg/jarvis/watcher.go`
- Modify: `pkg/jarvis/watcher_test.go`

- [ ] **Step 1: Write failing runtime-semantics tests**

Update `NewRun` callers to pass a `waveobj.PrincipleList`. Add tests proving:

```go
func TestNewRunSnapshotsPrinciples(t *testing.T) {
    source := waveobj.PrincipleList{{ID: "simple", Text: "Prefer simple solutions."}}
    run := NewRun("ship it", "ws", "/repo", source, RunMode_Pipeline, DefaultPlaybook(), 1)

    source[0].Text = "changed later"
    require.Equal(t, "Prefer simple solutions.", run.Principles[0].Text)
}
```

Add prompt tests that assert:

- a replacement appears once and the original wording is absent;
- disabled principles are absent;
- project additions appear after inherited principles;
- a single legacy Run principle preserves its exact prompt text, including embedded newlines;
- an empty list adds no principles section;
- Gatekeeper classification resolves the current profile for each ask instead of reading a Run snapshot.

- [ ] **Step 2: Run the focused runtime tests and confirm the red state**

Run:

```powershell
go test ./pkg/jarvis -run 'Test(NewRunSnapshotsPrinciples|BuildPhasePrompt|BuildClassifyPrompt|ResolveGatekeeper)' -count=1
```

Expected: compile failures at string-based signatures and assertions.

- [ ] **Step 3: Convert consumers to structured lists**

Change signatures to:

```go
func NewRun(goal, workspaceID, projectPath string, principles waveobj.PrincipleList, mode string, playbook []waveobj.RunPhase, ts int64) waveobj.Run
func BuildPhasePrompt(phase waveobj.RunPhase, goal string, priorArtifacts []string, principles waveobj.PrincipleList) string
func BuildClassifyPrompt(q baseds.AgentAskQuestion, task string, channel *waveobj.Channel, principles waveobj.PrincipleList) string
```

`NewRun` must deep-copy the slice before assigning it to `Run.Principles`. `BuildPhasePrompt` and `BuildClassifyPrompt` must call `RenderPrinciples` and keep their current surrounding prompt ownership. Do not duplicate rendering logic in either consumer.

In the Gatekeeper path, keep the existing sequence `LoadGlobalProfile -> OverrideFromMeta -> ResolveProfile` for every ask. Do not cache resolved principles on the watcher or channel.

- [ ] **Step 4: Run the focused runtime tests**

Run:

```powershell
go test ./pkg/jarvis -run 'Test(NewRunSnapshotsPrinciples|BuildPhasePrompt|BuildClassifyPrompt|ResolveGatekeeper)' -count=1
```

Expected: PASS.

---

### Task 4: Normalize and validate the profile RPC contract

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes.go`
- Modify: `pkg/wshrpc/wshserver/wshserver.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_test.go`
- Regenerate: `pkg/wshrpc/wshclient/wshclient.go`
- Regenerate: `frontend/app/store/wshclientapi.ts`
- Regenerate: `frontend/types/gotypes.d.ts`

- [ ] **Step 1: Add failing handler tests**

Add focused tests around the existing handlers proving:

- `GetJarvisProfileCommand` returns normalized structured global, override, and resolved lists;
- it returns `PrincipleDiagnostics` for stale replacement/disabled IDs;
- a legacy project string is returned as a structured patch view;
- `SetChannelProfileCommand` rejects blank text and ID collisions without updating channel meta;
- a valid save stores only the patch, not the resolved list;
- an empty principle patch is omitted, and an otherwise-empty profile override deletes `jarvis:profile` as today.

- [ ] **Step 2: Run the handler tests and confirm the red state**

Run:

```powershell
go test ./pkg/wshrpc/wshserver -run 'Test(GetJarvisProfile|SetChannelProfile)' -count=1
```

Expected: failures because diagnostics and server validation are absent.

- [ ] **Step 3: Extend the return contract and minimally patch the handlers**

Add to `CommandGetJarvisProfileRtnData`:

```go
PrincipleDiagnostics []waveobj.PrincipleDiagnostic `json:"principlediagnostics,omitempty"`
```

Immediately before editing `wshserver.go`, run `git diff -- pkg/wshrpc/wshserver/wshserver.go` and preserve the concurrent cancel-run changes. In `GetJarvisProfileCommand`, call `ResolveProfileWithDiagnostics`, normalize the returned override's principle patch, and return diagnostics. In `SetChannelProfileCommand`:

1. load the current global profile;
2. normalize a legacy marker if present;
3. call `ValidatePrinciplePatch`;
4. return `fmt.Errorf("validating principle patch: %w", err)` before any write on failure;
5. omit an empty patch before the existing whole-override emptiness check;
6. store the structured patch only.

Update `CreateRunCommand` in the same file to pass the resolved structured list to `NewRun`. Do not modify unrelated Run cancellation code in this shared file.

- [ ] **Step 4: Regenerate bindings**

Run:

```powershell
task generate
```

Expected: generated Go/TypeScript bindings change for `Principle`, `PrinciplePatch`, `PrincipleDiagnostic`, structured profile fields, Run principles, and `principlediagnostics`.

- [ ] **Step 5: Run handler and Jarvis tests**

Run:

```powershell
go test ./pkg/wshrpc/wshserver -run 'Test(GetJarvisProfile|SetChannelProfile|CreateRun)' -count=1
go test ./pkg/jarvis ./pkg/waveobj -count=1
```

Expected: PASS.

---

### Task 5: Add pure frontend patch editing and presentation helpers

**Files:**
- Modify: `frontend/app/view/agents/profilemodel.ts`
- Modify: `frontend/app/view/agents/profilemodel.test.ts`

- [ ] **Step 1: Write failing reducer and row-mapping tests**

Use generated `Principle`, `PrinciplePatch`, and `PrincipleDiagnostic` types. Cover these actions:

```ts
type PrinciplePatchAction =
    | { type: "override"; id: string; text: string }
    | { type: "reset"; id: string }
    | { type: "disable"; id: string }
    | { type: "reenable"; id: string }
    | { type: "add"; principle: Principle }
    | { type: "update-addition"; id: string; text: string }
    | { type: "delete-addition"; id: string };
```

Tests must prove every action is immutable, preserves unrelated fields/order, removes empty maps/slices from the returned patch, and that `principleRows(global, patch, diagnostics)` maps global/modified/project/disabled/stale states without resolving policy itself.

Add dirty-state tests showing structurally empty patches compare equal to `undefined` after normalization.

- [ ] **Step 2: Run the tests and confirm the red state**

Run:

```powershell
npx vitest run frontend/app/view/agents/profilemodel.test.ts
```

Expected: compile/assertion failures because the reducer and row mapper do not exist.

- [ ] **Step 3: Implement the minimal pure helpers**

Export:

```ts
export function reducePrinciplePatch(
    patch: PrinciplePatch | undefined,
    action: PrinciplePatchAction
): PrinciplePatch | undefined;

export function principleRows(
    global: Principle[],
    patch: PrinciplePatch | undefined,
    diagnostics: PrincipleDiagnostic[]
): PrincipleRow[];
```

`PrincipleRow` is presentation state only: inherited, modified, project, disabled, plus stale diagnostics. It must not reproduce Go's effective-resolution algorithm. Keep `sectionSource` for playbook/defaults and update `isDirty` to compare normalized patches.

- [ ] **Step 4: Run the frontend model tests**

Run:

```powershell
npx vitest run frontend/app/view/agents/profilemodel.test.ts
```

Expected: PASS.

---

### Task 6: Replace the textarea with the structured principle editor

**Files:**
- Create: `frontend/app/view/agents/principleseditor.tsx`
- Modify: `frontend/app/view/agents/profilepanel.tsx`

- [ ] **Step 1: Build a controlled `PrinciplesEditor` from existing profile primitives**

Use this contract:

```tsx
type PrinciplesEditorProps = {
    global: Principle[];
    patch: PrinciplePatch | undefined;
    diagnostics: PrincipleDiagnostic[];
    onChange: (patch: PrinciplePatch | undefined) => void;
};
```

Render rows from `principleRows`:

- inherited: text, existing `Global` badge treatment, Override and Disable actions;
- modified: controlled input/textarea, `Modified` badge, native disclosure for original text, Reset action;
- project: controlled input/textarea, `Project` badge, Delete action;
- disabled: collapsed `Disabled · N` disclosure with Re-enable actions;
- stale: non-blocking warning using the existing warning/text/border tokens and a remove action routed through the reducer;
- Add principle: append `{id: `project-${crypto.randomUUID()}`, text: ""}` once, then preserve that ID through edits.

Use semantic `<button>`, `<textarea>`/`<input>`, and `<details>/<summary>` elements so keyboard behavior comes from the platform. Do not add a custom disclosure primitive or animation.

- [ ] **Step 2: Enforce the design-system rules while writing markup**

Use only existing utility/token vocabulary already present in `profilepanel.tsx` and nearby cockpit settings/profile surfaces, such as:

```tsx
className="border-edge-mid bg-surface text-primary"
className="text-secondary hover:text-primary"
className="bg-accentbg/50 text-accent-soft"
className="border-warning/40 bg-warning/10 text-warning"
```

Do not use:

```tsx
className="bg-[#...]"
style={{ color: "#..." }}
className="text-[color:...]"
```

Do not create or modify any `.scss` file. Do not add a new `--color-*` token unless execution proves an existing semantic token cannot express a required state; if that happens, stop and ask because it changes the approved design-system scope.

- [ ] **Step 3: Integrate the controlled editor into `ProfilePanel`**

Replace `PrinciplesSection` and its whole-string customize/reset logic. Pass `data.global.principles`, `draft.principles`, and `data.principlediagnostics` to `PrinciplesEditor`. Keep the panel's existing Save button as the only persistence action.

Update `overrideIsEmpty` so `principles` is empty only when additions, replacements, and disabled are all empty. Saving must send the patch as-is; it must never copy `data.resolved.principles` into the override.

Keep the current `CollapsibleRail` section ownership, spacing scale, typography, and button hierarchy. Do not restyle playbook or Run defaults.

- [ ] **Step 4: Run frontend tests and typecheck**

Run:

```powershell
npx vitest run frontend/app/view/agents/profilemodel.test.ts
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```

Expected: PASS with zero type errors.

---

### Task 7: Verify the integrated behavior and design-system compliance

**Files:**
- Verify all files changed in Tasks 1-6
- Do not create additional production files unless a failing verification requires an in-scope fix

- [ ] **Step 1: Run focused and cross-seam automated verification**

Run:

```powershell
go test ./pkg/waveobj ./pkg/jarvis ./pkg/wshrpc/wshserver -count=1
npx vitest run frontend/app/view/agents/profilemodel.test.ts
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
task generate
git diff --exit-code -- pkg/wshrpc/wshclient/wshclient.go frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts
```

Expected: all tests/typecheck pass, and the second `task generate` leaves generated bindings unchanged.

- [ ] **Step 2: Run static design-system checks on the touched frontend files**

Run:

```powershell
rg -n '#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\(|\[color:|bg-\[|text-\[|border-\[' frontend/app/view/agents/profilepanel.tsx frontend/app/view/agents/principleseditor.tsx
rg -n '\.scss|style=\{\{[^}]*color' frontend/app/view/agents/profilepanel.tsx frontend/app/view/agents/principleseditor.tsx
```

Expected: no matches introduced by this feature. Existing arbitrary non-color sizing utilities elsewhere are out of scope; do not reformat unrelated code.

- [ ] **Step 3: Perform a live CDP walkthrough when the dev app is available**

Do not start, stop, or restart Arc/wavesrv without explicit user approval. With the user's running dev app on `:9222`:

1. open a channel's Jarvis profile;
2. confirm inherited rows display as Global;
3. override one row and confirm Modified plus original comparison;
4. disable one row and confirm it moves under `Disabled · 1`;
5. add one project principle and confirm its ID remains stable while editing text;
6. save, close, reopen, and confirm the patch survives;
7. confirm a stale diagnostic is non-blocking if a stale fixture is available;
8. capture `node scripts/cdp-shot.mjs` evidence and visually compare spacing, badges, borders, typography, focus states, and colors to the existing profile panel.

If CDP is unavailable, report the visual gate as skipped; do not claim it passed.

- [ ] **Step 4: Self-review the final diff and prepare the approval gate**

Run:

```powershell
git status --short
git diff --check
git diff --stat
git diff -- pkg/waveobj pkg/jarvis pkg/wshrpc/wshrpctypes.go pkg/wshrpc/wshserver/wshserver.go frontend/app/view/agents/profilemodel.ts frontend/app/view/agents/profilemodel.test.ts frontend/app/view/agents/profilepanel.tsx frontend/app/view/agents/principleseditor.tsx
```

Confirm:

- no unrelated cancel-run or known-issues changes are included;
- no debug statements, commented-out code, or generated-file hand edits exist;
- Run snapshots are copied, not aliased;
- Gatekeeper still resolves live on each ask;
- channel meta stores only the patch;
- all frontend colors/styles use the existing design system.

Then present the scoped M/A/D file list, a brief rationale-focused summary, and the proposed message:

```text
feat(jarvis): structure profile principles
```

Ask exactly: `Awaiting approval. Proceed? (yes/no)` Do not commit or push without that approval.
