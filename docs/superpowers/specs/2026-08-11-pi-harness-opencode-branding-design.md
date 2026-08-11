# Pi Harness And OpenCode Branding Design

## Summary

Add Pi as a first-class Agent harness with the same cockpit capabilities as the existing fully integrated runtimes. Pi integration will use Pi's typed extension lifecycle and native versioned JSONL sessions rather than a Wave-owned shadow transcript.

Normalize OpenCode's visible product name to `OpenCode` and replace generic glyph and initial fallbacks with the official compact OpenCode mark. Pi will likewise use its official compact mark.

## Goals

- Add `pi` to harness discovery, preference, launch, consult, background worker, channel dispatch, session history, transcript, usage, and resume flows.
- Report live Pi state through a Wave-managed global Pi extension.
- Preserve Pi's native session file as the authoritative source for transcript and usage data.
- Represent Pi as waiting only during an explicit Wave ask flow.
- Display `OpenCode` consistently in all Agent surfaces.
- Use embedded official compact assets for OpenCode and Pi anywhere the cockpit renders a runtime logo.
- Keep the changes local to existing per-harness seams and make only the shared status-contract change required by Pi.

## Non-Goals

- A general harness adapter or telemetry framework.
- A Wave-owned Pi shadow transcript.
- Heuristic detection of third-party Pi permission or question extensions.
- Changes to unrelated runtime styling or cockpit layout.
- Treating `pi --no-extensions` as an error; it intentionally disables live Wave reporting.

## Runtime Catalog And Execution

The existing Go harness catalog remains the source of truth for installability and capabilities. Add a Pi specification with:

- ID: `pi`
- executable: `pi`
- display name: `Pi`
- consult support: enabled
- run-worker support: enabled

Frontend runtime unions, metadata, settings, launch controls, channel parsing, and usage presentation will accept `pi` without adding a second runtime catalog.

Pi commands will use its native CLI contract:

- interactive launch with an optional initial task: `pi [task]`
- resume a known cockpit session: `pi --session <full-session-path>`
- isolated structured consult: `pi --mode json --no-session --no-extensions <prompt>`
- persistent background worker: interactive Pi with the task as its initial positional message

Using the full session path for resume avoids partial-ID ambiguity and avoids `--session-id` creating a replacement session when the original file is unavailable.

## Live Status Extension

`wsh install-agent-hooks` will manage this global Pi extension:

```text
~/.pi/agent/extensions/waveterm-status.ts
```

The extension will be self-contained and use Pi's typed lifecycle API. It will translate events as follows:

| Pi event | Cockpit behavior |
| --- | --- |
| `session_start` | Register cwd, native transcript path, session ID, title, provider, and model; report idle |
| `session_info_changed` | Refresh title |
| `model_select` | Refresh provider and model |
| `agent_start` | Report working |
| `tool_execution_start` | Report working with concise activity detail |
| `message_end` | Refresh authoritative model and usage metadata when needed |
| `agent_settled` | Report idle after retries, compaction, and queued follow-ups have settled |
| `session_shutdown` | Flush final metadata and prevent stale working state |

The extension will not infer waiting from tool duration or names and will not register a speculative Pi question tool. When a Pi workflow explicitly invokes Wave's existing `wsh ask` integration, the runtime-neutral `agent:ask` event and frontend `withAsk` overlay represent that agent as asking until the ask is cleared. No Pi-specific status transition is required for this existing path.

Pi can be launched with `--no-extensions`; in that case native history, usage scanning, and resume remain available, but the live agent does not appear or update through the extension. Missing `wsh` likewise affects live reporting only.

## Status Contract

Pi will report through the existing `wsh agentstatus` command and general agent-status payload rather than the OpenCode-specific shadow path. That command boundary must accept:

- agent ID
- state and activity detail
- cwd
- native transcript path
- stable session ID
- title
- provider and model

The managed Pi extension will invoke `wsh agentstatus` directly. OpenCode-specific `wsh agent-hook` shadow parsing remains unchanged, and no Pi data will pass through OpenCode's shadow schema.

## Native Session Discovery

Pi sessions live under:

```text
~/.pi/agent/sessions/<encoded-cwd>/*.jsonl
```

The encoded directory name is lossy and must not be decoded. The version 3 session header is authoritative for:

- session UUID
- cwd
- timestamp
- optional parent session

The scanner will retain the full native file path for resume. It will tolerate a final partially written JSONL record but report malformed complete records with file context. An unsupported session version must be surfaced and skipped rather than interpreted as version 3.

## Transcript Projection

Pi's JSONL is an append-only tree. Transcript projection will follow `parentId` from the current leaf to construct the active branch instead of presenting append order as a linear conversation. This prevents abandoned branches from appearing in the active transcript.

The projector will map native user, assistant, tool call, and tool result content into the cockpit's existing transcript model. Compaction and branch-summary records inform context and history but are not rendered as ordinary user messages.

The implementation will not create or maintain a second transcript file.

Pi transcript consumers will request and retain the complete native JSONL while that session is open. Existing bounded tails cannot reliably reconstruct an active branch whose parent records precede the retained window. Other runtimes retain their current bounded behavior.

## Usage Aggregation

Historical usage will aggregate all billed native entries, including abandoned branches, because those tokens were consumed even when they are not part of the active transcript. Sources include:

- assistant message usage
- nested tool-result usage where present
- compaction usage
- branch-summary usage

`reasoning` is a subset of output and must not be added twice. `cacheWrite1h` is a subset of cache-write usage and must not be added twice. Provider and model remain separate dimensions, matching the current OpenCode usage model.

Live context percentage, when displayed, comes from Pi's context-usage API rather than historical token totals. A null percentage immediately after compaction is valid.

## Consult Parsing

Pi consults emit JSONL events. The parser will use completed assistant messages as the authoritative output and must not concatenate both text deltas and completed text, which would duplicate content.

The parser will:

- extract text blocks from assistant `message_end` events
- surface assistant error stop reasons and messages
- allow tool events without treating them as final text
- consider the stream complete at process exit or `agent_settled`, not `agent_end`, because retries or follow-up work may still occur

Consults use `--no-session --no-extensions` so they do not pollute session history or register as live cockpit agents.

## Identity And Assets

All visible OpenCode labels will use `OpenCode`. Internal runtime IDs and CLI commands remain lowercase `opencode`.

Official compact OpenCode and Pi marks will be stored as local frontend assets so the cockpit does not depend on remote images. Runtime logo lookup will return these assets in the same way it already handles branded runtimes. Generic diamond and `O` fallbacks will no longer appear for OpenCode in branded contexts.

The shared harness picker will render the official mark beside the product name. Existing theme tokens continue to control surrounding badge and accent colors; components will not add raw brand colors.

Canonical asset sources:

- OpenCode: `https://opencode.ai/apple-touch-icon-v3.png`
- Pi: `https://pi.dev/press-kit` and `https://pi.dev/favicon.svg`

The assets identify third-party runtimes and must not imply WaveTerm ownership or endorsement.

## Failure Behavior

- If `pi` is not on `PATH`, catalog probing reports it as unavailable using the existing harness behavior.
- If the managed extension cannot invoke `wsh`, Pi continues normally and only live cockpit reporting is absent.
- If session JSONL is partially written, preserve all complete records and retry discovery on the next scan.
- If a session version is unsupported, skip it with contextual diagnostics.
- If a referenced resume file is gone, surface the launch failure rather than creating a replacement session silently.
- If a Pi JSON consult emits an assistant error, propagate a meaningful consult error with runtime context.

## Testing

Tests will cover behavior at each existing boundary:

- harness catalog order, probing, display name, and capabilities
- Pi launch, initial-task, consult, worker, and full-path resume arguments
- channel `@pi` parsing and dispatch
- managed extension installation and lifecycle-to-status mapping
- explicit Wave ask waiting transitions
- version 3 session header parsing and cwd authority
- active-branch transcript projection with abandoned branches
- complete Pi transcript loading when active-branch parents precede the existing tail limits
- partial final records and unsupported versions
- usage aggregation across assistant, tool, compaction, and branch-summary records without double counting
- consult completion, text extraction, retries, and assistant errors
- consistent `OpenCode` labels and OpenCode/Pi runtime-logo lookup
- updated runtime-count assumptions in existing tests

Verification will run focused Go and Vitest suites, the stack-adjusted TypeScript check, and the existing CDP surface-smoke scenario. A local Pi 0.84.1 session will validate hook installation, working/idle/waiting transitions, transcript discovery, usage, and full-path resume end to end.

## Compatibility

The implementation targets Pi session format version 3 and the installed Pi 0.84.1 lifecycle contract. Version checks and fixture tests make future Pi format changes fail visibly. Existing Claude, Codex, OpenCode, and Antigravity behavior remains unchanged except for OpenCode's corrected visible identity.
