# Design brief — Live worker visibility in the Runs view

**One line:** When you start a "run" in a channel, you currently can't tell what the
agent workers are actually *doing*. This feature surfaces each worker's live
activity — narration, tool actions, and task progress — inside the Runs view itself,
so you can watch a run without leaving it.

---

## Product context (what a "run" is)

Wave/Arc is an agent-cockpit terminal. A **channel** is a workspace tied to a code
project. Inside a channel you can start a **run**: give a goal (e.g. "Add live worker
visibility to Runs"), and the manager agent ("Jarvis") drives it through a sequence of
**phases** (e.g. Plan → Implement → Verify) executed by one or more **workers** (headless
Claude/Codex agent processes).

Two run modes:
- **Pipeline** — a fixed playbook of phases with optional human **review gates** (approve
  before the next phase runs). Each phase may run in a fresh worker (context cleared).
- **Orchestrator** — a single **lead** worker that itself spawns **subagents** (via its
  Task tool) to do sub-work; the lead resumes in place.

The Runs view today (top → bottom):
1. **Run tabs** — one tab per run in the channel, "+ New run".
2. **Run header** — status pill (planning / awaiting-review / executing / blocked / done /
   failed / cancelled) + the goal, plus Steer / Pause controls.
3. **Compact stepper ("Playbook")** — a horizontal row of phase nodes (○ pending, ● running,
   ✓ done, ! blocked, ✕ failed, – skipped).
4. **Phase rail** — a vertical timeline; each phase is a numbered node connected by a spine,
   with the phase name, state, any skill/artifacts, and **worker rows** for that phase.
   Special cards render on a phase: review gate, "worker exited / blocked", inline ask,
   "worker starting…", and a "done · all phases complete" ship marker.
5. **Start-run composer** — text box: "Give Jarvis a goal to start a run…".
6. **Right-side ProfilePanel** — Jarvis's profile drawer (already occupies the right edge).

## The problem

A worker row today shows **only** a colored state dot + the worker name + its static task
+ an "open ↗" link. To see what a worker is doing you must click "open ↗", which navigates
you *away* to that worker's raw terminal. Inside the Runs view, a running phase is just a
pulsing dot — no sense of progress, current action, or whether it's stuck. User's words:
**"more visibility, I have no idea what it's doing."**

Meanwhile the app *already has* rich live data for these workers (the Agents tab renders a
full live feed per agent) — the Runs view simply discards it.

## The job to be done

While a run executes, let me answer at a glance, without leaving the Runs view:
- What is this worker doing **right now**?
- What has it done **recently** (last few steps)?
- How far along is it (task progress)?
- Is it **stuck / waiting on me / crashed**, vs. just quietly working?

## Content available to display (all real, already streamed per worker)

Each live worker is keyed by a tab id; a per-worker transcript stream provides:

- **Identity:** worker name; runtime brand (Claude / Codex / Antigravity → brand-logo
  avatar); short model label (e.g. "opus", "sonnet"); elapsed time (working) or blocked
  duration (asking).
- **Current activity line** — a single live narration string ("now: …").
- **Live timeline** — an ordered feed of:
  - **assistant messages** (prose the agent writes),
  - **tool actions** — a verb + target + outcome (ok/fail) + optional summary
    ("14 matches", "80 lines", "24 passing") and rich, expandable detail:
    - grep (match locations + code),
    - read (file snippet),
    - bash (command + output + exit code),
    - skill (name + args),
    - edit (per-file diff: path, M/A badge, +adds/−dels, changed lines),
  - **slash commands / skills** invoked,
  - **compaction** events (context was summarized).
  - Consecutive tool actions fold into collapsible **bursts** (3+); runs of edits
    aggregate into an **edit burst** with total +/−. There's a "quiet" cue when no new
    narration has arrived for ~45s.
- **Task progress** — the latest TodoWrite checklist → done / total / percent.
- **Usage** (optional) — context window %, cost, plan rate-limit.
- **Ask** (when the worker escalates a question) — structured questions + options that
  render an inline answer picker so you can unblock it without leaving.

## States the design must cover

| State | Meaning | Needs |
|---|---|---|
| **starting** | worker spawned, no status yet | brief "starting…" placeholder |
| **working** | actively reasoning/acting | the live feed (this is the core state) |
| **quiet** | working but silent >45s | subtle "still working" cue, not alarming |
| **asking** | escalated a question to the human | inline answer UI (amber/attention) |
| **blocked** | worker exited mid-phase | recovery affordances (take control / cancel) |
| **done / ship** | phase or whole run complete | success marker; feed becomes history |
| **gone** | finished worker, kept for history | de-emphasized / collapsible |

Also design for: **multiple workers in one phase**; an **orchestrator lead with nested
subagents** (subagents shown under the lead, each with its own type/model/state);
**finished phases** whose feed is now history you can still expand.

## Layout candidates (the open design question)

All three show the *same* content; they differ in where the detail lives. They're
combinable (A or B could also carry C's one-line rollup in the header).

- **A · Inline in the phase rail** — the running phase's worker row expands in place:
  current line + recent actions + model/elapsed + task progress. Detail sits on the phase.
  Trade-off: rows get tall; needs a collapse toggle; multiple workers compound height.
- **B · Side activity panel** — phase rail stays compact (dots + names); a panel shows the
  *selected* worker's fuller timeline (like a mini Agents-tab card). Most room for detail.
  Trade-off: competes with the existing right-side ProfilePanel for space.
- **C · Header rollup line** — one live "what's happening now" line under the run header;
  rail stays dots-only. Simplest, best at-a-glance. Trade-off: weakest for orchestrator
  runs with several workers/subagents (loses per-worker detail).

## Visual system / constraints

- **Dark cockpit UI.** Monospace for meta/labels/glyphs, system-ui for names & titles.
- **Color is semantic and token-driven** — success = green, asking = amber, error/blocked
  = red, muted = grey, accent = periwinkle/blue. (No raw hex; the app uses Tailwind
  `@theme` tokens. Designs should map to those roles, not invent new colors.)
- **Reuse existing atoms:** worker rows, brand-logo avatars, small uppercase tags, the
  answer-picker bar, and the phase-node glyphs (○ ● ✓ ! ✕ –) all already exist. The
  **Agents-tab live card is the reference** for how a worker feed already reads — this
  feature should feel like a compact sibling of it, not a new language.
- Keep it legible at a glance and calm while streaming (no strobing as new lines arrive).

## Out of scope (do not design here)

The Runs view's disabled controls (Edit plan, Re-dispatch, Pause), run archive/delete/
history, the start-run composer, and any run-engine/back-end behavior. This feature is
**observability only** — surfacing activity that already exists.

---

## Design decisions (design-tool intake)

Answers given to the design intake, biased toward the one job: *"is it stuck, or
working — what's it doing right now?"*

1. **Layout candidate(s):** **A + C combined** — A (inline in the phase rail) makes a
   running phase self-explanatory and reuses the existing rail structure; C's one-line
   header rollup adds at-a-glance "what's happening now" for multi-worker/orchestrator
   runs. B (side panel) is not primary — the right edge already holds the Jarvis
   ProfilePanel, which it would fight for space.
2. **Options this turn:** **2 side by side** — A+C (primary) vs B (the one genuinely
   different alternative). A-alone / C-alone aren't worth separate studies.
3. **Main scenario:** **Pipeline run, single worker actively working** (the core case);
   multiple-workers and orchestrator become smaller state studies.
4. **State studies:** **asking** (amber + inline answer picker), **blocked** (red
   recovery card), **quiet >45s** (the "still working, not stuck" cue), **done/ship**
   (feed → history). Skip *starting* and *gone* (low design value).
5. **Live-feed detail per row:** **Medium** — summarized tool actions (grep/read/bash)
   that expand on demand. Minimal is too thin to tell you what it's doing; Full
   (diffs/bursts) blows up row height, worst for layout A. Full is the ceiling, not the
   default.
6. **Where it lives:** **New turn (Turn 3) at the top of `Wave-runs.dc.html`**, existing
   turns untouched — keeps the Runs design history in one versioned comp.
7. **What's driving it:** the anxiety is binary — stuck vs. working — so a steady,
   non-strobing feed and the quiet cue matter more than density. **Calm while streaming**
   = new lines append without layout jumps, the current-activity line updates *in place*
   (not push-down), and tool-action bursts collapse rather than flood. It should read as
   a **compact sibling of the Agents-tab live card**, not a new visual language — reuse
   the existing brand-logo avatars, semantic `@theme` color roles (green=working,
   amber=asking, red=blocked), and phase glyphs (○ ● ✓ ! ✕). Honor two structural facts:
   the right edge already has the Jarvis **ProfilePanel** (layout B must reconcile with
   it), and **orchestrator subagents nest under their lead** worker, not as peers.
