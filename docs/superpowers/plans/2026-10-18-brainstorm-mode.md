# Brainstorm mode Implementation Plan

> **For agentic workers:** each task is one engine worker. Read the spec and the canvas first. Steps use checkbox (`- [ ]`) syntax.

**Spec:** `C:\Users\cktra\Projects\waveterm\docs\superpowers\specs\2026-10-18-brainstorm-mode-design.md` (decisions 1-12 and the planning decisions P1-P10 at its end)
**Verify:** `node scripts/verify.mjs ./cmd/wsh/cmd ./pkg/waveobj ./pkg/agentsync ./skills`
**Check:** `go vet ./cmd/wsh/cmd/ ./pkg/waveobj/ ./skills/ && node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs brainstorm-mode`
**Prototype:** C:\Users\cktra\Projects\waveterm\.superpowers\design\brainstorm-mode\project\Main.dc.html

**Goal:** An agent's brainstorm shows on the Agent surface as a pane beside its terminal: the current question with a free-text answer, the design's parts as they form (yours / guess / asked / open), mockup thumbnails beside their parts, a builder check and an approve that opens the run launcher.

**Architecture:** The agent writes `<project>/.superpowers/brainstorm/<topic>/brainstorm.json`; Arc only reads it (a poller every 3 s) and answers by typing one line into the agent's terminal. A pure `brainstormmodel.ts` derives everything the pane, tree, popup and roster show; a store holds per-agent state in one map atom; `brainstorm:<topic>` is a cockpit address landed by `openref.ts`; the Claude hook reveals on writes and injects `arc:brainstorm` when superpowers brainstorming starts; a new skill tells any harness what to write.

**Tech Stack:** React 19, jotai, Tailwind 4 tokens, vitest; Go (`wsh`), cobra; CDP scenario harness.

**The canvas:** `C:\Users\cktra\Projects\waveterm\.superpowers\design\brainstorm-mode\project\` (`Main.dc.html`, `Handoff.dc.html`, `States.dc.html`). Gitignored, so read it by that absolute path. Where the spec and the canvas disagree on a look, the canvas wins. Copy, sizes and layout below come from it; open the board for anything not quoted here.

## Global Constraints

- Colours only from `@theme` tokens in `frontend/tailwindsetup.css` (amber `warning`, green `success`, blue `accent` / `accent-soft` / `accentbg`, red `error`, greys `primary` / `secondary` / `ink-hi` / `ink-mid` / `muted` / `ink-faint`, borders `border` / `edge-mid` / `edge-strong` / `edge-faint`, surfaces `background` / `surface` / `surface-raised` / `surface-hover`). Never raw hex. Follow `DESIGN.md`.
- Reuse, don't copy: `element/segmented.tsx` (switcher), `ICON_BTN` (`agentheader.tsx`), `CANVAS_BTN` / `CANVAS_PRIMARY_BTN` and the toolbar row (`canvaspane.tsx`), the answer bar's chip and text-field looks (`answerbar.tsx`).
- Arc never writes `brainstorm.json`. Every user action is one line typed into the agent's terminal through `ControllerInputCommand` followed by `\r` (as `canvassend.ts` `tauriSendIO.type` does). A typed line is one line: runs of whitespace, newlines included, become one space, trimmed.
- No "N of M", progress bar, or count of questions remaining anywhere (spec anti-goal).
- The xterm never remounts: brainstorm mode hides it (`hidden`), as canvas mode does.
- Never hand-edit generated files; run `task generate` after changing `pkg/waveobj/wtypemeta.go`.
- Testable logic lives in pure `.ts` files with a `.test.ts` beside them; no jsdom render tests. Every rendered state is shown by a named step of the `brainstorm-mode` CDP scenario (Task 8).
- Never prettier `scripts/*.mjs`; check formatting only on files you touched.

## Decisions made beyond the spec and the canvas

Recorded in the spec as P1-P10; restated where a task needs them. In short:

- **State** (P1): one atom `brainstormsAtom: Record<agentId, BrainstormState>`, a derived per-agent read; the poller lives in the always-mounted cockpit root and reads every attached brainstorm.
- **Restart** (P2): attaching writes tab meta `session:brainstorm` = absolute `brainstorm.json` path; the poller re-attaches every roster agent carrying it.
- **Hook context** (P3): a new synchronous managed hook, PostToolUse matcher `Skill`, runs `wsh agent-hook --skill-context` (the generic PostToolUse hook is async and its output never reaches the turn).
- **File additions** (P4): `compacted` (Unix ms); `check.yours[].a` / `.into`; `check.calls[]` as `{text, part}` (bare string allowed); `check.touched` part ids. All optional.
- **Keep talking** (P5) types `brainstorm: keep talking`.
- **While `working`** (P6): every action that types is disabled.
- **Thumbnail** (P7): 300 px wide, at most 200 px tall, top-aligned, bottom cropped, non-interactive iframe.
- **Exited** (P8): the block's `controllerstatus` reports `shellprocstatus: "done"`; last output via `TermGetScrollbackLinesCommand`.
- **Approve line** (P9): `<project> · orchestrator · this design attached · Change`.
- **Popup** (P10): the brainstorm attention item is made in the frontend and fed only to the taskbar flash and the desktop popup.
- **Prototype** (P11): the first board any part lists, under `<canvas>/project/`; none listed, no prototype.
- **Reveal** (P12): a `brainstorm:` reveal with a caller lands at once and toasts only when the topic is not already attached to the caller, as a canvas reveal does.
- **Key watcher**: `watchFocusedCanvas` (`whenstate.ts`) is extended to also subscribe the focused agent's brainstorm, so `hints-footer.tsx` stays as it is.
- **A parse failure** shows the error state only after two consecutive failed reads of the file; one failed read keeps the last good contents on screen (an agent mid-write must not flash an error).
- **Removed file**: the pane says the brainstorm file is gone, with Back to terminal (detaches), like canvas `Removed`.

## Review Focus

1. The agent rewrites `brainstorm.json` while Arc reads it (partial JSON): the pane keeps the last good contents; only a second consecutive bad read shows the error. Pinned in Task 4 (`pollBrainstormOnce` tests).
2. A multi-line, tab-filled or blank answer or edit: one line is typed, blank types nothing and Enter does nothing; Shift+Enter inserts a newline. Pinned in Task 1 (`brainstormLine` tests) and Task 5's acceptance.
3. A `question.part`, `history[].into` or `check.calls[].part` naming a part that does not exist: the raw id is shown, nothing throws. Pinned in Task 1.
4. The file deleted while attached (feature shipped): the pane says it is gone and offers Back to terminal; the poller stops reading it. Pinned in Task 4 (`removed: true`) and shown by Task 8 step 12.
5. A reveal of a second topic from the same agent: the new topic replaces the old one on that agent (one brainstorm per agent), and the tab meta follows. Pinned in Task 4 (`attachBrainstorm` test).

---

### Task 1: Pure brainstorm model
**Depends on:** none
**Model:** claude-sonnet-5-5
**Files:** `frontend/app/view/agents/brainstormmodel.ts`, `frontend/app/view/agents/brainstormmodel.test.ts`

Everything the pane, tree, popup, roster and approve flow derive from the file, with no React and no RPC. Reuse `canvasmodel.ts` path helpers (`canvasDir`, `prototypePath`, its `join`/separator handling: paths may be `\` or `/`); don't duplicate them.

**Interfaces (Produces; later tasks import these exact names):**

```ts
export const BRAINSTORM_POLL_MS = 3000;
export const BUILDER_PART = "builder";
export type PartState = "yours" | "guess" | "asked" | "open";
export type BrainstormPart = { id: string; title: string; state: PartState; from?: string; body: string; boards?: string[]; was?: string; why?: string };
export type BrainstormQuestion = { n: number; text: string; part: string };
export type HistoryEntry = { kind: "question" | "recon"; n?: number; q: string; a: string; into: string[] };
export type BuilderQuestion = { q: string; why?: string; a?: string; into?: string };
export type BuilderCall = { text: string; part?: string };
export type BuilderCheck = { yours: BuilderQuestion[]; calls: BuilderCall[]; answered: string[]; touched?: string[] };
export type BrainstormFile = { v: 1; title: string; spec: string; canvas?: string; question: BrainstormQuestion | null; working: string | null; parts: BrainstormPart[]; history: HistoryEntry[]; done: boolean; check: BuilderCheck | null; run: string | null; compacted?: number };
export type ParseResult = { ok: true; file: BrainstormFile } | { ok: false; error: string };
export function parseBrainstorm(text: string): ParseResult;
export function brainstormFilePath(cwd: string, topic: string): string;          // <cwd>/.superpowers/brainstorm/<topic>/brainstorm.json
export function parseBrainstormPath(path: string): { cwd: string; topic: string } | null; // inverse; same regex shape as Task 2's Go one
export function brainstormCounts(f: BrainstormFile): { yours: number; guesses: number; open: number }; // open counts asked + open
export function canCheck(f: BrainstormFile): boolean;                             // done && parts.length > 0 && every part yours
export function isAsking(f: BrainstormFile): boolean;                             // question != null && working == null
export function asksUser(f: BrainstormFile | null, agent: Pick<AgentVM, "state" | "atPrompt">): boolean; // isAsking && (state === "idle" || atPrompt === true)
export function withBrainstorm(agent: AgentVM, f: BrainstormFile | null, now: number): AgentVM; // asksUser -> state "asking", blockedMs from idleSince; else unchanged (same object)
export type TreeLine = { lead: "Brainstorm" | "Brainstorm done"; text: string; runId?: string };
export function treeLine(f: BrainstormFile, asking: boolean): TreeLine;
export type BrainstormAction =
  | { kind: "answer"; text: string } | { kind: "guess" } | { kind: "skip" }
  | { kind: "confirm"; part: string } | { kind: "edit"; part: string; text: string }
  | { kind: "keep"; part: string } | { kind: "restore"; part: string }
  | { kind: "check" } | { kind: "builder-answer"; text: string }
  | { kind: "approved" } | { kind: "keep-talking" };
export function brainstormLine(a: BrainstormAction): string | null;              // null when a text action is blank
export function partTitle(f: BrainstormFile, id: string): string;               // title, or the raw id when unknown
export type HistoryRow = { label: string; q: string; a: string; into: { id: string; title: string }[] };
export function historyRows(f: BrainstormFile): HistoryRow[];                   // newest first; label "Q<n>" or "Recon"
export function orderedParts(f: BrainstormFile): BrainstormPart[];              // file order, the builder part moved last
export type SentenceDiff = { kind: "same" | "added" | "removed"; text: string }[];
export function sentenceDiff(was: string, now: string): SentenceDiff;           // split after . ! ? + whitespace, LCS
export type HandoffView = { questions: number; open: BuilderQuestion | null; answered: BuilderQuestion[]; calls: BuilderCall[]; callsByPart: Record<string, string[]>; touched: BrainstormPart[]; untouched: BrainstormPart[]; canApprove: boolean };
export function handoffView(f: BrainstormFile): HandoffView;                    // touched absent -> every part touched
export function handoffSummary(f: BrainstormFile): string;
export function compactedSummary(f: BrainstormFile): string;
export function exitedSummary(f: BrainstormFile): string;
export function resumePrompt(path: string): string;
export function runPrefill(f: BrainstormFile, a: { projectName: string; cwd: string }): NewRunPrefill; // from jarvis/newrun.ts
export function runLine(projectName: string): string;
export function brainstormAttention(a: { agentId: string; agentName: string; topic: string }, f: BrainstormFile): AttentionItem;
export type PaneView = "error" | "removed" | "exited" | "check" | "board" | "design";
export function paneView(s: { file: BrainstormFile | null; error: string | null; removed: boolean; exited: boolean; showDesign: boolean; board: string | null }): PaneView;
```

**Rules the tests pin (exact copy):**
- `parseBrainstorm`: invalid JSON -> `{ok:false}` whose error starts `brainstorm.json is not valid JSON:`; `v` not 1 -> error naming the version; missing or non-string `title`, missing `parts` array -> error naming the field; a part with an unknown state -> error naming the part id and the state; duplicate part ids -> error naming the id. Optional fields default: `question: null`, `working: null`, `history: []`, `done: false`, `check: null`, `run: null`, `spec: ""`. A bare-string call becomes `{text}`. `question.part` that names no part is accepted.
- `brainstormLine`: answer -> the text; guess `brainstorm: guess`; skip `brainstorm: skip questions`; confirm `brainstorm: confirm <id>`; edit `brainstorm: edit <id>: <text>`; keep `brainstorm: keep <id>`; restore `brainstorm: restore <id>`; check `brainstorm: check`; builder-answer `brainstorm: builder answer: <text>`; approved `brainstorm: approved`; keep-talking `brainstorm: keep talking`. `"a\n\tb  c\r\n"` -> `"a b c"`; `"  \n "` -> null.
- `treeLine`: run set -> `{lead:"Brainstorm done", text:"run <first 8 of id>", runId}`; asking -> `"asking question <n>"`; check set -> `"builder check"`; working set -> `"writing up your answer"`; else `"in progress"`; lead `"Brainstorm"` for all but done.
- `compactedSummary`: `The agent compacted its context and re-read its brainstorm file: 5 parts yours, 2 guesses, 1 open. Nothing was lost.` (singulars `1 part yours`, `1 guess`).
- `exitedSummary` with a question: `The brainstorm is saved: 5 parts yours, 2 guesses, and question 5 still unanswered. A new agent reads it and carries on from that question.`; without one: `The brainstorm is saved: 5 parts yours, 2 guesses. A new agent reads it and carries on.`
- `handoffSummary`: open 0 and done -> `8 yours · nothing open · the agent has no more questions`; else `<y> yours · <o> open`.
- `resumePrompt(p)` = `Resume the brainstorm in ${p} with arc:brainstorm.`
- `runPrefill`: `{ projectName, shape: "orchestrator", goal: "Build <title> as specified in <absolute spec path>.", prototype? }`; a relative `spec` is joined to `cwd`; `prototype` = `<cwd>/.superpowers/design/<canvas>/project/<the first board any part lists, in part order>` (built with `canvasProjectDir(canvasDir(cwd, canvas))`), only when `canvas` is set and some part lists a board (P11). Tests: a canvas with parts listing `Page.dc.html` then `Other.dc.html` -> `…\project\Page.dc.html`; no listed board -> no `prototype`. `runLine("siem-pipeline")` = `siem-pipeline · orchestrator · this design attached`.
- `brainstormAttention`: `kind: "brainstorm"`, `key: "brainstorm:<agentId>:<n>"`, `source: agentName`, `text: question.text`, `reason: For “<part title>” · question <n>`, `action: "brainstorm"`, `oref: "brainstorm:<topic>"`, `phaseidx: 0`, `waitingsince: 0`.
- `handoffView`: `questions` = yours + calls + answered lengths; `open` = first `yours` entry with no `a`; `canApprove` = no unanswered yours and `run == null`; `callsByPart` groups call texts by part id (calls with no part only in `calls`).
- `paneView` precedence: removed > error (only with no last good file) > exited (unless `showDesign`, and never once `run` is set) > board (when `board` set) > check (when `check` set) > design.

- [ ] **Step 1:** Write `brainstormmodel.test.ts` covering every rule above, including Review Focus 2 and 3 (unknown part ids render as the raw id in `partTitle`, `historyRows` and `callsByPart`), the builder part moved last, and `withBrainstorm` returning the same object when not asking. Run `npx vitest run frontend/app/view/agents/brainstormmodel.test.ts`: FAIL.
- [ ] **Step 2:** Implement `brainstormmodel.ts` to the interfaces. Run the same command: PASS.
- [ ] **Step 3:** Commit.

### Task 2: Hook reveal, skill context, meta key
**Depends on:** none
**Model:** claude-sonnet-5-5
**Files:** `cmd/wsh/cmd/wshcmd-agenthook.go`, `cmd/wsh/cmd/wshcmd-agenthook_test.go`, `cmd/wsh/cmd/wshcmd-installhooks.go`, `cmd/wsh/cmd/wshcmd-installhooks_test.go`, `cmd/wsh/cmd/wshcmd-ui.go`, `pkg/waveobj/wtypemeta.go`, `pkg/waveobj/metaconsts.go`, `frontend/types/gotypes.d.ts`

Decisions:
- `brainstormRevealFor(ev ccHookEvent) (address, cwd string, ok bool)`: PostToolUse of Write/Edit/MultiEdit whose `file_path` matches `(?i)^(.+?)[\\/]\.superpowers[\\/]brainstorm[\\/]([^\\/]+)[\\/]brainstorm\.json$` with an absolute project -> `"brainstorm:"+topic`, project. Called beside `canvasRevealFor` in `agentHookRun`, same best-effort `UiRevealCommand` and debug line. Comment that the regex mirrors `parseBrainstormPath` in `brainstormmodel.ts`.
- `--skill-context` flag on `agent-hook`: reads the event, and when `brainstormContextFor(ev)` is ok writes `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":<text>}}` to stdout and returns, with no RPC and no status publish. Still a no-op outside Arc (`WAVETERM_BLOCKID` unset). `brainstormContextFor` is ok for PostToolUse, tool `Skill`, `tool_input.skill` equal to `superpowers:brainstorming` or `brainstorming`. The text: `You are inside Arc. Also follow the arc:brainstorm skill for this brainstorm: keep its state in .superpowers/brainstorm/<topic>/brainstorm.json, where Arc shows it, instead of long playbacks in the terminal; use arc:design boards instead of the visual companion's server.`
- `managedHooks` gains `{Event: "PostToolUse", Matcher: "Skill", Args: "agent-hook --skill-context", Timeout: 10}` (synchronous: no `Async`).
- `pkg/waveobj/wtypemeta.go`: `SessionBrainstorm string \`json:"session:brainstorm,omitempty"\`` (tab: absolute path of the brainstorm.json the session's agent writes), next to `SessionEffort`; then `task generate`.
- `wshcmd-ui.go` reveal help lists `brainstorm:<topic>`.

- [ ] **Step 1:** Tests in `wshcmd-agenthook_test.go`: `TestBrainstormRevealFor` (Write on a matching path -> `brainstorm:consumer-lag-alerts` and the project, both `\` and `/`; Read, a non-matching name, a relative path, a PreToolUse -> not ok); `TestBrainstormContextFor` (both skill names ok; `superpowers:writing-plans`, a non-Skill tool, PreToolUse -> not ok; the JSON written by the `--skill-context` path parses with `hookSpecificOutput.hookEventName == "PostToolUse"`). In `wshcmd-installhooks_test.go`, `TestManagedHooksSkillContext`: `managedHooks` holds exactly one PostToolUse entry with matcher `Skill` and args `agent-hook --skill-context`, and it is not async. Run `go test ./cmd/wsh/cmd -run '^(TestBrainstormRevealFor|TestBrainstormContextFor|TestCanvasRevealFor|TestManagedHooksSkillContext)$'`: FAIL.
- [ ] **Step 2:** Implement; `task generate`. Run the tests: PASS. `go vet ./cmd/wsh/cmd/ ./pkg/waveobj/`.
- [ ] **Step 3:** Commit.

### Task 3: The arc:brainstorm skill
**Depends on:** none
**Model:** claude-opus-5-5
**Files:** `skills/brainstorm/SKILL.md`, `skills/skills.go`, `cmd/wsh/cmd/claude-mod/skills/brainstorm/SKILL.md`, `AGENTS.md`

Write `skills/brainstorm/SKILL.md` (frontmatter `name: brainstorm`, a description that fires whenever `superpowers:brainstorming` runs inside Arc, i.e. `wsh` on PATH). It holds, from the spec's "The file", "The lines Arc types" and "What the skill says" sections plus P4/P5: the full file format with an example; every `brainstorm:` line and what the agent does with it (including `keep talking`: set `done: false`, ask the next question); the rules list. Sequencing the pane depends on, stated as rules:
- On an answer: append the exchange to `history` (with `into`), set `question: null`, set `working` to `Writing “<part title>” from your answer.`, keep that part `asked`, write the file; then write the part (`guess`, or `yours` when the user's own words are the part), clear `working`, set the next `question` (its part created as `asked` if new), write the file, and end the turn with the question in the terminal too.
- The first message: pick `<topic>`, create the file with question 1 and its part `asked`, history empty; reveal with `wsh ui reveal brainstorm:<topic>` (Claude's hook also reveals on every write).
- After a compaction: re-read the file first, set `compacted` to the current Unix ms, write it back.
- Builder check (`brainstorm: check`): write the spec at `spec`, run the builder check, fill `check` (`yours` with `q`/`why`, `calls` as `{text, part}`, `answered`, `touched`); on `brainstorm: builder answer: …` record `a` and `into` on that entry and fold the answer into the part. On `brainstorm: approved` stop; Arc opens the launcher. When a run starts the user tells the agent the run id or the agent reads it with `wsh runs`; it writes `run`.
- `Left to the builder` (id `builder`) is always the last part; the agent writes it as a `guess` once nothing is left to ask.
- Never write the file partially by hand-editing in place with a broken intermediate state; write the whole JSON each time.

Add `brainstorm` to the `//go:embed` line in `skills/skills.go`; run `task sync:claudemod` so the tracked copy under `cmd/wsh/cmd/claude-mod/skills/brainstorm/` is regenerated (never edit it by hand); update AGENTS.md's skills list "(cockpit, design, initiatives, notes, runs)" to include brainstorm.

- [ ] **Step 1:** Write the skill; embed; sync. Run `go test ./pkg/agentsync -run 'Skill'` and `go vet ./skills/`: PASS. Run `claude plugin validate claude/arc-mod` if `claude` is on PATH, else say so in the task report.
- [ ] **Step 2:** Commit.

### Task 4: Store, poller, address, restart re-attach, roster overlay, exit signal
**Depends on:** Task 1, Task 2
**Model:** claude-opus-5-5
**Files:** `frontend/app/view/agents/brainstormstore.ts`, `frontend/app/view/agents/brainstormstore.test.ts`, `frontend/app/view/agents/brainstormpoller.ts`, `frontend/app/view/agents/brainstormpoller.test.ts`, `frontend/app/view/jarvis/address.ts`, `frontend/app/view/jarvis/address.test.ts`, `frontend/app/view/jarvis/openref.ts`, `frontend/app/view/jarvis/openref.test.ts`, `frontend/app/cockpit/uiapi.ts`, `frontend/app/cockpit/uiapi.test.ts`, `frontend/app/cockpit/uiclient.ts`, `frontend/app/view/agents/agentcontrollerstore.ts`, `frontend/app/view/agents/agents.tsx`, `frontend/app/view/agents/agentsviewmodel.ts`, `frontend/app/view/agents/liveagents.ts`, `frontend/app/view/agents/session-models/sessionsidebarmodel.ts`, `frontend/app/view/agents/session-models/sessionviewmodel.ts`, `frontend/app/cockpit/cockpit-root.tsx`

**Interfaces (Produces):**

```ts
// brainstormstore.ts
export type BrainstormState = {
  topic: string; path: string; cwd: string;
  mode: "terminal" | "brainstorm";
  file: BrainstormFile | null;      // last good contents
  error: string | null;             // shown only after 2 consecutive failed reads
  failedReads: number;
  removed: boolean;
  modifiedMs: number | null;        // the file's mod time last read
  lastViewedMs: number;             // when brainstorm mode was last shown (compaction banner, unseen)
  board: string | null;             // a board opened full size, else null
  showDesign: boolean;              // "Open the design" pressed on the exited card
  boards: CanvasBoard[];            // from the canvas's canvas.json, for thumbnail sizes
  base: string | null;              // where wavesrv serves the project's design folder
};
export const brainstormsAtom: PrimitiveAtom<Record<string, BrainstormState>>;
export const brainstormAtom: (agentId: string) => Atom<BrainstormState | null>; // atomFamily over brainstormsAtom
export function getBrainstorm(agentId: string): BrainstormState | null;
export function updateBrainstorm(agentId: string, fn: (s: BrainstormState) => BrainstormState): void;
export function attachBrainstorm(agentId: string, a: { topic: string; cwd: string }, now: number): void; // a different topic replaces the old state
export function detachBrainstorm(agentId: string): void;
export async function dismissBrainstorm(agentId: string): Promise<void>; // detach, then clear tab meta session:brainstorm (null) so reconcile does not re-attach; a meta failure is logged with context, the detach stands
export function brainstormOwner(topic: string): string | null;
export function setBrainstormMode(agentId: string, mode: "terminal" | "brainstorm", now: number): void; // entering sets lastViewedMs
export function openBrainstormBoard(agentId: string, board: string | null): void;
export function focusedBrainstorm(model: AgentsViewModel): BrainstormState | null;
// agentcontrollerstore.ts
export function getProcExitAtom(blockId: string): PrimitiveAtom<{ code: number; at: number } | undefined>;
// agentsviewmodel.ts
AgentVM.brainstormFile?: string; LiveAgentInput.brainstormFile?: string;   // from tab meta session:brainstorm
// address.ts
OpenTarget gains { kind: "brainstorm"; topic: string }
// brainstormpoller.ts
export type BrainstormIO = { stat(path: string): Promise<{ exists: boolean; modifiedMs: number | null }>; read(path: string): Promise<string>; serve(designDir: string): Promise<string | null>; canvasJson(url: string): Promise<unknown> };
export async function pollBrainstormOnce(s: BrainstormState, io: BrainstormIO): Promise<Partial<BrainstormState>>;
export function reconcileBrainstorms(
  attached: Record<string, Pick<BrainstormState, "path">>,
  roster: { id: string; brainstormFile?: string }[]
): { attach: { agentId: string; topic: string; cwd: string }[]; detach: string[] };
export function BrainstormPoller({ model }: { model: AgentsViewModel }): null;
// uiapi.ts
export function revealLeavesTrail(address: string, attached: { canvas?: string; brainstorm?: string }): boolean; // was (address, attachedTopic)
```

Decisions:
- `pollBrainstormOnce`: missing file -> `{removed: true}`; same `modifiedMs` as last read and no pending failure -> `{}` (no read); a good read -> `{file, error: null, failedReads: 0, removed: false, modifiedMs}`; a bad read -> `failedReads + 1`, keeping `file`, and `error` set only when `failedReads` reaches 2. When the file names a `canvas` and a part lists boards and `base` is null: ask `serve(canvasDesignDir(cwd))` once and read `canvas.json` through it with `boardsFromCanvasJson`. Reuse `tauriCanvasIO.serve`/`get` from `canvaspoller.ts` for the IO; `stat` is `FileInfoCommand` (`notfound`, `modtime`), `read` is `FileReadCommand` (base64 data).
- `BrainstormPoller` (mounted in `cockpit-root.tsx` beside `AttentionPoller`): every `BRAINSTORM_POLL_MS` polls every attached state (one in flight per agent, results dropped if the state's path changed meanwhile, as `pollAndMerge` does), and applies `reconcileBrainstorms(get(brainstormsAtom), [...agents, ...terminals])`. `reconcileBrainstorms` (pure, P2): attach each roster agent whose `brainstormFile` parses with `parseBrainstormPath` and has no state, or whose state's `path` differs from it; never attach an unparsable path; detach each attached id absent from the roster, but only when the roster is non-empty (boot).
- `uiapi.ts` (P12): `revealWaitsForUser` returns false for a `brainstorm` address with a caller, as for `canvas`; `revealLeavesTrail(address, attached)` returns false when the target is a canvas whose topic is `attached.canvas` or a brainstorm whose topic is `attached.brainstorm`. `uiclient.ts` passes both topics of the caller's agent (`getCanvas(id)?.topic`, `getBrainstorm(id)?.topic`), replacing `canvasTopic`.
- `address.ts`: `brainstorm:<topic>` parsed with `isCanvasSegment`; anything else unsupported. `openref.ts` mirrors the canvas landing: with a caller, find the roster agent (agents + terminals) by `blockId`, check the file exists at `brainstormFilePath(caller.cwd, topic)` (else unavailable `No brainstorm at <path>`), `attachBrainstorm` without switching surface or mode, and write tab meta `session:brainstorm` = that path via `SetMetaCommand` on `tab:<agentId>` (a failure is logged with context, the attach stands); with no caller, land on `brainstormOwner(topic)` in brainstorm mode and `jumpToAgent` (none -> unavailable `No agent has the brainstorm <topic> open`). Label `brainstorm <topic>`. Add `brainstorm` wherever `openref.ts` special-cases `canvas` (the kind lists near lines 142 and 158).
- Roster overlay: `agents.tsx` wraps `mergePendingLaunches(...)` so each agent goes through `withBrainstorm(agent, get(brainstormsAtom)[agent.id]?.file ?? null, now)`.
- `agentcontrollerstore.ts`: the existing `controllerstatus` subscription also sets `getProcExitAtom(blockid)` to `{code: shellprocexitcode, at: Date.now()}` when `shellprocstatus === "done"`, and clears it on `"running"`.
- `session:brainstorm` flows tab meta -> `sessionsidebarmodel.ts` -> `sessionviewmodel.ts` -> `liveagents.ts` -> `AgentVM.brainstormFile`, as `session:effort` does.

- [ ] **Step 1:** Tests. `brainstormpoller.test.ts` (fake IO): missing -> removed; unchanged mod time -> no read; good read; one bad read keeps the file and no error; two bad reads set the error and keep the file; a good read after clears it (Review Focus 1, 4); the canvas serve is asked once. `brainstormstore.test.ts`: attach a second topic replaces the first (Review Focus 5); `setBrainstormMode("brainstorm")` sets `lastViewedMs`; `brainstormOwner`; `dismissBrainstorm` detaches and calls `SetMetaCommand` with `tab:<id>` and `session:brainstorm: null`, and still detaches when that call rejects. `brainstormpoller.test.ts` also covers `reconcileBrainstorms`: a roster agent with a brainstorm file and no state -> attach with the parsed topic and cwd; a state whose path differs -> attach; an unparsable path -> nothing; an attached id missing from a non-empty roster -> detach; an empty roster -> no detach. `address.test.ts`: `brainstorm:consumer-lag-alerts` parses; `brainstorm:../x`, `brainstorm:` refused. `openref.test.ts` (`describe("brainstorm landing")`, mocking `SetMetaCommand` beside `FileInfoCommand`): with a caller, the file missing -> unavailable naming `No brainstorm at <path>`; with a caller and the file present -> `{ok: true}`, the state attached in terminal mode without a surface switch, and `SetMetaCommand` called with `tab:<id>` and `session:brainstorm` = the path; a meta write that rejects still attaches; a caller block in no roster row -> unavailable naming `wsh ui reveal brainstorm:<topic>`; no caller with an owner -> owner in brainstorm mode and focused; no caller, no owner -> `No agent has the brainstorm <topic> open`. `uiapi.test.ts`: a brainstorm reveal with a caller does not wait; without one it waits; no trail when the caller already has that brainstorm topic, a trail for a different topic; the canvas cases still pass. Run `npx vitest run frontend/app/view/agents/brainstormpoller.test.ts frontend/app/view/agents/brainstormstore.test.ts frontend/app/view/jarvis/address.test.ts frontend/app/view/jarvis/openref.test.ts frontend/app/cockpit/uiapi.test.ts`: FAIL.
- [ ] **Step 2:** Implement. Same command: PASS. `task check:ts` clean.
- [ ] **Step 3:** Commit.

### Task 5: The brainstorm pane
**Depends on:** Task 4
**Model:** claude-opus-5-5
**Files:** `frontend/app/view/agents/brainstormpane.tsx`, `frontend/app/view/agents/brainstormsend.ts`, `frontend/app/view/agents/brainstormsend.test.ts`, `frontend/app/view/agents/canvaspane.tsx`

**Interfaces (Produces):** `export function BrainstormPane({ model, agent }: { model: AgentsViewModel; agent: AgentVM }): JSX.Element | null` in `brainstormpane.tsx`. `brainstormsend.ts`: `export async function sendBrainstorm(agent: AgentVM, action: BrainstormAction, io?: Pick<SendIO, "type">): Promise<void>` (throws `Nothing to send` for a blank line, `This agent has no terminal to type into` with no `blockId`, `Couldn't type into <name>: <err>` on failure; types the line plus `\r`); `export function approveAndOpenRun(model, agent, s: BrainstormState): Promise<void>` (types `brainstorm: approved`, then sets `newRunPrefillAtom` to `runPrefill(...)` and opens `model.newRunOpenAtom`); `export function openRunLauncher(model, agent, s)` (Change: the prefill alone). `canvaspane.tsx` gains an optional `onBack?: () => void` prop that, when set, draws a `Back to the design` `CANVAS_BTN` first in its toolbar and hides `Build this…`.

Draw every view the canvas draws, by `paneView` (Task 1). Data attributes are the scenario's contract (Task 8 queries them; keep them exact):
- Root `data-brainstorm-pane` with `data-brainstorm-view="<PaneView>"`.
- **design** (Main board): toolbar row (topic in mono, then counts `data-brainstorm-counts` as `<n> yours`, `<n> guesses`, `<n> open` with the board's dot styles, then `Check with a builder` `CANVAS_PRIMARY_BTN` `data-brainstorm-check-btn`, disabled with title `Opens when the agent has nothing left to ask and every part is yours` unless `canCheck`; it sends `check`). Left column 430 px: when history is empty the hint `Rather skip the questions and have me start? Say so.`; the question card `data-brainstorm-question` (amber dot, `Question <n>`, right side `for <part title>` linking to the part, question text, textarea `data-brainstorm-answer` with placeholder `Answer in your own words…`, chips `Guess for me` (hidden while history is empty) and `Skip the questions`, `Enter sends` hint); Enter sends `answer`, Shift+Enter inserts a newline, Enter during IME composition does nothing, a blank answer sends nothing. While `working` is set, the working card `data-brainstorm-working` (green dot, `Working`, `<working> The next question comes after.`) replaces it and every typing control is disabled with title `The agent is writing; this opens when it asks again` (P6). `Earlier` list `data-brainstorm-history` of `historyRows`: label (the newest gets ` · just now` while `working` is set), q, a, `Went into <titles>` (each scrolls its part into view). Right column: sticky head (`Design` `written as you talk`, legend Yours / Agent’s guess / Open, title h1, spec path in mono with ellipsis); then `orderedParts`, each `data-brainstorm-part="<id>"` with `data-state` = `yours | guess | changed | asked | writing | open` (`changed` = guess with `was`; `writing` = asked while `working` set and no question): yours (green dot, `Yours`, `from`, quiet `Edit`), guess (dashed border, `Agent’s guess · <from>`, `That’s right` and `Edit`), changed (accent border, `Changed since you confirmed it`, `Keep the change`, `Put mine back`, body, the `sentenceDiff` with `+ ` lines on a success tint and `− ` lines on an error tint, `Why: <why>`), asked (amber border, `Asked now`, body or `Waiting on your answer to the question on the left.`), writing (green dot, `Being written`, three skeleton bars), open (hollow dot, `Open`). With no history the hint `Parts appear here as the conversation finds them. Nothing else exists until you have said something.` follows the parts. Edit opens an inline textarea prefilled with the body; Enter sends `edit`, Escape cancels.
- **Thumbnails** (P7): for each board a part lists, `data-brainstorm-thumb="<board>"`: a 300 px wide frame, at most 200 px tall, the served board in a sandboxed iframe scaled to 300/board width (width from `boards`, else `DEFAULT_BOARD_W`), `pointer-events: none`; beside it `<board> · option <A..> of <n>` (only with more than one board) and an `Open full size` link `data-brainstorm-open-board`. No thumbnail until `base` is known.
- **board**: `<CanvasPane onBack=...>` for the brainstorm's canvas; Open full size first `attachCanvas(agentId, { topic: canvas, dir: canvasDir(cwd, canvas), projectDir: cwd, board })`, then `openBrainstormBoard`; back clears `board`.
- **check** (Handoff board): toolbar with `handoffSummary`; left column: `A builder read the design` and `A fresh agent checked whether it could plan from this without coming back to you. It had <n> questions; this is where they went.`; the open builder question card `data-brainstorm-builder-question` (`Only you can answer · <n>`, q, why, textarea, Enter sends `builder-answer`); each answered one as `You answered` card (`<a> Added to <into>.`); `The agent’s calls · <n>` `marked in the design, check them as you read`; `Answered already · <n>` `written into the design`. Right: the finished design (title, spec path) listing `touched` parts with their calls inline as `Agent’s call` chips on `accentbg`, and `Show the <n> parts the builder did not touch` expanding the rest. Approve bar `data-brainstorm-approve-bar`: `Approve and start an orchestrator run`, `runLine` + `Change` (opens the launcher), `Keep talking` (sends `keep-talking`), `Approve and start run` `data-brainstorm-approve` disabled with title `Answer the builder’s question first` unless `canApprove`. With `run` set the bar reads `Run <id8> started` with `Open run` (openTarget run).
- **exited** (States board): centered card `data-brainstorm-exited`: red dot, `<name> exited with code <code> at <HH:MM>`, `exitedSummary`, `Resume in a new agent` (`data-brainstorm-resume`, `CANVAS_PRIMARY_BTN`: `launchAgent(model, { runtime: agent.agent ?? "claude", startupCommand: runtimeStartupCommand(runtime), task: resumePrompt(path), projectPath: cwd, projectName: projectOf(agent) })`), `Open the design` (sets `showDesign`), and `Last output: <line>` from the last non-empty line of `TermGetScrollbackLinesCommand` routed to the block (omitted when that read fails; the failure is logged).
- **error**: `EdgeState`-style: `Arc could not read this brainstorm`, the parse error, the path in mono. **removed**: `<topic>'s brainstorm file is gone`, `Back to terminal` (`dismissBrainstorm`).
- Every send failure shows inline under the control that sent it in `text-error`; nothing is swallowed.

- [ ] **Step 1:** `brainstormsend.test.ts` with a fake `type`: each action types `brainstormLine(...) + "\r"` to the agent's block; blank answer throws `Nothing to send` and types nothing; no `blockId` throws; approve types `brainstorm: approved` before setting the prefill. Run `npx vitest run frontend/app/view/agents/brainstormsend.test.ts`: FAIL, implement, PASS.
- [ ] **Step 2:** Build the pane. `task check:ts` clean. Every view and interaction is shown by Task 8's scenario: design (steps 1, 2), the post-answer question and new Earlier row (2), Guess for me, Skip the questions, inline Edit with Escape and with Enter, Shift+Enter newline (2), the two-board thumbnail label (2), board (3), working (4), changed with Keep the change and Put mine back (5), check with Show the N parts and Keep talking (8), Change, Approve and the run-started bar (9), exited (10), error (11), removed with Back to terminal (12). Keep the data attributes above exact so those steps can find them; give the inline edit textarea `data-brainstorm-edit` and the untouched-parts toggle `data-brainstorm-untouched`.
- [ ] **Step 3:** Commit.

### Task 6: Agent surface wiring: switcher, key, banner, tree line
**Depends on:** Task 5
**Model:** claude-opus-5-5
**Files:** `frontend/app/view/agents/agentsurface.tsx`, `frontend/app/view/agents/agentheader.tsx`, `frontend/app/view/agents/agenttree.tsx`, `frontend/app/store/keybindings/bindings.ts`, `frontend/app/store/keybindings/whenstate.ts`, `frontend/app/store/keybindings/whenstate.test.ts`, `frontend/app/store/keybindings/store.test.ts`, `docs/keyboard-shortcuts.md`

Decisions:
- An agent with a brainstorm never shows canvas mode (spec 8): the header renders `Segmented` `role="group"` `ariaLabel="Show terminal or brainstorm"` with `Terminal` / `Brainstorm` (titles carry `(b)` via `formatChordString`), an amber dot (`aria-label="asking you"`) inside Brainstorm while `asksUser`; the Canvas switcher and the tree's `CanvasTag` are hidden for that agent; the `c` canvas bindings stand down (`&& focusedBrainstorm(model) == null`). In terminal mode a hint follows the switcher: a `B` keycap and `switch view` (States board).
- `agentsurface.tsx`: `brainstormMode` hides the terminal (class `hidden`, never unmounted) and renders `<BrainstormPane>`; entering blurs the xterm and leaving refocuses it, as the canvas branch does; the details rail and composer hide in brainstorm mode as they do in canvas mode.
- Compaction banner `data-brainstorm-compacted` above the terminal in terminal mode while `file.compacted > lastViewedMs`: accent dot and `compactedSummary(file)`, styled as the States board's banner.
- Keys: `agent:brainstorm-open` (`b`, when the focused agent has a brainstorm in terminal mode) and `agent:brainstorm-close` (`b`, in brainstorm mode), exclusive `when()`s; brainstorm mode stands down the same agent keys canvas mode does. `watchFocusedCanvas` in `whenstate.ts` is extended to also subscribe the focused agent's `brainstormAtom` (re-subscribed on a focus switch, unsubscribed on stop), so `hints-footer.tsx`, which already starts it, is unchanged; update its comment. Keep `assertNoConflicts` green; document `b` in `docs/keyboard-shortcuts.md`.
- Tree row (`agenttree.tsx`): for an agent with a brainstorm file, the second line's branch text is replaced by `data-brainstorm-tree-line`: `treeLine(...)`'s `lead` in `text-warning` (in `text-ink-mid` for done), a muted `·`, the text in `text-ink-mid`; for done the text is a link opening the run (`openTarget(model, { kind: "run", runId })`, click stops propagation). The row's dot and tint already read asking through the roster overlay.

- [ ] **Step 1:** Add to `store.test.ts` a case that the two `b` bindings never both match and that building every surface's bindings raises no conflict; add to `whenstate.test.ts` (`describe("watchFocusedCanvas")`) a case that a change to the focused agent's brainstorm bumps `whenVersionAtom`, an unfocused agent's does not, a focus switch moves the subscription, and stop ends it. Run `npx vitest run frontend/app/store/keybindings/store.test.ts frontend/app/store/keybindings/whenstate.test.ts`: FAIL, implement, PASS. `task check:ts` clean.
- [ ] **Step 2:** Shown by Task 8's scenario: the switcher and the xterm kept across swaps (steps 1, 6), `b` (step 6), the banner (step 6), the tree line (step 7). Keep `data-brainstorm-compacted` and `data-brainstorm-tree-line` exact.
- [ ] **Step 3:** Commit.

### Task 7: The brainstorm question in the desktop popup
**Depends on:** Task 4
**Model:** claude-sonnet-5-5
**Files:** `frontend/app/view/agents/attentionpoller.tsx`, `frontend/app/view/agents/attentionpopup.ts`, `frontend/app/view/agents/attentionpopup.test.ts`, `frontend/app/view/agents/attentionpopuptarget.ts`, `frontend/app/view/agents/attentionpopuptarget.test.ts`, `frontend/app/view/jarvis/bubblecard.tsx`, `frontend/tauri/popup.tsx`

Decisions:
- `attentionpoller.tsx`: a derived atom of `brainstormAttention(...)` for every agent whose brainstorm `asksUser`; the taskbar and popup effect runs on `[...attention, ...brainstormItems]` (server items first, so their rank wins), and re-runs when either changes. The in-app attention lists are untouched (P10).
- `PopupBubble` gains `kind?: "brainstorm"` and `detail?: string`. `popupBubble` maps a `kind: "brainstorm"` item to `{ kind, label: "<source> · brainstorm", name: undefined, text: item.text, detail: item.reason }`. `attentionpopup.ts` stays import-free at runtime.
- `BubbleCard` gains optional `detail?: ReactNode`, drawn under the text in `text-[12px] text-ink-mid` with `data-<marker>-detail`. `popup.tsx` passes `dot="bg-warning"` and `tone="text-warning"` for a brainstorm bubble, and `detail`.
- `popupTarget`: a `kind: "brainstorm"` item lands through `parseAddress(item.oref)` (the brainstorm address, Task 4's owner landing in brainstorm mode), before `askAgent`.

- [ ] **Step 1:** Tests: `attentionpopup.test.ts` (a new brainstorm item while unfocused -> the bubble above, exact label `lag-alerts · brainstorm` and detail `For “What on-call sees” · question 5`; focused -> null; an item already seen -> null); `attentionpopuptarget.test.ts` (a brainstorm item -> `{kind: "brainstorm", topic}` even when its source names a roster agent). Run `npx vitest run frontend/app/view/agents/attentionpopup.test.ts frontend/app/view/agents/attentionpopuptarget.test.ts`: FAIL, implement, PASS. `task check:ts` clean.
- [ ] **Step 2:** Commit.

### Task 8: The brainstorm-mode CDP scenario
**Depends on:** Task 6, Task 7
**Model:** claude-opus-5-5
**Files:** `scripts/cdp/scenarios.mjs`

Add scenario `brainstorm-mode` (surface `agent`) to `scripts/cdp/scenarios.mjs` and to `SCENARIOS`. Model it on `canvas-swap` (`openCanvasTerminal`, `uireveal` with `callerblockid`/`callercwd`, `polishWaitFor`, `pressCanvasKey`) and `attention-popup` (`h.page("popup.html")`, `plugin:window|is_visible` on the popup target, the `document.hasFocus` override). Never prettier this file.

Arrange: a temp project (`mkdtempSync`) with `.superpowers/brainstorm/consumer-lag-alerts/brainstorm.json` and `.superpowers/design/consumer-lag-alerts/project/` (`canvas.json` with `Page.dc.html` and `PageB.dc.html`, both w 1440, and a small page for each); a terminal tab opened like `openCanvasTerminal`, made a roster agent by publishing an `agent:status` event for its block through `eventpublish` (shaped as `buildAgentStatusEvent` in `cmd/wsh/cmd/wshcmd-agentstatus.go` builds it: agent `claude`, state `idle`, cwd the temp project); then `uireveal brainstorm:consumer-lag-alerts` with the caller. Each step writes that step's `brainstorm.json` (contents from the canvas board for that state: the Main board's parts, history and question; Handoff's check; States' variants), waits for the pane to show it (≤ 2 poll intervals), asserts, and shoots `cdp-shots/brainstorm-mode-<n>.png`. Typed lines are asserted by reading the terminal's text (TermGetScrollbackLines routed to the block, or the `.xterm-rows` text) for the exact line. Steps, one per board state:

1. **just started** (States): Q1, one `asked` part, no history; switch with the Brainstorm segment. Assert `data-brainstorm-view="design"`, the skip hint and the parts hint, no `Guess for me`, part `data-state="asked"` with `Asked now`.
2. **mid-conversation** (Main): counts `3 yours`, `3 guesses`, `2 open`; `Question 4`, `for When it pages`; four `Earlier` rows newest first with `Went into`; `Check with a builder` disabled; part states yours×3, guess×3, asked, open; the `page` part lists `Page.dc.html` and `PageB.dc.html`, so two thumbnail iframes, the first labelled `Page.dc.html · option A of 2`. Click `That’s right` on `current` -> `brainstorm: confirm current` typed. `Edit` on `constraints` -> `data-brainstorm-edit` prefilled with the body; Escape -> closed, nothing typed; `Edit` again, replace the text, Enter -> `brainstorm: edit constraints: <text>` typed. `Guess for me` -> `brainstorm: guess`; `Skip the questions` -> `brainstorm: skip questions`. In the answer box type a line, Shift+Enter, a second line (the box now holds a newline and nothing was typed), Enter -> both lines typed as one line. Then write the next file (Main's answered state: `Question 5`, `for What on-call sees`, a new newest `Earlier` row `Q4` going into `When it pages`, `thresholds` now a guess) -> the card reads `Question 5` and the first Earlier row is `Q4`.
3. **open full size** (Main): `Open full size` on the first thumbnail -> `data-brainstorm-view="board"` with the Mark button and `Back to the design`; back -> `design`.
4. **between questions** (States): `question: null`, `working` set, `thresholds` asked -> the working card, no answer textarea, part `data-state="writing"` with `Being written`, `That’s right` buttons disabled, the newest history label ends `· just now`.
5. **a confirmed part changed** (States): `constraints` a guess with `was`/`why` -> `data-state="changed"`, `Changed since you confirmed it`, a `+ ` diff line, `Why: …`; click `Keep the change` -> `brainstorm: keep constraints` typed; click `Put mine back` -> `brainstorm: restore constraints` typed.
6. **after a compaction** (States): press `b` (first prove key delivery with an unbound probe key, as `canvas-swap` does, and fall back to clicking the `Terminal` segment when keys do not arrive; same for every `b` below) -> terminal mode (xterm visible, same node as before); write `compacted` = now -> the banner reads `The agent compacted its context and re-read its brainstorm file: 5 parts yours, 2 guesses, 1 open. Nothing was lost.`; the switcher shows Terminal pressed and the `switch view` hint. Press `b` -> brainstorm mode; press `b` again -> the banner is gone.
7. **tree row and attention popup** (States): Q5 for `page` -> the row's `data-brainstorm-tree-line` reads `Brainstorm · asking question 5` and the row's dot is the asking dot; with `document.hasFocus` overridden false, write a new question -> the popup page's card reads `<agent name> · brainstorm`, the question, `For “What on-call sees” · question 5`, and the popup window is visible; restore focus.
8. **builder check, before your answer** (Handoff): `done: true`, eight parts all yours, `check` with one unanswered `yours`, three calls with parts, two answered, `touched` naming four parts -> `data-brainstorm-view="check"`, `Only you can answer · 1`, `It had 6 questions`, `Agent’s call` chips under their parts, `Show the 4 parts the builder did not touch`, `Approve and start run` disabled with its title. Click `data-brainstorm-untouched` -> the four other parts are drawn. Click `Keep talking` -> `brainstorm: keep talking` typed. Answer the builder's question -> `brainstorm: builder answer: <text>` typed.
9. **builder check, after your answer** (Handoff): that entry with `a` and `into` -> `You answered` card ending `Added to Anti-goals.`, approve enabled. Click `Change` -> the New run window opens and no `brainstorm: approved` line was typed; close it with Escape. Click `Approve and start run` -> `brainstorm: approved` typed and the New run window open with a goal holding the absolute spec path and the prototype `…\consumer-lag-alerts\project\Page.dc.html` (P11); close it with Escape. Then write the same file with `run: "7f3a21c0-…"` -> the approve bar reads `Run 7f3a21c0 started` with `Open run`, and the tree line reads `Brainstorm done · run 7f3a21c0`.
10. **agent exited** (States): publish a `controllerstatus` event for the block (`shellprocstatus: "done"`, `shellprocexitcode: 1`) -> `data-brainstorm-exited` reads `<name> exited with code 1 at`, the `exitedSummary` text, `Resume in a new agent` present (not clicked: it would launch a real agent); `Open the design` -> `design`.
11. **unreadable file**: write invalid JSON -> after two polls `data-brainstorm-view="error"` with the parse error and the path.
12. **file gone**: delete `brainstorm.json` -> `data-brainstorm-view="removed"` reading `consumer-lag-alerts's brainstorm file is gone`; click `Back to terminal` -> the pane is gone, the terminal is visible, and the header has no brainstorm switcher.

Teardown: restore `hasFocus`, close the tab, delete the temp dir (as `canvas-swap` does). A step that cannot run returns a skip with the reason, never a silent pass.

- [ ] **Step 1:** Write the scenario. Run it against a dev app: `task dev`, then `CDP_PORT=9222 task verify:ui -- brainstorm-mode`, or `node scripts/cdp/final-verify.mjs brainstorm-mode`. Every step PASS; look at every screenshot against its board.
- [ ] **Step 2:** A step that fails on a bug in a file another task owns: fix it there (no task runs beside this one) and name the file and the fix in your report.
- [ ] **Step 3:** Commit.
