# Pi Main Harness Meta Design

## Summary

Roadmap and decision doc for making Pi the primary agent harness of arc (the Wave Terminal fork). It sequences three workstreams that build on the existing core integration:

- **Part A** — Pi as the default and promoted harness across cockpit surfaces.
- **Part B** — Bidirectional integration: Pi can operate arc (`wave_*` tools) and arc can steer live Pi sessions (control channel).
- **Part C/D** — Pi identity and repo resources: an arc-matching Pi theme, keybindings alignment, AGENTS.md, skills, prompt templates, a Pi package, and idempotent provisioning.

The core spec `2026-08-11-pi-harness-opencode-branding-design.md` (launch, consult, worker, transcript, usage, resume, live status extension) is the foundation and is already in flight. This doc does not re-specify it; it scopes and sequences what comes after.

## Status

- Decision/roadmap doc, not an implementation spec.
- Parts A, C, and D are small enough to implement directly from this doc after the core spec lands.
- Part B is the largest new surface and receives its own design spec(s) before planning: the tool contract (B1) and the control-channel protocol (B2) each deserve review.

## Goals

- Pi is the default agent: picker, channel, workers, consult, usage views.
- Pi can drive arc through model-callable tools; arc can steer live Pi sessions without replacing Pi's TUI.
- Pi inside arc looks and feels like arc: theme, keybindings, branding.
- The arc repo works natively with Pi: AGENTS.md, skills, templates.
- `wsh install-agent-hooks` provisions the full Pi experience idempotently and never clobbers existing user configuration.

## Non-Goals (Deferred Explicitly)

- **C: Wave-native RPC rendering.** Running Pi headless (`--mode rpc`) with Wave reimplementing the transcript, dialogs, model picker, and editor UI. Cost of maintaining a second full Pi UI outweighs current value; the core spec already renders transcripts from native JSONL. Revisit only if a concrete need appears (web/mobile client, or fighting Pi's TUI).
- SDK in-process embedding (`createAgentSession` in the Node server).
- Migrating headless AI features (reporadar, memgarden, memdistill, SpecForTier) from the OpenRouter runtime to Pi consult.
- Pi-internal cosmetics: custom autocomplete providers, custom editors, markdown transformers.
- Per-project session directories via `PI_CODING_AGENT_SESSION_DIR`.
- A generic harness adapter or telemetry framework (carried over from the core spec).

## Part A: Prominence And Defaults

All changes are ordering and selection defaults; every other harness remains fully functional.

- **Catalog order:** move `pi` first in `pkg/harness/catalog.go` (currently last among the fully integrated runtimes: claude, codex, opencode, pi, antigravity).
- **Agent picker:** Pi is the pre-selected runtime in the new-agent flow.
- **Channel dispatch:** `@pi` remains the channel name; the default agent when launching from the cockpit is Pi.
- **Background workers:** default `run-worker` runtime is Pi.
- **Consult:** default consult runtime is Pi (`pkg/consult`).
- **Usage dashboard:** default harness filter shows Pi first.
- **Launch shortcut:** a cockpit shortcut launches a Pi tab with the current cwd, consistent with existing harness launch UX.

Defaults apply to new sessions and fresh installs only; existing user selections are preserved.

## Part B: Bidirectional Integration

### B1: Wave tools (Pi drives arc)

The Wave-managed extension grows from status reporter to tool provider. It registers model-callable tools via `pi.registerTool()` that invoke wsh RPC:

| Tool | Purpose |
| --- | --- |
| `wave_open_file` | Open a file (optionally at a line) in a Wave tab |
| `wave_run_command` | Run a command visibly in a Wave tab (cwd, new tab options) |
| `wave_notify` | Send a Wave notification |
| `wave_create_widget` | Create or update a live widget with data |
| `wave_query_sessions` | List open tabs/sessions so the model can reference them |

Rules:

- Tools call existing wsh endpoints where possible; new server surface is added only where a capability is missing (for example a tab-listing endpoint for `wave_query_sessions`).
- Security boundary is the same as Pi's bash tool: the user already authorized model-callable code execution by running Pi. No new permission layer. Users can disable the tools through Pi's own tool management (`/settings`, `pi.setActiveTools`).
- `wave_run_command` output must respect the existing truncation utilities so large output does not flood model context.
- Tool names are lowercase with a `wave_` prefix and use `promptSnippet`/`promptGuidelines` naming the tool explicitly, per the extension API conventions.

### B2: Control channel (arc steers Pi)

Steering live Pi sessions without RPC mode: a per-session command pipe the extension watches.

- Wave writes JSON command files into a Wave-managed directory, named `<sessionId>.json` (the session ID the extension reported at `session_start`), written atomically (temp file + rename).
- The extension watches the directory (`fs.watch`, polling fallback), executes the command via Pi APIs, and deletes the file after processing.
- Command set, mapped to existing Pi APIs:
  - `steer` / `follow_up` — `pi.sendUserMessage(content, { deliverAs })`
  - `set_session_name` — `pi.setSessionName`
  - `compact` — `ctx.compact`
  - `abort` — `ctx.abort`
  - `new_session` / `switch_session` — `ctx.newSession` / `ctx.switchSession` with `withSession`
- Command failures are surfaced through the existing `wsh agentstatus`/notify path.
- The core spec's waiting-state rule is preserved: Pi is represented as waiting only during an explicit Wave ask flow; the control channel does not introduce a speculative question tool.

### B3: Notification bridge

The extension maps Pi events worth surfacing (for example a settled run ending in error) to Wave notifications via `wsh notify`. Minimal, rides on the existing wsh channel. Only explicit, user-meaningful transitions notify; no per-turn spam.

## Part C: Theme And Keybindings

### Theme

- A Pi theme JSON defining all 51 required color tokens, generated from arc's theme token palette for the shared tokens (accent, borders, backgrounds, text).
- Pi-specific tokens hand-tuned, not mapped mechanically: thinking-level editor borders, tool box backgrounds (`toolPendingBg`/`toolSuccessBg`/`toolErrorBg`), markdown, diff, and syntax highlight colors.
- Source of truth lives in the repo as a package resource (`pi/themes/arc.json`); provisioning copies it to `~/.pi/agent/themes/arc.json` and sets `theme: "arc"` in settings when the key is absent.
- Pi hot-reloads edited custom theme files, so arc-side edits flow into running Pi sessions automatically.
- A CI check validates the theme against the published theme schema (all required tokens present).

### Keybindings

- Provision a minimal `keybindings.json` merge aligned with arc conventions (model picker, alt-screen navigation) only when the user has no existing bindings. Never overwrite user bindings; `wsh install-agent-hooks` merges, and user-owned keys win.

## Part D: Repo Resources And Distribution

### AGENTS.md

- Create a repo-root `AGENTS.md` (the repo currently ships only `CLAUDE.md`; Pi reads AGENTS.md). Content mirrors the existing conventions: build and test commands (`task generate`, `go test ./...`, Vitest, CDP scenario harness), repo layout, and the coding conventions from CLAUDE.md where they apply.

### Skills and prompt templates

- `.pi/skills/` in the repo: one initial `arc-dev` skill covering the build/generate/test workflow with exact commands. Grow only when a concrete gap appears.
- `.pi/prompts/`: `/arc-review` template — review staged changes against repo conventions, matching the existing prompt-template format (frontmatter description, `$@` arguments).

### Pi package

- A `pi/` directory at repo root with its own `package.json` marked as a `pi-package` and a `pi` manifest declaring `extensions`, `skills`, `prompts`, and `themes` resources.
- **Coordination with the core spec:** the extension's single source of truth moves to `pi/extensions/waveterm-status.ts`; `wsh install-agent-hooks` provisions it to `~/.pi/agent/extensions/waveterm-status.ts`. The core plan's file map (`cmd/wsh/cmd/pi-status-extension.ts`) is adjusted to match at implementation time.
- Provisioning installs the package from the repo checkout; the package is also standalone-installable (`pi install git:github.com/kaeltran16/waveterm`) for use outside arc.

### Provisioning (`wsh install-agent-hooks`)

Grows from "install the status extension" to "install the Pi experience":

1. Detect `pi` on PATH; if missing, offer to install via the official installer (consent required, never silent).
2. Install the extension (`pi/extensions/waveterm-status.ts` → `~/.pi/agent/extensions/`).
3. Install the arc Pi package (or add it to settings `packages`).
4. Write settings defaults only when keys are absent: `defaultProvider`, `defaultModel`, `defaultThinkingLevel`, `theme` (arc theme), and package entry.
5. Merge keybindings only when no user bindings exist.
6. Idempotent: running again changes nothing; report what was installed and what was skipped because the user already configured it.

## Sequencing

1. **Core harness spec** (in flight) — prerequisite; everything below builds on it.
2. **Parallel after core:** Part A (prominence), Part C (theme + keybindings), Part D (AGENTS.md, skills, templates, package, provisioning).
3. **B1 wave tools** — own design spec and plan first (largest new surface).
4. **B2 control channel** — own design spec and plan first (protocol review).
5. **B3** rides with B1/B2.

## Testing

- Catalog order, picker default, worker/consult defaults: existing Go and Vitest seams.
- Extension tool registration and tool-call gating: extension unit tests.
- Control channel round trip: write a command file, observe the Pi action, confirm file removal and error surfacing.
- Provisioning idempotency and no-clobber rules: run twice, assert no drift; assert existing user settings survive.
- Theme: schema validation (all 51 tokens) in CI; hot-reload sanity check in a live session.
- End-to-end: extend the core spec's CDP surface-smoke scenario to cover the new-agent default and a `wave_run_command` call.

## Compatibility

- Targets Pi 0.84.1 (same as the core spec); extension APIs used (`registerTool`, `sendUserMessage`, `setSessionName`, `compact`, `ctx.newSession`) are stable in that version.
- Settings and keybindings merges are non-destructive by construction.
- No changes to other harnesses' behavior; Part A only reorders defaults.
