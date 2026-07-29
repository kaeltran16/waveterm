# Using Jarvis — an end-to-end tour

A task-ordered walkthrough of the Jarvis surface. [`docs/jarvis-tab.md`](jarvis-tab.md) is the reference —
it describes what each region *is*; this describes what to *do*, in the order you would do it.

Every screenshot was driven against the **live dev app** over CDP at 1440×900 on 2026-07-29, on real data in
the dev vault: one channel (`#waveterm`) with four completed runs, 17 records, 425 graph nodes. Nothing is
mocked except the six shots labelled **fixture**, which are the dev-only fixture states.

**What this tour does not show, and why.** Five states need a live worker, and producing them means
dispatching a real agent against this repo: the composer's **Talk** face, steering a worker, an ask card
being answered, **Needs you** with a real ask, and a non-zero **Fleet**. Every screenshot below was taken
without dispatching anything. Those five are described but not pictured, and marked *not pictured*.

- [0. Before you start](#0-before-you-start)
- [1. Landing](#1-landing)
- [2. Create a channel](#2-create-a-channel)
- [3. Launch a run](#3-launch-a-run)
- [3a. Stopping things](#3a-stopping-things)
- [4. What a finished run looks like](#4-what-a-finished-run-looks-like)
- [5. Attribution — the record band](#5-attribution--the-record-band)
- [6. Autonomy](#6-autonomy)
- [7. The profile drawer](#7-the-profile-drawer)
- [8. The command palette](#8-the-command-palette)
- [9. Records — the old Tasks tab](#9-records--the-old-tasks-tab)
- [10. The graph peek](#10-the-graph-peek)
- [11. Threads — asking Jarvis](#11-threads--asking-jarvis)
- [12. Answer states](#12-answer-states)
- [13. Arriving from Radar](#13-arriving-from-radar)
- [14. Finding things](#14-finding-things)
- [15. Keyboard](#15-keyboard)
- [16. A narrow window](#16-a-narrow-window)
- [Regenerating these images](#regenerating-these-images)

---

## 0. Before you start

1. `task dev` — or `tail -f /dev/null | task dev` if you launch it headless, because a bare headless
   `task dev` dies on stdin EOF.
2. **Register a project first.** `+ Channel` has nothing to offer until one exists — Cockpit →
   `+ New project`.
3. `wsh` must be on the `PATH` of whatever shell launched the app, or workers report nothing and the
   cards stay empty.
4. Get there: `g` `c`, or `Ctrl:2`, or click **Jarvis** in the nav rail.

## 1. Landing

![The empty Stage on a fresh launch](images/jarvis-tour/01-empty-stage.png)

A fresh launch always lands here — the last subject is deliberately not persisted, because restoring one
would re-run its side effects on boot (selecting a channel is an RPC, and selecting a thread can prune the
one you left). The rail's open state *is* persisted, since it carries none. The Stage states what
the surface is for, and the rail already carries **Needs you** (*never filtered*, "All clear") before you
have selected anything: an ask that only appears once you happen to click a subject would not be an
attention channel.

The **Subjects** column is the merge of the three former nav destinations: channels grouped by project,
then `RECORDS · DOSSIERS` (the old **Tasks** tab), then `THREADS`. Marks are `#` channel, `▤` record,
`~` thread.

> The group header reads `RW-TEST-CHECKPOINT` rather than `WAVETERM` because this dev config has two
> projects registered at the same path. New duplicate registrations are now refused, but the existing one
> has to be removed by hand (Cockpit → project switcher → remove).

## 2. Create a channel

`+ Channel` is a two-step picker — pick the project, then name the channel.

![Step one: pick a project](images/jarvis-tour/02-new-channel-picker.png)

![Step two: name the channel](images/jarvis-tour/03-new-channel-name.png)

The name prefills with the project name. `Enter` or **Create** commits, **Back** returns to the project
list, `Esc` backs out of the name box.

## 3. Launch a run

Select the channel. The composer is on its **Launch** face, and the line above the box — `Talking to
Jarvis · dispatch` — is the only thing that tells you where a keystroke goes. The suffix matters: on this
face `Enter` spawns workers and spends money, while `Jarvis · consult` (what the chip reads once you type
`@ask`) and `Jarvis · this thread` only ask a question.

![A channel subject with the Launch composer](images/jarvis-tour/04-channel-launch.png)

Three things to read here:

- the footer states the channel's strategy, not a per-dispatch choice: `→ pipeline run · stops at a review
  gate · set in ⚙`;
- the hint on the right of the box is the whole vocabulary;
- the selected channel expands inline into its **run switcher** — one row per run with a status dot. This
  is the only run list; there is no run tab.

![A goal typed on the Launch face](images/jarvis-tour/05-launch-draft.png)

| Input | Result |
|---|---|
| a bare goal | managed run using the channel's `defaultmode` + `defaultplangate` |
| `@run <goal>` | the same, explicit |
| `@quick <goal>` | one worker, no phases |
| `@ask <goal>` | one-shot consult, **no run** — lands in the rail's **Consults** |
| `@ask codex <goal>` | same, runtime override (`claude` / `codex` / `antigravity`) |

`Run ⏎` or `Enter` dispatches. **Not pictured:** once the run has a live worker the composer flips itself
to the **Talk** face, the chip turns green and reads `<worker> · run <id>`, and typing injects a follow-up
turn into that worker. `＋ New run` in the Talk header breaks back to Launch under a banner — *"The run
already going keeps running — this starts a second one"* — with a `Cancel`. Also not pictured: answering an
ask card with `1`–`9` and `Enter`, and **Needs you** listing asks across every channel (one in a
Space-hidden channel still surfaces, labelled `outside focus`).

## 3a. Stopping things

The counterpart to launching, and the one thing a task-ordered tour must not omit.

**Cancel a run.** `Cancel run` sits under the phase rail on any non-terminal run. With live workers it
confirms first — *"Stop N running workers and cancel this run? Completed phases, transcripts, and
artifacts are kept."* — because silently killing running agents is never acceptable. Cancelling stops the
processes and marks the remaining phases skipped; nothing already produced is discarded. If a worker
survives the stop, a **Cancel survivors** card offers a per-worker `Stop`.

**Rename / archive / delete a channel.** Right-click any channel row in the Subjects column.
`Rename channel` edits in place (`Enter` commits, `Esc` cancels). `Archive channel` moves it to a trailing
`ARCHIVED · N` group, where the same menu offers `Unarchive`. `Delete channel` confirms first and cannot be
undone — the vault records the channel's runs produced are not touched.

Autonomy is deliberately **not** on that menu: the header ladder owns it, and a second control would be a
second source of truth.

## 4. What a finished run looks like

A completed run does **not** show the live run body. Once `status === "done"` and the evidence is sealed,
the thread renders the completion report instead: an immutable evidence snapshot (`sealed 11:08 · ev·f25e2d`),
status / runtime / duration / completed, the completion summary, **files touched** as a diff against the run
baseline, and **verification** with its pass/fail counts and the actual commands.

That is what you are looking at in the shot above, and in every channel shot in this tour.

## 5. Attribution — the record band

The band sits above the thread and never becomes a destination. Its job is making a weak inferred link
impossible to mistake for a confirmed one, so each edge chip draws its own line weight — solid = strong,
dashed = medium, dotted = weak — and labels `state · bucket`.

**Several edges** — the primary first, then the others:

![The record band with two edges](images/jarvis-tour/06-record-band-several.png)

**Expanded** — the record's own fields in a 420px scroll region, with the extra edges as one-line rows
beneath, each opening that record as a subject. Expanding never produces a tab strip, and never unmounts
the run output underneath:

![The band expanded over a run](images/jarvis-tour/07-record-band-expanded.png)

**One edge** — `🔒 <task id>` + chip + `Expand the record`:

![The record band with a single edge](images/jarvis-tour/08-record-band-one.png)

The other two cases: a record subject reads *"Selected directly from Records — no run beneath it"*, and a
thread reads `MENTIONED HERE` with the records its answers cited. A run with no attribution says *"No record
attributed to this run · 🔒 attribution is machine-maintained"* — there is nothing to click, because there
is nothing you are expected to do: the attribution lifecycle is the backend's.

Where there are several edges the collapsed row shows the primary chip and a `+N more` count; the rest are
one-line rows in the expanded panel. The row is a single control — `Tab` to it, `Enter` or `Space` to
expand.

## 6. Autonomy

Three **nested** rungs, not alternatives: delegator implies gatekeeper implies concierge. Click a rung to
set it; the lower rungs stay filled because they are implied. The dispatch mode strip
(`report` / `manage` / `fanout`) appears at **Delegator** only, because below that tier it has nothing to
act on.

![The autonomy ladder at Delegator](images/jarvis-tour/09-autonomy-delegator.png)

| Rung | Behaviour |
|---|---|
| Concierge | watches and narrates; every ask reaches you |
| Gatekeeper | + answers routine asks itself; real forks still escalate |
| Delegator | + dispatches follow-up work without asking first |

Note the header in this shot: the subject name `waveterm` is gone. That is a real layout defect, measured
below.

## 7. The profile drawer

⚙ in the channel header. It shares the right-edge slot with the context rail, which force-collapses while
the drawer is open so the two never stack. `Esc` closes it; selecting a non-channel subject closes it too.

![The profile drawer, scoped to this project](images/jarvis-tour/10-profile-drawer.png)

- **Global defaults / This project** at the top is the scope, and the **Save** button's label follows it
  (`Save` vs `Save global defaults`) — read the button before pressing it.
- **Playbook** — the ordered phases with their skills and `GATE` / `FRESH-CTX` flags.
- **Run defaults** — `pipeline` / `orchestrator` + the plan gate. This is what the Launch footer states.

Each section badges `GLOBAL` or `PROJECT`, with **customize** (copy the inherited section down into an
editable override) and **reset to global**. Save stays disabled until something is dirty.

![Principles, with per-principle override and disable](images/jarvis-tour/11-profile-principles.png)

Principles are injected into worker, orchestrator and quick prompts and into the Gatekeeper, and each one
can be overridden or disabled against the global list.

## 8. The command palette

`^P`, then type the **goal** — here the query is the goal, not a filter.

![The palette's launch rows](images/jarvis-tour/12-palette-launch.png)

`LAUNCH IN #WAVETERM` offers `↯ Quick · claude`, `▸▸ Run`, `? Ask · claude` and `? Ask · codex`, plus an
`ASK JARVIS` row that sends the same text to Jarvis instead. The footer spells out what firing the
highlighted row will do. `Quick` and `Run` both call `createRun` directly, ignoring the composer's face —
so a goal dispatched here is captured as a record like any other. The two `Ask` rows are consults and go
through `sendChannelMessage` instead.

(The `Run` row reads *"resolving channel strategy…"* when the palette opens before the channel's profile
has loaded. That is a label only: the dispatch sends no mode at all, so the server resolves the channel's
strategy whether or not the palette has finished reading it.)

## 9. Records — the old Tasks tab

A record is a *dossier* in the vault, and the `RECORDS · DOSSIERS` group is the whole of the former Tasks
list. **You never create one**: `CreateRun` captures a dossier for every run it dispatches, so records
accumulate as you work (historical runs were backfilled by the separate `cmd/jarvisbackfill`).

![A record as a subject](images/jarvis-tour/13-record-subject.png)

Reading it top to bottom:

- header — `Grounded in: this record + its runs`, absence chip `Record · not a run`. No autonomy, no ⚙;
- the record's own fields: objective, status, `confidence: med`, and the **status transitions** it allows
  (`→ active`, `→ archived`). Terminal transitions route through a confirm dialog;
- **MACHINE-MAINTAINED**, behind a 🔒 — `Acceptance`, `State`, `Blockers`, `Refs`. Agents write these; you
  cannot;
- **RECORD ACTIVITY** — *"no phases — a record does not run"* — then the runs attributed to it, then the
  append-only decision log;
- the composer retargets to `Jarvis · scoped to this record`, and the rail's Fleet becomes
  `FLEET · ON THIS RECO…` / `0 working · 1 channel` — the title truncates and the counts hold their line,
  because a clipped count would read as a smaller fleet than the real one.

`+ Add decision` is the one place you write to a record by hand:

![Appending a decision](images/jarvis-tour/14-record-decision-form.png)

A short summary (used as the filename) and a **rationale**, which is required — the submit stays disabled
until the draft validates. It is written user-attributed, committed to the vault, and never edited or
deleted afterwards.

## 10. The graph peek

The **Graph** button in the header. It is an overlay, never a destination: you enter it from an object and
leave it by opening one.

Opened from a record, it arrives already focused on that record, with the record's edges and the actions
that close the overlay onto something:

![The graph peek focused on a record](images/jarvis-tour/15-graph-peek-record.png)

Opened where nothing resolves — a thread with no attachment, an unattributed run, no subject — it says so
and offers a **node filter** rather than guessing at an id:

![The peek with nothing to focus](images/jarvis-tour/18-graph-peek-filter.png)

![Filtering nodes by name](images/jarvis-tour/19-graph-peek-search.png)

Selecting a match is enough to see it; the canvas recenters an off-screen selection. One legend only,
bottom-left, sitting with the nodes it labels. `Esc` or `Close · Esc` dismisses.

## 11. Threads — asking Jarvis

`+ Thread` gives you an `all`-scope conversation. The chip reads `Jarvis · this thread`.

![A new, unasked thread](images/jarvis-tour/16-thread-empty.png)

Click `+ Thread` three times and you still get one row: an unasked thread is a false start and is pruned
when you leave it. Nothing durable is lost, because the backend record is created by the first turn.

Off a channel, a dispatch has to be **typed** — a bare sentence is a question, not a run. An explicit
`@run` or `@quick` asks which channel to dispatch into:

![The off-channel channel picker](images/jarvis-tour/17-offchannel-channel-picker.png)

The draft and that open picker are both keyed by subject, so neither follows you to the next one.

## 12. Answer states

These six are the dev-only **fixture** states (`import.meta.env.DEV`; the fixture data leaves the
production bundle entirely). They are the fastest way to see every answer shape without a backend.

A grounded answer — working steps, prose with inline `[n]` citations, and the rail's **Sources** cards with
project, age and freshness:

![A grounded answer with sources](images/jarvis-tour/20-fixture-grounded.png)

A `[n]` only becomes a citation button when a card with that number exists; an unmatched one stays literal
text, so a citation is never fabricated.

| Fixture | What it shows |
|---|---|
| ![working](images/jarvis-tour/21-fixture-working.png) | steps streaming, no verdict yet |
| ![weak](images/jarvis-tour/22-fixture-weak.png) | `Weak grounding`, warning tone |
| ![notfound](images/jarvis-tour/23-fixture-notfound.png) | `Not found`, muted — an absence is not a warning |
| ![stale](images/jarvis-tour/24-fixture-stale.png) | freshness surfaced rather than hidden |
| ![contextual](images/jarvis-tour/25-fixture-contextual.png) | a thread attached to a source object |

There is a seventh state with no fixture, because it needs a dead backend rather than dead data: when the
query itself fails — backend down, RPC timeout at 130s, a stream that aborts mid-answer — the turn reads
`Couldn't reach Jarvis` in the **error** tone and carries a `Retry` that re-submits the same question into
the same thread. That is deliberately not `Weak grounding`: weak is a statement about the corpus, and "the
request died" is not.

`narrow` collapses the rail to its strip:

![The narrow fixture](images/jarvis-tour/26-fixture-narrow.png)

A genuinely narrow window now does the same thing on its own, and more besides — see §16.

## 13. Arriving from Radar

Jarvis is usually entered *from* an object. A Radar finding offers both directions:

![A Radar finding's actions](images/jarvis-tour/27-radar-finding-actions.png)

**Explain with Jarvis** opens the thread for that finding with the prompt pre-filled and a `This finding`
chip. Opened, not created — asking about the same object twice continues one thread:

![The thread for a Radar finding](images/jarvis-tour/28-contextual-thread.png)

**Start investigation** goes the other way: it moves the Stage to the project's channel and hands the goal
to the composer under a `From Radar` banner. Nothing dispatches until you press Start; `Discard` throws it
away:

![A Radar investigation awaiting Start](images/jarvis-tour/29-radar-run-draft.png)

| From | Button | Pre-filled prompt |
|---|---|---|
| a Radar finding | `Explain with Jarvis` | "Explain this Radar finding." |
| a Memory note | `Ask Jarvis` | "Recall decisions related to this." |
| a Run | `Ask Jarvis` | "What changed in this Run and why?" |

## 14. Finding things

Free-text filter over every subject label, across all three kinds; groups that empty out disappear.

![Filtering subjects](images/jarvis-tour/30-subject-filter.png)

The filter also reaches into **run goals**. A channel whose own name does not match stays in the list if
one of its runs does, and expands to just the matching runs — clicking one selects that channel and puts
that run on the Stage. Runs are not subjects and have no list of their own, so without this, finding a run
by what it was about meant selecting every channel in turn.

## 15. Keyboard

| Key | Action |
|---|---|
| `g` `c` / `Ctrl:2` | go to Jarvis |
| `j` / `k` | move the Subjects cursor |
| `[` / `]` | cycle surfaces |
| `1`–`9`, `Enter` | answer the shown run's asking worker |
| `^P` | command palette |
| `Esc` | close the graph peek; otherwise leave for the Cockpit |

The strip along the bottom of the window advertises `g go`, `esc home`, `^P palette`, `^N new`, `? help`.

## 16. A narrow window

The thread and the composer never give up space — everything around them yields first, in a fixed order.
As the window narrows:

1. the **context rail** closes to its 44px strip (you can still open it; the width only picks the default);
2. the **Subjects** column drops to a 56px column of status dots — same subjects, same order, same asking
   dot, labels on hover;
3. the **header** sheds its project path, then the ladder's rung labels, then the dispatch-mode strip —
   the subject's own name has a floor and never truncates away.

The Stage holds at or above 640px through all of that, which is the width its widest thread element needs.
Below roughly 1000px there is nothing left for this surface to give: the nav rail is global chrome shared
by every surface, so it is not this surface's to collapse.

## Regenerating these images

The driver is `scripts/cdp/jarvis-tour.mjs`, run against a live `task dev` with the debug port up. It
never presses `Enter` on a channel Launch composer, never picks a channel in the off-channel dispatch
picker, and never presses `Save` in the profile drawer — each would dispatch a real worker or write real
config. The autonomy tier it toggles for shot 09 is read first and restored afterwards.

Shots 18 and 19 no longer need a fresh page: the peek clears its selection when it opens on something with
nothing to focus, so the honest empty state is reachable at any point in a session.

Pin the window width before shooting. The surface is width-responsive — below roughly 1290px the context
rail closes and below roughly 1034px the Subjects column drops to status dots — so a run at a different
width produces a different layout. These shots are 1440×900.
