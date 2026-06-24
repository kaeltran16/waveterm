# Wave — Redesign Brief

A design brief to hand to Claude. Describes what the product is and the surfaces that matter. Visual direction is intentionally open — make it your own.

## What it is

Wave is a desktop terminal that is becoming an **agent-orchestration cockpit**: a place where a developer runs and supervises many AI coding agents at once, across multiple projects, alongside a real terminal.

The terminal foundation (PTY, blocks, layout, SSH, config) is solid and not the focus. The redesign is about the **agent layer** — making it feel like a calm control room for parallel AI work rather than a wall of scrolling logs.

## Who it's for

A single power user driving 3–10 agents in parallel. They glance, triage, and intervene. They need to know at a glance: who's working, who's stuck and waiting on me, what just happened, and what's idle. Keyboard-first; the mouse is optional.

## Core experience to design

**The cockpit.** A view of all live agents grouped by state — *asking me something*, *working*, *idle*. The "asking" group is the most urgent and should pull the eye. Each agent shows what it's doing, which project, recent activity, and live usage. Selecting one focuses its transcript and lets you reply inline.

## Key surfaces

- **Agent cockpit** — the grouped, at-a-glance overview above. The heart of the app.
- **Focused agent view** — one agent's live transcript + an inline reply composer; collapses repetitive tool-call bursts so the signal stands out.
- **Subagents** — agents can spawn child agents; surface them as a nested tree under their parent (each child showing its type and working → success/failure), with click-to-open a child's live session. A child should be unmistakable from a top-level agent at a glance.
- **Activity feed** — one cross-project stream of agent events (started, finished, asked, errored) with one-click jump to the source.
- **Channel chat** — a coordination/chat surface where agents and the human share context (net-new; design from scratch).
- **Sessions & resume** — one place to browse, search, and resume past agent sessions, including a searchable history of every prompt sent across agents.
- **Agent memory** — a panel to browse, search, and edit the persistent memory agents accumulate, unified across all projects. Show it two ways: a structured list and an interactive graph of how memories connect.
- **Command palette** — keyboard-driven launcher for actions and navigation.
- **Usage** — live plan/quota gauges (5h + weekly, per provider, with reset timers).

## Feel

Dark, dense-but-calm, terminal-adjacent. Status communicated through restrained color and motion, not noise — a glance should answer "where do I need to step in?" Polished, modern developer-tool aesthetic.

## Constraints (light)

- Desktop app, dark UI.
- Don't redesign the raw terminal/PTY rendering — focus on the agent surfaces and app chrome around them.
- Everything else (layout, type, color, components, motion) is yours to define.
