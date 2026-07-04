# Channels Runs — Piece 4 (escalation guidance) acceptance

End-to-end verification of principle-aware phase prompts + the principle-aware classifier + the
gatekeeper↔run-worker coupling, run **2026-07-05** against the live tauri dev app over CDP via
`scripts/cdp-e2e-runs-piece4.mjs`. Worker cwd was an isolated temp dir (not the repo); the worker
was killed and the channel deleted after the run.

Backend built with the Piece 4 changes (`build_time 202607050202`). Profile principles came from the
builtin fallback (`BuiltinProfile().Principles` / `DefaultPrinciples`) — no `jarvis-profile.json`
present, so principles are non-empty by default. The channel's `gatekeeper:enabled` toggle was set
**false** to prove run-worker classification is toggle-independent.

**Result: 3/3 steps passed.**

| Step | Action | Observed |
|---|---|---|
| 1 | `CreateRun{goal:"add a coupon field to checkout"}`, read phase-0 worker block `cmd:args[0]` | Prompt begins `Work by these principles:\n<DefaultPrinciples>` then `Use the superpowers:brainstorming skill …` + the goal. `Run.Principles` populated. Confirms Task 1 (snapshot) + Task 2 (prompt injection). |
| 2 | `ask` (single single-select, routine) against the worker **block** oref | `jarvis-answered`, `choice 0`, reason *"Matching the repo's existing prettier config is the conventional, reversible, DRY choice with no scope or user-facing impact."* Ask reached `Classify` (classifier-generated reason, not the pre-filter string), was auto-answered, and delivered to the live worker — with the channel toggle **off**. Confirms Task 4 (routing) + Task 3 (principle-aware). |
| 3 | `ask` (single single-select, DRY-vs-KISS fork across 3 existing call sites) against the worker block oref | `jarvis-escalation`, reason *"quick-patch-vs-clean-fix judgment call with cross-site refactor scope — exactly the principle-significant fork that needs the human."* The classifier weighed the principles and escalated rather than auto-answering. Confirms Task 3. |

Both classifier outcomes were exercised: the answer branch (step 2, with keystroke delivery to the
live worker) and the escalate branch (step 3). Every classifier reason string explicitly cited the
resolved principles (DRY, reversibility, scope, quick-patch-vs-clean-fix), confirming the principles
section reached the model.

## Notes / harness constraints surfaced

- **The classifier is a live LLM call — its answer/escalate verdict is nondeterministic.** The
  "quick patch vs. clean fix" fork escalated in most runs, but a weakly-framed variant ("add a null
  check here" vs "refactor the validation path" on *nascent* code) was auto-answered once, the model
  reasoning via KISS/YAGNI that the minimal fix was correct and a refactor of new code was premature —
  itself a principle-grounded decision. The step-3 question was strengthened to a genuine DRY-vs-KISS
  conflict across **existing** code (no "premature/nascent" escape), which escalates reliably. Takeaway:
  principle-significance must be a real, unresolvable judgment for the classifier to defer; a fork with
  an obviously-minimal option gets auto-answered (correctly).

- **The routine auto-answer branch requires the ask to be delivered to a live worker block.**
  `handleAsk` only posts `jarvis-answered` when `DeliverAnswer` succeeds (`delivered==true`); a routine
  verdict whose delivery fails posts no card. The driver therefore injects asks against the worker's
  **block** oref (`DeliverAnswer` keys on the pending ask's block id) with the worker still running.
  This mirrors the Piece 1 keystroke-delivery constraint (`deliver.go`/`encode.go`).

- **`jarvis-answered` card text does not echo the question** (it reads `Answered → "<label>" — <reason>`);
  only `jarvis-escalation` text does. The driver matches posted cards on the `question` field of the
  card `Data` payload (`JarvisCardData`) so both branches are detected, and uses `card.choice`
  (present ⇒ auto-answered, absent ⇒ escalation) to distinguish them.
