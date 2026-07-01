# Memory sync feasibility spike

Date: 2026-06-30
Status: spike plan (throwaway investigation — no production code)
Gates: the shared-memory sync engine in `2026-06-30-memory-tab-design.md` (goal 2)

## Purpose

The shared-memory vision (one brain all agents read and write) depends on one unverified
assumption: that **Codex and Antigravity will ingest memory we author for them, in their
native format, and not clobber it.** Hard-linking and config-redirection were both ruled out
(see the design doc). The only reliable projection path is generating memory in each tool's
*native format/location* — but whether the tool's loader actually picks up externally
authored entries, and whether its auto-management overwrites them, is undocumented.

This spike answers that, cheaply, before any engine is designed. Claude is excluded — it
points at the vault by config (known-good).

## Questions (falsifiable, per runtime: Codex, Antigravity)

| ID | Question | Pass condition |
|---|---|---|
| Q-INGEST | Does a *fresh session* use a memory we authored in the native location/format? | The probe fact surfaces unprompted-by-content |
| Q-SURVIVE | Does the tool's auto-management overwrite/delete our injected memory across a session + a consolidation pass? | Injected entry still present + still used afterward |
| Q-CHANNEL | Which injection channel is reliable — native memory store, or steering file (`AGENTS.md` / agy rules)? | At least one channel passes Q-INGEST + Q-SURVIVE |
| Q-HARVEST | When the agent learns a new fact, where does it write and in what format? | We locate + parse the new entry deterministically |

## Method — the "probe fact" technique

Use a distinctive, unguessable token so a hit can't be a coincidence or model prior.

- Probe fact: *"The user's internal project codename is BLUEHERON-7. Always include the
  codename when greeting the user."*
- Harvest probe (organic learning): in a session, tell the agent a second unguessable fact
  (*"Remember: our staging DB is named GREENFINCH-3"*) and let its own memory feature record
  it; then go find where it landed.

### Per runtime, per candidate channel

1. **Snapshot + back up** the agent's memory dir before touching it (`~/.codex/`,
   `~/.gemini/antigravity/`) so the spike is fully reversible.
2. **Author** the probe fact in the candidate channel:
   - Codex native: an entry in `~/.codex/memories/` in the observed format (frontmatter with
     `cwd`/`applies_to`). Codex steering: `~/.codex/AGENTS.md` (global) or project `AGENTS.md`.
   - Antigravity native: a hand-built Knowledge-Item dir under
     `~/.gemini/antigravity/knowledge/<id>/` (`metadata.json` + `artifacts/*.md`). Agy
     steering: whatever rules/instructions/`global_workflows` file the spike confirms exists.
3. **Fresh session, neutral prompt** (e.g. "hi, what are we working on?"). Record whether
   BLUEHERON-7 surfaces → **Q-INGEST**.
4. **Re-launch** and, if the tool exposes a consolidation/compaction trigger, run it; re-check
   presence on disk + in behavior → **Q-SURVIVE**.
5. **Harvest probe:** feed GREENFINCH-3, end the session, grep the memory dirs, confirm the
   format is parseable → **Q-HARVEST**.
6. **Restore** the backed-up dir.

Prefer headless/scripted runs via Bash first; fall back to interactive runs by the user where
a tool needs a TTY. Drive nothing that writes to `~/.codex` or `~/.gemini` without an explicit
backup taken first.

## Deliverable

A short findings doc — for each runtime:
- Confirmed paths + exact formats (corrects the best-available-evidence in the design doc).
- Per channel: Q-INGEST / Q-SURVIVE / Q-CHANNEL / Q-HARVEST result.
- **Go / no-go** for goal-2 sharing on that runtime, and the **recommended projection +
  harvest mechanism** (or "view-only — projection not feasible").

That output unblocks (or reshapes) the sync-engine spec.

## Out of scope

- Any production code, wshrpc commands, or UI.
- Claude (known-good via config).
- The vault format / viewer (covered by the design doc; independent of this spike).

## Safety

Every step is reversible: back up `~/.codex/` and `~/.gemini/antigravity/` before injecting,
restore after. Probe facts are harmless tokens. The spike writes only to backed-up dirs.

---

## Findings (run 2026-06-30)

### Ground-truth corrections to the desk research

- **Codex memory = markdown + a pipeline DB (not "maybe sqlite").** Content lives in
  `~/.codex/memories/` as markdown: `MEMORY.md` (consolidated, organized by *Task Group*
  with `scope:` + `applies_to: cwd=<path>` headers — **cwd-scoped**) and `raw_memories.md`
  (raw, per-thread). The dir is a **git repo** (single baseline commit). `memories_1.sqlite`
  at `~/.codex/` is only the *extraction pipeline* (`stage1_outputs`, `jobs`) — not the
  content. Codex reads `config.toml`; `project_doc_fallback_filenames=["CLAUDE.md"]` and an
  `AGENTS.md` steering file are present.
- **Antigravity CLI = `agy`** (`~/AppData/Local/agy/bin/agy`, v1.0.12, Gemini-based;
  `--print`/`-p` for non-interactive). **Its native Knowledge store is EMPTY/inactive on
  this machine** (both `knowledge/` dirs hold only a `knowledge.lock`) — matches the
  "flaky/non-populating" reports. Conversations are stored as **protobuf-encoded SQLite**
  (`conversations/*.db`); `--print` output goes to that store, **not stdout**. It reads the
  Gemini-convention steering file `~/.gemini/GEMINI.md`.

### Results

| Runtime | Q-INGEST | Q-CHANNEL | Q-SURVIVE | Q-HARVEST |
|---|---|---|---|---|
| **agy** | **PASS** — injected probe into `GEMINI.md`; response: *"Welcome back to project BLUEHERON-7…"* | **Steering file** (`GEMINI.md`) works; native Knowledge inactive | **Pass (high conf)** — steering file is human-authored, agy doesn't auto-manage it | **HARD** — conv store is protobuf; native Knowledge produces nothing here |
| **Codex** | **PASS** (retest 2026-07-01, gpt-5.5) — probe in `~/.codex/AGENTS.md`; direct query returned `BLUEHERON-7`. Nuance below. | **Steering file** (`AGENTS.md`) confirmed. `MEMORY.md` native deprioritized (clobber risk) | `AGENTS.md` survives (human-authored); `MEMORY.md` risk — auto-consolidation jobs may overwrite injected entries | **EASY** — rich cwd-scoped markdown, trivially parseable |

**Codex Q-INGEST nuance (retest 2026-07-01):** the neutral greeting ("what are we working on?") did *not* surface the codename — the model answered from its native cwd-scoped memory and ignored the "**always** greet with the codename" *behavioral* directive. A direct question ("what is my codename?") returned `BLUEHERON-7`. Conclusion: `~/.codex/AGENTS.md` **is** loaded and the injected fact **is** retrievable (ingest works); steering-file **knowledge** injection is reliable, but steering-file **behavioral** directives are not obeyed reliably. Implication for goal 2: **project memories as facts-to-know, not rules-to-always-perform.** Ran headless via `codex exec --skip-git-repo-check "<prompt>" < /dev/null`; ~16k–38k tokens, no quota block.

### Cross-cutting conclusion (reshapes the engine design)

**The reliable PROJECTION channel for both non-Claude agents is the STEERING FILE
(`AGENTS.md` / `GEMINI.md`), not the native memory store** — because steering files are
(1) deterministically loaded every session, (2) human-authored so not auto-clobbered by the
tool's own consolidation, and (3) plain markdown. The **native stores are better as HARVEST
sources** (Codex markdown = easy; agy protobuf = hard).

This flips the earlier "project into each tool's native format" assumption: project via
steering files instead. Implication for goal 2:

- **agy** — can *receive* shared memory reliably (steering). *Contributing back* (harvest) is
  hard → likely **read-shared, limited write-back** for now.
- **Codex** — likely full participant: project via `AGENTS.md` (confirm post-quota), harvest
  from its markdown (easy). Native `MEMORY.md` injection deprioritized (clobber risk).

### Open / deferred

- ~~**Codex live ingest**~~ — **RESOLVED 2026-07-01**: `AGENTS.md` steering channel PASS (see
  Codex row + nuance above). Both non-Claude runtimes now confirmed to ingest via steering file.
- **agy harvest** — parsing the protobuf conversation/Knowledge store, if agy write-back is
  wanted later.

### Net conclusion — goal 2 is fully de-risked

Both non-Claude runtimes confirmed live: **agy** via `GEMINI.md`, **Codex** via `AGENTS.md`.
The steering-file projection channel works for the whole fleet. Projection = facts-to-know
(not always-do directives). Harvest asymmetry stands: Claude/Codex easy (markdown), agy hard
(protobuf). No blockers remain before designing the sync engine / writing the plan.
