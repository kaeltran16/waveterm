# Cache miss notice through the avatar implementation plan

**Effort:** effort:99832658-9ade-458d-b466-32e7adedea4a
**Verify:** `node scripts/verify.mjs ./pkg/wshrpc/... ./cmd/wsh/...`
**Check:** `go vet ./pkg/wshrpc/ ./cmd/wsh/cmd/`
**Final:** `node scripts/cdp/final-verify.mjs surface-smoke`
**Prototype:** C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/cache-miss-notice/project/Main.dc.html

## Goal and shape

When a Claude turn re-bills a large part of its prompt because the prompt cache was missed, the user is told
by Jarvis's avatar, on whichever surface they are on, in a bubble that names the agent and leaves by itself.
Today the only notice is one dim transcript line from a personal Stop hook
(`C:/Users/kael02/.claude/scripts/cache-miss-notice.mjs`), which is easy to miss and names no agent.

There is no separate spec. The user approved the canvas in the Prototype folder (`Main.dc.html`,
`Cases.dc.html`, `canvas.json`); it is the visual and wording spec. It is gitignored scaffolding: read it at
its absolute path, do not expect a copy in a worker checkout, and do not commit it. Its agent names and token
counts are sample data.

Two tasks on separate files, with nothing between them, so they run at the same time:

- Task 1 teaches a notice to carry the agent that sent it and to be said once without being kept.
- Task 2 makes the Claude mod detect the miss and send that notice.

## Global constraints

- Touch only the files a task names, plus generated files where the task says to regenerate. No refactors or
  reformatting beside the change.
- Match the surrounding code's naming, comment density and test style. Comments say why, never what.
- Each task names its focused tests. Do not run a whole package or the full suite: Verify does that.
- Never hand-edit generated files. After changing a wshrpc type run `task generate` and commit what it writes.
- `cmd/wsh/cmd/claude-mod/` is a generated copy of `claude/arc-mod/`. Edit `claude/arc-mod/` and refresh the
  copy with `task sync:claudemod`; never edit the copy by hand.
- Colors come from the existing `@theme` tokens. Add no token, no new shadow and no new motion.
- Do not edit anything under `C:/Users/kael02/.claude/`. Removing the old Stop hook is the user's step after
  this lands.

### Task 1: A notice names the agent that sent it and can be said once

**Depends on:** none

**Files:** `pkg/wshrpc/wshrpctypes_notify.go`, `cmd/wsh/cmd/wshcmd-notify.go`, `cmd/wsh/cmd/wshcmd-notify_test.go`, `frontend/app/view/jarvis/petvoice.ts`, `frontend/app/view/jarvis/petvoice.test.ts`, `frontend/app/view/jarvis/petjoin.ts`, `frontend/app/view/jarvis/petjoin.test.ts`, `frontend/app/view/jarvis/petbubble.tsx`, `frontend/app/view/jarvis/petview.tsx`, `frontend/app/view/jarvis/petsources.tsx`, `scripts/cdp/scenarios.mjs`

A notice today is a title, a message and a level (`NotifyCommandData`). The avatar says the title in a bubble
for 6 seconds, keeps it in the popup's read-back list (`petSaidAtom`) and shows an unread marker when the
bubble leaves unopened (`petview.tsx`).

Required behavior:

- `NotifyCommandData` gains two optional fields: the oref of the block the notice came from, and a flag that
  the notice is said once and not kept. Existing callers that set neither behave exactly as today.
- `wsh notify` fills the block oref from `WAVETERM_BLOCKID` when that variable is set, and takes a
  `--transient` flag for the said-once flag. Outside a block it sends no oref and still works.
- `eventFromNotify` (`petjoin.ts`) carries both onto the `PetEvent`: the oref as the event's existing `ref`,
  and the flag as a new field.
- A bubble whose event has a `ref` that matches a roster agent shows that agent on its own line between the
  label and the text: the agent's name, then its project, laid out as in the canvas (`Main.dc.html` panel A).
  Resolve the agent the way an agent's question already does (`askAgent` in `petjoin.ts`). A long name is cut
  with an ellipsis on one line and the project stays visible (`Cases.dc.html`, fourth bubble). A `ref` that
  matches no agent shows no agent line, and the bubble is otherwise as today.
- A said-once event is spoken like any other, but it is not added to `petSaidAtom`, so the popup never lists
  it, and its bubble leaving sets no unread marker (`Main.dc.html` panel B).
- Clicking the bubble of a said-once event whose agent resolved opens that agent through the one router
  (`frontend/app/view/jarvis/openref.ts`) and closes the bubble, instead of opening the popup. Every other
  bubble click opens the popup as today.
- Accepted limit, do not build around it: the avatar says one utterance at a time, so of two said-once
  notices arriving together only the newest is shown.

Keep the deciding logic pure and tested, the renderer thin, as the files' headers describe.

Tests:

- `petjoin.test.ts`: a notify payload with an oref and the flag maps both; one with neither maps as today.
- `petvoice.test.ts` or `petjoin.test.ts`, wherever the pure piece lands: a said-once event is the utterance
  but is left out of what gets remembered; a normal event is unchanged.
- `wshcmd-notify_test.go`: the payload built with `--transient` and a block id carries both; without them it
  is unchanged.
- `scripts/cdp/scenarios.mjs`, in `surface-smoke` beside the existing "wsh notify -> the avatar says it once"
  step, add steps that prove, each with a screenshot:
  1. a warn notify sent with a live roster agent's block oref and the said-once flag shows a bubble holding
     that agent's name, its project and the title;
  2. after the bubble's 6 seconds it is gone, the avatar has no unread marker, and opening the popup shows no
     entry with that title;
  3. the same notify with a title as long as the fourth bubble in `Cases.dc.html` and an agent whose name is
     long keeps the agent line on one line.
  Use the arrange and teardown helpers the file already has for a roster agent; do not add a new fixture
  mechanism. If no live agent can be arranged, the step must fail, not skip.

Run: `npx vitest run frontend/app/view/jarvis/petjoin.test.ts frontend/app/view/jarvis/petvoice.test.ts` and
`go test ./cmd/wsh/cmd -run 'Notify'`

### Task 2: The Claude mod reports a cache miss when a turn ends

**Depends on:** none

**Files:** `claude/arc-mod/hooks/cache-core.ts`, `claude/arc-mod/hooks/cache-core.test.ts`, `claude/arc-mod/hooks/register.ts`, `cmd/wsh/cmd/claude-mod/`, `docs/agents/usage-reporting.md`

Load the `plugin-authoring` skill before touching the hooks module. The detection to port is
`C:/Users/kael02/.claude/scripts/cache-miss-notice.mjs` (read it; do not edit it): it walks the session
transcript and, for the main thread's requests since the last real prompt, counts as missed the part of a
request's prompt that overlaps the previous request's but was not read from cache.

Required behavior:

- A pure `cache-core.ts`, in the style of the other `*-core.ts` files, turns transcript entries into the
  `wsh notify` arguments for the turn that just ended, or nothing. It keeps the script's rules: misses at or
  under 1,024 tokens are noise; a compaction boundary resets the comparison; sidechain and synthetic-model
  entries are ignored; one response written as several lines counts once; a request with no cache figures
  counts only once caching has been seen; the cache window is 5 minutes, or 1 hour once a 1-hour cache write
  is seen.
- Only misses of 20,000 tokens or more are reported. A turn with none sends nothing.
- One notice per turn. Its title is the whole message, worded as the canvas has it (`Cases.dc.html`):
  - idle past the cache window: `Cache miss: 85k tokens re-billed after 12m idle`
  - model switch: `Cache miss: 212k tokens re-billed after a model switch`
  - neither: `Cache miss: 31k tokens re-billed`
  - several in one turn: `2 cache misses: 140k tokens re-billed (85k after 12m idle, 55k after a model switch)`,
    a part with no known cause being just its token count
  Token counts format as the script does (`85k`, `1.2M`). The notice has no message body.
- The arguments are `notify <title> --level warn --transient`. `--transient` and the block oref are Task 1's;
  this task only passes the flag, and `wsh` adds the oref itself from the environment.
- `register.ts` only wires it: at `turn.complete` of a main-thread turn (not a subagent's), when the mod is
  active inside Arc, it reads the transcript whose path the module already tracks, and runs `wsh` with the
  arguments. A missing transcript, a half-written last line, a failed read or a failed `wsh` never blocks or
  fails the turn: log to debug as the neighbouring calls do. The turn's existing idle report and its order
  are unchanged.
- Outside Arc the mod stays inert, as today.

Tests, in `cache-core.test.ts` beside the other core tests: each of the four wordings above from a small
transcript fixture; a miss under 20,000 tokens sends nothing; a miss in an earlier turn is not reported again
after a new prompt; a compaction boundary resets the comparison; a response split over several lines counts
once.

Then run `task sync:claudemod` and commit the refreshed `cmd/wsh/cmd/claude-mod/` with the change. Add to
`docs/agents/usage-reporting.md` a short section saying the mod reports a cache miss through the avatar, the
20,000-token floor and that the notice is said once.

Run: `npx vitest run claude/arc-mod/hooks/cache-core.test.ts` and `claude plugin validate claude/arc-mod`
