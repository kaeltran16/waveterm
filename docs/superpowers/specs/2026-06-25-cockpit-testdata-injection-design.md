# Cockpit test-data injection — design

**Date:** 2026-06-25
**Status:** design (awaiting review)
**Companion spec:** `2026-06-25-cockpit-handoff-parity-design.md` (the visual work this verifies)

## Problem

Iterating on the cockpit UI requires a populated roster in many states (asking / working /
idle, multi-question asks, subagents, usage). Today the only fake roster is `mockagents.ts`: a
static `AgentVM[]` gated by a compile-time `USE_MOCK_AGENTS = false` constant — you must edit
code and rebuild to use it, and it bypasses the live rendering path entirely.

We want two complementary mechanisms (user chose **both**):

1. **Runtime FE mock** — fast, no backend, no rebuild. The primary tool for eyeballing the
   visual pass. A script writes a fixture; reload shows it.
2. **Live-pipeline injector** — drives the *real* path (`agent:status` events, ask routing,
   transcript streaming) end-to-end, for confidence that the production wiring renders.

### How the data paths actually work (grounding)

- **Live roster** (`liveagents.ts`): `liveAgentBaseAtom` iterates rows from
  `sessionSidebarViewModelAtom` that have a `termBlockOref`, joins each with
  `getAgentStatusAtom(oref)` (set by `agent:status` wave-events), `getAgentUsageAtom`, and
  `getAgentAskAtom`. **Key constraint:** an agent only appears if a real block exists in the
  session sidebar — publishing `agent:status` for an unknown oref renders nothing.
- **Reporters** publish via `wsh agentstatus` (→ `agent:status` event,
  `cmd/wsh/cmd/wshcmd-agentstatus.go`) and `wsh ask` (→ `AskCommand`, `wshcmd-ask.go`), each
  scoped to a block oref. `wsh -b block:<oref> …` targets an arbitrary block (verified:
  `resolveBlockArg` accepts a full ORef). `wsh` only connects when it has the `WAVETERM`
  socket/token — i.e. it must run from inside a Wave terminal (or with `WAVETERM_*` env set).

## Goals

- A single set of **fixture scenarios** that is the source of truth for *both* mechanisms.
- **Runtime mock:** a dev-only switch (no rebuild, no devtools) + a generator script.
- **Live injector:** a script that creates/targets real blocks and animates them as agents.

## Non-goals

- Shipping any of this in a production build (everything is `import.meta.env.DEV`-gated or a
  dev-only script).
- Replacing `mockagents.ts` semantics for unit tests (those stay as-is).

## Architecture

### Shared fixture scenarios (single source)

`scripts/cockpit-fixtures/scenarios.mjs` — exports named scenarios, each an array of plain
agent records shaped like `AgentVM` (mirrors `mockagents.ts`): `id, name, task, state, model,
blockId, usage, previousInfo[], ask{questions[], replySuggestions?[]}, idleSince/activeMs`.

Scenarios:
- `mixed` (default) — a handful of asking (incl. multi-question + multi-select), working, and
  idle (in-grace + parked) agents across 2–3 projects.
- `all-asking` — every agent asking (stress the answer flow + amber chrome).
- `heavy` — many agents, long narration, subagents, high usage (stress layout + scroll).
- `empty` — no agents (the empty state).

These records drive the FE mock directly, and the injector's `agentstatus`/`ask` payloads.

### Mechanism 1 — Runtime FE mock

**Switch (Tauri-friendly, no devtools):** the model, in dev only, fetches
`/cockpit-fixtures/active.json` on boot. If present and non-empty → use it as the roster; if
absent → live path. Reload (`Ctrl+R`) applies. This avoids the Tauri no-devtools problem (the
window has no easy console to set `localStorage`).

- `agents.tsx` constructor: `this.agentsAtom = import.meta.env.DEV ? devRosterAtom :
  liveAgentsAtom`, where `devRosterAtom` returns the fetched fixture when loaded, else
  `liveAgentsAtom`. A boot-time loader (in `CockpitBody` or a small `devmock.ts`) fetches
  `/cockpit-fixtures/active.json`, parses, and sets a `PrimitiveAtom<AgentVM[] | null>`.
- The fetched JSON is served from `public/cockpit-fixtures/active.json` by Vite in dev.

**Generator script:** `scripts/gen-cockpit-fixtures.mjs`
- `node scripts/gen-cockpit-fixtures.mjs <scenario>` → writes that scenario to
  `public/cockpit-fixtures/active.json`. Reload → injected.
- `--clear` (or `live`) → removes `active.json`. Reload → back to the live path.
- Optional: also emit each scenario to `public/cockpit-fixtures/<name>.json` for reference.

`public/cockpit-fixtures/active.json` is git-ignored (a local dev artifact). The scenario
definitions are committed.

**Loop:** `node scripts/gen-cockpit-fixtures.mjs mixed` → reload the dev app → roster appears.

### Mechanism 2 — Live-pipeline injector

`scripts/inject-live-agents.mjs` (run from inside a Wave terminal, where `wsh` is on PATH and
authenticated). For a chosen scenario:

1. **Provision blocks** — one block per agent so each appears in the session sidebar.
   *Open question for planning:* the exact creation entry point (candidates: the same path
   `newAgentSession` uses in `cockpit-actions.ts`; a block/object service call; or a `wsh`
   subcommand). Fallback: accept existing block orefs as args (user opens N terminals; the
   script animates them).
2. **Drive status** — for each block oref: `wsh agentstatus -b block:<oref> --state
   working|waiting|idle --detail … --agent claude --model … --transcript <path>` and, for
   asking agents, pipe the scenario's questions JSON to `wsh ask -b block:<oref>`.
3. **Fake transcript** — write a small Claude-Code-format JSONL to `<path>` so the live
   streaming/narration path renders. *Open question for planning:* match the JSONL schema that
   `transcriptprojection.ts` parses.
4. **Animate (optional)** — step working→asking→idle over time to exercise transitions; usage
   deltas via `wsh agentstatus --usage …`.

**Cleanup:** clear asks (`wsh ask -b … --clear`), set idle, and remove the blocks/transcripts.

## Decisions

- **D1 — One scenario source.** Both mechanisms read `scripts/cockpit-fixtures/scenarios.mjs`.
- **D2 — File-fetch switch, not localStorage/env.** Survives the Tauri no-devtools constraint;
  the "script writes a file, you reload" loop is the literal "inject test data" the user asked
  for.
- **D3 — Dev-only.** FE mock is `import.meta.env.DEV`-gated; `active.json` is git-ignored.
- **D4 — Injector runs inside Wave.** It depends on an authenticated `wsh`; documented, not
  worked around.
- **D5 — Keep `mockagents.ts`?** Fold its roster into the `mixed` scenario and delete the
  compile-time `USE_MOCK_AGENTS` toggle (superseded), OR keep it for unit-test seeding. Lean:
  migrate its content into scenarios and remove the dead toggle. *Confirm in planning.*

## Testing

- Pure-logic: a node test that every scenario parses to valid `AgentVM` records (required
  fields, valid `state`, well-formed `ask.questions`) so a fixture can't silently break the
  grid.
- The generator and injector are dev scripts — smoke-tested by running them against `task dev`,
  not unit-tested.
- Static gates same as the companion spec (tsc / vitest / vite build).

## Open questions for planning

- Block-creation entry point for the live injector (and whether to start with the
  existing-blocks fallback to de-risk).
- The transcript JSONL schema expected by `transcriptprojection.ts`.
- D5: migrate `mockagents.ts` into scenarios vs. keep both.

## Suggested execution order (across both specs)

Mechanism 1 (runtime mock) **first** — it's how the visual pass is verified — then the
handoff-parity spec, then Mechanism 2 (live injector) for end-to-end confidence.
