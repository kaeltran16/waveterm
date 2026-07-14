# Structured Jarvis Principles

**Date:** 2026-07-14  
**Status:** Design approved; implementation not started  
**Scope:** Jarvis profile principle model, resolution, profile editor, Run snapshots, and Gatekeeper prompt input

## 1. Problem

Jarvis principles are currently one free-text string on `JarvisProfile`. A channel either inherits that entire string or replaces it with another entire string through `ProfileOverride.Principles`.

This makes the first project-specific edit a permanent fork of the global principles. Later global improvements no longer reach that channel, and the editor cannot express the common operations cleanly: add one project rule, refine one inherited rule, or disable one inherited rule that does not apply.

The principle text is already consumed in two important places:

- a resolved snapshot is stored on each Run and injected into every phase-worker prompt;
- Gatekeeper resolves the live channel profile when classifying a new ask.

The improvement must preserve those consumption semantics while replacing whole-section string overrides with maintainable per-principle layering.

## 2. Goals

- Represent global principles as an ordered list of independently identifiable statements.
- Let a channel add project principles, replace individual global statements, and disable individual global statements.
- Continue inheriting unrelated and newly-added global principles.
- Keep resolution deterministic in Go as the single source of truth.
- Snapshot the resolved list on Run creation; do not mutate in-flight Runs when the profile changes.
- Continue using the live resolved profile for each new Gatekeeper classification.
- Preserve the effective wording of existing string-based global and project profiles during migration.

## 3. Non-goals

- Principle priorities, weights, categories, tags, or conditional policy rules.
- AI-assisted writing, automatic rewriting, or automatic principle extraction.
- Learning principles from user decisions.
- Showing which principle influenced a model decision.
- Drag ordering or arbitrary interleaving of project additions among global principles.
- An in-app editor for the global profile file.
- Changing the playbook or Run-default sections of the Jarvis profile.

## 4. Data model

### 4.1 Canonical principle

```go
type Principle struct {
    ID   string `json:"id"`
    Text string `json:"text"`
}
```

`ID` is a stable identity, not display text. Builtin and file-authored global principles must have explicit, unique IDs. Editing a principle's wording must not change its ID.

### 4.2 Project patch

```go
type PrinciplePatch struct {
    Additions   []Principle      `json:"additions,omitempty"`
    Replacements map[string]string `json:"replacements,omitempty"`
    Disabled    []string         `json:"disabled,omitempty"`
}
```

- `Additions` are project-owned principles with their own stable IDs.
- `Replacements` maps a global principle ID to project-specific wording.
- `Disabled` contains global principle IDs excluded for this project.

`JarvisProfile.Principles` becomes an ordered `[]Principle`. `ProfileOverride.Principles` becomes `*PrinciplePatch`; `nil` means there is no project patch.

The existing playbook, default mode, and plan-gate fields keep their current types and section-level replacement behavior.

## 5. Resolution

Principle resolution is a pure Go operation:

1. Validate the global list and project patch.
2. Walk global principles in their declared order.
3. Skip IDs present in `Disabled`.
4. Substitute project wording when `Replacements` contains the global ID.
5. Append project `Additions` in their stored order.

The resolver returns both the effective list and non-fatal diagnostics for stale patch entries. It does not mutate either input.

The following invariants apply:

- A disabled ID wins over a replacement for the same ID.
- An addition ID must not collide with a global ID or another addition ID.
- Replacements and disabled IDs may reference only global IDs.
- Empty IDs and blank text are invalid.
- The model never performs profile merging.

## 6. Prompt rendering and runtime semantics

The effective list is rendered into model prompts as a readable Markdown bullet list. Internal JSON is never exposed to the model.

New Runs snapshot the resolved `[]Principle` at creation. Every phase in that Run receives the same snapshot, matching the current deterministic Run behavior.

Gatekeeper continues resolving the channel's live global profile plus project patch for every new ask. A profile edit therefore affects future classifications immediately without rewriting an existing Run's worker instructions.

Disabled principles are absent from both prompt paths. Project replacements appear once, in the global principle's original position. Project additions appear after the inherited list.

## 7. Backward compatibility

Existing installations may contain:

- `jarvis-profile.json` with `principles` as a string;
- channel `jarvis:profile` meta with `principles` as a string override;
- Runs with `principles` as a string snapshot.

The backend must accept both legacy and structured JSON shapes during the transition.

- A legacy global string normalizes in memory to one principle with ID `legacy-global` and the original text unchanged.
- A legacy project string retains its old full-replacement semantics: resolution suppresses the current global list and yields one project-owned legacy principle with the original text unchanged.
- A legacy Run string normalizes to one Run-owned principle without changing the worker prompt text.
- Saving the profile through the new editor writes only the structured patch shape.

Do not split legacy text into inferred bullets. That could change meaning and violates the requirement to preserve effective wording.

Migration decoding belongs at the Go JSON/meta boundary. The frontend receives only normalized structured data.

## 8. Profile editor

Replace the Principles textarea in `profilepanel.tsx` with an ordered list.

### 8.1 Inherited global row

Each inherited row shows:

- principle text;
- a `Global` badge;
- **Override for this project**;
- **Disable for this project**.

### 8.2 Replaced row

Each replacement shows:

- editable project wording;
- a `Modified` badge;
- the original global wording in a muted expandable comparison;
- **Reset to global**.

### 8.3 Project addition

Project additions appear after inherited principles and show:

- editable wording;
- a `Project` badge;
- **Delete**.

**Add principle** appends a project-owned row. IDs are generated once when the row is created and remain stable through wording edits.

### 8.4 Disabled principles

Disabled global principles appear under a collapsed `Disabled · N` section. Each row offers **Re-enable**.

### 8.5 Saving

The editor modifies only the local project patch. Saving persists additions, replacements, and disabled IDs; it never copies the effective global list into channel meta.

The existing Save button remains the single persistence action for the whole profile panel.

## 9. Backend and RPC behavior

`GetJarvisProfileCommand` continues returning `{global, override, resolved}`, but all three principle sections use the structured shape after backend normalization. The return also includes non-fatal principle diagnostics when a stored patch references missing global IDs.

`SetChannelProfileCommand` validates the structured patch server-side before writing channel meta. Invalid external input returns a contextual error and does not partially update the profile.

An empty principle patch is omitted from the stored override. If the playbook and Run-default override sections are also empty, the `jarvis:profile` meta key is deleted as it is today.

No database migration is required because the profile remains JSON in the existing global file and channel meta.

Changing the Go wire types requires `task generate`; generated Go and TypeScript files must not be edited manually.

## 10. Errors and stale patches

- Missing or malformed global profile: log and use `BuiltinProfile`, matching current behavior.
- Duplicate or blank global IDs: treat the global structured profile as invalid and use `BuiltinProfile` rather than guessing.
- Blank project addition or replacement: reject the save.
- Addition ID collision: reject the save.
- Replacement or disabled ID missing from the current global list: ignore it during resolution and return a non-blocking stale-patch diagnostic.
- The editor surfaces stale entries and lets the user remove them; stale entries never enter prompts.
- Malformed channel meta: ignore the override, log the cause, and resolve the global profile, matching the current fail-safe behavior.

## 11. Testing

### Go

- global-only resolution preserves order;
- project additions append in stored order;
- replacement keeps the global position;
- disable removes the global principle;
- disable wins over replacement;
- unknown replacement and disabled IDs produce diagnostics and do not enter the result;
- blank/duplicate/colliding IDs and blank text are rejected;
- legacy global, project, and Run strings preserve exact effective text;
- Run creation snapshots the resolved list;
- editing a profile does not change an existing Run snapshot;
- phase prompts contain only the effective principles;
- Gatekeeper prompts omit disabled principles and include replacements/additions.

### Frontend

Pure patch helpers cover:

- Override;
- Reset to global;
- Disable;
- Re-enable;
- Add;
- Delete;
- dirty-state detection;
- stale-patch presentation mapping.

The profile panel is verified by the repository typecheck and a live CDP walkthrough: inherit global rows, override one, disable one, add one, save, reopen, and confirm the effective list survives.

## 12. Expected file areas

- `pkg/waveobj/wtype.go` — structured principle and patch wire types; Run snapshot type.
- `pkg/jarvis/profile.go` — validation, legacy normalization, resolution, diagnostics, and prompt rendering.
- `pkg/jarvis/profile_test.go` — resolver and migration tests.
- `pkg/jarvis/run.go`, `runexec.go`, and `classify.go` — consume/render the resolved list without changing their ownership boundaries.
- `pkg/wshrpc/wshrpctypes.go` and `pkg/wshrpc/wshserver/wshserver.go` — normalized get/set contracts and server-side validation.
- Generated `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, and `frontend/types/gotypes.d.ts` via `task generate`.
- `frontend/app/view/agents/profilemodel.ts` and tests — pure patch editing helpers.
- `frontend/app/view/agents/profilepanel.tsx` — structured list editor.

## 13. Acceptance criteria

1. A project can add one principle without copying or replacing the global list.
2. A project can replace or disable one inherited principle independently.
3. A later global addition appears automatically in projects that have patches.
4. New Runs snapshot the effective structured list; existing Runs remain unchanged.
5. Gatekeeper uses the latest effective list for each new ask.
6. Legacy string profiles and Run snapshots retain their effective wording.
7. Invalid or stale patch data never silently enters a model prompt.
8. The editor clearly distinguishes Global, Modified, Project, and Disabled rows.

