# Merged Channels surface — design brief

**Status:** design handoff (build the UI). **Date:** 2026-07-13.
**Audience:** a frontend design/build agent with no access to the originating conversation. Everything needed is here.

---

## 1. One-line goal

Collapse the Channels tab's **Chat｜Runs** split into a **single surface where "a channel *is* its runs."** Delete the chat message stream. Re-home the few things that only lived in Chat into Runs-native affordances. The result: one paradigm, one composer, one place attention lands.

---

## 2. Why (the problem being fixed)

Today `frontend/app/view/agents/channelssurface.tsx` hosts a channel as **two parallel worlds joined by a header toggle**:

- **Chat** — a Slack-style avatar'd message stream. You type `@claude do X` (dispatch a worker), `@name …` (steer a live worker), `ask @codex …` (one-shot consult), `@jarvis` (fleet summary). Autonomy tiers concierge/gatekeeper/delegator.
- **Runs** (`runssurface.tsx`) — structured multi-phase runs: a run strip, a phase rail, review gates, worker cards. Modes pipeline/orchestrator.

The two never reference each other (a `@claude` dispatch never becomes a Run; a Run never posts to Chat), "how autonomous is Jarvis" is expressed twice, and an item that needs the user can surface in *either* tab. **In practice the Chat side goes unused and reads as the wrong UI** — a conversational metaphor for what is really launch-and-monitor work. So Chat goes away; Runs becomes the whole surface.

---

## 3. What to build — the merged surface

Transform `channelssurface.tsx` into a single, no-toggle surface. Column layout (left→right):

```
┌ NavRail ┬ Channel rail ┬────────── Main (Runs) ──────────┬ Context panel ┐
│ (icons) │ per-project  │  header  · autonomy toggle · ⚙  │  Needs you    │
│         │ channels     │  overview/notes strip (collapse)│  Consults     │
│         │ + New channel│  run strip: [run][run][+ New]   │  Fleet        │
│         │              │  phase rail / orchestrator body │               │
│         │              │  ───────────────────────────────│               │
│         │              │  composer (two faces)           │               │
└─────────┴──────────────┴─────────────────────────────────┴───────────────┘
```

### 3.1 Channel rail — KEEP as-is
Existing `channelrail.tsx` (list of project-bound channels + "New channel"). No change beyond removing any Chat-specific affordances if present.

### 3.2 Header
- `#<channel name>` + project path (existing).
- **Autonomy toggle** (replaces the 3-segment concierge/gatekeeper/delegator control). A single switch:
  - **`Observing`** (off) — Jarvis stays hands-off; every worker ask routes to you (Needs you).
  - **`Handling asks`** (on) — Jarvis auto-answers routine asks and escalates the genuine forks to Needs you.
  - **Wiring:** call the *existing* `SetChannelTierCommand` with `tier: "gatekeeper"` (on) / `"concierge"` (off). **No backend change.** `delegator` is simply no longer offered from the UI (backend still supports it; harmless). Rationale: the composer's Pipeline/Orchestrator modes already *are* delegation, and `concierge` was never a capability — just the floor with both autonomy flags off.
- `⚙` opens the existing profile drawer (`profilepanel.tsx`).

### 3.3 Overview / notes strip — collapsible, below header, collapsed by default
Holds the two "observational" capabilities: free-text channel **notes**, and an on-demand **Jarvis summary** of the fleet (labelled "Jarvis summary"; button → existing `JarvisCommand`, streams a summary; not gated by the autonomy toggle). Keep it quiet — one line when collapsed (e.g. `Overview & notes · 2 runs`). The context panel's separate **"Fleet here"** roster is a distinct thing (live worker list, not a narrative).

### 3.4 Run strip — KEEP
Existing run tabs (one per run in `channel.runs`) + "+ New run". Selecting "+ New run" puts the composer in its **launch face** (see 3.6).

### 3.5 Run body — EXTRACT from `RunsView` (do **not** reuse it whole)
The phase rail (pipeline) and orchestrator body from `runssurface.tsx` are the run body, and their internals must be preserved as-is — they are the working heart of the surface. **But `RunsView` is not a clean body component.** It also renders its own run strip, its own new-run composer, an inline steer composer (inside `RunHeader`), and `ProfilePanel` as a permanent sibling column — every one of which the merged surface wants to own itself (single run strip §3.4, single two-face composer §3.6, profile behind ⚙ §3.2, right column = Needs you/Consults/Fleet §3.7). So the merge **extracts the inner run body** — `RunHeader` (minus its steer composer) + `RunRollup` + `CompactStepper` + `PhaseRail` + `OrchestratorBody` + the gate/ask/blocked cards — into a `RunBody` component that takes the selected `run` as a prop, and the merged `ChannelsSurface` owns the surrounding chrome. Do not redesign the phase-rail internals; only lift them out of `RunsView`'s shell.

### 3.6 Composer — TWO FACES, driven by context (the key idea)
One composer at the bottom. Its identity flips based on what the user is looking at:

- **Launch face** — when on "+ New run" / a channel with no live worker in view. A **plain goal input with typed `@`-commands** (no visible button picker):
  - Commands: **`@quick`** (one worker, no phases) · **`@run`** (a managed run using the channel's strategy) · **`@ask`** (one-shot consult, no worker). Typing `@` opens an autocomplete listing the three with one-line descriptions — this is how the modes stay discoverable without buttons. A **bare goal with no command defaults to `@run`.**
  - `@run`'s strategy — pipeline-vs-orchestrator (+ plan gate) — is **not** part of the command; it is the channel's ⚙ setting (`defaultmode`/`defaultplangate` in the Jarvis profile), surfaced in the footer (e.g. "→ pipeline run · stops at a review gate · set in ⚙").
  - `@ask` uses the channel's default consult runtime; `@ask codex <q>` overrides it. Placeholder: `Give Jarvis a goal…`.
  - The open-ended `@runtime`/`@name` chat incantations stay gone (decisions #8/#12) — this is a curated three-command vocabulary, not free mentions, and it makes the composer stylistically match the `Ctrl+P` palette (both goal-plus-command driven).
- **Talk face** — when viewing a run whose current phase has a **live worker**. A plain message box addressed to *that worker*:
  - Placeholder: `Message <worker>…`. **No mode picker.**
  - Sending injects the text into that worker as a follow-up turn (the behavior formerly called "Steer" — now unnamed, because a text box next to an agent you're watching is universally assumed to talk to it).
  - Wiring reuses the existing `steerWorker` transport (`ControllerInputCommand` to the worker's block).
- **Rules that keep the two faces unambiguous:**
  - The composer must always visibly show *who it addresses* (placeholder + a small addressee label).
  - "+ New run" (and `Ctrl+P`, built separately) is always one action away to break out of Talk and Launch a new run.
  - After a Talk send, keep Talk; after a Launch, reset the mode to the launch default.
  - A run has **at most one live worker at a time** (phases are sequential), so "the worker in view" is never ambiguous within a run.

Build on `composer-shell.tsx` (`ComposerShell`) for the input chrome.

### 3.7 Context panel — REWORK (existing `CollapsibleRail`)
Three sections:
- **Needs you** — a *unified* attention list: review gates + Jarvis escalations + live-worker asks, all in one place (today they scatter across Chat cards and the phase rail). Reuse `attentioncard.tsx` (`AttentionCard`/`AttentionBanner`) styling and the derivations in `jarviscards.ts` (`pendingAsks`, `escalationPending`) + `runmodel.ts` (`reviewGate`).
- **Consults** — results of **Ask**-mode consults as compact cards (runtime name + question + answer), with a "Dispatch ↗" to promote a consult into a run. This is where `ask @runtime` output goes instead of into a chat stream.
- **Fleet** — workers dispatched here + working/waiting counts (existing `buildFleetSnapshot`/`fleetCounts`).

---

## 4. Capability re-homing (the four things Chat uniquely held)

All four are **kept** — only their container changes:

| Capability (was in Chat) | New home in the merged surface |
|---|---|
| One-shot consult (`ask @runtime`) | Composer **Ask** mode → results as **Consults** cards in the context panel |
| Ad-hoc dispatch (`@claude do X`) | Composer **Quick** mode (one worker) — shows in the run strip like any run |
| Jarvis autonomy control | Single header **toggle** (`Observing ⟷ Handling asks`) |
| Notes + `@jarvis` summary | Collapsible **overview strip** at the top |

---

## 5. What to remove

- The **Chat view** entirely: the message stream and all conversational rows (`ConsultRow`, `JarvisRow`, `GatekeeperRow`, `EscalationRow`, `OutcomeRow`, `MessageRow` as a feed) and the avatar/message-bubble rendering.
- The **`Chat｜Runs` toggle**.
- The **`@runtime`/`@name` chat incantations** (`@claude`, `ask @codex`, `@jarvis`, `@name`) as user-facing input. (The parsing functions may remain as internal transport if convenient.) **Note:** the composer *does* accept a small curated command vocabulary — `@quick`/`@run`/`@ask` — as the mode selector (decision #12); that is distinct from the open-ended runtime/agent mentions removed here.
- The **standalone top-level `Runs` nav destination.** Runs live inside channels now; there is no separate global Runs surface. (A cross-channel run browser, if ever wanted, is a new decision — not this.)
- **"Steer"** as a named verb: no Steer mode, no `@name` steering, no inline Steer button, no dedicated Steer control. Steering = the composer's Talk face.
- The **3-tier autonomy control** (concierge/gatekeeper/delegator segmented buttons) → the single toggle. `delegator` and the `concierge` *name* are dropped from the UI.

---

## 6. Data model facts (so you don't re-derive them)

From `pkg/waveobj/wtype.go`:
- A **`Run`** is a data object stored on the **channel** (WOS-mirrored) — `Goal`, `Mode` (`pipeline|orchestrator`), `Status`, `Phases[]`, `WorkspaceId` ("where phase-worker tabs are created"). **A run is not a tab — it owns/creates worker-tabs.**
- **`RunPhase.WorkerOrefs`** references workers by `tab:<id>`. A **worker = a tab** (agent session + terminal block, via `launchAgent`).
- `RunPhase.FreshCtx` → a fresh worker-tab per fresh-context phase. So: **Pipeline** = several tabs across its life; **Orchestrator** = one lead tab (+ in-process Task subagents, not tabs); **Quick** = one tab.
- Because phases are sequential, **a run has at most one *live* worker at a time** — the Talk-face target.

---

## 7. Out of scope for this brief

- **`Ctrl+P` fast-dispatch shortcut** — being implemented separately (extends `frontend/app/cockpit/command-palette.tsx` with launch rows). The composer stays the primary launcher; the palette is only a keyboard shortcut to the same actions. Leave composer behavior authoritative; don't duplicate its logic.
- **A true "Quick" backend Run mode.** Today `CreateRunCommand` accepts only `pipeline|orchestrator`. "Quick" currently maps to the existing dispatch path (`launchAgent` + a dispatch record), i.e. a bare worker-tab, not a `Run` object. For v1, surface Quick dispatches in the run strip as lightweight entries; a real one-phase Run mode is a **backend follow-up** (flagged, not required now).
- Backend changes generally. The autonomy toggle, consult, run creation, steer, and summary all reuse **existing** RPCs.

---

## 8. Reuse map

**Keep / build on:** `channelrail.tsx`, `runssurface.tsx` (`RunsView`), `runmodel.ts`, `composer-shell.tsx` (`ComposerShell`), `attentioncard.tsx`, `element/collapsiblerail.tsx`, `markdownmessage.tsx`, `jarviscards.ts`, `jarvisderive.ts`, `profilepanel.tsx`, `channelsstore.ts`.
**Existing actions to wire to:** `channelactions.ts` (`sendChannelMessage`, `steerWorker`), `runactions.ts` (`createRun`, `approveGate`, `sendBackGate`, `cancelRun`, `getJarvisProfile`).
**Existing RPCs (via `RpcApi`):** `SetChannelTierCommand`, `CreateRunCommand`, `ConsultCommand`, `JarvisCommand`, `AnswerAgentCommand`, `ControllerInputCommand`.

## 9. Constraints

- **Colors via `@theme` tokens only** (defined in `tailwindsetup.css`). No raw hex/rgba in markup. **No new SCSS** — Tailwind utilities; convert any touched SCSS.
- **Never hand-edit generated files** (`wshclientapi.ts`, generated Go/TS types). Edit Go + run `task generate`.
- Dark cockpit aesthetic; respect reduced-motion (reuse `motiontokens`/`cardVariants`).
- **Typecheck** with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` overflows). Baseline is clean.
- **Visual-verify** the live dev app over CDP (`node scripts/cdp-shot.mjs`) — Tauri renders in WebView2, there is no jsdom render harness.

---

## 10. Decisions log (so we don't forget)

1. **Direction:** Approach 1 — "the channel *is* Runs." One surface, no Chat｜Runs toggle. (Rejected: connecting Chat↔Runs; a Console second view; demoting Chat to a rail — all keep a version of the unused Chat.)
2. **Chat message stream removed** — the conversational UI is the wrong metaphor for launch-and-monitor work; it went unused.
3. **All four Chat-only capabilities kept**, re-homed per §4 (consult→Ask cards, ad-hoc→Quick, autonomy→toggle, notes/summary→overview strip).
4. **Autonomy simplified to one toggle** `Observing ⟷ Handling asks`. **`delegator` dropped** (composer modes are delegation). **`concierge` dropped as a name** (it was just "gatekeeper off"). Toggle → existing `SetChannelTierCommand` (`gatekeeper`/`concierge`). Placement: **header** (recommended; ⚙ drawer is an acceptable alternative). The `@jarvis` summary is **not** autonomy-gated.
5. **Composer kept** as the primary launcher; **`Ctrl+P` is only a shortcut** to the same actions (separate workstream).
6. **Composer has two context-driven faces** (§3.6): Launch (mode picker) vs Talk (message the live worker). No 5th "Steer" mode.
7. **"Steer" eliminated as a concept** — it *is* the Talk face. No `@name`, no inline button, no palette row. To steer a non-viewed worker, navigate to it and type.
8. **`@mention` incantations removed** from the user's hands. *(Amended by #12: the mode is now set by a curated typed `@`-command — `@quick`/`@run`/`@ask` — replacing the button picker; the open-ended `@runtime`/`@name` mentions stay gone.)*
9. **Data facts** recorded in §6 (run owns tabs; ≤1 live worker per run; Quick=1 tab; Pipeline=many; Orchestrator=1 lead).
10. **Deferred:** true one-phase "Quick" backend Run mode; free-text-vs-command disambiguation in the palette (`>` prefix = command search, plain text = goal).
11. **Launch modes = Quick · Run · Ask.** Pipeline & orchestrator collapse into one **Run**; the engine (pipeline|orchestrator + plan gate) is the channel's ⚙ profile setting, resolved at launch — not chosen per dispatch. Both already dispatch through the same `createRun(channelId, goal, {mode})` call. The `Ctrl+P` palette mirrors these rows — see `2026-07-13-ctrlp-fast-dispatch-spec.md`.
12. **Composer launch input = typed `@`-commands, not a button picker** (§3.6). The Launch face is a plain goal input; `@quick`/`@run`/`@ask` set the mode, `@` opens an autocomplete of the three, and a bare goal defaults to `@run`. Removes the segmented mode buttons. Discoverability comes from the `@` autocomplete. Talk face is unchanged (no commands). This is a deliberate, curated re-introduction of `@`-commands — narrower than the removed `@runtime`/`@name` mentions — and it converges the composer with the `Ctrl+P` palette's goal-plus-command model.
13. **Standalone top-level `Runs` nav destination removed** — *correction after reading the code:* the app never had a top-level `Runs` surface. `SurfaceKey` (`agents.tsx`) has no `runs` member; the nav (`navrail.tsx` `ITEMS`) is Cockpit/Agent/Channels/Radar/Sessions/Diff/Memory/Usage/Settings. The only "Runs" is the `chat｜runs` **toggle inside `ChannelsSurface`**, which the merge deletes regardless. The "Runs" nav item exists only in the mockup — claude design removes it there; **no code change is required.**
14. **Fleet naming disambiguated.** The overview-strip narrative (produced by `@jarvis`) is renamed **"Jarvis summary"**; the context-panel live roster stays **"Fleet here."** This removes the "Fleet summary" vs "Fleet here" near-collision — one is a Jarvis-authored narrative, the other a worker roster.
