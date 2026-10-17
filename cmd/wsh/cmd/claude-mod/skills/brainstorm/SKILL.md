---
name: brainstorm
description: Use whenever superpowers:brainstorming (or brainstorming) runs inside Arc, i.e. `wsh` is on PATH — keeps the brainstorm's state in .superpowers/brainstorm/<topic>/brainstorm.json, which Arc shows beside your terminal, and defines the `brainstorm:` lines Arc types back to you.
---

# Brainstorming inside Arc

Follow `superpowers:brainstorming` as usual, with this skill beside it. Arc shows the brainstorm on
the Agent surface as a pane next to your terminal: the current question with an answer box, the
design's parts as they form, mockups beside their parts, and at the end a builder check and the
start of a run. It reads all of that from one file you write. You are its only writer; Arc only
reads it, and every user action reaches you as one line typed into your terminal.

What changes from plain brainstorming:

- A playback is a part written to the file, not 200-300 words in the terminal.
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
  "question": { "n": 4, "text": "Walk me through the last time lag bit you: what did you see first?", "part": "thresholds" },
  "working": null,
  "parts": [
    { "id": "intent", "title": "Intent and why", "state": "yours", "from": "answer 1", "body": "Page on-call before a consumer falls far enough behind to drop data." },
    { "id": "page", "title": "What on-call sees", "state": "guess", "from": "mockup", "body": "One page per consumer group, with the lag trend.", "boards": ["Page.dc.html"] },
    { "id": "constraints", "title": "Constraints", "state": "guess", "from": "answer 2", "body": "Prometheus 2.45 or later.",
      "was": "Any Prometheus version.", "why": "your answer 4 named the growth rate, which needs Prometheus 2.45" },
    { "id": "thresholds", "title": "Thresholds", "state": "asked", "body": "" },
    { "id": "builder", "title": "Left to the builder", "state": "open", "body": "" }
  ],
  "history": [
    { "kind": "question", "n": 1, "q": "What should this make possible?", "a": "Know before we drop data.", "into": ["intent"] },
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
- `parts` is an array; every part has a non-empty string `id` that no other part has, and a
  `state` that is exactly `yours`, `guess`, `asked` or `open`.
- `question`, when not `null`, is an object with a numeric `n` **and** a string `text`.
- `check`, when not `null`, is an object.

Everything else is optional and read leniently, but write every field as described:

| Field | What it holds |
|---|---|
| `spec` | The spec path, relative to the project (or absolute). You write the spec there on `brainstorm: check`. |
| `canvas` | The `arc:design` topic whose boards the parts list: boards live in `.superpowers/design/<canvas>/project/`. Omit it when there are no mockups. |
| `question` | `{ "n", "text", "part" }`: the question you are waiting on, its number (1, 2, 3, ...), and the id of the part it is for. `null` while you are not asking. |
| `working` | A short sentence while you turn an answer into a part, else `null`. Arc closes the answer box and disables every action while it is set. |
| `parts[]` | The design, in display order. `title`; `state`; `body` (the part's text); `from` (where it came from: `answer 2`, `mockup`, `recon`); `boards` (board file names under the canvas's `project/`); `was` / `why` (below). |
| `history[]` | Every finished exchange, oldest first: `kind` (`question` or `recon`), `n` (the question's number), `q`, `a`, `into` (the part ids it went into). |
| `done` | `true` only when nothing is left to ask. |
| `check` | The builder check's result (below), else `null`. |
| `run` | The run id once a run started from this brainstorm, else `null`. |
| `compacted` | Unix milliseconds of your last re-read after a compaction (below). |

Part states:

- `yours`: the user said it or confirmed it.
- `guess`: your guess or playback, not yet confirmed.
- `asked`: the part the current `question` is for.
- `open`: known to be needed, nothing written yet.

There is no total and no fixed list of parts: parts appear as the conversation finds them. Never
write a count of questions remaining, a progress figure or "N of M" anywhere, in the file or the
terminal.

## The lines Arc types

An answer arrives as the user's own text, on one line. Every other action is a `brainstorm:` line:

| Line | What you do |
|---|---|
| the answer, as typed | Answer sequence below. |
| `brainstorm: guess` | The user wants you to decide. Write your best guess for the current question's part as `guess` (say in `from` that it was your call), then ask the next question as after an answer. |
| `brainstorm: skip questions` | Stop asking. Write every `asked` and `open` part as a `guess`, set `question: null` and `done: true`. |
| `brainstorm: confirm <part id>` | Make that part `yours`; drop its `was` and `why`. |
| `brainstorm: edit <part id>: <text>` | Replace that part's `body` with the text (fix only obvious typos), make it `yours`, drop `was` and `why`. |
| `brainstorm: keep <part id>` | The user accepts your change to a part they had confirmed: make it `yours`, drop `was` and `why`. |
| `brainstorm: restore <part id>` | Put their version back: `body` = `was`, make it `yours`, drop `was` and `why`. |
| `brainstorm: check` | Builder check, below. |
| `brainstorm: builder answer: <text>` | Builder check, below. |
| `brainstorm: keep talking` | Set `done: false` and `check: null`, and ask your next question. |
| `brainstorm: approved` | Stop. Arc opens the run launcher with the spec attached. Do not start a run yourself. |

After acting on any line, write the whole file, then end the turn with a short reply in the
terminal (the next question, when there is one).

## Rules

**Always write the whole file.** Write the complete JSON in one write every time. Never patch it in
place with a partial edit that can leave it half-written or invalid; Arc reads it every few seconds.

**The first message.** Pick `<topic>`. Create the file with `title`, `spec` (the path superpowers
would write the spec to), question 1 in `question` with `n: 1`, its part created as `asked`, and
`history: []`. Then run `wsh ui reveal brainstorm:<topic>` from your terminal. (In Claude Code a hook
also reveals it on every write of the file.)

**On an answer**, in two writes, so the pane shows the work in progress:

1. Append the exchange to `history` (with `n`, `q`, `a` and `into`), set `question: null`, set
   `working` to `Writing “<part title>” from your answer.` (the part's title in typographic double
   quotes), keep that part `asked`, write the file.
2. Write the part: `guess`, or `yours` when the user's own words are the part. Set `working: null`,
   set the next `question` (its part created as `asked` if new), write the file. End the turn with
   the question in the terminal too.

**Asking.** One question per turn, as superpowers does. Every question names its `part`.

**Playbacks are parts.** Write or rewrite a playback as a `guess`. It becomes `yours` only on
`brainstorm: confirm`, `brainstorm: edit`, or when the user's own words are the part.

**Changing a confirmed part.** When you rewrite a part that is `yours`, set `was` to the body they
had confirmed and `why` to the reason (name the answer that caused it), and make it a `guess`. It
stays a guess until they keep or restore it.

**Mockups.** Draw them as `arc:design` boards under `.superpowers/design/<canvas>/project/`, set
`canvas`, and list each board's file name in `boards` on the part it illustrates. Arc draws it as a
thumbnail beside the part. The run's prototype is the first board any part lists.

**Left to the builder.** The part with id `builder` and title `Left to the builder` is always the
last part. Write it as a `guess` once nothing is left to ask.

**Done.** Set `done: true` only when nothing is left to ask and `question` is `null`. Arc enables
**Check with a builder** once `done` is true and every part is `yours`.

**After a compaction**, before anything else: re-read the file, set `compacted` to the current Unix
time in milliseconds, write it back. Carry on from the file, not from memory.

**The builder check** (`brainstorm: check`): write the spec at `spec` from the parts, run
superpowers' builder check against it, then fill `check` and write the file:

```json
"check": {
  "yours": [{ "q": "Should a paused consumer page?", "why": "the spec says every group pages" }],
  "calls": [{ "text": "Lag is measured per partition, alerted per group.", "part": "thresholds" }],
  "answered": ["Which Prometheus? The spec names 2.45."],
  "touched": ["thresholds", "constraints"]
}
```

- `yours`: the questions only the user can answer, each with `why` it matters.
- `calls`: the decisions you made for them, each `{ "text", "part" }` naming the part it belongs
  to. Mark each one inline in the spec as "Agent's call".
- `answered`: what the builder asked that the spec already answers.
- `touched`: the ids of the parts the check changed or annotated.

On `brainstorm: builder answer: <text>`: the answer is for the first `check.yours` entry with no
`a`. Set its `a` to the text and `into` to the part it went into, fold the answer into that part
and into the spec, and write the file.

**The run.** On `brainstorm: approved`, stop; Arc opens the launcher. When a run starts, the user
tells you its id, or read it with `wsh runs`; set `run` to it and write the file.

**Resuming.** Asked to resume a brainstorm from a `brainstorm.json` path (a new agent after the old
one exited): read the file, carry on from its `question` or its next step, and keep writing the
same file.
