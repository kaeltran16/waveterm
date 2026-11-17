# Transcript renderer, fix round 2

Effort `2bd27b27-0403-43cd-a540-ff66edce3b3c`, chunks 19-35 and 37-51 (36 is decided "keep as is"). Each chunk's
notes in `wsh effort show 2bd27b27-0403-43cd-a540-ff66edce3b3c` hold the evidence (session ids, file:line, a
screenshot under `C:/Users/kael02/scratch/replay/shots`). This spec records the user's decisions and the calls made
beyond them, with why. Path: architectural (32 chunks across the projection, layout, rows, panels and cards; a
planned run splits them by file ownership so independent slices run at once).

## The user's decisions (not to be revisited)

- **27 + 35, turn folds and cards.** A finished turn stays folded even when it holds a tool output card (this
  replaces the 11-16 rule that a card-bearing turn starts open). Opened, the cards of such a turn draw as their
  header only (files and +/- for a diff, passed/failed for tests) and open on a click on that header. The latest or
  live turn keeps its cards open.
- **33 (and 31), thoughts.** No clamp: consecutive thoughts stay merged into one block and draw in full, with no Show
  more. Chunk 31's "...." goes with the clamp.
- **39, colours.** A step title is `text-secondary` whether running or done (drop the running/done switch); the
  spinner alone marks the running step. Thoughts stay `text-ink-mid`; commands and durations `text-muted`.
- **47, new files.** A file the agent wrote new draws as a file preview with a "new" badge through the Read panel's
  renderer (highlighted code, plain text for a non-code file, the chunk 46 gutter). Edits keep the diff.
  Call made here: the preview applies to every added file (badge `A`) in an edit detail, which includes a new file
  in a git diff card, since that diff is the same all-green wall; one rule in `ToolDetailBody` rather than a flag
  threaded through each caller.

## Calls made here, and why

1. **Split `narrationtimeline.tsx` first.** It is 1,568 lines and most chunks land in it. A pure move into
   `tooldetailbody.tsx` (the per-kind panel body), `steprows.tsx` (step rows, stretches, thoughts) and
   `clampedtext.tsx` (Show more) lets the panel, wake-card and row work run beside each other instead of in one
   serial chain on one file. No behaviour change in the move.
2. **"Latest turn" (27/35).** While the agent works, the live turn is unfolded and its cards draw open; every
   finished turn's cards draw header-only. When it does not work, the last finished turn is the latest: every turn
   item of it carries `latest` (a permission mark can split one turn into several items), and its cards draw open
   once its fold is opened. Steps outside any fold draw cards open. The header is the card's existing header
   (`BashCardShell`), made clickable; a collapsed card has no nested scroll box, which also fixes the ~400px diff
   scroll box in history. An image card is already a small thumbnail strip, so it draws the same in every turn.
   `LayoutOpts.renderers` existed only for the old open rule and goes; `StepRow`'s own `renderers` prop stays.
3. **Errors are projection data (42, 43).** `AgentActionEntry` gains `error?: string`: the tool's error text with any
   `<tool_use_error>` wrapper removed, set for a failed non-Bash call and for a Bash call that never ran (blocked or
   refused). A Bash call that ran and failed keeps its output and exit code, so the error is not drawn twice. The row
   renders the error; the projection stays the single place that reads Claude's record shapes.
4. **A failed or blocked row with an error always opens (43).** A failed call's body leads with the error, above the
   attempted edit or other detail. A refused (blocked) Bash call is the one exception: its body shows the refused
   command first and the reason as a note directly under it, not as program output (42), since the command is what
   was refused. Both are drawn by the step body (`StepBody`), outside `ToolDetailBody`. The full view leads with the
   error too.
5. **Notification source (50)** is read from the summary's leading words, which Claude Code writes in a fixed shape
   (sampled 11-17 over recent transcripts: "Background command ..." 1,740, "Monitor event ..." 353,
   "Background shell ..." 2, "Agent "x" finished" for subagents). The notification entry gains
   `source?: "command" | "monitor" | "subagent"`; the row's label names it ("Background command", "Monitor",
   "Subagent"), with "Background task" when unknown.
6. **A turn started by a notification (25).** A `<task-notification>` that arrives as its own user record (not a
   queued attachment) starts a turn and stays outside the fold, like a prompt; the projection gives that entry its
   record time so the turn's duration starts there. A queued notice (`notice: true`) still sits inside the running
   turn.
7. **A pending step in an inactive transcript (40)** lays out as `stopped`: no spinner, no clock. A pending step while
   the agent works stays `running` (it may be waiting on a permission prompt).
8. **Merging edits (29).** Two or more consecutive finished edits to the same path (no other step or thought between)
   lay out as one step whose detail holds each edit's file block in order, counts summed, and `Step.edits` set to the
   number merged; the row draws "N edits" beside the counts. A failed edit never merges.
9. **Command titles (28, 34).** When picking the verb, skip wrappers (`timeout` and its duration, `env` and its
   assignments and flags, `nohup`, `time`, `command`, `VAR=`) and the contents of `$( )` and backticks. A title that
   would only name the program ("Ran grep") is dropped, so the row shows the command alone as for a short command;
   titles that add a script, file or subcommand stay. The row's mono preview drops a leading `cd <dir> &&` (or `;`);
   the opened detail keeps the full command.
10. **Durations (38).** A step row shows its duration only from `STEP_DURATION_MIN_MS = 1000`; the full view keeps
    every duration.
11. **"Raw output" (49, 30).** Under a test or diff card the "Raw output, N lines" label goes: the card header's raw
    toggle already offers it. Under a wsh view, "Raw output" becomes a real toggle that reveals the recorded output.
    A wsh card or view whose fetch fails draws the recorded output (ANSI stripped) in place of the bare error line,
    with the error as one muted line above it. Any line count left in the UI is singular for 1. The recorded-output
    block is one component (`RecordedOutput`), which the test/diff cards' raw view (`RawOutput`) also uses.
12. **wshcall (19, 20).** The tokenizer keeps a single-quoted span literal: no `$` expansion inside it, and a `$` there
    does not mark the call unresolved. Only positionals and the flags a card fetches by mark a call unresolved; a
    display-only flag (`--note`, `--summary`, `--reason`, ...) holding `$` does not.
13. **23, ImageThumbs' compact prop** has a caller now (`BubbleAttachments` passes it in compact hosts), so it stays;
    the chunk closes with that note.
14. **Panel paths (44)** become relative in the projection: each detail path (edit files, grep locations, the read
    path) under the record's `cwd` is written relative to it, with forward slashes. The panel truncates a long path
    from the left, so the file name stays visible.
15. **Grep (45).** The grep detail gains the `pattern` (and case-insensitive flag) from the tool input; the panel
    groups matches under a file header, highlights each match (no highlight when the pattern is not a valid JS
    regex), and the full view shows whole lines.
16. **Read (46).** The read detail gains its `path`. A consistent leading line-number prefix (`cat -n`'s
    `<spaces>N<tab>` or `N→`) parses into a muted gutter, and a wrapped line hangs under its own text. A file whose
    extension is not code (`.output`, `.log`, `.txt`, no extension) draws as plain text, not highlighted.
17. **Full view (48)** is wide (about 1100px, capped by the viewport); inline wraps, the full view scrolls sideways
    for long lines. Its header drops the status square for a successful call (it read as a checkbox) and keeps a
    failed or blocked call's mark as a word chip, as the row does.
18. **Images (32, 51).** A closed "Read N images" row shows a small thumbnail strip (the compact thumbnail height);
    an image read's frame is sized to its thumbnails rather than the column width.
19. **Show earlier (22)** is one component used by both hosts; each host keeps its own data attribute
    (`data-rendered-earlier`, `data-sessions-earlier`) since scenarios select by them.
20. **Tables (26).** Markdown table cells wrap (`white-space: normal`); the table keeps its horizontal scroll only
    when columns still cannot fit.
21. **Wake items (37).** In the latest wake card each "Since the last wake" item clamps to 3 lines with Show more,
    through the shared `ClampedText`.
22. **21, 24, 41 (projection).** A user record holding an interruption marker yields no empty-text bubble for its
    images. `<task-notification>` and `<local-command-stdout>` are recognised only at the start of a record, so a
    prompt quoting them draws as a prompt. Bash tool output is ANSI-stripped (with the existing `stripAnsi`).

Every projection change regenerates `pkg/remotemode/web/static/projectors.js` with `task sync:remoteweb` (generated,
never hand-edited) in the same task. Colours and spacing use the existing `@theme` tokens only (`DESIGN.md`); motion
reuses the moments in `docs/reference/motion-system.md`.
