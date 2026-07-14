# New Agent task sharpening — design

**Date:** 2026-07-14
**Status:** approved (brainstorm), pending implementation plan

## Goal

Add an optional **Sharpen** action to the New Agent modal. It rewrites a rough task into a clearer,
bounded instruction before launch while preserving the user's intent and keeping launch fully manual.

This is a small capability improvement, not a planning or orchestration system. It should improve the
input given to every supported coding runtime without changing how agents launch or execute.

## Non-goals

- No repository scan, file selection, git inspection, Radar lookup, or memory lookup.
- No multi-step wizard or clarifying-question flow.
- No automatic launch or automatic replacement of the user's task.
- No Channels/Runs integration in v1.
- No prompt history, persisted sharpened-task type, or user-facing model setting.
- No automatic Sonnet fallback. A higher-cost retry is always explicit.

## Interaction

V1 changes only `NewAgentModal`.

- **Sharpen** appears beside the Task label for Claude, Codex, and Antigravity launches.
- It is hidden for Terminal and disabled when the task is empty or a request is running.
- Clicking it snapshots the current task as the undo value, then starts one fast-model request.
- A successful result replaces the textarea contents and exposes **Undo** and **Try with Sonnet**.
- Undo restores the exact pre-request task. It remains available until the user edits the result,
  starts another sharpening request, changes runtime/project, closes the modal, or launches.
- The result is ordinary editable task text. Launch uses the existing path and receives only the final
  textarea value.
- Sonnet retry uses the currently displayed task as input, snapshots it for Undo, and replaces it only
  after a successful response.

The request does not run on every edit. The user must click Sharpen or Try with Sonnet each time.

## RPC contract

Add one focused wshrpc command:

```text
SharpenTaskCommand
  input:
    task: string
    projectname: string
    runtime: "claude" | "codex" | "antigravity"
    mode: "fast" | "sonnet"
  output:
    task: string
    model: string
```

`projectname` and `runtime` are descriptive context only. Do not send the project path: it is not
needed for rewriting and would tempt future implementations to turn sharpening into a repo scan.

Use two named bounds: `MaxSharpenTaskChars = 4000` for both input and output, measured in Unicode
code points, and `SharpenTimeout = 45 * time.Second` for the CLI call. Backend validation rejects:

- blank tasks;
- unsupported runtimes or modes;
- task input above `MaxSharpenTaskChars`;
- empty or oversized model output.

Validation errors are returned normally through wshrpc. They never mutate frontend task state.

## Backend design

Keep sharpening isolated from Channels and Jarvis behavior:

- Add a small `pkg/tasksharpen` package with pure prompt construction and response normalization.
- The package depends on `pkg/consult`; `pkg/consult` remains the generic one-shot process runner.
- `SharpenTaskCommand` validates input, builds the prompt, clones the Claude `RuntimeSpec`, appends
  sharpening-only arguments, runs it with a named timeout, normalizes the result, and returns it.
- Do not modify the shared `runtimeSpecs["claude"]` value in place.

The Claude invocation adds:

```text
--model <selected model>
--tools ""
--no-session-persistence
```

`--tools ""` prevents repository access and side effects. `--no-session-persistence` prevents helper
calls from appearing as resumable Sessions. The request runs without the selected project as its
working directory and receives no channel history or operator-principles document.

Model selection is internal and deterministic:

- `fast` uses one named small-model constant. The installed Claude CLI currently advertises `fable`
  as its small-model alias; keep the value in one place so model-alias changes require one edit.
- `sonnet` uses the stable `sonnet` alias.

The API returns the selected model alias for diagnostics and optional subtle UI copy. The existing
Claude stream parser discards the init event, so v1 deliberately does not claim to return the fully
resolved model id. Users do not configure the model.

## Prompt contract

The prompt instructs the model to:

1. Preserve the original intent and every explicit constraint.
2. Never invent files, technologies, deadlines, symptoms, or product requirements.
3. Clarify the goal, relevant boundaries, and observable completion evidence when the input supports
   them.
4. Keep an already-clear task mostly unchanged.
5. Produce concise plain Markdown suitable for direct use as an agent task.
6. Return only the rewritten task—no preamble, critique, alternatives, or code fence.
7. Stay below `MaxSharpenTaskChars`.

The deterministic prompt includes only the original task, project name, and selected runtime. It does
not ask the model to plan implementation or infer repository facts.

Response normalization trims surrounding whitespace and removes one accidental outer Markdown code
fence. It does not rewrite, truncate, or otherwise reinterpret model text. An empty or oversized result
fails rather than returning a partial task.

## Frontend state

Keep request state local to `NewAgentModal`; no jotai atom or persistence is needed.

```text
idle
  -> loading(originalTask, mode)
  -> proposed(currentTask, undoTask, resolvedModel)
  -> idle after edit / context change / close / launch

loading
  -> idle with inline error on failure; textarea remains unchanged
```

Only apply a response if it still belongs to the latest request and the modal context has not changed.
Use a monotonically increasing request id or equivalent stale-response guard. This prevents a slow
response from overwriting text after the user changed project, runtime, or task.

Errors render inline near the action. Retry is explicit. There is no automatic model fallback and no
global notification for a local editing failure.

## Consequences and risks

- **Benefit:** every coding runtime receives a clearer task without changing runtime-specific launch
  behavior.
- **Token/cost control:** the call has minimal input, no tools, no repository context, no persisted
  session, and a bounded response. The small model is the default; Sonnet requires a separate click.
- **Model drift:** Claude aliases can change. One internal constant contains the fast alias; failure is
  visible and leaves the task intact.
- **Over-specification:** the prompt forbids invented requirements and asks for light edits when the
  input is already clear. The user still reviews the result before launch.
- **Process startup latency:** the existing CLI runner starts a subprocess for each request. V1 accepts
  this rather than adding a daemon or cache.

## Testing

### Go

- Prompt construction includes the original task, project name, runtime, preservation rules, and
  output-only contract.
- Prompt construction does not include a project path, channel history, or repository content.
- Model selection maps `fast` and `sonnet` to their intended aliases.
- The cloned runtime spec contains `--model`, `--tools ""`, and `--no-session-persistence` without
  mutating the shared Claude spec.
- Response normalization trims plain text, unwraps one outer code fence, and rejects blank or
  oversized output.
- Command validation rejects blank/oversized input and unsupported modes/runtimes.
- Inject the runner function in package tests so no test invokes Claude or spends tokens.
- Timeout and runner errors preserve their context for the frontend error message.

### Frontend

- Extract only state logic that benefits from deterministic tests: eligibility, stale-response
  acceptance, and Undo invalidation. Do not add a component-test framework for this feature.
- Existing New Agent launch tests continue to prove the final textarea value flows through the normal
  launch metadata path.
- Typecheck remains clean.

### Live verification

Use the Tauri dev app over CDP:

1. Empty task disables Sharpen; Terminal hides it.
2. Fast sharpening replaces a non-empty task and exposes Undo plus Try with Sonnet.
3. Undo restores the exact original text.
4. Editing or changing project/runtime invalidates Undo and ignores a stale response.
5. A simulated backend failure leaves the textarea unchanged and shows an inline error.
6. Launch after sharpening sends the displayed task through the existing launch path.
7. The helper cannot invoke tools and creates no resumable Claude session.

## Rollout

Ship New Agent only. Do not add the action to Channels/Runs until real usage shows the rewrite is useful
and the prompt contract is stable. A later integration should reuse the same RPC rather than create a
second sharpener.
