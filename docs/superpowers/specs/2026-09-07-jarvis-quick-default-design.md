# Jarvis: ordinary-agent launch default

## Decision

New top-level launches default to the existing Quick mode: one worker, no mandatory plan, review gate, lead triage, or DAG. Saved channel strategies must not silently select pipeline or orchestrator. The user approved this behavior; existing runs and saved settings remain untouched.

Reuse Quick rather than adding a classifier or changing adaptive-lead prompts. Merely changing the orchestrator prompt retains the unnecessary lead contract; preserving saved strategy defaults leaves the reported problem in configured channels.

## Behavior and scope

- Initialize and reset the channel launch composer to Quick. Asynchronous profile loading must not switch it to a heavier mode.
- Keep pipeline and orchestrator as explicit per-launch selections, including the existing engine/adaptive choice and route selection.
- Default top-level run creation to Quick when the request omits mode, covering non-composer callers such as Radar. Explicit request modes retain their existing semantics.
- Keep child-run inheritance separate: this change must not silently alter an orchestrator's explicitly delegated child execution policy.
- Pass orchestration and worker-route options only when the effective submitted mode is orchestrator, not when a stale picker value says orchestrator but an @quick command overrides it.
- Review launch descriptions and other top-level entry points for claims that a bare launch inherits channel strategy; align the active paths with the new behavior.
- Preserve existing validation, route-error handling, draft retention, principles, evidence, and completion behavior.

## Non-goals

No new classifier, automatic engine promotion, scheduler fixes, new execution mode, saved-profile migration, or change to running agents. Ordinary workers can use their existing tools and ask for consequential decisions; no new escalation subsystem is introduced.

## Verification

Behavioral tests must cover omitted top-level mode with pipeline/orchestrator profiles selecting Quick; explicit modes remaining honored; composer initialization/reset and late profile loading preserving Quick; @quick excluding orchestrator-only options; and child inheritance retaining its prior behavior. Run relevant Go and frontend tests, TypeScript checking with the repository's larger stack, and inspect the diff. If a live UI check is unavailable, report that explicitly.
