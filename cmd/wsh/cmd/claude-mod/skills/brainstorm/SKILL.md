---
name: brainstorm
description: Use whenever superpowers:brainstorming (or brainstorming) runs inside Arc, i.e. `wsh` is on PATH, except in an agent an Arc run started — keeps the brainstorm's state in .superpowers/brainstorm/<topic>/brainstorm.json, which Arc shows beside your terminal, and defines the `brainstorm:` lines Arc sends you.
---

# Brainstorming inside Arc

Follow `superpowers:brainstorming` as usual, with this skill beside it. Arc shows the brainstorm on
the Agent surface as a pane next to your terminal: the current question with why you ask it, the
answers you offer and an answer box, what was decided so far, the design's parts as they form, mockups beside their parts, and at the end a builder check and the
start of a run. It reads all of that from one file you write. You are its only writer; Arc only
reads it, and every user action reaches you as one line, sent to you as a message.

**Not in a run's agent.** When your instructions put every question through AskUserQuestion or
`wsh ask` (an orchestrator run's lead, or any agent an Arc run started; Arc sets `ARC_RUN_AGENT` in its
environment), follow them and do not use this skill: the cockpit shows those questions instead.

What changes from plain brainstorming:

- A playback is a part written to the file, not 200-300 words in the terminal.
- The user reads the pane, not the terminal. Your terminal reply is one short line on what you
  changed, then the question you are waiting on. Never repeat a part's text there.
- Mockups are `arc:design` boards, listed on the part they illustrate. Never start the visual
  companion's server inside Arc.
- Still end every turn on the question in the terminal: the file is what Arc shows, the terminal is
  what you wait on.

## The file

`<project>/.superpowers/brainstorm/<topic>/brainstorm.json`, where `<project>` is your working
directory and `<topic>` is a kebab-case name you pick at the first message. `.superpowers/` is
gitignored.

```json
{
  "v": 1,
  "title": "Consumer lag alerts",
  "spec": "docs/superpowers/specs/2026-10-18-consumer-lag-alerts-design.md",
  "canvas": "consumer-lag-alerts",
  "question": {
    "n": 4, "text": "When a group stays past its lag threshold, who gets paged first?", "part": "thresholds",
    "why": "Every consumer group names an owning team, so paging by owner needs no new config. I can't tell whether every team keeps a rota.",
    "read": "Owner first wakes the fewest people if teams keep rotas; platform first is the safe fallback if they don't.",
    "options": [
      { "label": "Owning team first, platform after 15 minutes", "detail": "The owning team is paged; platform hears if nobody acks.", "pick": true,
        "pros": ["Pages go to who can fix it.", "Needs no new config: every group already names its team."],
        "cons": ["Needs every team to keep a rota."] },
      { "label": "Platform on-call first", "detail": "Platform is paged and hands off what it can't fix.",
        "pros": ["One rota to keep."], "cons": ["Platform wakes for lag it can't fix."] },
      { "label": "Both at once", "detail": "Owner and platform are paged together.",
        "pros": ["Nothing waits on a hand-off."], "cons": ["Every page wakes two people."] }
    ]
  },
  "parts": [
    { "id": "intent", "title": "Intent and why", "state": "yours", "from": "answer 1", "gist": "Page before a lagging consumer drops data.", "body": "Page on-call before a consumer falls far enough behind to drop data." },
    { "id": "page", "title": "What on-call sees", "state": "guess", "from": "mockup", "gist": "One page per group, with the lag trend.", "body": "One page per consumer group, with the lag trend.", "boards": ["Page.dc.html"] },
    { "id": "constraints", "title": "Constraints", "state": "guess", "from": "answer 2", "gist": "Prometheus 2.45 or later.", "body": "Prometheus 2.45 or later.",
      "was": "Any Prometheus version.", "why": "your answer 4 named the growth rate, which needs Prometheus 2.45" },
    { "id": "thresholds", "title": "Thresholds", "state": "asked", "body": "" },
    { "id": "today", "title": "What runs today", "kind": "note", "from": "recon", "gist": "Every group names an owning team; nothing pages on lag yet.", "body": "kafka-exporter scrapes 14 consumer groups. Every group names an owning team in services/*/kafka.yaml. There are no lag rules in Alertmanager." },
    { "id": "builder", "title": "Left to the builder", "state": "open", "body": "" }
  ],
  "history": [
    { "kind": "question", "n": 1, "q": "What should this make possible?", "a": "Know before we drop data.", "into": ["intent"] },
    { "kind": "question", "n": 2, "q": "One threshold for every group, or one per group?", "why": "Groups range from a few hundred messages a day to millions an hour.", "a": "Per group, with a default to start from", "into": ["thresholds"],
      "options": [{ "label": "One threshold for every group", "detail": "One number to tune for every group." }, { "label": "Per group, with a default to start from", "detail": "Every group alerts from day one; teams tighten their own.", "pick": true }], "picked": 1 },
    { "kind": "recon", "q": "I offered to look at your Prometheus targets. You said yes.", "a": "Found 2.45 on every target.", "into": ["constraints"] }
  ],
  "done": false,
  "check": null,
  "run": null
}
```

Arc treats the file as broken, and shows an error instead of the brainstorm, unless:

- `v` is the number `1`.
- `title` is a string.
- `parts` is an array; every part has a non-empty string `id` that no other part has, and every
  part that is not a note has a `state` that is exactly `yours`, `guess`, `asked` or `open`.
- `question`, when not `null`, is an object with a numeric `n` **and** a string `text`.
- `check`, when not `null`, is an object.

Everything else is optional and read leniently, but write every field as described:

| Field | What it holds |
|---|---|
| `spec` | The spec path, relative to the project (or absolute). You write the spec there on `brainstorm: check`. |
| `canvas` | The `arc:design` topic whose boards the parts list: boards live in `.superpowers/design/<canvas>/project/`. Omit it when there are no mockups. |
| `question` | `{ "n", "text", "part", "why", "read", "options" }`: the question you are waiting on, its number (1, 2, 3, ...), the id of the part it is for, why you ask it, your one-line read of the options, and the answers you offer (below). Leave `part` out for a question about no part (below). `null` while you are not asking. |
| `parts[]` | The design, in display order. `title`; `state`; `kind` (`"note"` for background, below; leave it out for a decision); `gist` (the part in one line, below); `body` (the part's text); `from` (where it came from: `answer 2`, `mockup`, `recon`); `boards` (board file names under the canvas's `project/`); `was` / `why` (below). |
| `history[]` | Every finished exchange, oldest first: `kind` (`question` or `recon`), `n` (the question's number), `q`, `why` (the question's `why`), `a`, `into` (the part ids it went into), and for a question that offered answers, `options` and `picked` (below). |
| `done` | `true` only when nothing is left to ask. |
| `check` | The builder check's result (below), else `null`. |
| `run` | The run id once a run started from this brainstorm, else `null`. |
| `compacted` | Unix milliseconds of your last re-read after a compaction (below). |

Part states:

- `yours`: the user said it or confirmed it.
- `guess`: your guess or playback, not yet confirmed.
- `asked`: the part the current `question` is for.
- `open`: known to be needed, nothing written yet.

**Decisions and notes.** A part is a decision unless it has `"kind": "note"`. A decision is what the
run builds, and each one has to be `yours` before the builder check. A note is background the
decisions stand on: what recon found, what research says, a trade-off write-up. It goes into the
spec as context, the user has nothing to confirm on it, and Arc lists it apart, under "What the
agent found"; it needs no `state`. Whatever the user needs in order to choose belongs on the
question (`read`, and each option's `pros` and `cons`), never only in a part: while a question is
open it fills the pane and the parts are out of sight.

**Gist.** Give every part a `gist`: the part in one line, under 100 characters, as a reader skimming
the design would want it ("Daily: one forecast per entity-day, with a weekday cycle and trend").
Arc shows the design one line per part and opens a part's `body` on demand, so the gist is what the
user reads when they confirm. Rewrite it whenever you rewrite the body.

There is no total and no fixed list of parts: parts appear as the conversation finds them. Never
write a count of questions remaining, a progress figure or "N of M" anywhere, in the file or the
terminal.

## The lines Arc sends

An answer arrives as the user's own text, on one line; a picked option arrives as its `label`. Every other action is a `brainstorm:` line:

| Line | What you do |
|---|---|
| the answer, as typed | Answer sequence below. |
| `brainstorm: guess` | The user wants you to decide. Write your best guess for the current question's part as `guess` (say in `from` that it was your call), then ask the next question as after an answer. |
| `brainstorm: skip questions` | Stop asking. Write every `asked` and `open` part as a `guess`, set `question: null` and `done: true`. |
| `brainstorm: confirm <part id>` | Make that part `yours`; drop its `was` and `why`. |
| `brainstorm: confirm every guess` | Make every `guess` part that has no `was` `yours`. A part with `was` stays a guess: it waits for keep or restore. |
| `brainstorm: edit <part id>: <text>` | Replace that part's `body` with the text (fix only obvious typos), make it `yours`, drop `was` and `why`. |
| `brainstorm: keep <part id>` | The user accepts your change to a part they had confirmed: make it `yours`, drop `was` and `why`. |
| `brainstorm: restore <part id>` | Put their version back: `body` = `was`, make it `yours`, drop `was` and `why`. |
| `brainstorm: check` | Builder check, below. |
| `brainstorm: builder answer: <text>` | Builder check, below. |
| `brainstorm: builder decide` | Move the first `check.yours` entry with no `a` into `check.calls` as `{ "text": <your decision>, "part": <its part> }`, fold it into that part and the spec (marked "Agent's call"), write the file. |
| `brainstorm: keep talking` | Set `done: false` and `check: null`, and ask your next question. |
| `brainstorm: approved` | Stop. Arc opens the run launcher with the spec attached. Do not start a run yourself. |
| `brainstorm: run <id>` | A run started from this brainstorm: set `run` to the id. |

After acting on any line, write the file once, then end the turn with a short reply in the
terminal (the next question, when there is one).

## Rules

**One write per turn, always the whole file.** Arc reads the file every few seconds and shows that
you are working from the moment it sends a line, so write it once, when the turn's change is
complete. Each write leaves the whole file valid JSON:

- The first write, which creates the file, and any change that rewrites most of it: your
  file-writing tool, with the complete JSON.
- A small change (a confirm, an edit, a state flip, a field set): a one-line script that reads the
  JSON, changes it and writes the whole file back in one write (`node -e` or `python -c`). It is far
  cheaper than retyping the file.
- Never an in-place text edit of part of the file: one mismatched brace and Arc shows an error.

**The first message.** Pick `<topic>`. Create the file with `title`, `spec` (the path superpowers
would write the spec to), question 1 in `question` with `n: 1`, its part created as `asked`, and
`history: []`. In Claude Code a hook reveals the pane when your file-writing tool creates the file;
in any other harness run `wsh ui reveal brainstorm:<topic>` from your terminal.

**On an answer**, in that one write: append the exchange to `history` (with `n`, `q`, the question's `why`, `a`
and `into`; when the question offered `options`, copy them into the entry and set `picked` to the index
of the one the user's answer is, or leave `picked` out when they answered in their own words), write the part (`guess`, or `yours` when the user's own words are the part), and set the
next `question` (its part created as `asked` if new). End the turn with the question in the
terminal too.

**Asking.** One question per turn, as superpowers does. Every question about the design names its
`part`. Every question carries `why`: one or two sentences on what you already know and what you
cannot tell without the user, which Arc shows under the question. When the question has natural
choices, it also carries 2-4 `options`, each `{ "label", "detail", "pros", "cons" }`: `label` is the
answer in a few words, `detail` says what the option is in one sentence, and `pros` and `cons` are
your reasons for and against it, one short sentence each (what it gains and loses, what it costs,
whether it fits what is there today). Mark your recommendation with `"pick": true` on exactly one
option, and say how the options compare in `read`: one line, the reason for your pick included. Arc
shows the options as lettered rows the user picks from, each with its pros and cons under it, and
`read` above them; the free-text box stays for any other answer. Write pros and cons whenever the
choice is a trade-off; a question whose answers need no weighing leaves them and `read` out. An open question (a story, a moment, a number only the user knows) has no
`options`.

**Check an approach before you offer it.** A question that picks an approach (how to build
something, which design, which mechanism) is never asked from what such designs usually look like.
Before you write its options:

- Look up the facts the choice turns on: the code it touches, what already exists that an option
  would reuse, the constraints that rule an option out. Finding facts is your job; ask the user only
  for what you cannot look up. Add what you found to `history` as a `recon` entry, and as a note part
  when the design stands on it.
- Ground every pro and con in something you found or the user said, and name it (`pkg/foo already
  retries`).
- Argue for each option you did not pick, and ask what approach would beat all of them. If one does,
  it is an option; if it beats your pick, it is the pick.
- Say in `read` the fact your pick rests on.

The test: if the user answered "double check", would you come back with another approach or another
pick? Then the check is not done. Do it now, before you ask.

**Every question you wait on is in the file.** Whenever your turn ends waiting on the user, whatever
the phase (a choice you need before you can go on, a permission, a clarification), that question is
in `question` with the next `n`, and `part` left out when it is for no part. Arc shows only what the
file holds, and a question asked only in the terminal leaves the user with nothing to answer. The
builder's questions for the user are the one exception: they live in `check.yours`, which Arc asks.

**Playbacks are parts.** Write or rewrite a playback as a `guess`. It becomes `yours` only on
`brainstorm: confirm`, `brainstorm: edit`, or when the user's own words are the part.

**A later answer changes earlier parts.** When an answer overrides or narrows what a part already
says, rewrite that part in the same write, whatever its state, and check every other part the
answer touches: two parts that contradict each other reach the builder check as two confirmed
decisions. A `guess` or a note is rewritten in place. When you rewrite a part that is `yours`, set
`was` to the body they had confirmed and `why` to the reason (name the answer that caused it), and
make it a `guess`. It stays a guess until they keep or restore it.

**Mockups.** Draw them as `arc:design` boards under `.superpowers/design/<canvas>/project/`, set
`canvas`, and list each board's file name in `boards` on the part it illustrates. Arc draws it as a
thumbnail in the part, under its body when the user opens it. The run's prototype is the first board any part lists.

**Left to the builder.** The part with id `builder` and title `Left to the builder` is always the
last part. Write it as a `guess` once nothing is left to ask.

**Done.** Set `done: true` only when nothing is left to ask and `question` is `null`. Arc enables
**Check with a builder** once `done` is true, no question is open and every decision is `yours`.

**After a compaction**, before anything else: re-read the file, set `compacted` to the current Unix
time in milliseconds, write it back. Carry on from the file, not from memory.

**The builder check** (`brainstorm: check`): the user pressed **Check with a builder**, which is their
go-ahead for superpowers' builder check, the one fresh subagent included: do not ask again. Write the
spec at `spec` from the parts, run the builder check against it, then fill `check` and write the file:

```json
"check": {
  "yours": [{
    "q": "Should a paused consumer page?", "label": "Page on a paused consumer?", "why": "the spec says every group pages", "part": "thresholds",
    "options": [
      { "label": "Yes, like any lag", "detail": "A paused consumer pages once its lag crosses the threshold.", "pick": true,
        "pros": ["One rule for every group."], "cons": ["Planned pauses page too."] },
      { "label": "No, only running consumers", "detail": "A paused consumer never pages.",
        "pros": ["No pages for planned pauses."], "cons": ["A stuck pause goes unnoticed."] }
    ],
    "a": "Yes, like any lag", "into": ["thresholds"]
  }],
  "calls": [{ "text": "Lag is measured per partition, alerted per group.", "part": "thresholds" }],
  "answered": ["Which Prometheus? The spec names 2.45."],
  "touched": ["thresholds", "constraints"]
}
```

- `yours`: the questions only the user can answer, each `{ "q", "label", "why", "part", "options", "a", "into" }`.
  `why` is why it matters; `part` is the part the question is for; `label` is a short line for the
  queue, under 80 characters; `options` are written exactly as a talk question's (`label`, `detail`,
  `pros`, `cons`, one `pick`), and left out when the answer is open. `a` and `into` stay out until the
  question is settled (below); `into` is the list of every part the answer changed.
- `calls`: the decisions you made for them, each `{ "text", "part" }` naming the part it belongs
  to. Mark each one inline in the spec as "Agent's call".
- `answered`: what the builder asked that the spec already answers.
- `touched`: the ids of the parts the check changed or annotated. Refresh it whenever the check's
  parts change (rewritten, added or annotated), on every write that does that.

Your terminal reply after the check is one line naming the spec's path: the pane shows the builder's
questions, your calls and what the design already answered, so do not list them there.

On `brainstorm: builder answer: <text>`: the answer is for the first `check.yours` entry with no
`a`. Set its `a` to the text and `into` to every part it changed, fold the answer into those parts
and into the spec, and write the file. A part the answer rewrites that was `yours` gets `was` (the
body they had confirmed) and `why` naming "builder question N", and stays a `guess` until they
`keep` or `restore` it, one by one: there is no keep-all. A part the answer only fills in, or that
was already a `guess`, becomes `yours` (the user just decided it).

On `brainstorm: builder decide`: the user leaves the first `check.yours` entry with no `a` to you.
Move it out of `yours` into `calls` as `{ "text": <your decision>, "part": <its part> }`, fold it into
that part and into the spec marked "Agent's call", and write the file. Arc keeps no state for it: the
entry is gone from `yours`.

**An answer settles builder questions too.** When any answer, a talk question's or a builder
question's, settles a `check.yours` entry, set that entry's `a` (what was decided, in a few words) and
`into` in the same write. Otherwise the pane keeps asking it.

**Name the cause.** Every `why` on a changed part names its cause in a few words, for example
`answer 12: your boss wants PyTorch` or `builder question 1`: the review shows it under the
decision.

**Approving.** Arc enables approve only once no question is open, every builder question is
answered or decided by you, and every decision is `yours`.

**The run.** On `brainstorm: approved`, stop; Arc opens the launcher, and sends `brainstorm: run <id>`
once the run starts.

**Resuming.** Asked to resume a brainstorm from a `brainstorm.json` path (a new agent after the old
one exited): read the file, carry on from its `question` or its next step, and keep writing the
same file.
