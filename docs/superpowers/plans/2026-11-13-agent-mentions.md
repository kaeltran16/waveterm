# Tag other agents from the prompt (@@) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In a Claude Code session in an Arc block, `@@` in the prompt lists this project's other live agent tabs; a submitted `@@tag` resolves to a tab id the session's own agent then messages with `wsh agents send/read/wait`.

**Architecture:** Two arc-mod hooks in `claude/arc-mod/hooks/register.ts` (`prompt.autocomplete` matched on `@@`, `prompt.submit`), all logic pure in a new `mention-core.ts` tested by vitest. The roster comes from `wsh agents list --json --others`, a new flag that drops the caller's own tab with the same `getTabIdFromEnv()` the text listing already uses for its `(you)` mark.

**Tech Stack:** TypeScript (Claude Code mod API), vitest, Go (cobra) for `wsh`.

**Spec:** `C:\Users\kael02\AppData\Local\arc-wt\86d96a3b\docs\superpowers\specs\2026-11-13-agent-mentions-design.md`
**Verify:** `node scripts/verify.mjs ./cmd/wsh/...`
**Check:** `go vet ./cmd/wsh/cmd/ && claude plugin validate claude/arc-mod`

## Decisions beyond the spec, and why

- **Self is dropped in `wsh`, not in the mod: new `wsh agents list --others` flag.** The mod cannot know its
  own tab reliably: `WAVETERM_TABID` is missing in some blocks, and `getTabIdFromEnv()`
  (`cmd/wsh/cmd/wshcmd-root.go`) already falls back to resolving the block's tab over RPC. Reusing it keeps
  one source of truth for "which tab is me". `AgentInfo` (a wire type) is untouched, so no `task generate`.
  The `--json` shape stays a bare array, so no consumer changes (none exists in the repo today).
- **Tag form: `@@<slug>`, and `@@<slug>-<id8>` when two listed rows share a slug.** Tab names are often the
  project name (every tab "waveterm"), so duplicates are the common case, not an edge. slug = the name
  lowercased, each run of characters outside `[a-z0-9_]` replaced by `-`, leading/trailing `-` trimmed; an
  empty slug falls back to the first 8 characters of the tab id. `id8` = first 8 characters of the tab id
  (the same short id `wsh agents list` prints).
- **Resolution at submit re-fetches the roster and matches case-insensitively, in order:** (1) the tag a row
  gets from `tagOf` over the fresh roster; (2) else the plain slug of exactly one row (a duplicate that
  appeared after the pick); (3) else the tag text, or, for a tag ending in `-` plus 8 hex characters, that
  8-character suffix, as a tab id prefix of 4+ characters unique among rows (a hand-typed `@@a1b2`; a
  picked `@@waveterm-e5f6a7b8` after the other `waveterm` tab closed, when that row's tag became plain
  `@@waveterm`). More than one
  match is ambiguous; none is unknown. Both are said in the context, never a failed prompt.
- **Tag syntax in a submitted prompt:** `@@` not preceded by a word character or `@`, then
  `[A-Za-z0-9_][A-Za-z0-9_-]*`. So `@@reviewer,` / `@@reviewer?` stop at the punctuation, and a diff hunk
  header (`@@ -1,3 +1,4 @@`) or `a@@b` is not a tag. Tags are deduplicated case-insensitively.
- **Only `origin.kind === "composer"` prompts that are not slash commands (`e.command` unset) are resolved**
  (spec: composer only; a slash command's text rewrite is not applied by the engine, and context on it is
  noise). No `wsh` call happens when the prompt has no tag.
- **Typeahead filter:** the text after `@@`, case-insensitive substring of the row's tag (without `@@`), its
  tab id, or its title. Titles are what tell same-named tabs apart, so `@@bench` finds "Benchmark sonnet
  workers". Rows keep `wsh`'s order. No row at all when nothing matches or the roster is empty: a
  typeahead row always writes its `text`, so it cannot be a non-insertable "no agents" notice.
- **Row shape:** `text` and `label` = the tag; `description` = `<id8> <harness> <state>` then ` · <title>`
  when there is one, title whitespace collapsed to one line (the surface cuts it). Agent rows go before the
  rows `next(e)` returned.
- **Fetch cadence:** fetch when the token is exactly `@@` (a new tag starts) or its `start` differs from the
  cached one; reuse the cached promise otherwise. A failed fetch is cached as an empty roster for that token
  (logged once to debug), so a broken `wsh` costs one spawn per tag, not one per keystroke.
- **Context: one entry per prompt,** naming each resolved tag with its full tab id, harness, state and title;
  the commands `wsh agents send <tab> "<message>"`, `wsh agents read <tab>`, `wsh agents wait <tab>`; the
  waiting rule (asks for something back: `send --wait` and continue with the answer; only tells: send and
  move on); "write the message yourself, keep it to what the user asked, do not forward the prompt
  verbatim"; then one line per unknown or ambiguous tag (ambiguous lists the candidates' `id8` and title and
  says to ask the user which). When the roster fetch itself fails, the entry says the tags could not be
  resolved, with the error, and that `wsh agents list` shows the live agents.
- **No Final line.** The change draws in Claude Code's TUI inside a terminal, not in a cockpit view the CDP
  scenarios reach, and the cockpit is unchanged. The live check is Task 3's scripted pty run (a worker step,
  not a manual one): a scratch copy of the mod against a stub `wsh`, as the spec's "Evidence" probe did. The
  harness and its node deps live in a temp dir, not the repo (no new dependency for a one-off check).
- **pi's `@@` deferral is recorded** in `docs/deferred.md` + a Held row in `docs/open-issues.md`, as
  AGENTS.md asks for deferred work.

## Global Constraints

- Trigger is `@@`; bare `@` (Claude Code's file mention) is never hooked or changed.
- Scope: this project's live agents only (`wsh agents list` without `--all`).
- Outside an Arc block (`active` false in `register.ts`: no `WAVETERM_BLOCKID` / `WAVETERM_JWT`) both hooks
  return `next(e)` untouched and spawn nothing.
- A failure in either hook never blocks typing or the prompt: catch, log with
  `$.ui.log(..., { to: "debug" })`, pass through.
- The user's text is never delivered to the tagged agent by the mod; only context for this agent is attached.
- Pure logic in `mention-core.ts`, no `claude-code` import there (vitest runs it); comments say why, lowercase.
- After editing `claude/arc-mod/`, `task sync:claudemod` and commit the `cmd/wsh/cmd/claude-mod/` copies.

## Review Focus

- Every tab named after the project (all "waveterm"): picked tags must be `@@waveterm-<id8>` and each must
  resolve to its own tab, never the first one. (Task 2 `tagOf`/`resolveTags` duplicate tests.)
- Punctuation and lookalikes: `@@reviewer, please`, `(@@reviewer)`, a pasted diff with `@@ -1,3 +1,4 @@`,
  `foo@@bar`. Only real tags resolve. (Task 2 `submittedTags` tests.)
- The agent closes between pick and Enter, or `wsh` fails: the prompt still goes, and the context says the
  tag names no live agent / the roster could not be read. (Task 2 `mentionContext` tests, Task 3 hook
  error path.)
- A message from another agent or the cockpit quoting `@@x` must not make this agent message a third one.
  (Task 2 `isTaggable` test, Task 3 wiring uses it.)
- Hand-typed tags: `@@Reviewer` (case), `@@a1b2` (tab id prefix), a tag picked before a duplicate name
  appeared. (Task 2 `resolveTags` tests.)

---

### Task 1: `wsh agents list --others`
**Depends on:** none
**Files:** `cmd/wsh/cmd/wshcmd-agents.go`, `cmd/wsh/cmd/wshcmd-agents_test.go`

**Interfaces:**
- Produces: `wsh agents list --others` leaves out the row whose `tabid` equals `getTabIdFromEnv()`; combines
  with `--json` and `--all`. With no self tab known (`""`), nothing is dropped. The `--json` output stays a
  bare JSON array of `AgentInfo` (`[]` when empty). Task 3 calls `wsh agents list --json --others`.

- [ ] **Step 1: Write the failing test** `TestAgentsWithout` in `wshcmd-agents_test.go`, using
  `agentsTestRoster()`: `agentsWithout(roster, agentsTestTabB)` returns tab ids `[A, C]` in order;
  `agentsWithout(roster, "")` returns all three; `agentsWithout(nil, agentsTestTabA)` returns a non-nil empty
  slice (so `--json` prints `[]`).
- [ ] **Step 2:** `go test ./cmd/wsh/cmd -run '^TestAgentsWithout$'` fails (undefined `agentsWithout`).
- [ ] **Step 3:** add `func agentsWithout(rows []wshrpc.AgentInfo, tab string) []wshrpc.AgentInfo` and the
  `--others` bool flag ("leave out this session's own tab") in `wshcmd-agents.go`; `agentsListRun` applies it
  after `agentsInProject`, calling `getTabIdFromEnv()` once and passing that same value to
  `agentsListLines` (no second lookup).
- [ ] **Step 4:** `go test ./cmd/wsh/cmd -run '^TestAgents'` passes (the existing listing tests too).
- [ ] **Step 5:** commit both files.

### Task 2: `mention-core.ts`, the pure mention logic
**Depends on:** none
**Files:** `claude/arc-mod/hooks/mention-core.ts`, `claude/arc-mod/hooks/mention-core.test.ts`

Implements every rule in "Decisions beyond the spec" above except the fetch itself. No `claude-code` import.

**Interfaces (Produces, Task 3 consumes exactly these):**
```ts
export type AgentRow = { tabid: string; name: string; harness: string; state: string; title?: string };
export type Suggestion = { text: string; label: string; description: string };
// the text after "@@" for a token that starts with it, else null
export function mentionQuery(token: string): string | null;
// true when the roster must be fetched for this token: it is exactly "@@", or cachedStart !== start
export function needsFetch(cachedStart: number | null, token: string, start: number): boolean;
// `wsh agents list --json` stdout -> rows; throws an Error naming the problem on non-JSON or non-array
export function parseAgents(stdout: string): AgentRow[];
// "@@<slug>" or, when another row in rows shares the slug, "@@<slug>-<id8>"
export function tagOf(row: AgentRow, rows: readonly AgentRow[]): string;
export function suggestions(rows: readonly AgentRow[], query: string): Suggestion[];
// tags in a submitted prompt, "@@" included, deduped case-insensitively, in first-seen order
export function submittedTags(text: string): string[];
// composer origin and not a slash command
export function isTaggable(e: { origin: { kind: string }; command?: unknown }): boolean;
// the one context entry for the tags; roster is the fresh rows or the fetch's error
export function mentionContext(tags: readonly string[], roster: readonly AgentRow[] | { error: string }): string;
```

- [ ] **Step 1: Write the failing tests** in `mention-core.test.ts` (vitest, `describe` per function), with
  a roster fixture: `{tabid:"a1b2c3d4-0000-…", name:"reviewer", harness:"claude", state:"idle", title:"reviewing the boards diff"}`,
  two tabs both named `"waveterm"` (ids `e5f6a7b8-…`, `c9d0e1f2-…`, titles "Benchmark sonnet workers",
  "Explore improvement areas"), and a pi tab named `"Design Lead"`.
  - `mentionQuery("@@rev")` = `"rev"`, `mentionQuery("@@")` = `""`, `mentionQuery("@rev")` and
    `mentionQuery("x@@")` = `null`.
  - `needsFetch`: true for `("@@", start 4)` even with cache at 4; true for `("@@r", 9)` with cache 4; false
    for `("@@re", 4)` with cache 4; true with cache `null`.
  - `parseAgents` on `[]` gives `[]`; on `{"x":1}` and `not json` throws.
  - `tagOf`: reviewer -> `@@reviewer`; the two waveterm rows -> `@@waveterm-e5f6a7b8` and
    `@@waveterm-c9d0e1f2`; "Design Lead" -> `@@design-lead`; a row with name `""` -> `@@` + its id8.
  - `suggestions(roster, "")` returns all four in order; `"bench"` returns only the Benchmark row (title
    match); `"A1B2"` returns reviewer (tab id, case-insensitive); `"zzz"` returns `[]`. Reviewer's row is
    `{ text: "@@reviewer", label: "@@reviewer", description: "a1b2c3d4 claude idle · reviewing the boards diff" }`;
    a row without a title has no ` · `.
  - `submittedTags("ask @@reviewer, then @@Reviewer and (@@waveterm-e5f6a7b8)")` =
    `["@@reviewer", "@@waveterm-e5f6a7b8"]`; `"@@ -1,3 +1,4 @@"`, `"foo@@bar"` and `"@@@x"` give `[]`.
  - `isTaggable`: true for `{origin:{kind:"composer"}}`; false for kinds `"plugin"`, `"bridge"`, `"peer"`,
    and for composer with `command` set.
  - `mentionContext(["@@reviewer"], roster)` contains the full reviewer tab id, `wsh agents send <id>`,
    `wsh agents read <id>`, `wsh agents wait <id>`, `--wait`, and the phrase `what the user asked`.
  - Resolution through `mentionContext`: `@@REVIEWER` and `@@a1b2` resolve to reviewer; `@@waveterm` with two
    waveterm rows is ambiguous (text contains both `e5f6a7b8` and `c9d0e1f2` and asks the user which);
    `@@waveterm-e5f6a7b8` resolves to that tab even when the roster has only that waveterm row (its tag is
    then plain `@@waveterm`); `@@gone` produces a line containing `@@gone` and `no live agent`.
  - `mentionContext(["@@reviewer"], { error: "wsh exited 1: boom" })` contains `boom` and
    `wsh agents list`, and does not throw.
- [ ] **Step 2:** `npx vitest run claude/arc-mod/hooks/mention-core.test.ts` fails (module missing).
- [ ] **Step 3:** implement `mention-core.ts` to the interface above; resolution order and tag syntax as in
  the Decisions section (keep resolution a private helper unless a test needs it exported). Named constants
  for `"@@"`, the id8 length and the 4-character minimum prefix.
- [ ] **Step 4:** the same vitest run passes; `npx eslint claude/arc-mod/hooks/mention-core.ts claude/arc-mod/hooks/mention-core.test.ts`
  and `npx prettier --check` on both are clean.
- [ ] **Step 5:** commit both files.

### Task 3: Wire the hooks into the arc mod, sync, verify live
**Depends on:** Task 1 (calls `wsh agents list --json --others`), Task 2 (uses every `mention-core.ts` export)
**Files:** `claude/arc-mod/hooks/register.ts`, `cmd/wsh/cmd/claude-mod/hooks/register.ts`, `cmd/wsh/cmd/claude-mod/hooks/mention-core.ts`, `docs/deferred.md`, `docs/open-issues.md`

- [ ] **Step 1: `prompt.autocomplete`** in `register.ts`: `on("prompt.autocomplete", { token: /^@@/ }, ...)`.
  When `!active`, `return next(e)`. Otherwise keep a module-level cache `{ start: number; rows: Promise<AgentRow[]> } | null`;
  when `needsFetch(cache?.start ?? null, e.token, e.start)`, replace it with a fetch of
  `$.process.run([WSH, "agents", "list", "--json", "--others"])` -> `parseAgents(stdout)`, where a non-zero
  exit or a parse error logs `arc: wsh agents list ...` to debug and resolves `[]`. Return
  `{ suggestions: [...suggestions(rows, mentionQuery(e.token) ?? ""), ...(await next(e)).suggestions] }`.
  Reset the cache in `session.start` alongside `isKnownNonWorker`.
- [ ] **Step 2: `prompt.submit`** (matcherless; the mod has none yet): when `!active` or `!isTaggable(e)`,
  `return next(e)`; `const tags = submittedTags(e.text)`, none -> `next(e)`. Otherwise fetch the roster fresh
  (never the typeahead cache), passing `{ error }` to `mentionContext` on a non-zero exit, a thrown spawn or a
  parse error, and `return next({ ...e, context: [...(e.context ?? []), mentionContext(tags, roster)] })`. Any
  unexpected throw before `next` is caught, logged to debug, and falls back to `next(e)`.
- [ ] **Step 3:** `task sync:claudemod`, so `cmd/wsh/cmd/claude-mod/hooks/` gains `mention-core.ts` and the new
  `register.ts`; `git status` shows no other copy changed. `go vet ./cmd/wsh/cmd/ && claude plugin validate claude/arc-mod`
  passes, and `npx vitest run claude/arc-mod` passes.
- [ ] **Step 4: live check through a pty (scripted, not manual).** In a temp dir outside the repo: install
  `@lydell/node-pty` and `@xterm/headless` there; build a stub `wsh` (a tiny Go `main` built with `go build`
  is the safe choice on Windows, since the mod spawns `WSH` directly with no shell) that prints a fixed
  two-agent JSON array (one named `reviewer`, tab `a1b2c3d4-…`, title "reviewing the boards diff"; one
  `waveterm` tab) for `agents list --json --others` and exits 0 silently for every other subcommand (the mod
  also spawns `agentctl`, `agentstatus`, `transcript-tail`, `notify`). Copy `claude/arc-mod` to the temp dir
  with `__WSH_PATH__` replaced by the stub path and the plugin renamed from `arc` (the installed `arc` mod
  also loads). Spawn `claude` through the pty with `--plugin-dir <copy>`, `--model haiku`, an
  `--append-system-prompt` telling it to never call a tool and reply exactly `TAB=<tab id>` when the
  prompt's context names a live agent tab, else `NOTAB`, and an env with dummy `WAVETERM_BLOCKID` /
  `WAVETERM_JWT` (so `active` is true; the old installed mod's failing `wsh` calls are harmless). Probe
  notes: `.superpowers/probes/claude-mods/compactprobe/mention-drive.cjs` in the main checkout
  (`C:\Users\kael02\IdeaProjects\waveterm`) is the driver this repeats. Acceptance, from the captured
  screen text:
  - after typing `ask @@`: both stub agents' rows show, with `a1b2c3d4 claude idle · reviewing the boards diff`;
  - after `@@rev` then Tab: the prompt reads `ask @@reviewer`;
  - after ` to look` + Enter: the reply contains `TAB=a1b2c3d4` (the full stub id).
  Report the three captures in the task's completion. If `claude` or the pty cannot start in the worker's
  environment, say exactly which acceptance line went unverified; do not mark it passed.
- [ ] **Step 5: record the deferral.** Top of `docs/deferred.md` (entries append at the top): "`@@` agent tags
  in pi's prompt (deferred 2026-11-13)" — what (pi agents are listed and messageable, but pi's own prompt has
  no `@@`), why held (spec: Claude Code only for now), where it plugs in (a pi extension under
  `pi/extensions/` mirroring `mention-core.ts`), revive when a pi session needs to tag an agent, recovery:
  `docs/superpowers/specs/2026-11-13-agent-mentions-design.md`. Add the one-line Held row under "Cockpit and
  surfaces" in `docs/open-issues.md`.
- [ ] **Step 6:** commit `register.ts`, both synced copies and the two docs.
