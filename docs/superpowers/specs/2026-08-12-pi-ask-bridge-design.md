# Pi Ask Bridge — Design Spec (Workstream F)

> 2026-08-12. Implements Workstream F of the
> [pi-package-integration meta-spec](../../pi-package-integration-meta-spec.md): pi's ask
> tool routes through the cockpit attention list instead of pi's terminal questionnaire.
> Reads on the [Part D `pi/` package](../../superpowers/specs/2026-08-11-pi-main-harness-meta-design.md)
> (provisioning, landed `c916b808`), the [core spec](2026-08-11-pi-harness-opencode-branding-design.md)
> (waiting-state rule, in flight), and
> [organic-ask-setup.md](../../agents/organic-ask-setup.md) (the Claude Code ask protocol
> this mirrors).

## 1. Goal

When a pi agent running inside a Wave block calls its `ask_user_question` tool, the
questions surface in the cockpit attention list (the existing `agent:ask` overlay), the
human answers or dismisses there, and the tool call resumes with the answers — no
terminal questionnaire. Bare pi (outside a Wave block) fails closed with a plain-text
fallback. Claude Code's existing ask flow is untouched.

## 2. Ground truth (verified against source, 2026-08-12)

**CC flow today:** `wsh ask` (PreToolUse hook, `cmd/wsh/cmd/wshcmd-ask.go`) unwraps the
CC hook envelope (`tool_input`) from stdin, registers a pending ask keyed by the block
ORef (`pkg/agentask`), and returns an AskId (fire-and-forget, 5s RPC timeout).
Answers arrive via `AnswerAgentCommand` → `DeliverAnswer` (`pkg/agentask/deliver.go`),
which `Claim`s the pending ask (atomic, idempotent — stale AskId is a no-op) and injects
keystrokes into the block PTY to drive CC's native picker (`pkg/agentask/encode.go`).
`wsh ask --clear` (PostToolUse) drops the pending ask and publishes the cleared event.
The Gatekeeper (server-side auto-answer) calls `DeliverAnswer` directly.

**pi side:** pi 0.84.1 has no built-in ask tool; the rpiv-ask-user-question package
(`~/.pi/agent/npm/node_modules/@juicesharp/rpiv-ask-user-question`) is the template — a
`pi.registerTool` extension that renders a blocking TUI questionnaire via
`ctx.ui.custom()` and returns `{content:[{type:"text",text}], details:{answers,
cancelled}}` (`tool/response-envelope.ts`). Canonical constants: 1–4 questions, 2–4
options, header ≤16 chars, label ≤60 chars (`tool/types.ts`).

**Constraints that shape this design:**

- `pi.exec(command, args, options)` uses `stdio: ["ignore", "pipe", "pipe"]`
  (`dist/core/exec.js`) — **stdin is ignored**, so the tool payload cannot be piped; it
  travels as an argv flag (`--questions-json`). Real asks (~2–4KB) are far under the 32K
  Windows argv ceiling.
- pi resolves duplicate tool names **first-registration-wins** across extensions
  (`dist/core/extensions/runner.js` `getAllRegisteredTools`), and loads
  **project-local `.pi/extensions/` → global `~/.pi/agent/extensions/` → configured
  paths (settings.packages)** in that order (`dist/core/extensions/loader.js`
  `discoverAndLoadExtensions`). Arc's installed global extension therefore shadows the
  rpiv package's `ask_user_question` wherever both exist — the "replaces terminal
  rendering in-arc" goal falls out of load order, no configuration needed.
- The wshrpc ask model (`pkg/wshrpc/wshrpctypes_ask.go`, `pkg/baseds/baseds.go:127`)
  has **no preview field** on `AgentAskOption` (CC parity), and the cockpit answer
  surface (`frontend/app/view/agents/answerbar.tsx`) has **no dismiss control** — both
  are additions in this spec.
- The core spec's waiting-state rule (2026-08-11, §goals) already covers pi: the
  runtime-neutral `agent:ask` event + frontend withAsk overlay represent the agent as
  asking. **No pi-specific status work** in F.

## 3. Locked decisions (2026-08-12)

| Decision | Choice | Rationale |
|---|---|---|
| Tool name | `ask_user_question` (canonical) | Arc's global-extension copy loads before packages, so first-wins shadowing gives the replacement behavior; rpiv stays reachable in bare pi |
| Previews | **carry end-to-end** | `preview` on options flows through wshrpc → generated bindings → answerbar side-by-side layout (rpiv rule: single-select only) |
| Cockpit cancel | **dismiss button** on the answer surface | Clears the panel via `AgentAskClearCommand`; a pi waiter resolves as cancelled; CC's terminal picker is unaffected |
| Wait-mode delivery | **waiter registry consulted inside `DeliverAnswer`** | Single delivery decision point preserves claim/idempotence; Gatekeeper deliveries resolve waiters too (it calls `DeliverAnswer`) |
| Payload transport | `--questions-json <inline>` argv flag | `pi.exec` stdin is ignored; CC keeps stdin |
| Wait timeout | fixed 30m RPC timeout | Long enough for a human; the tool's abort path covers cancel |

## 4. Backend — waiter registry in `pkg/agentask`

New `Waiters` registry (AskId → `chan WaitResult`, buffered size 1, non-blocking
resolve so a double-resolve is a no-op). `WaitResult = {Answers []baseds.AgentAnswerItem,
Cancelled bool}`.

- `AskCommand` handler (`pkg/wshrpc/wshserver/wshserver_ask.go`): when `data.Wait`, in
  addition to the existing register + publish, register the waiter and **block** on
  `select { answers <- waiter; ctx.Done() }`. On `ctx.Done()` (wsh client killed — pi
  tool aborted, pi session closed): drop the pending ask and publish the cleared event
  so the attention list never shows a stale ask for a dead agent.
- `DeliverAnswer` (`pkg/agentask/deliver.go`): after `Claim` succeeds (semantics
  unchanged — exactly one deliverer, stale AskId no-ops), look up the waiter by the
  claimed `PendingAsk.AskId`. Waiter present → resolve it, **no keystrokes** (a pi
  session has no native picker to drive). No waiter → existing keystroke path (CC).
  `EncodeAnswer`/`KeystrokeDelay` untouched.
- `AgentAskClearCommand` (`pkg/wshrpc/wshserver/wshserver_ask.go`): in addition to the
  existing drop + publish, resolve any waiter for the pending AskId as
  `{cancelled: true}`. For CC this path is unchanged in effect (PostToolUse clears after
  the answer was already claimed; the waiter lookup is a miss).
- Frontend `AnswerAgentCommand` (`frontend/app/view/agents/agents.tsx:198`) and the
  Gatekeeper need no changes — both already call the two entry points above.

## 5. wshrpc + CLI

`pkg/wshrpc/wshrpctypes_ask.go`:

- `CommandAskData` + `Wait bool json:"wait,omitempty"`
- `AskRtnData` + `Answers []baseds.AgentAnswerItem json:"answers,omitempty"`,
  `Cancelled bool json:"cancelled,omitempty"`

Then `task generate` (wshrpc domain change → regenerated `wshclientapi.ts`,
`gotypes.d.ts`, `wshclient.go`).

`cmd/wsh/cmd/wshcmd-ask.go`:

- `--wait` flag: RPC timeout `30 * time.Minute` (vs the current 5000ms); on return,
  print `{"answers":[…],"cancelled":true|false}` as JSON on stdout; exit 0 for both
  answered and cancelled (cancelled is a legitimate outcome, not an error), non-zero on
  RPC failure (fail-closed degradation).
- `--questions-json <payload>` flag: parse the inline container through the existing
  `parseAskQuestions` (which also still unwraps the CC envelope for the stdin path —
  harmless for the flag path). When the flag is set, stdin is not read.
- `--clear` unchanged.

## 6. Frontend — previews + dismiss

**Preview end-to-end:**

- `pkg/baseds/baseds.go` `AgentAskOption` + `Preview string json:"preview,omitempty"`
  (flows through the regenerated bindings; `AgentAskData` untouched otherwise).
- `frontend/app/view/agents/agentsviewmodel.ts` `AgentAskOption` + `preview?: string`.
- `frontend/app/view/agents/answerbar.tsx` `QuestionGroup`: when any option in a
  **single-select** question has a preview, render the rpiv layout — vertical option
  list on the left, markdown preview panel on the right (`MarkdownMessage`, the
  cockpit's block renderer from `markdownmessage.tsx`; boxed, monospace for ASCII
  mockups). The preview panel shows the option that is hovered or keyboard-focused
  (`onFocus`/`onMouseEnter`), defaulting to the first option until then. Multi-select
  questions never render previews (rpiv rule); label/description/recommended-badge
  behavior unchanged.

**Dismiss button:**

- `AnswerBar` gains an `onDismiss?: () => void` prop; rendered as a small dismiss
  control beside the answer band. Callers wire it to
  `RpcApi.AgentAskClearCommand(TabRpcClient, agent.ask.oref)`.
- Both AnswerBar call sites get it: `frontend/app/view/agents/agentrow.tsx` (agent card
  answer band) and `frontend/app/view/agents/channelsprimitives.tsx` (Channels ask
  rows).
- Behavior: dismissing clears the panel copy (the published cleared event nulls the ask
  in `frontend/app/view/agents/agentaskstore.ts:33`). For a pi ask the waiter resolves
  cancelled and the tool returns the decline envelope. For a CC ask the terminal picker
  remains open (the hook already returned; the user can still answer there) — the
  dismiss is cosmetic for CC, which is acceptable and useful (unclutter).

## 7. Pi extension + provisioning

`pi/extensions/waveterm-ask.ts` — registers `ask_user_question` (rpiv-compatible
`QuestionParamsSchema` shape including `preview`; adapted promptSnippet/promptGuidelines
stating questions surface in the Wave Agents panel, previews are single-select only).
`execute`: build the payload via the core module → `pi.exec(wshPath, ["ask", "--wait",
"--questions-json", payload], {signal})` → parse stdout → rpiv-shaped envelope. Failure
modes mirror `waveterm-tools.ts`'s fail-closed pattern: not in a Wave block / RPC error
→ error text telling the model to ask the questions as plain chat text instead;
`signal` abort (user Esc's the tool call) → killed child → cancelled envelope
("User declined to answer questions", `{answers: [], cancelled: true}`).

`pi/extensions/waveterm-ask-core.ts` — pure functions, vitest-tested beside the file
(pattern: `waveterm-tools-core.ts` + its `.test.ts`):

- `buildAskPayload(questions)` → `{questions:[{question, header, multiSelect, options:
  [{label, description, preview}]}]}`
- `parseAskResult(stdout)` → `{answers, cancelled}` (validates shape; malformed → error)
- `envelopeFromResult(result, questions)` → the rpiv-shaped `{content, details}` with
  the canonical answered/declined text (`tool/response-envelope.ts` shapes: "User has
  answered your questions: …" / "User declined to answer questions").

Provisioning (Part D pattern):

- `Taskfile.yml` `sync:piartifacts` + `cp pi/extensions/waveterm-ask.ts
  cmd/wsh/cmd/pi-ask-extension.ts` (+ `waveterm-ask-core.ts` →
  `cmd/wsh/cmd/pi-ask-core-extension.ts`).
- `cmd/wsh/cmd/wshcmd-installhooks.go` + `installPiAskExtension` (idempotent rewrite
  with `__WSH_PATH__` substitution, status-extension pattern), called from
  `installAgentHooksRun`.
- `pi/package.json` `pi.extensions` + `"./extensions/waveterm-ask.ts"` and
  `"./extensions/waveterm-ask-core.ts"`.

## 8. Out of scope

- Preview panels in the CC/terminal flow (CC has no preview field; the field is
  cosmetic there).
- A cockpit "ask again" / re-ask affordance after dismissal.
- pi task writing, subagent execution, control channel, wave tools — owned by other
  workstreams (E, Part B).
- Changing the CC keystroke-injection path in any way.

## 9. Testing

- Go (`pkg/agentask/deliver_test.go` pattern + `pkg/wshrpc/wshserver`):
  - DeliverAnswer resolves a waiter without keystrokes when one is registered; falls
    back to keystrokes when none (CC path regression guard).
  - Claim semantics preserved: stale AskId no-op, concurrent deliveries single-winner.
  - `AgentAskClearCommand` resolves a waiter as cancelled; no waiter → unchanged.
  - AskCommand wait: ctx cancel drops the pending ask and publishes the cleared event.
- TS: `pi/extensions/waveterm-ask-core.test.ts` (payload build, result parse, envelope
  text incl. cancelled).
- Visual (repo convention — no jsdom render tests): preview side-by-side layout and the
  dismiss control via `task verify:ui` (contact sheet in `cdp-shots/index.html`).
- Live round-trip (needs `task dev` + a pi session in a Wave block): ask → answer in
  the panel → tool resumes with answers; dismiss → declined envelope; Esc abort →
  declined envelope; both rpiv + arc installed → arc's tool wins; bare pi → plain-text
  fallback.

## 10. Sequencing

1. Backend: waiter registry + `DeliverAnswer`/`AgentAskClearCommand`/`AskCommand`
   changes, wshrpc types, `task generate`, `wsh ask --wait/--questions-json`, Go tests.
2. Frontend: preview end-to-end (baseds → bindings → VM → answerbar) + dismiss button
   on both surfaces.
3. Pi extension + provisioning (`waveterm-ask*.ts`, sync:piartifacts, installhooks,
   package.json) + core-module tests.
4. Verification suite + live round-trip; then the plan folds into one commit per
   AGENTS.md.
