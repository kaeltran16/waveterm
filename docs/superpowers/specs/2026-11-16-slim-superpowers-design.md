# Slim the orchestrator's superpowers dependency

## Intent

Arc's orchestrator runs on two upstream superpowers skills (brainstorming for the design session, writing-plans
for the lead) and loads the whole plugin into every session it starts. Engine sessions carry the
using-superpowers text but almost never call a skill (203 of 203 run sessions injected, 10 Skill calls, all from
leads or design). Specs (median 1,661 words, p90 2,902) and plans (median 3,252, p90 7,861) balloon. Arc
should own the skills it runs on, merged from superpowers and Matt Pocock's skills, stop tracking either
upstream, and turn superpowers off.

## Goals

- Engine sessions (workers, task reviewers, plan review, final verify) stop loading superpowers now.
- Arc owns its design skill and its plan skills; superpowers is turned off once they exist.
- Specs and plans get shorter without losing quality.
- A fair answer to whether the ticket-shaped arc:plan beats writing-plans.

## Non-goals

- Porting executing-plans or any other superpowers skill: in the last 30 days only brainstorming (114),
  writing-plans (109) and executing-plans (15) were invoked, and plans here are executed by runs.
- Tracking future upstream changes to superpowers or Matt's skills.
- Renaming the `.superpowers/` and `docs/superpowers/` paths.

## Approaches

For the design skill:

- **Arc protocol as the spine, interview rules and size step borrowed** (chosen). Arc's brainstorm skill
  already overrides most of superpowers (playback, recon, approaches via the judge, builder check), so it
  becomes the body and only the still-unique interview rules come in.
- Superpowers' flow trimmed with grilling's design tree: two spines in one file, each defining playback,
  approaches and spec rules.
- Superpowers copied verbatim with the overlay folded in: brings nothing from grilling and keeps every rule the
  overlay cancels.
- Grilling's rounds in the pane: the pane holds one open question, and grilling's sub-agent fact dispatch
  conflicts with the user's rule that subagents need approval.

For keeping specs short: a content rule with the size step (chosen); the same plus a word cap in the check; a
fixed template with a cap; the builder check flagging padding.

## Decisions

1. **Engine sessions without superpowers, now.** Claude launches for workers, task reviewers, and the plan
   review and final verify stage sessions get a per-launch settings override that disables the superpowers
   plugin. It is part of the resume arguments, so a resumed session keeps it. The lead, the design session and
   the interrupted-run relaunch are untouched. A probe on claude 2.1.325 confirmed the override removes the
   plugin, its 15 skills and its session-start injection (~1.3k tokens per session). The override is deleted
   in the change that turns superpowers off.
2. **Arc's own design skill.** Arc's brainstorm skill stops being an overlay on superpowers brainstorming and
   becomes the skill itself. Its existing protocol (the brainstorm file, the lines Arc sends, the judge, the
   builder check) is the body. One short interview section is added, drawn from both upstreams: ask why first,
   look before asking, one question per turn, pick the next question from a design tree of decisions whose
   prerequisites are settled, finding facts is the agent's job, and superpowers' size step (a small change
   gets a short design, a project the full design). The size step only sets how long the spec is: every
   design still goes through the builder check, so the pane does not change.
   Agent's call: the existing rule that an open request opens on a directions question stays, as the exception
   to "ask why first"; why-first applies to a request whose goal is settled.
   Agent's call: the skill stays Arc-only. A session outside Arc has no design skill once superpowers is off;
   the user works through Arc.
3. **Short specs by content, not by cap.** The skill's spec rule: decisions are written in final form with one
   line of why; no file paths, code snippets, commit refs, change history, or builder-question and
   Agent's-call markers; background notes and rejected approaches stay in the brainstorm file. With the size
   step, that is the whole mechanism: no word cap in the check.
4. **Tests in the spec.** A spec names a test seam only where the design itself chose one. There is no default
   testing section. Test cases are settled at run time by the worker, then the lead on doubt.
5. **arc:plan.** An Arc-owned plan skill adapted from Matt Pocock's to-tickets (MIT), writing the engine's plan
   format. Each task is a vertical slice: what to build, what blocks it, acceptance criteria, plus Arc's
   must-haves (owned files, interfaces other tasks rely on, the scenario step for UI). No step lists and no
   listed tests: the lead prompt drops its complete-code override and "the focused tests that prove them".
   The worker picks its test cases red-green at the public seam the criteria imply (behaviour through the
   public interface, mocks only at system boundaries, no tautological expected values) and asks the lead
   through the existing worker-question path only when the seam is unclear, such as needing a new public
   interface. The task reviewer judges tests against the criteria and the seam.
   Agent's call: to-tickets is taken from the latest mattpocock/skills at build time; grilling's text from the
   installed copy. Either is a one-time snapshot.
6. **Both plan skills, chosen in Settings.** Arc keeps its own copy of writing-plans (MIT, notice kept) beside
   arc:plan, and a setting on the Settings surface picks the lead's plan skill. arc:plan is the default.
   Neither is deleted after the bench. The setting switches the whole plan contract, not only the skill name:
   writing-plans brings today's plan format, complete-code override, worker brief and task-review brief;
   arc:plan brings the new ones (Decision 5). Agent's call: the setting is the default for new runs, and a run records
   the plan skill it started with, so a lead started partway through (after design approval, a sent-back plan
   review or an interrupted relaunch) keeps that run's skill, and two runs can use different skills at once.
7. **Superpowers off.** Once Arc's design skill, arc:plan and the writing-plans copy exist, superpowers is
   turned off for every session, the user's own included. arc:plan serves the user's own planning too.
8. **Bench after a couple of weeks.** arc:plan is used for a couple of weeks first and adjusted from what is
   seen. Then two things:
   - A comparison of those real runs against earlier writing-plans runs on cost by role, time, rework and
     Final, reported only.
   - A replay bench that decides: 3 shipped specs, each replayed from its pre-feature commit in a worktree
     under both plan skills on the same build. Route pinned (no reviewer-picks), autonomous, same parallelism.
     Metrics: usage by role, time, plan words, tasks and width, plan-review rounds, worker asks, review fails,
     fix rounds, Final, mutation score on changed files, and a blind pairwise review of the two diffs against
     the spec.
9. **The bench rule, fixed before running.** The bench sets the default plan skill; both stay selectable.
   arc:plan stays the default only if it wins the blind review on at least 2 of the 3 pairs, and Final pass
   rate, mutation score and rework are each no worse. Shorter plans or lower cost alone are not enough; a tie
   makes writing-plans the default.

   Agent's call: the bench and its tooling are not part of this work; they get their own plan once the weeks
   of use are done. This work lands in two parts: the engine override (Decision 1) first and alone, then the
   skills, the setting and superpowers off.
10. **pi.** A pi lead no longer needs the superpowers package once arc:plan and Arc's design skill replace the
    upstream skills; the orchestrator guide's pi requirement is updated.

## Constraints

- Both upstreams are MIT; copied text keeps its notice.
- Arc's brainstorm pane shows one open question at a time.
- The skill sources are copied into the wsh build and the agent harnesses; edit the sources and re-sync.
- Arc code that names the upstream skills by name: the design-session prompt, the agent hook that reveals the
  brainstorm pane when the skill starts, the brainstorm skill's own trigger description, the lead prompt's
  plan step, the waveobj Skill example, and the orchestrator guide.

## Left to the builder

- The merged skill's exact interview wording.
- arc:plan's ticket wording and its mapping onto the plan format; the writing-plans copy kept as close to
  7.0.2 as the plan format allows.
- The plan-skill setting's key and its place on the Settings surface.
- Re-pointing everything that names the upstream skills (Constraints).
- Turning superpowers off: the user disables the plugin in their Claude settings; the same change deletes the
  engine override.
- The bench's own plan, later: mutation setup (Stryker and the Go overlay mutator), the replay harness, the
  blind pairwise review prompt, and the real-run comparison query.
