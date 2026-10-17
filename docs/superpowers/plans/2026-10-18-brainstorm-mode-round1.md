# Brainstorm mode, fix round 1

> **For agentic workers:** each task is one engine worker. Read the spec and the main plan (`docs/superpowers/plans/2026-10-18-brainstorm-mode.md`) first. This round brings back the main plan's Task 3, whose worker could not launch: its text held curly double quotes, which the worker's PowerShell launch line reads as string delimiters. This copy uses straight quotes only.

**Spec:** `C:\Users\cktra\Projects\waveterm\docs\superpowers\specs\2026-10-18-brainstorm-mode-design.md`

### Task 1: The arc:brainstorm skill
**Depends on:** none
**Model:** claude-opus-5-5
**Files:** `skills/brainstorm/SKILL.md`, `skills/skills.go`, `cmd/wsh/cmd/claude-mod/skills/brainstorm/SKILL.md`, `AGENTS.md`

Write `skills/brainstorm/SKILL.md` (frontmatter `name: brainstorm`, a description that fires whenever `superpowers:brainstorming` runs inside Arc, i.e. `wsh` on PATH). It holds, from the spec's "The file", "The lines Arc types" and "What the skill says" sections plus P4/P5: the full file format with an example; every `brainstorm:` line and what the agent does with it (including `keep talking`: set `done: false`, ask the next question); the rules list. The file must match what `parseBrainstorm` in `frontend/app/view/agents/brainstormmodel.ts` (landed) accepts: read it, and state its required fields in the skill. In particular a present `question` needs both a numeric `n` and a string `text`, or Arc treats the file as broken.

Sequencing the pane depends on, stated as rules:
- On an answer: append the exchange to `history` (with `into`), set `question: null`, set `working` to the sentence `Writing '<part title>' from your answer.` (the part title in typographic double quotes in the file itself), keep that part `asked`, write the file; then write the part (`guess`, or `yours` when the user's own words are the part), clear `working`, set the next `question` (its part created as `asked` if new), write the file, and end the turn with the question in the terminal too.
- The first message: pick `<topic>`, create the file with question 1 and its part `asked`, history empty; reveal with `wsh ui reveal brainstorm:<topic>` (Claude's hook also reveals on every write).
- After a compaction: re-read the file first, set `compacted` to the current Unix ms, write it back.
- Builder check (`brainstorm: check`): write the spec at `spec`, run the builder check, fill `check` (`yours` with `q`/`why`, `calls` as `{text, part}`, `answered`, `touched`); on `brainstorm: builder answer: <text>` record `a` and `into` on that entry and fold the answer into the part. On `brainstorm: approved` stop; Arc opens the launcher. When a run starts the user tells the agent the run id or the agent reads it with `wsh runs`; it writes `run`.
- `Left to the builder` (id `builder`) is always the last part; the agent writes it as a `guess` once nothing is left to ask.
- Never leave the file in a broken intermediate state by hand-editing it in place; write the whole JSON each time.

Add `brainstorm` to the `//go:embed` line in `skills/skills.go`; run `task sync:claudemod` so the tracked copy under `cmd/wsh/cmd/claude-mod/skills/brainstorm/` is regenerated (never edit it by hand); update AGENTS.md's skills list "(cockpit, design, initiatives, notes, runs)" to include brainstorm.

- [ ] **Step 1:** Write the skill; embed; sync. Run `go test ./pkg/agentsync -run 'Skill'` and `go vet ./skills/`: PASS. Run `claude plugin validate claude/arc-mod` if `claude` is on PATH, else say so in the task report.
- [ ] **Step 2:** Commit.

### Task 2: Give the memory-fixtures tests a timeout that fits their git launches
**Depends on:** none
**Model:** claude-sonnet-5-5
**Files:** `scripts/cdp/memory-fixtures.test.mjs`

The run's final Verify failed on `writeMemoryStates > writes each state under <data dir>/memhygiene and nothing else`: "Test timed out in 5000ms". The file was not changed by this run, and the test passes alone in about 2 s. `buildMemoryFixture` (in `scripts/cdp/memory-fixtures.mjs`) runs `git init` once per fixture project through `execFileSync`, which can exceed vitest's 5 s default when the full suite runs in parallel.

Decision: every `it` in `memory-fixtures.test.mjs` that calls `buildMemoryFixture` gets a `30_000` timeout as its last argument, the form `scripts/cdp/final-verify.test.mjs` already uses for its process-spawning tests. Do not change `memory-fixtures.mjs`, the assertions, or `vitest.config`. Keep the file's hand formatting: never run prettier on `scripts/*.mjs`.

- [ ] **Step 1:** Add the timeouts. Run `npx vitest run scripts/cdp/memory-fixtures.test.mjs`: PASS (10 tests). Run `grep -c "30_000" scripts/cdp/memory-fixtures.test.mjs` and check that it equals the number of `it` blocks that call `buildMemoryFixture`.
- [ ] **Step 2:** Commit.
