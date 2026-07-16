# Jarvis (Gatekeeper tier): auto-answer routine asks, escalate genuine forks

Date: 2026-07-01
Scope: feature (a per-channel autonomy toggle + a server-side ask watcher/classifier/actuator). Spec only — hands off to writing-plans.
Related: `docs/orchestrator-roadmap.md` (Gatekeeper is the second manager tier), `docs/superpowers/specs/2026-07-01-jarvis-concierge-design.md` (the tier this builds on), `pkg/agentask` + `docs/agents/organic-ask-setup.md` (the ask/answer channel Gatekeeper reuses), `pkg/consult` (the headless-CLI exec primitive).

## Naming

**Jarvis** is the manager agent (`author:"jarvis"`). **Concierge / Gatekeeper / Delegator** are internal shorthand for what Jarvis may do at each stage (observe → answer → act). This spec builds **Jarvis at the Gatekeeper tier: read + post + answer-ask**. It adds exactly one verb over Concierge — answering a worker's ask — and nothing else.

## Problem

A channel's workers block on `AskUserQuestion` calls (surfaced today via the organic-ask hook → the Agent tab's ask-in-place row and the Channels attention dot). Every one of them requires a human to stop, read the options, and click — even when the answer is obvious ("use the existing migration", "yes, keep the current name"). The orchestrator roadmap's second cost is exactly this interrupt load. Gatekeeper attacks it: **for a channel you've explicitly trusted, it auto-answers the routine asks (visibly, on the record) and escalates only the genuine forks to you.**

It grants a single, low-blast-radius verb. It answers multiple-choice questions; it does not dispatch or steer (Delegator). It earns the answer verb only after Concierge has lived in the read-only tier.

## Decisions (locked via brainstorming, 2026-07-01)

Settled interactively; recorded so the plan doesn't relitigate them.

- **Trigger: opt-in per-channel toggle.** A `gatekeeper:enabled` flag on the channel, **off by default**. While on, Gatekeeper auto-reacts to every incoming ask on that channel's workers; while off, nothing happens. Rationale: the toggle *is* the trust gate — the human grants a specific channel autonomy once, deliberately, and it then works unattended. Not on-demand (that loses the unattended value and is just Concierge-plus); not always-on (violates the roadmap's "earn trust / lived-in" principle).
- **Commit model: auto-answer routine, post a visible record; escalate the rest.** A routine ask is answered immediately via the existing answer path, and Gatekeeper posts a `jarvis-answered` row saying what it chose and why. No per-ask countdown or confirm — that re-litigates the trust decision the toggle already made, and adds recurring latency on every routine ask for a class of asks the classifier already judged safe. The safety valve is the *escalation path*, not a delay: anything not confidently routine is escalated, never auto-answered.
- **Classifier: stateless, single model call, fails safe to escalate.** Every ask is classified fresh by one headless `claude -p` call that returns structured JSON `{action, optionId, reason}`. No persistent rules, no learning in v1. "Make-a-rule" persistence is a clean v1.1 add once real usage shows which asks recur — mirrors how Concierge deferred its auto-trigger until quality was proven.
- **Watcher lives server-side (`pkg/jarvis`), not in the frontend.** Unattended handling must not depend on a window being open or a channel view being mounted, and must not race across multiple windows. This matches the roadmap's "the manager is a server-side participant."
- **Model for judgment, code for determinism.** The model judges routine-vs-fork and picks an option; code owns the event plumbing, the channel-ownership resolution, the answer delivery, and — critically — the invariant that an unparseable or uncertain model result becomes an *escalation*, never an auto-click.
- **Claude-only**, consistent with Concierge and the agent-manager brainstorm.
- **Scope: per-channel**, consistent with Concierge. Gatekeeper only handles asks from workers *this channel* dispatched. A worker owned by no gatekeeper-enabled channel is ignored.

## What already exists (build-on, don't rebuild)

- **`AskCommand`** (`wshserver.go`) — a worker (via the PreToolUse hook → `wsh ask`) registers a `PendingAsk{AskId, BlockId, Questions}` keyed by block ORef, calls `publishAgentAsk`, and *blocks* until answered. `AgentAskClearCommand` calls the same `publishAgentAsk` with `Cleared:true`. **`publishAgentAsk` is the single choke point every ask and clear flows through** — the watcher hooks here (see below).
- **`AnswerAgentCommand{ORef, Answers}`** — looks up the pending ask, `EncodeAnswer` → keystrokes → `blockcontroller.SendInput`. **Already idempotent:** it no-ops if the ask was answered in the terminal or cleared. So Gatekeeper racing the human needs zero locking — whoever answers first wins.
- **`agentask.EncodeAnswer`** — accepts **exactly one single-select question**, answered by one option index (`AgentAnswerItem{SelectedIndexes:[]int{idx}}`); anything else (multiple questions, multi-select) returns an error. Gatekeeper inherits this hard constraint, which yields a free deterministic pre-filter.
- **`wps.Broker` routes events only to a single websocket `Client.SendEvent`** — there is *no* in-process Go-handler subscription. This is why the watcher hooks `publishAgentAsk` directly rather than "subscribing."
- **Concierge** — the `pkg/jarvis` package home, the `JarvisRow` rendering + jarvis message plumbing, and the dispatch/directive reforef-resolution pattern (`buildFleetSnapshot`). Gatekeeper depends on Concierge being shipped.

## Architecture / data flow (Approach A — server-side watcher)

```
worker calls AskUserQuestion ─▶ ask-hook ─▶ wsh ask ─▶ AskCommand
   registers PendingAsk{oref}, publishAgentAsk(...), BLOCKS
                                    │
        publishAgentAsk hook ─▶ jarvis.OnAgentAsk(data) ◀┘  (async goroutine)
                                    │  not Cleared? (dedupe by askId)
        resolve oref ─▶ owning gatekeeper-enabled channel (scan reforefs)
                                    │  none ⇒ ignore
        PRE-FILTER (code): len(questions)!=1 || MultiSelect ⇒ escalate (no model call)
                                    ▼  single single-select question
        classify: consult.Run(claude, channel.ProjectPath, classifyPrompt)
           → parse JSON → GatekeeperDecision{action, optionIndex, reason}
              │  (fail-safe: parse/timeout/CLI error OR index out of range ⇒ escalate)
              │                              │
       action=="answer"               action=="escalate"
              ▼                              ▼
   agentask.DeliverAnswer(oref,      post kind:"jarvis-escalation" @you
     [idx]) → delivered?             (human answers via the existing ask row)
     delivered ─▶ post                │
       kind:"jarvis-answered"         │
     not delivered (human beat        │
       it) ─▶ post nothing            ▼
              └────────────▶ channel message log (WOS live-append)
```
A `Cleared:true` event routed through the same hook cancels any in-flight classification for that `AskId`.

**Alternative rejected — Approach B (frontend-driven):** the FE already receives `Event_AgentAsk`; a FE effect could classify and call `AnswerAgentCommand`. Rejected because it only runs while the app is open on that channel and races across windows — Concierge-grade foreground behavior, not a real gatekeeper.

**Watcher attachment — hook, not subscribe.** `wps.Broker` dispatches only to a single websocket client; there is no server-side handler registration. So the watcher is a plain function, `jarvis.OnAgentAsk(baseds.AgentAskData)`, called from `publishAgentAsk` in `wshserver.go` (the one place every ask and clear is published). It spawns its own goroutine, so the publish path is never blocked. No new pubsub machinery.

## Backend — `pkg/jarvis`

`pkg/jarvis` is created here (the Concierge plan deferred it to "when Gatekeeper adds real logic"). Concierge's `JarvisCommand` may migrate into it opportunistically, but that is not required by this spec.

1. **Ask watcher** (`watcher.go`) — `OnAgentAsk(data)` called from `publishAgentAsk`. On a non-cleared ask: dedupe by `AskId` (the persisted event can re-deliver), then run resolver → flag check → pre-filter → classifier → actuator in a goroutine. A `Cleared:true` call for a tracked `AskId` cancels any in-flight classification (context cancel) and drops it from the dedupe set.
2. **Channel resolver** (`resolve.go`, pure/testable) — given the asking ORef (`tab:<id>`), find the gatekeeper-enabled channel that dispatched it by scanning channels' `dispatch`/`directive` message `RefORef`s (the Go mirror of `buildFleetSnapshot`'s resolution). No owning enabled channel → return none, watcher ignores.
3. **Deterministic pre-filter** (in the watcher) — before any model call: if `len(questions) != 1` or `questions[0].MultiSelect`, escalate immediately (these can't be delivered by `EncodeAnswer` anyway). This is the "code for determinism" boundary: the model is only ever consulted for asks that are actually auto-answerable.
4. **Classifier** (`classify.go`) — `buildClassifyPrompt(question, workerTask, recentTimeline)` composes a **JSON-only** prompt: the single question + its indexed options (index, label, description), the worker's task, and a capped recent channel timeline (cap mirrors consult). Runs `consult.Run(ctx, claudeSpec, channel.ProjectPath, prompt, …)` under the consult timeout. `parseDecision(reply)` → `GatekeeperDecision{Action string; OptionIndex int; Reason string}`.
5. **Actuator** — `action=="answer"` and `OptionIndex` in range: call `agentask.DeliverAnswer`; if it delivered, post `jarvis-answered` (author `jarvis`, text = the chosen option label + reason). `action=="escalate"` (or index out of range): post `jarvis-escalation` (author `jarvis`, text addressing `@you` with the question, options, and the fork reason).

**Shared answer function (small refactor, no new behavior).** The answer-injection core — lookup pending by ORef → `EncodeAnswer` → send keystrokes with `KeystrokeDelay` → `blockcontroller.SendInput` — is extracted from `AnswerAgentCommand` into **`agentask.DeliverAnswer(oref string, answers []baseds.AgentAnswerItem) (delivered bool, err error)`**. Both `AnswerAgentCommand` and the Gatekeeper actuator call it. It **returns whether it actually delivered** (pending existed) so the actuator only records `jarvis-answered` when Gatekeeper truly answered, not when the human beat it. `pkg/agentask` is imported only by `wshserver` today, so it can take the new `blockcontroller` dependency without a cycle. `pkg/jarvis` then depends on `agentask` + `consult` + `wstore`, never on `wshserver`.

## Backend command — the toggle

`SetChannelGatekeeperCommand{ChannelId string, Enabled bool}` — sets `channel.Meta["gatekeeper:enabled"]`, persists via wstore, and `SendWaveObjUpdate` so the FE toggle reflects state live. Regenerate bindings via `task generate` (never hand-edit `wshclientapi.ts`).

Meta key constant: `"gatekeeper:enabled"` (bool). Absent ⇒ off.

## Frontend (thin — judgment moved server-side this tier)

1. **`channelssurface.tsx` — toggle.** A switch in the channel header bound to `channel.meta["gatekeeper:enabled"]`, calling `SetChannelGatekeeperCommand`. Off-state and on-state styling via @theme tokens only. A short hint conveys what "on" means (auto-answers routine asks).
2. **`channelssurface.tsx` — row rendering.** Route two new message kinds, both reusing the Concierge `JarvisRow` treatment:
   - `jarvis-answered` — muted/confirmed tone (Gatekeeper answered on your behalf; on the record).
   - `jarvis-escalation` — amber attention tone (a fork addressed to `@you`).
   Add both to the message-map filter/route beside the Concierge `jarvis`/`jarvis-reply` kinds.

No new pure FE derivations this tier (the resolution/classification logic is Go).

## Error handling

All uncertainty resolves to **escalate** — Gatekeeper never auto-answers on doubt.

- **Ask ORef owned by no enabled channel** → silently ignore (not an error).
- **`claude` unavailable / headless failure / classify timeout** → post `jarvis-escalation` noting it could not auto-classify. Never auto-answer.
- **Malformed / non-JSON / prose-wrapped / missing `optionId`** reply → `parseDecision` returns `escalate`. The model never fails open.
- **Human answers before classification returns** → shared answer fn reports "not delivered" → actuator posts nothing (no false "I answered" record).
- **Ask cleared mid-classification** → in-flight context cancelled; no post.
- **Toggle flipped off mid-flight** → re-check the flag immediately before acting; if off, drop silently.
- **Worker resolves to `state:"gone"`** (terminal exited) → the pending ask is already gone; shared answer fn no-ops; drop.

## Testing / verification

The logic is Go this tier (inverse of Concierge's FE-heavy tests), so unit coverage is Go.

- **Go, resolver:** correct owning channel for an asking oref; dedup of a repeatedly-steered worker; a not-enabled channel is ignored; an oref owned by no channel returns none.
- **Go, pre-filter:** a multi-question ask and a multi-select ask both route to `escalate` without invoking the classifier.
- **Go, classify prompt builder:** the prompt includes every indexed option, the worker task, and the capped timeline.
- **Go, decision parser (safety-critical):** valid JSON → the decision; malformed, missing `action`, missing/non-numeric `optionIndex`, out-of-range index, prose-wrapped, and empty replies all → `escalate`.
- **Go, `agentask.DeliverAnswer`:** delivers keystrokes and returns `true` when a pending ask exists; returns `false` and sends nothing when the ask is already gone (the refactor preserves `AnswerAgentCommand`'s idempotent no-op).
- **Go, actuator:** `answer` with a live pending ask delivers and posts `jarvis-answered`; `answer` after the ask is gone posts nothing; `escalate` posts `jarvis-escalation`.
- **`consult.Run` invocation** itself is delegation → CDP-verified, not unit-tested (like Concierge's `JarvisCommand`).
- **Typecheck:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (baseline has 3 pre-existing `api.test.ts` errors).
- **CDP (live dev app):** toggle a channel on; a routine ask on one of its workers auto-answers with a visible `jarvis-answered` row and the worker resumes; a fork-shaped ask produces an amber `jarvis-escalation` `@you` row and does *not* auto-answer; toggle off → asks are untouched and answered normally by the human.

## Deferred (noted, not built)

- **Make-a-rule persistence (v1.1)** — store a per-channel rule when the human corrects/confirms a decision, then apply it deterministically. Adds a rules store + matching + management UI; wait until usage shows which asks recur. **(Reviewed 2026-07-16 — declined; revive only on evidence that asks recur. The structured-principles profile-patch system would be its store. See `docs/deferred.md`.)**
- **Propose + countdown/veto commit (v1.1)** — only if lived-in use shows the classifier is too aggressive; the toggle + escalation path is the v1 trust model. **(Reviewed 2026-07-16 — declined as net-negative vs the unattended thesis; a better fix for an over-aggressive classifier is tighter escalate criteria / an allow-deny list. See `docs/deferred.md`.)**
- **Inline-answer buttons on the escalation row** — v1 points the human at the existing ask surface (Agent-tab ask-in-place / attention dot); clickable options on the escalation row need structured option rendering and is deferred.
- **Bare-prose asks** — uncatchable (organic-ask non-goal; only explicit `AskUserQuestion` tool calls fire the hook).
- **Multi-answer** — still single-select-gated in `encode.go`; Gatekeeper answers single-select only.
- **Delegator verbs** (dispatch/steer by Jarvis), whole-fleet scope — later tiers.

## Implementation outline (writing-plans will expand)

1. Extract `agentask.DeliverAnswer` (returns delivered bool) from `AnswerAgentCommand`; `AnswerAgentCommand` calls it. Go test for delivered/not-delivered.
2. `SetChannelGatekeeperCommand` + `gatekeeper:enabled` meta key; `task generate`.
3. `pkg/jarvis` resolver (`resolve.go`) + Go tests.
4. `pkg/jarvis` classifier: prompt builder + `parseDecision` (fail-safe) + Go tests; `consult.Run` wiring.
5. `pkg/jarvis` watcher: `OnAgentAsk` hooked into `publishAgentAsk`, dedupe, flag check, pre-filter, orchestrate resolver → classifier → actuator; cancel on cleared.
6. FE: channel-header toggle (`SetChannelGatekeeperCommand`) + `jarvis-answered`/`jarvis-escalation` row rendering (@theme tokens).
7. Tests + CDP verify the auto-answer, escalate, and toggle-off paths, plus the classify-failure → escalate path.
