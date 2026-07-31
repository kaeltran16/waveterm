# Git review — UI design brief

**Date:** 2026-07-31
**Status:** Ready for visual design, with two product decisions still open (see below)
**Audience:** Claude Design
**Design target:** `wave` project, proposed file `Wave-git-review.dc.html`
**Scope:** Product and interaction design only. Not an implementation spec or plan.
**Supersedes (visually):** nothing. There is no existing design file for the Diff surface; the `wave` project's local set is `Wave-answer`, `Wave-channels-merged`, `Wave-cockpit-live`, `Wave-jarvis-consolidated`, `Wave-repo-radar`, `Wave-run-completion`, `Wave-runs`, `Wave-transcript-feed`.

## Two decisions not yet settled

Design under these assumptions and flag anywhere they bind you:

1. **Assumed: read-only review only.** No repo-mutating operations except `git fetch`. See "Deliberate non-goals" — this is the brief's most important constraint and it is not yet formally confirmed.
2. **Assumed: this grows inside the existing Diff surface**, not as a new nav-rail entry. If your composition argues strongly for its own surface, say so and why — but note the nav rail is deliberately capped so that `Ctrl+1..8` maps one-to-one onto rail entries, and a tenth entry breaks that.

## The design problem

The cockpit can show **what an agent changed**. It cannot show **what happened in a repository**.

The Diff surface answers one question: given some base commit, which files differ now. It anchors that base to an agent's session-start commit specifically so an agent's committed work stays visible instead of collapsing to nothing. That is a good answer to a narrow question.

Two questions it cannot answer at all:

1. **"What is the history here?"** Nothing in the surface calls `git log`. There is no commit list, no ordering, no authorship over time, no way to see the commit an agent actually produced as a commit. The surface's only axis is *files*; it has no *time* axis.
2. **"How does this branch differ from main?"** There is a single base-commit concept, not a two-branch comparison. You cannot see which commits exist on one branch and not the other.

Both matter for supervising agents, which is the cockpit's job. An agent works on a branch and commits; deciding whether to accept that work means seeing its commits in sequence, and seeing how the branch now stands against its base.

### The failure mode to avoid

**Becoming a Git client.** This is the single biggest risk and the reason this brief exists in narrow form.

There are two different products inside "Git UI." *Review* — history, graph, branch comparison, diff, blame — is inseparable from supervising agents. *Authoring* — staging individual lines to compose a commit, writing commit messages, interactive rebase, cherry-pick, stash juggling, publish-branch, open-a-PR — is the workflow of a human writing code by hand, which is the workflow this cockpit exists to replace.

If the mockup contains a commit-message composer, a stage-this-line gutter control, a drag-to-reorder rebase dialog, or a stash list, **it has failed** regardless of how good it looks. Name and avoid this.

## What exists today

The nav rail entry is labelled **"Diff"** (its internal surface key is `files`; ignore the mismatch, it is an implementation artifact). Implementation is `frontend/app/view/agents/filessurface.tsx` with state in `filesstore.ts`.

Current composition, verified from a captured screenshot of the running app and from the source:

- Page title `Diff` at 16px bold, with a two-item segmented control beside it: **Browse** / **Review**.
- Below it, a `Select a source` dropdown. Sources are of two kinds only: a focused **agent**, or a registered **project**.
- A left column roughly 275px wide holding the changed-file list.
- The remaining width is the diff pane. Empty state reads *"Select a file to view its changes."*
- Review mode is a distinct component and does mutate the working tree on apply.

Three scope behaviours exist, and they matter to the design because they are the real entry points:

- **Agent-scoped** — working directory resolved from the agent's transcript; diff anchored to the session-start commit.
- **Run-scoped** — anchored to a run's captured base commit; an immutable historical record.
- **Project-scoped** — the registry path is the working directory; shows the live uncommitted working-tree diff. The source comment calls this "the 'open this repo in a git client' view."

The diff itself is **not Monaco**. The surface parses unified diff text into line records and renders its own rows. Keep the existing diff pane's visual idiom unless you are deliberately proposing a change to it.

For adjacent visual language, **Radar** (`Wave-repo-radar.dc.html`, and the live surface) is the closest existing composition: page title plus status pill, a coverage checklist, a filter-chip row, a ~340px left list of items with severity tags and strength meters, and a wide right detail pane with uppercase micro-labels over evidence cards.

## The object model

What the backend can already answer cheaply, and what is new work. This should shape how ambitious each region is.

**Already available** (`pkg/gitinfo/gitinfo.go`, reachable over the existing typed RPC as `GitChangesCommand` and `GitDiffCommand`):

- Working-tree changes against a ref, with per-file add/delete counts.
- Changes between **two** refs — the aggregate file diff half of a branch comparison.
- A single file's unified diff at a ref.
- The branch list.
- **A range commit log.** `RangeLog(cwd, base, end)` shells out to `git log --pretty=format:%H%x1f%ct%x1f%s base..end` and returns hash, author timestamp and subject per commit. This means the **divergent commit lists for a branch comparison are nearly free** — two calls plus a merge-base call.

**Does not exist yet and must be added:**

- **A full history walk.** `RangeLog` covers a bounded `base..end` range only, and returns no parent links, no ref decoration, no author identity, no pagination and no filters. Parent links and ref labels are what a graph is drawn from, so the graph specifically is new work.
- **Blame / annotate.**
- **Any link from a commit back to the run or agent that produced it.** Runs already capture a base commit, so the join is possible, but nothing computes it today.

Treat the commit graph as the expensive thing it is. A design that needs commit history is fine; a design that needs commit history *plus* blame *plus* provenance joins on the same screen is proposing three new backends.

## Required design states

Produce enough states to settle the interaction, not only the ideal populated screen.

1. **Commit history, populated** — a real-shaped repository: several hundred commits, multiple active branches, merge commits, branch and tag labels attached to commits.
2. **A commit selected** — its metadata, its changed files, and one file's diff, all reachable without losing your place in the history.
3. **Branch comparison** — two branches chosen, the commits unique to each, and the aggregate file diff between them. This is one of the two features the user explicitly asked for; it deserves a first-class state, not a modal.
4. **A messy graph** — heavy parallel branching and criss-crossing merges. Show what happens when the lane count exceeds what the region can show, because in real repositories it will.
5. **A linear graph** — a repository with one branch and no merges. The graph must not look broken or wasteful when there is nothing to draw.
6. **History filtered** — by author, by path, and by free text. Show the filtered result and how the user knows a filter is active.
7. **Agent scope** — the existing "what did this agent change since session start" view, with history now available. The current capability must not regress.
8. **Run scope** — a run's immutable base-anchored record.
9. **Not a Git repository** — a legitimate, calm empty state. The selected source simply is not a repo.
10. **The Git read failed** — visually *distinct* from state 9. The app already separates these two internally because a failed call used to masquerade as "not a repo"; the design must honour that distinction.
11. **Loading** — history is paginated and can be slow on a large repository. Show the skeleton and what is interactive while it loads.
12. **Returning to the surface** — the surface unmounts when the user switches away (see Constraints). Show what the user sees on return: same commit, same scroll position, same expanded diff.
13. **Narrow window** — what collapses, and in what order.

Use believable Wave content. Fabricated commit subjects, hashes, and branch names are fine for presentation but should read as placeholders, not real project claims.

## Constraints

- **Dark mode only.** No light or Paper variant.
- **Preserve the 46px app bar and the 78px nav rail.** Do not redraw the cockpit shell; reuse it.
- **No new nav-rail entry** under the working assumption. Rail entries are capped at 8 so that `Ctrl+1..8` maps one-to-one.
- **Use the established design tokens. No raw hex.** Hardcoded colour silently opts out of runtime theming, which works by overriding the same `--color-*` custom properties. Relevant existing families: surfaces (`--color-background`, `--color-surface`, `--color-surface-raised`, `--color-surface-selected`, `--color-surface-code`), text (`--color-foreground`, `--color-ink-hi`, `--color-ink-mid`, `--color-muted`, `--color-ink-faint`), edges (`--color-border`, `--color-edge-mid`, `--color-edge-strong`, `--color-edge-faint`), accent (`--color-accent`, `--color-accentbg`), status (`--color-success`, `--color-warning`, `--color-error`), and the six-colour `--color-avatar-1..6` set.
- **Graph lane colours need care.** A token named `--color-lane` already exists and means something else — the agent-card lane fill. If lanes need their own palette, propose a distinctly named family rather than reusing or shadowing that name, and derive from the existing avatar or graph hues rather than inventing new ones.
- **I did not enumerate tokens past line 118 of `frontend/tailwindsetup.css`.** Diff add/delete colours may already have dedicated tokens; check before proposing new ones.
- **The surface unmounts when the user navigates away.** Only the Agent surface stays mounted. Any state worth preserving — selected commit, history scroll position, expanded diff, active filters — must be designed as persistent, and the design should make clear what persists and what resets.
- **Monospace for hashes, paths, branch names and refs.** The app already uses monospace for identifiers.
- **Design at the real window size.** Reference captures are roughly 1600×950 logical pixels with the 78px rail and a ~28px keyboard-hint footer. The current 275px left column is almost certainly too narrow for a commit graph — expect to change the layout, not just add a widget to it.
- **Keyboard reachability.** The app has a global palette on `Ctrl+P`, a `g`-leader chord system, and a persistent hint footer. Whatever you add should be operable without the mouse and should declare its keys.
- **Verification is by screenshot, not component test.** There are deliberately no render tests; correctness is checked by capturing the live app and comparing. Prefer compositions that are unambiguous in a still frame.

## Deliberate non-goals

Everything here is the authoring half, and all of it is out of scope:

- Staging or unstaging — no file checkboxes, no hunk buttons, no line-level gutter controls.
- Composing a commit: no message box, no amend, no co-author field.
- Interactive rebase, squash, reword, drop, cherry-pick, revert.
- Stash and unstash.
- Branch creation, deletion, rename, checkout, publish, or merge.
- Push and pull. `fetch` is the only permitted mutation, and it should be quiet.
- Conflict resolution.
- `.gitignore` editing, remote configuration, submodules, LFS, commit signing.
- Creating or reviewing GitHub pull requests.
- Light mode.
- Redrawing the cockpit shell, the app bar, or the nav rail.
- A multi-repository dashboard. Scope is one repository at a time, chosen from what the cockpit already knows about.

## Design latitude

These are genuinely open, and they are the design work.

- **How history relates to the existing Browse / Review modes.** Whether the segmented control grows, is replaced by something else, or disappears in favour of a different organising idea is unspecified. Note that a mode switch that simply renames the problem is not a solution.
- **Where the graph lives.** A column, a full pane, a collapsible strip, a background, or a device the user opens deliberately — all open. The graph is the most expensive thing to build here, so a composition that makes it *earn* its space is more valuable than one that makes it decorative.
- **How a commit, its files, and a file's diff coexist** without the user losing their position in a long history.
- **How branch comparison is entered and represented.** Two lists plus a diff is IntelliJ's answer; it is not necessarily the right one here.
- **How scope selection reads** now that a repository is a first-class subject rather than a consequence of which agent is focused. The existing source dropdown may not survive.
- **Whether a commit shows its provenance** — the run or agent that produced it — and how much that is worth, given nothing computes that join today.
- **What collapses first at narrow widths.**

Prefer the simplest composition that makes *what am I looking at, when did it happen, and how does it differ from what I expect* immediately answerable.

## Success criteria

- A user can answer "what happened in this repository recently, and who did it" without leaving the surface. Today they cannot at all.
- A user can compare two branches and see both the divergent commits and the resulting file changes.
- The existing agent-scoped and run-scoped review capability is visibly intact, not regressed.
- The graph is legible in the messy-repository state at the real window width. If it is only legible in the tidy example, it has failed.
- Nothing on screen invites the user to author a commit.
- "Not a repository" and "the Git read failed" are clearly different experiences.
- Returning to the surface returns you to where you were.
- The interface remains recognisably Wave, and specifically does not read as an embedded third-party Git client.

## Deliverable

A desktop-first interactive design in the `wave` project, proposed as `Wave-git-review.dc.html`, covering the required states above. Include concise interaction annotations wherever a static frame would be ambiguous — particularly around what persists across surface switches, and what each keyboard affordance does. Reuse the existing Wave design system and cockpit shell.

Existing local references in the `wave` project: `Wave-repo-radar.dc.html` (closest compositional relative), `Wave-cockpit-live.dc.html` (shell, app bar, nav rail, hint footer), `Wave-runs.dc.html`, `Wave-jarvis-consolidated.dc.html`. Token definitions live in `frontend/tailwindsetup.css` in the repository.
