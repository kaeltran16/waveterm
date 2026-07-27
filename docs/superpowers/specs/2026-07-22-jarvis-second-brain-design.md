# Jarvis second brain — design

**Date:** 2026-07-22
**Status:** Design complete; pending spec review, then implementation planning.
**Scope:** Resolves the four open design questions from the [Wave Vault brief](../briefs/2026-07-22-jarvis-second-brain-wave-vault-brief.md) — recall, attribution, write-ownership, and presence — plus the cost model and the v1/v2 sequencing. It builds on that brief's approved storage direction (Wave Vault: canonical Markdown, its own git repo, the memory/tasks collection boundary) and does not restate decisions already settled there.

## Design principle: the determinism boundary is the cost boundary

The only operation that costs tokens is a model call. Recording facts, git commits, frontmatter and full-text queries, wikilink traversal, and content-hash invalidation are all deterministic and free. Controlling cost is therefore controlling *when the model is allowed to run*. Every subsystem below is built so deterministic code does the mechanical work and the model runs only to summarize, judge, or converse — at explicit boundaries or on demand, never on a background poll.

Model tiers: a cheap model (Haiku-class) does the grunt work — boundary summaries, retrieval navigation, nudge drafts; a capable model (Opus/Sonnet) is reserved for final synthesis and conversation.

## Presence — ship D, grow into C

Two presence models were considered:

- **D — Ambient layer + command bar (v1):** Jarvis dissolves into the existing cockpit. Task tags on agent / Channel / Run rows, inline "relevant past decision" cards rendered where they matter, and a ⌘K command bar to ask or act. No persistent panel, no screen cost; the cockpit stays global.
- **C — Task Focus / "Spaces" (north star):** the task becomes the lens for the whole cockpit — every surface scopes to the active task, switched like desktops.

**Decision: build D first, treat C as the additive focus mode to grow into.** C's original headline advantage was that "being in a task auto-attributes new work." The hands-off attribution design below fills the graph globally without task-scoping, so C is no longer required for a trustworthy graph — it becomes a UX preference (focus vs global), not a correctness requirement. D is lighter, ships sooner, and is a strict subset of C (the same ambient cards + ⌘K, minus the scoping), so C is reachable later by adding "focus on a task" without rework.

## Recall — agentic graph traversal

Recall separates **finding the slice** (deterministic, free) from **answering from it** (model, bounded). The model synthesizes; it does not search.

Retrieval has three layers, cheapest first:

1. **Structured query over frontmatter** — status, ticket id, tags, actor, dates, wikilinks. Answers the bulk of recall (status lookups) as a `WHERE` clause. Zero model, zero embeddings.
2. **Full-text search** — keyword / phrase over prose and fenced records. Deterministic.
3. **Semantic / embedding search** — vector similarity over section-level chunks, each embedded with its frontmatter as metadata. The only layer with standing cost. Needed when wording does not match. **Deferred to v2** (see Sequencing).

Traversal — the "second brain" behavior — walks the wikilink graph rather than returning flat documents. The mechanism keeps model turns proportional to *decision points*, not to graph size:

- The model picks seed nodes from the initial search.
- **Code expands the neighborhood deterministically** — breadth-first to a bounded depth, following typed edges (decision → Run, Run → commit, task → related-task).
- The model reads the assembled subgraph once, then either answers or requests one more expansion in a named direction.

Wander control: edges are typed, and the cheaply-classified query intent selects which edge types to walk. Candidate edges are scored against the query (via the embedding index, once it exists) and only the top-k above a threshold are expanded; depth and fanout are bounded. The cheap model drives the loop; the capable model is spent once, on the final answer.

Grounding: every claim cites the node / section it came from — the traversal path *is* the citation. "Not found" is a first-class, rewarded terminal state; the model must not confabulate to fill a gap. If the best path scores below threshold, Jarvis surfaces the weak candidates rather than asserting a confident answer.

Freshness: traversal discovers the *path* from canonical Markdown; volatile leaf values (Run status, test results) are resolved from their authoritative store at synthesis time. The dossier says where to look; the fresh value comes from the source.

Scope enforcement (collection boundary): retrieval is scoped per caller in code, via the tool set handed to the retriever — not by prompt. Interactive user queries search everything (tasks + memory + decisions). Worker-prompt assembly gets a retriever that physically cannot see other tasks — only `memory/**` plus that one task's constraining decisions.

### Learning store

Resolved traversals are materialized so a repeated question becomes a flat lookup instead of a re-walk. Two speeds:

- **Cache-fast (automatic):** a high-confidence, fully-cited resolved answer is written to the **rebuildable derived layer** (alongside the embedding index) — never committed into the vault. It is a cache: fully rebuildable by re-walking, so it does not violate "Markdown is canonical / no second authoritative store," and it has no authorship to contest (dodging the write-ownership contract entirely).
- **Knowledge-slow (promoted):** a genuinely durable insight goes through the existing human-approved promotion gate into `memory/**` or `decisions/**` — canonical, committed, authored.

Invalidation is deterministic and free: each materialized answer stores the content-hashes of its cited nodes. At each coarse commit, code rehashes changed nodes; any resolved answer whose cited set intersects the change set is marked stale (not deleted), skipped by flat lookup, and re-materialized lazily only if asked again. Zero standing cost — the store defers work rather than adding background work.

## Attribution — hands-off, self-healing

Attribution produces the edges recall traverses. A wrong edge poisons traversal and can harden into a cached answer, so its cost is higher here than in a plain search box. Attribution is modeled as **typed edges, each carrying provenance and confidence** (parallel to how a decision carries rationale / actor / timestamp / provenance), so edges are inspectable, correctable, and weightable during traversal.

Signal layers, deterministic/reliable → fuzzy/expensive:

| Layer | Signal | Cost | Confidence |
|---|---|---|---|
| 1 · Active-task context | Work dispatched from a task, or cockpit scoped to it | Free | High |
| 2 · Identifier match | Ticket id in branch name, commit message, PR title, Channel name | Free | High on hit |
| 3 · Structural correlation | Same repo + overlapping time window | Free | Weak (a prior) |
| 4 · Semantic inference | Model matches a Run's objective / diff to a task's acceptance criteria | Model call | Fuzzy; proposes only |

Layers 1–2 are free and reliable — developers already embed ticket ids in branches and commits, and the Run's `BaseCommit..EndCommit` range is an existing hook for scanning commit messages. Layer 4 runs only when 1–3 are silent and a decision is worth making.

Hands-off posture (chosen over precision-biased): optimistic auto-attach, correct rather than confirm. Made safe by decoupling auto-confirm from hardening:

- **Optimistic attach, passive correction** — the default is "attached until you say otherwise"; every attribution is visible (ambient tags) and one-click detachable. The user acts only to correct.
- **Probation before hardening** — an auto-confirmed fuzzy edge is live in the view and in traversal immediately, but cannot feed a *materialized* cached answer until it survives a probation window without being contradicted or detached. Time replaces the confirmation click.
- **Self-correction from stronger signals** — if a layer-4 guess is later contradicted by a deterministic fact (a commit with a different ticket id), the hard signal wins and the fuzzy edge auto-retracts. The graph converges toward correct without the user.
- **Visible confidence** — low-confidence edges render distinctly and are weighted lower in traversal.

Invariant preserved: fuzzy edges may *inform* traversal, but only confirmed edges (deterministic hits, or human-accepted proposals, post-probation) may *harden* into the learning store.

Consequence: transient wrong edges will exist before self-healing. Harmless for interactive recall (a dismissible weak-cited path); a risk for proactive resurfacing, which raises the bar on proactive's relevance gate — another reason proactive is v2.

Edge cases: many-to-many (a Run may attribute to several tasks); no-ticket tasks fall back to layer 1 or manual; drift handled by time-boxing edges; retroactive backfill offered as a batched one-click accept.

## Write-ownership contract

The vault is its own git repo with a coarse commit cadence (task lifecycle boundaries + an idle/quit safety flush); machine writes are authored as `Jarvis`, human edits as the user, staged as separate commits by ownership (per the brief). This section makes the in-file region contract explicit.

Three ownership classes within a dossier file:

- **Machine-exclusive** — a reserved frontmatter key namespace (status, ticket ref, objective snapshot, acceptance criteria, reference wikilinks, confidence, timestamps) plus one delimited state-summary block. Jarvis writes and regenerates these in place.
- **Human-exclusive** — all prose outside markers, and all non-reserved frontmatter keys (the user's own tags/properties). Jarvis never touches these.
- **Append-only shared** — the decisions log and blockers list (structured; see below). Anyone appends; existing entries are not rewritten, except their machine-owned status field.

There is no in-file activity log — that leans on git history, removing the busiest machine-written region.

### Structured records (decisions, blockers)

Decisions and blockers are machine-maintained structured blocks, chosen over minimal prose for cheaper deterministic recall, precise traversal nodes, and entry-granular cache invalidation. Each entry is co-owned at **field granularity**:

| Field | Owner | Jarvis may write |
|---|---|---|
| id, timestamp, actor, provenance, links | machine | yes (code-captured) |
| status (active / superseded / reverted) | machine | yes — the one case Jarvis mutates an existing entry |
| rationale / description | human | seed a draft only; a human edit locks it |

Representation: machine fields as a **fenced record (YAML) with the prose rationale beneath** — clean parsing and per-field git diffs, which are what serve recall and git-attribution; owning the renderer makes raw-file prettiness moot. Entries are immutable append-only records with tolerant parsing (missing fields on old entries are fine; no migrations).

Fabrication guard: code creates the entry scaffold from a deterministic fact (a decision was submitted, a worker reported blocked); the model only drafts the rationale; material decisions and completion require human confirmation.

### Enforcement — code, not prompt

The writer is region-aware and diff-validated: code parses the file into regions, the model produces only the new value for one machine region, code splices it back, and before commit **code diffs old vs new and rejects any change outside machine-owned regions / fields.** The model cannot emit a write that clobbers human text.

Conflict-aware write path: before writing, compare the file's current hash to what Jarvis last read; if it changed underneath, re-read and re-splice into the current regions. A human edit inside a machine region is the one true conflict — human wins, it is flagged, never silently clobbered.

Two-tier enforcement, enabled by owning the editor:

- **Inside Wave's native editor** — machine regions render read-only / visually distinct; the decisions log offers "append entry," not "edit entry." Conflicts are prevented by design.
- **Outside Wave** (any external Markdown editor, or git) — the diff-validated, conflict-aware write path is the guard, making external editability safe rather than dangerous.

## Cost model summary

| Cost center | When the model runs | Tier |
|---|---|---|
| Capture | Once per lifecycle boundary to write the narrative summary; facts are recorded by code during work | Haiku |
| Continuity | Pre-computed at pause, served free on resume; one refresh only if facts changed | Haiku |
| Recall | Per question, pull-based; input bounded to the top-N slices regardless of vault size | Haiku drives traversal, Opus/Sonnet synthesizes |
| Proactive (v2) | Deterministic event → embedding pre-filter → model only if it clears a threshold | Haiku drafts, Opus only if engaged |

## Sequencing

- **v1 — recall + continuity, no embedding index.** Retrieval layers 1–2 (frontmatter + full-text) cover status recall and all of continuity with zero standing cost. Traversal runs over explicit wikilinks. The learning store operates at cache-tier over deterministic paths. Attribution layers 1–3 (deterministic) auto-attach; layer 4 (semantic) is deferred with embeddings. Presence is D. This proves the dossier is useful before incurring the one standing cost.
- **v2 — proactive resurfacing + semantic.** Adds the embedding index (with its rebuild / freshness story), which simultaneously unlocks semantic recall (layer 3), semantic attribution (layer 4), and proactive resurfacing (recall triggered by an event instead of a question — same tools, same traversal, a different entry point). Optionally grow presence D → C.

Rationale: recall and continuity are nearly free and need no embedding index; proactive is the one subsystem that requires the index *and* carries interruption-noise risk. Deferring it isolates the only standing cost and the only noise risk into a second phase, earned by a populated vault.

Implementation planning starts from the v1 scope, which is itself large and will likely decompose further in the plan.

## Non-goals

Per the brief: no embedding or executing Obsidian or its plugins; no Dataview / Canvas / theme compatibility; no replacing Jira, Linear, or another external tracker; no auto-projecting task history into every coding agent; no copying full transcripts or Run evidence into Markdown; no cloud sync or collaborative editing; not a general-purpose knowledge-management product.
