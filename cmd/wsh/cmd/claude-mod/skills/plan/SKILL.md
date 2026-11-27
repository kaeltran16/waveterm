---
name: plan
description: Use to turn a spec, a design or a settled request into an implementation plan, before touching code. Writes the plan an Arc run executes, in the engine's plan format, with tasks as vertical slices that state what to build, what blocks each, acceptance criteria, the files each owns and the interfaces others rely on.
---

# Plan

Break a spec, design or conversation into a plan an Arc run executes: numbered tasks, each a tracer-bullet
vertical slice that declares the tasks that **block** it. The engine runs every task whose blockers are done
at the same time, each in its own worktree with a fresh worker, then reviews and merges it.

A plan records the decisions a worker cannot make alone: what each task delivers, how it is accepted, which
files it owns and the names other tasks rely on. It is not the code. A worker writes the implementation and
picks its own test cases, red-green, at the public seam the acceptance criteria imply.

**In a run** (you are its lead), the prompt gives the plan format, where to save the plan and how to submit
it; follow it where it differs from this skill. **Outside a run**, the plan format is the one
`wsh jarvis dag submit --help` prints (in Arc's repo also `docs/orchestrator-guide.md`, "The plan format"),
except its sentence on naming the focused tests in a task step: a task here lists no tests. Save the plan to
`docs/superpowers/plans/YYYY-MM-DD-<topic>.md`; the user starts it with `wsh runs start --plan <path>`.

## Process

### 1. Gather context

Work from what is already in the conversation. If you are given a spec path or a reference, read its full
text. The spec is the authority: copy the values it pins (names, limits, wording it fixes) exactly.

### 2. Explore the codebase

Read the code the work touches, enough to name each task's files and the interfaces between tasks. Use the
project's own vocabulary in titles and criteria, and respect its recorded decisions (`AGENTS.md`,
`CLAUDE.md`, ADRs).

Look for a prefactor that makes the work easier: "Make the change easy, then make the easy change." A
prefactor is its own first task.

For every symbol whose signature, type shape or name a task changes, grep its references across the repo,
tests and scripts included, and put each file that must change on that task's Files line.

### 3. Draft vertical slices

<vertical-slice-rules>

- Each slice cuts a narrow but COMPLETE path through every layer it needs (schema, API, UI, tests): vertical,
  NOT a horizontal slice of one layer
- A completed slice is verifiable on its own: its tests pass and the project's checks stay green
- Each slice fits in a single fresh context window
- Any prefactoring is done first

</vertical-slice-rules>

Give each task its **blocking edges**: the tasks that must complete before it can start. Make a task wait
only when it truly builds on another's output, since the edges set how many tasks run at once. When several
tasks build on one interface whose implementation is long, land the interface first as its own small task,
so the implementation and its users run beside each other.

Two tasks that can run at the same time never list the same file: give the file to one of them, or put an
edge between them.

**Wide refactors are the exception to vertical slicing.** A wide refactor is one mechanical change (rename a
column, retype a shared symbol) whose blast radius fans across the whole codebase, so no vertical slice can
land green. Sequence it as **expand-contract**: first add the new form beside the old so nothing breaks; then
migrate the callers in batches sized by blast radius (per package, per directory), each batch its own task
blocked by the expand; finally delete the old form in a task blocked by every batch.

### 4. Check the breakdown with the user

Outside a run, present the breakdown as a numbered list before writing the plan. For each task: its title,
what blocks it, and what it delivers end to end. Ask whether the granularity is right, whether each edge
gates a task that genuinely needs it, and whether any task should be merged or split. Iterate until the user
approves. In a run, ask only when the prompt tells you to or when you are genuinely unsure, through the ask
path it gives you.

### 5. Write the plan

The header lines go before the first task: the Spec the plan implements, and the Verify, Check, Setup and
Final commands the format describes (in a run, the prompt says which this project uses). Then one task per
slice, in dependency order (blockers first):

```markdown
### Task N: <title>
**Depends on:** none | Task 1 (<what this task uses from it>), Task 3
**Files:** `<path>`, `<another path>`

**What to build:** the end-to-end behaviour this task makes work, from its user's perspective (a person, or
the code that calls it), not a layer-by-layer implementation list. Name the design decisions the spec leaves
to this task, with the one it takes. A decision fills what the spec leaves open; it never narrows,
approximates or postpones what the spec settled. When a settled requirement costs more than it looks worth,
the task builds it anyway, or you ask the user before planning around it.

**Interfaces:** the exact names, signatures, wire fields or table columns another task relies on. Only when
another task uses them.

**Acceptance:**
- each criterion is behaviour a test can check through a public seam the task implies, with the spec's exact
  values
- for a task that adds or changes a rendered view, a visual state or an interaction: the scenario step that
  shows it
```

The Depends on and Files lines go directly under the heading, as the format requires. The Files line lists
every file the task creates, edits or deletes, generated files and the tests and callers it breaks included.

No step lists, no listed tests and no implementation code. A code block belongs in a task only for a decision
prose cannot pin as precisely (a state machine, a schema, a type shape), trimmed to the decision.

## Self-review

Before you hand the plan over, read the spec again beside it and fix what you find inline:

1. **Coverage:** every requirement in the spec has a task whose acceptance criteria would fail without it.
   **Fidelity:** no decision in the header or a task weakens one: shown on a subset of the cases, checked
   lazily instead of when it happens, folded or dropped input, a check moved off the server. Each one found
   is built as the spec says, or asked.
2. **Criteria:** every criterion is checkable by a test; "works correctly", "handles edge cases" and "TBD"
   decide nothing. Every UI task names its scenario step.
3. **Interfaces:** a name or signature used in one task matches the task that defines it.
4. **Edges and files:** no two tasks that can run at once list the same file, and every edge between tasks
   that share no file says what it uses.
5. **Proportion:** a plan longer than the code it describes has written the code instead. Cut it back to
   decisions.
