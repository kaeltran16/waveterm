# Harness-neutral background agents

## Context

Arc supports several installed coding-agent harnesses, but some background flows still select Claude Code without an explicit user choice:

- Run workers are hardcoded to Claude.
- Pet Errand selects the first installed consult runtime.
- Bare `@ask` defaults to Claude.
- New Agent's Sharpen action always invokes Claude, regardless of the selected launch runtime.

This behavior makes Claude a shadow default. It is especially misleading when the operator primarily uses OpenCode, Codex, or Antigravity.

## Goals

- Require a visible harness choice before starting new background agent work.
- Share one preferred harness between Run creation, Pet Errand, and bare `@ask`.
- Keep the preferred harness visible and editable until an action starts.
- Persist a Run's harness and use it for every phase and child Run.
- Preserve explicit one-off runtime overrides without mutating the preference.
- Remove Sharpen completely.
- Never silently fall back to another harness.

## Non-goals

- Changing a Run's harness after it starts.
- Moving long-lived Run workers into the one-shot consult process runner.
- Treating OpenRouter as an installed coding harness.
- Automatically ranking or selecting installed harnesses.
- Changing interactive New Agent launch behavior.

## Terminology

- **Harness**: an installed coding-agent CLI such as Claude Code, OpenCode, Codex, or Antigravity.
- **Preferred harness**: the operator's shared, visible choice for new background agent work.
- **Consult**: a one-shot answer returned by a harness without creating a Run worker.
- **Run worker**: a persistent, steerable agent tab owned by a Run phase.

The wire model continues to use the existing `runtime` identifier for compatibility with the rest of the application.

## Architecture

### Shared harness catalog

Add a small backend harness catalog as the source of truth for:

- Runtime ID
- Executable name
- Display label
- Consult capability
- Unattended Run-worker capability
- Installation probing

The catalog covers Claude Code, OpenCode, Codex, and Antigravity. OpenRouter remains an API-backed utility inference runtime inside `pkg/consult`; it is not included in harness selectors.

Expose the catalog through `ListHarnessesCommand`:

```go
type HarnessInfo struct {
	Runtime          string `json:"runtime"`
	Label            string `json:"label"`
	Installed        bool   `json:"installed"`
	Version          string `json:"version,omitempty"`
	ConsultCapable   bool   `json:"consultcapable"`
	RunWorkerCapable bool   `json:"runworkercapable"`
}
```

The RPC excludes OpenRouter. It replaces the Pet Errand-only `ListConsultRuntimesCommand`, and typed-command runtime recognition consumes the returned catalog instead of retaining a static frontend list. Installation/version probes run concurrently under one bounded request context. Dispatch validation uses executable lookup without invoking every binary's version command.

Execution remains split by lifecycle:

- `pkg/consult` owns one-shot arguments, output parsing, streaming, and process execution.
- `pkg/jarvis` owns Run-worker tab creation, unattended startup arguments, steering, status, and lifecycle.

Each execution package obtains shared identity, binary, capability, and installation information from the catalog while retaining its mode-specific adapter logic. This avoids duplicating runtime identity without forcing persistent workers through a one-shot abstraction.

### Run-worker adapter contract

A harness is marked Run-worker capable only after its adapter verifies all of these behaviors:

- Starts in an interactive, persistent terminal session with an initial prompt
- Uses a harness-specific unattended approval mode and cannot stop on an approval dialog
- Inherits the Run working directory and Wave JWT
- Accepts later steering through the existing PTY `ControllerInput` path
- Can execute the prompt's `wsh jarvis hold`, `triage`, `run`, and `complete` commands
- Uses `session:agent=<runtime>` and `session:project=<project>` tab metadata
- Publishes the runtime-specific initial working event; the existing block-controller exit path publishes idle from tab metadata

The verified launch forms are:

| Harness | Executable | Worker arguments before the prompt | Prompt transport |
|---|---|---|---|
| Claude Code | `claude` | `--dangerously-skip-permissions` | Positional initial prompt |
| Codex | `codex` | `--dangerously-bypass-approvals-and-sandbox` | Positional initial prompt in interactive mode; never `exec` |
| OpenCode | `opencode` | `--auto --prompt` | Value of `--prompt` in interactive mode; never `run` |
| Antigravity | `agy` | `--dangerously-skip-permissions -i` | Value of `-i` in interactive mode |

All adapters use `cmd:shell=false`, `cmd:jwt=true`, and the Run project path as `cmd:cwd`. Backend-published start and exit events are authoritative for roster presence; optional external hooks may enrich status but are not required to start, steer, or complete a Run.

Selecting a Run-capable harness authorizes that harness's documented unattended mode, including file edits and command execution without interactive approval. Every Run-picker row states this. Consult selection does not imply unattended worker flags.

### Preferred harness

Add one persisted setting, `harness:preferredruntime`. Both the Run composer and Pet Errand read and write it.

Add the setting to the Go settings source and constants, regenerate `schema/settings.json`, Go schema bindings, and frontend types, and expose it through the existing settings atoms.

The setting starts empty. Arc does not derive it from runtime ordering or default it to Claude. The first Run, Pet Errand, or bare `@ask` requires the operator to select a harness.

Changing the harness in either visible selector updates the shared preference immediately. It affects only future actions; it never changes an existing Run.

The picker updates a shared frontend atom immediately while the settings write is in flight, so both visible selectors stay synchronized. Run and Ask actions remain disabled until persistence succeeds. A failed settings write restores the prior selection and shows the error; it must not appear durable or affect dispatch.

### Run ownership

Add `runtime` to `CommandCreateRunData` and `waveobj.Run`.

At creation, the server validates that the runtime:

- Is known
- Supports unattended Run workers
- Is installed

The validated runtime is copied onto the Run before its first worker starts. Every phase reads the persisted Run runtime. Child Runs inherit the parent's runtime server-side, including when the child command omits one.

The runtime is immutable after Run creation. There is no in-progress selector and no worker replacement behavior.

## User Interface

### Shared picker

Create one reusable harness picker following the existing Autonomy control:

- Fixed-width chip showing the current harness
- Popover with one descriptive row per compatible harness
- Selected-row highlight and checkmark
- Installed harnesses selectable
- Unavailable harnesses visible but disabled with `not installed`
- `Choose harness` state when no preference exists

Run-capable rows disclose that the worker can edit files and run commands without approval. Consult-only presentation omits that disclosure because one-shot consults use their own mode-specific contract.

The picker derives compatibility for its operation. A harness may be available for consults but disabled for Runs if its unattended worker adapter has not been verified.

### Run composer

The picker remains visible in the launch composer footer until the Run starts. The footer order is:

1. Harness picker
2. Run behavior summary
3. Flexible space
4. File attachment
5. Run action

The Run action is disabled while no valid harness is selected. Starting the Run freezes the selected runtime on the Run. When the launch composer changes to the live worker composer, the picker disappears because the runtime is no longer editable.

### Pet Errand

Keep Pet Errand. Replace its first-installed selection with the shared picker below the input. The row contains:

1. Harness picker
2. Destination channel
3. Ask action

The Ask action is disabled while no valid consult-capable harness is selected. The selected harness remains visible before every dispatch.

### Typed commands

- A bare goal, `@run`, and `@quick` use the visible preferred harness.
- Bare `@ask` uses the preferred harness.
- `@ask <runtime> ...` is an explicit one-off override and does not change the preference.
- Bare `@ask` is blocked with a prompt to choose a harness when no preference exists.

While an explicit Ask override is present, the footer shows the effective runtime as `<Harness> · one-off` and states that the preferred harness is unchanged. Runtime recognition uses catalog IDs supplied to the parser. An unknown first token remains part of the Ask body, preserving the current free-text behavior rather than inventing an invalid-runtime syntax.

No typed-command path defaults to Claude or selects the first installed harness.

## Data Flow

### New Run

1. The Run composer reads `harness:preferredruntime`.
2. The picker updates the setting when the operator selects a harness.
3. Submit sends the selected runtime in `CommandCreateRunData`.
4. The server validates capability and installation.
5. The server persists the runtime on the Run.
6. The worker launcher resolves the Run-worker adapter for that runtime.
7. Later phases read the same persisted runtime.
8. Child Runs inherit the runtime from their parent.

### Pet Errand

1. Pet Errand reads the shared preference.
2. Submit sends that runtime to the existing consult command.
3. The server validates consult capability and installation.
4. `pkg/consult` executes the runtime's one-shot adapter.

### Bare and explicit ask

1. The parser preserves an optional explicit runtime.
2. An explicit runtime is used for that request only.
3. Without an explicit runtime, dispatch reads the shared preference.
4. Missing or invalid preference preserves the draft and attachments, opens/focuses the harness picker, and blocks dispatch; it is never replaced with Claude.

## Sharpen Removal

Remove Sharpen end-to-end:

- New Agent modal controls and state
- Sharpen RPC request and response types
- Server handler
- `pkg/tasksharpen`
- Generated frontend bindings
- Dedicated frontend and Go tests

Sharpen has no persisted domain data, so no compatibility shim or migration is required.

## Error Handling

- **Missing preference**: show `Choose harness`; disable the action and direct focus to the picker.
- **Unknown runtime**: reject server-side and include the runtime ID in the error.
- **Unsupported operation**: explain whether consult or unattended worker capability is missing.
- **Not installed**: show the saved runtime as unavailable, block the action, and require reselection.
- **Spawn failure**: use the existing Run failure surface and preserve partial Run state.
- **Consult failure**: use the existing channel or Pet Errand error surface.

No error path retries through another harness, changes the preference, or falls back to Claude.

## Legacy Runs

Existing persisted Runs do not have a runtime field. Resolve a missing runtime as Claude only for these legacy objects because Claude was their historical worker implementation.

- Define legacy deterministically as `Run.Runtime == ""`; the field uses `json:"runtime,omitempty"`.
- Label their harness `Claude · legacy` beside mode/status in the selected Run header and Run summary cards. Derive this label from the Run object, not the global `runtimeMeta` fallback.
- Existing phases may continue spawning Claude workers.
- A child created from a legacy Run persists `claude` explicitly.
- New Run creation rejects a missing runtime.

The missing field itself identifies legacy data, so no database rewrite is required. This compatibility rule does not participate in preferred-harness selection.

## Testing

### Backend

- Catalog tests cover IDs, executable lookup, capabilities, and installation states.
- Catalog RPC tests cover capability fields, OpenRouter exclusion, concurrent bounded probes, and version-free dispatch validation.
- Consult adapter tests continue to cover runtime-specific output parsing and invocation.
- Worker-launch tests verify exact command metadata, unattended flags, prompt transport, cwd, JWT, tab metadata, and runtime-specific start/exit events for Claude Code, OpenCode, Codex, and Antigravity.
- Create Run tests verify missing, unknown, unsupported, and unavailable runtime rejection.
- Run lifecycle tests verify runtime persistence across phases.
- Child Run tests verify runtime inheritance.
- Legacy tests verify missing-runtime resolution and explicit inheritance by children.
- Pet Errand and consult tests verify that execution uses the requested runtime without fallback.

### Frontend

- Pure picker tests cover empty, selected, unavailable, and operation-incompatible states.
- Composer tests verify Run, Quick, and bare Ask use the shared preference.
- Composer tests verify explicit Ask overrides are one-off.
- Composer tests verify the effective `<Harness> · one-off` presentation and that blocked dispatch preserves draft and attachments.
- Pet Errand tests verify it never chooses the first installed runtime.
- Sharpen tests and generated contracts are removed.

### Integrated verification

- Run `task generate` after removing and changing RPC and object types.
- Run focused Vitest tests for the picker model, composer command/dispatch, Pet Errand model, Run model, and Sharpen removal.
- Run Go tests for the harness catalog, consult, Jarvis Run lifecycle, and wshrpc server packages using the repository's required CGO include path.
- Run the repository's increased-stack TypeScript check.
- Add and run a focused CDP harness-picker scenario covering both picker placements, attachment-right order, missing-preference disabled state, one-off Ask presentation, and legacy labeling; also run surface-smoke.
- Search production code for Claude defaults and allow only the harness catalog, Claude-specific adapter/parser code, and the explicit legacy resolver. Specifically remove `cmd.runtime ?? "claude"`, first-installed Errand selection, `SpawnClaudeWorker`, Sharpen symbols, and missing/unknown-runtime fallbacks in `runtimeMeta` where they would hide legacy or invalid state.

## Success Criteria

- A new installation cannot start a Run, Pet Errand, or bare Ask until the operator visibly chooses a harness.
- Selecting OpenCode in either picker makes it the visible choice in both.
- A Run started with OpenCode uses OpenCode for every phase and child Run.
- Explicit `@ask codex` uses Codex once without changing the shared preference.
- Removing or uninstalling the preferred harness blocks new dispatches with a clear message.
- No new-background-work path silently invokes Claude.
- Existing Claude Runs remain operable and visibly identified as legacy.
- Sharpen no longer exists in UI, RPC, generated bindings, or backend code.
