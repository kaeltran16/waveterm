# Ctrl+P: actions on every thing — Implementation Plan

**Verify:** `node scripts/verify.mjs ./pkg/jarvis/...`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs palette-actions palette-goal`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\palette-actions\project\Main.dc.html

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement your task. Steps use
> checkbox (`- [ ]`) syntax for tracking. Do not spawn subagents or forks.

**Goal:** Ctrl+P can act on every thing it lists (→ opens a thing's actions, verb-first rows like "cancel"), has a
Needs you scope with inline answers, typed scope prefixes, a Start group on every surface, and a goal block that
can open the full New run window.

**Architecture:** One new structure, an action registry under `frontend/app/cockpit/actions/`: pure
`ThingAction<T>` definitions per thing kind whose `applies` predicate is the owning view's own condition
(extracted into that view's pure model file where it is inline JSX today) and whose `run` calls the handler the
view already calls. Everything else is pure palette modules (`palette-*.ts`, tested beside) wired by
`command-palette.tsx`. Views keep their buttons.

**Tech Stack:** React 19, jotai, TypeScript (strict: false), vitest, Tailwind 4, CDP scenarios
(`scripts/cdp/scenarios.mjs`).

**Spec:** `docs/superpowers/specs/2026-09-30-palette-actions-design.md` — read it in full before your task. The
mockup (the Prototype path above; gitignored, lives only in the main checkout) is the visual spec: layout, sizes
and copy come from it, not from this plan. `ScopeRow.dc.html` beside it, option F, is the scope row.

## Global Constraints

- Colors only from `@theme` tokens in `frontend/tailwindsetup.css`; no raw hex/rgba; no new tokens (AGENTS.md,
  DESIGN.md).
- Testable logic lives in a pure `foo.ts` with `foo.test.ts` beside it; `.tsx` stays thin. No jsdom/render tests.
- Never hand-edit generated files (`frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, …). This
  plan needs no Go or RPC change.
- `applies` is copied from the owning view's condition, never re-invented; where that condition is inline JSX,
  extract it into the view's pure model file and make the view call the extracted function too.
- `run` calls the handler the view already calls. Destructive handlers own their confirm (as `confirmCancelRun`).
- Only actions that exist as a button today are in v1 (spec "v1 inventory").
- Typecheck with the Check command above, never `npx tsc` (stack overflow) and never `task check:ts` inside a
  worktree (it runs a real `npm install` that replaces the `node_modules` junction).
- Run prettier/eslint only on files you touched: `npx prettier --check <paths>`, `npx eslint <paths>`.
- Non-strict TS: a `{ok:true}|{ok:false;reason}` union does not narrow on `.ok`; use `"reason" in r`.
- Comments explain why, not what; match the surrounding comment density.

## Review Focus

1. **A pasted Windows path in All** (`c:\Users\x`, `f:/tmp`) must stay query text, not narrow to Commands/Files —
   Task 1 tests it.
2. **→ with the caret mid-query** must move the caret, not open actions; ← / Backspace on an empty action filter
   must restore the previous query *and* selection — Task 1 tests the state transitions, Task 10 wires the caret
   check.
3. **Typing a verb that matches nothing applicable** ("cancel" with no cancellable run) must not silently start a
   Quick run named "cancel" when a run *exists* but is not cancellable — the verb row is absent, the name floor
   decides as today; with cancellable runs the verb rows outrank the goal block. Task 2 tests verb expansion;
   Task 10 tests ranking in All.
4. **An ask whose agent is not in the roster, or whose ask is multi-question / multi-select**, must fall back to
   opening the agent at its question, never answer with a wrong index — Task 5 tests it.
5. **Palette opened first thing on Cockpit** (no channels loaded, no active channel) must still list runs and
   offer launch rows in the last-picked or only project — Task 3 tests the pick, Task 9 wires `primeChannels`.

---

### Task 1: Scope model — prefixes, Needs you scope, hints, action-drill navigation

**Depends on:** none

**Files:**
- Modify: `frontend/app/cockpit/palette-scope.ts`
- Test: `frontend/app/cockpit/palette-scope.test.ts` (append with Edit; never overwrite it with Write)

**Interfaces — Produces:**
- `ScopeId` gains `"needs"`. `SCOPES` order becomes All, Needs you, Go to, Agents, Runs, Sessions, Records,
  Projects, Files, Commands. `ScopeDef` gains `prefix?: string` (`"n"`, `"g"`, `"a"`, `"r"`, `"s"`, `"re"`,
  `"p"`, `"f"`, `"c"`; All has none). Sigils stay on their defs (they keep working) but the UI stops showing them.
- `NavState` gains `via: "prefix" | "pick"` (how a narrowed scope was reached; `"pick"` = Tab or click) and
  `actions: ActionDrill | null`.
- New exports:

```ts
export interface ActionDrillThing { key: string; title: string; noun: string } // noun: "Run", "Agent", …
export interface ActionDrill {
    thing: ActionDrillThing;
    back: { scope: ScopeId; query: string; sel: number; asGoal: boolean }; // restored on leave
    input: { actionId: string; label: string } | null; // a second level that takes a value
}
export function parsePrefix(value: string): { scope: ScopeId; rest: string } | null;
export function ghostHint(query: string): string | null; // "r" -> ": narrows to Runs"
export function placeholderFor(nav: NavState): string;
export function openActions(s: NavState, thing: ActionDrillThing, sel: number): NavState;
export function openActionInput(s: NavState, input: { actionId: string; label: string }): NavState;
export function leaveActions(s: NavState): { nav: NavState; sel: number } | null; // null: not in a drill
export function caretAtEnd(query: string, caret: number | null): boolean;
```

- `backspaceEmpty` order: action input → action list → actions drill (restore `back`) → command drill → scope → null.

**Rules (from spec decisions 1, 3, 4):**
- A prefix is recognized only in All with no drill and no action drill, and only while the previous query is a
  strict prefix of `"<prefix>:"` (so `""`, `"r"`, `"re"` before `"re:"`). Otherwise the value is text.
- `parsePrefix` matches `^([a-z]{1,2}):` against the `prefix` fields; the rest must not start with `\` or `/`
  (that is a path). `r:` → Runs, `re:` → Records.
- `typeQuery` narrows on a prefix (`via: "prefix"`, query = rest) exactly as it narrows on a sigil today; sigils
  keep their current behavior.
- `ghostHint(query)` returns `": narrows to <label>"` when the untrimmed query equals a scope's prefix letters
  (`"r"`, `"re"`, `"n"`…), else null. Only meaningful in All with no drill; the caller decides when to render.
- `placeholderFor`: an action drill → `Filter <noun> actions…` (or the input's label for a second level);
  a command drill → `DRILL_PLACEHOLDERS`; empty All → the placeholder naming the prefixes (copy from
  `Main.dc.html` "open" state); a scope with `via: "pick"` → its placeholder plus the prefix that would have
  reached it (copy from `ScopeRow.dc.html` option F); otherwise the scope's own placeholder. (The Files scope's
  project-specific placeholder stays in the component.)
- `cycleScope` / `pickScope` set `via: "pick"` and clear `actions`.

- [ ] **Step 1: Write the failing tests** (append to `palette-scope.test.ts`)

```ts
describe("scope prefixes", () => {
    const all = initialNav("cockpit");
    it("narrows on a typed prefix, letter by letter", () => {
        const r = typeQuery(typeQuery(all, "r"), "r:");
        expect(r).toMatchObject({ scope: "runs", query: "", via: "prefix" });
    });
    it("re: is Records, r: is Runs", () => {
        expect(typeQuery(typeQuery(typeQuery(all, "r"), "re"), "re:").scope).toBe("records");
        expect(typeQuery(all, "r:fix").scope).toBe("runs");
    });
    it("a pasted path stays text", () => {
        expect(typeQuery(all, "c:\\Users\\x")).toMatchObject({ scope: "all", query: "c:\\Users\\x" });
        expect(typeQuery(all, "f:/tmp")).toMatchObject({ scope: "all", query: "f:/tmp" });
    });
    it("a colon after other text is text", () => {
        expect(typeQuery({ ...all, query: "fix" }, "fix:").scope).toBe("all");
        expect(typeQuery({ ...all, query: "x" }, "xr:").scope).toBe("all");
    });
    it("sigils still work", () => {
        expect(typeQuery(all, "@juno")).toMatchObject({ scope: "agents", query: "juno" });
    });
    it("n: is Needs you", () => {
        expect(parsePrefix("n:")).toEqual({ scope: "needs", rest: "" });
    });
});

describe("placeholderFor", () => {
    const all = initialNav("cockpit");
    const thing = { key: "run:1", title: "palette redesign", noun: "Run" };
    it("empty All names the prefixes", () => {
        const p = placeholderFor(all);
        for (const prefix of ["n:", "r:", "a:", "c:"]) expect(p).toContain(prefix);
    });
    it("a scope picked by Tab says which prefix reaches it; one reached by prefix does not", () => {
        expect(placeholderFor(cycleScope(all, 1))).toContain("n:"); // Tab from All lands on Needs you
        expect(placeholderFor(typeQuery(all, "n:"))).not.toContain("n:");
    });
    it("an action drill filters that thing's actions; an input level shows its label", () => {
        const drill = openActions(all, thing, 0);
        expect(placeholderFor(drill)).toBe("Filter Run actions…");
        expect(placeholderFor(openActionInput(drill, { actionId: "run:message", label: "Message the lead" }))).toContain("Message the lead");
    });
});

describe("ghostHint", () => {
    it("names the scope a lone prefix letter would narrow to", () => {
        expect(ghostHint("r")).toBe(": narrows to Runs");
        expect(ghostHint("re")).toBe(": narrows to Records");
        expect(ghostHint("n")).toBe(": narrows to Needs you");
    });
    it("is silent otherwise", () => {
        expect(ghostHint("")).toBeNull();
        expect(ghostHint("ru")).toBeNull();
        expect(ghostHint("r ")).toBeNull();
    });
});

describe("action drill", () => {
    const base = { ...initialNav("cockpit"), scope: "runs" as const, query: "palette" };
    const thing = { key: "run:1", title: "palette redesign", noun: "Run" };
    it("opens with an empty filter and restores query and selection on leave", () => {
        const open = openActions(base, thing, 3);
        expect(open.query).toBe("");
        expect(open.actions?.thing).toEqual(thing);
        const left = leaveActions(open)!;
        expect(left.nav).toMatchObject({ scope: "runs", query: "palette", actions: null });
        expect(left.sel).toBe(3);
    });
    it("backspace on an empty filter leaves the input level, then the drill", () => {
        const withInput = openActionInput(openActions(base, thing, 0), { actionId: "run:message", label: "Message the lead" });
        const one = backspaceEmpty({ ...withInput, query: "" })!;
        expect(one.actions?.input).toBeNull();
        const two = backspaceEmpty(one)!;
        expect(two).toMatchObject({ actions: null, query: "palette" });
    });
    it("backspace with text is ordinary", () => {
        expect(backspaceEmpty({ ...openActions(base, thing, 0), query: "c" })).toBeNull();
    });
    it("→ acts only at the end of the query", () => {
        expect(caretAtEnd("abc", 3)).toBe(true);
        expect(caretAtEnd("abc", 1)).toBe(false);
        expect(caretAtEnd("", 0)).toBe(true);
    });
    it("Tab clears an action drill", () => {
        expect(cycleScope(openActions(base, thing, 0), 1).actions).toBeNull();
    });
});
```

Note on `backspaceEmpty` for the drill: it restores `back` but the component also needs `sel`; the component
calls `leaveActions` directly when the drill is at its top level, and `backspaceEmpty` for the rest. Keep both
consistent (the test above checks `backspaceEmpty` returns the restored nav).

- [ ] **Step 2: Run to see them fail** — `npx vitest run frontend/app/cockpit/palette-scope.test.ts` → FAIL.
- [ ] **Step 3: Implement** in `palette-scope.ts`. Keep existing tests green (update any that assert the old
  `SCOPES` order or `NavState` shape, adding `via: "pick"`, `actions: null` to `initialNav`).
- [ ] **Step 4: Run** `npx vitest run frontend/app/cockpit/palette-scope.test.ts` → PASS; run Check.
- [ ] **Step 5: Commit** `feat(palette): typed scope prefixes, Needs you scope, action-drill navigation`.

---

### Task 2: Action registry core

**Depends on:** none

**Files:**
- Create: `frontend/app/cockpit/actions/types.ts`, `frontend/app/cockpit/actions/types.test.ts`
- Create: `frontend/app/cockpit/actions/index.ts`
- Create stubs: `frontend/app/cockpit/actions/{run,agent,session,record,initiative,project}.ts`

**Interfaces — Produces** (every later action task relies on these exact names):

```ts
// types.ts
import type { AgentsViewModel } from "@/app/view/agents/agents";
import type { Getter } from "jotai";

export type ThingKind = "run" | "agent" | "session" | "record" | "effort" | "channel"; // matches GroupKind names
export type ActionGroup = "open" | "steer" | "stop"; // the action list's sections, in this order

export interface ActionDeps {
    model: AgentsViewModel;
}

export type ActionInput<T> =
    | { kind: "text"; placeholder: string }
    | { kind: "pick"; placeholder: string; options: (thing: T) => { value: string; label: string }[] };

export interface ThingAction<T> {
    id: string; // "run:cancel"
    label: string; // "Cancel run" — also the verb-search text
    group: ActionGroup;
    applies: (thing: T) => boolean; // pure; the owning view's own condition
    input?: ActionInput<T>; // present: Enter opens a second level that collects `value`
    run: (thing: T, deps: ActionDeps, value?: string) => void | Promise<void>;
    destructive?: boolean; // red; the handler owns its confirm
}

// one listable thing; key MUST equal the palette row key command-palette.tsx gives the same thing today
// (run:<id>, agent:<id>, session:<runtime>:<id>, record:<id>, effort:<oref>, channel:<oid>)
export interface ThingEntry<T> {
    key: string;
    title: string;
    thing: T;
}

export interface ThingKindDef<T> {
    kind: ThingKind;
    noun: string; // "Run" — the drill chip reads `Run › <title>`
    actions: ThingAction<T>[];
    entries: (get: Getter, model: AgentsViewModel) => ThingEntry<T>[];
}

export interface ThingActionList<T> {
    available: Record<ActionGroup, ThingAction<T>[]>; // registry order kept inside each group
    notNow: ThingAction<T>[]; // defined for the kind, not applicable now ("Not now" line)
}
export function actionsFor<T>(actions: ThingAction<T>[], thing: T): ThingActionList<T>;

export interface VerbRow<T> {
    key: string; // `action:<action.id>:<entry.key>`
    search: string; // `${action.label} ${entry.title}`
    action: ThingAction<T>;
    entry: ThingEntry<T>;
}
// one row per (action, entry) the action applies to — "cancel" lists Cancel run once per cancellable run
export function verbRows<T>(def: ThingKindDef<T>, entries: ThingEntry<T>[]): VerbRow<T>[];

// index.ts
export const THING_KINDS: ThingKindDef<any>[]; // [RUN_KIND, AGENT_KIND, SESSION_KIND, RECORD_KIND, INITIATIVE_KIND, PROJECT_KIND]
export function kindOfKey(key: string): ThingKindDef<any> | undefined; // by the key's prefix before the first ":"
```

Each stub exports its kind def with `actions: []` and `entries: () => []`, e.g. in `run.ts`:

```ts
import type { ThingKindDef } from "./types";
export type RunThing = unknown; // Task 6 replaces this
export const RUN_KIND: ThingKindDef<RunThing> = { kind: "run", noun: "Run", actions: [], entries: () => [] };
```

Stub names: `RUN_KIND` (run.ts, noun "Run"), `AGENT_KIND` (agent.ts, "Agent"), `SESSION_KIND` (session.ts,
"Session"), `RECORD_KIND` (record.ts, kind "record", "Record"), `INITIATIVE_KIND` (initiative.ts, kind "effort",
"Initiative"), `PROJECT_KIND` (project.ts, kind "channel", "Project"). Later tasks only edit their own file, so
index.ts never changes again.

- [ ] **Step 1: Failing tests** in `types.test.ts` with a fake kind:

```ts
type T = { id: string; live: boolean };
const cancel: ThingAction<T> = { id: "t:cancel", label: "Cancel run", group: "stop", applies: (t) => t.live, run: () => {} };
const open: ThingAction<T> = { id: "t:open", label: "Open in Jarvis", group: "open", applies: () => true, run: () => {} };
const def: ThingKindDef<T> = { kind: "run", noun: "Run", actions: [open, cancel], entries: () => [] };
const e = (id: string, live: boolean) => ({ key: `run:${id}`, title: `run ${id}`, thing: { id, live } });

it("splits available by group and lists the rest as not now", () => {
    const l = actionsFor(def.actions, { id: "1", live: false });
    expect(l.available.open).toEqual([open]);
    expect(l.available.stop).toEqual([]);
    expect(l.notNow).toEqual([cancel]);
});
it("expands a verb once per thing it applies to", () => {
    const rows = verbRows(def, [e("1", true), e("2", false), e("3", true)]).filter((r) => r.action === cancel);
    expect(rows.map((r) => r.key)).toEqual(["action:t:cancel:run:1", "action:t:cancel:run:3"]);
    expect(rows[0].search).toBe("Cancel run run 1");
});
it("kindOfKey resolves by prefix", () => {
    expect(kindOfKey("run:abc")?.noun).toBe("Run");
    expect(kindOfKey("effort:effort:x")?.noun).toBe("Initiative");
    expect(kindOfKey("widen")).toBeUndefined();
});
```

- [ ] **Step 2:** `npx vitest run frontend/app/cockpit/actions/types.test.ts` → FAIL.
- [ ] **Step 3:** Implement `types.ts`, `index.ts`, the six stubs.
- [ ] **Step 4:** Tests PASS; Check passes.
- [ ] **Step 5: Commit** `feat(palette): action registry core`.

---

### Task 3: Palette data — runs in every project, and a project when none is active

**Depends on:** none

**Files:**
- Create: `frontend/app/cockpit/palette-data.ts`, `frontend/app/cockpit/palette-data.test.ts`

**Interfaces — Produces:**

```ts
export interface ProjectRun { channelId: string; run: Run }
export const allRunsAtom: PrimitiveAtom<ProjectRun[]>; // every channel's runs, newest load wins
// fans out GetChannelRunsCommand per channel (as cmd/wsh/cmd/wshcmd-runs.go does); a failed channel keeps its
// previous runs in the result and is reported, never blanks the list
export async function loadAllRuns(channels: Channel[]): Promise<void>;
export function mergeChannelRuns(prev: ProjectRun[], results: { channelId: string; runs?: Run[]; error?: unknown }[]): ProjectRun[];
// the channel launch rows start in: the active one, else the channel of the last-picked project, else the only
// project's channel, else null
export function palettePickChannel(
    active: Channel | null,
    channels: Channel[] | null,
    lastPicked: string | null,
    projectLabel: (c: Channel) => string
): Channel | null;
```

Find the exact `GetChannelRunsCommand` request/response shape in `frontend/app/store/wshclientapi.ts` and
`frontend/types/gotypes.d.ts`; mirror how `activeChannelRunsAtom` is filled in `channelsstore.ts`. Guard
concurrent loads with a load id as `attentionstore.ts` does. Log a failed channel with `console.warn` including
the channel id (errors are not swallowed silently).

- [ ] **Step 1: Failing tests** for the pure parts:

```ts
describe("mergeChannelRuns", () => {
    const r = (id: string) => ({ id }) as Run;
    it("replaces each loaded channel's runs", () => {
        const out = mergeChannelRuns([{ channelId: "a", run: r("old") }], [{ channelId: "a", runs: [r("new")] }]);
        expect(out.map((p) => p.run.id)).toEqual(["new"]);
    });
    it("keeps a failed channel's previous runs", () => {
        const prev = [{ channelId: "a", run: r("1") }, { channelId: "b", run: r("2") }];
        const out = mergeChannelRuns(prev, [{ channelId: "a", error: new Error("x") }, { channelId: "b", runs: [] }]);
        expect(out.map((p) => p.run.id)).toEqual(["1"]);
    });
});
describe("palettePickChannel", () => {
    const c = (oid: string) => ({ oid }) as Channel;
    const label = (x: Channel) => x.oid;
    it("prefers the active channel", () => expect(palettePickChannel(c("a"), [c("a"), c("b")], "b", label)?.oid).toBe("a"));
    it("falls back to the last-picked project", () => expect(palettePickChannel(null, [c("a"), c("b")], "b", label)?.oid).toBe("b"));
    it("falls back to the only project", () => expect(palettePickChannel(null, [c("a")], null, label)?.oid).toBe("a"));
    it("picks nothing among several with no memory", () => expect(palettePickChannel(null, [c("a"), c("b")], null, label)).toBeNull());
    it("picks nothing before channels load", () => expect(palettePickChannel(null, null, "a", label)).toBeNull());
    it("ignores a last-picked project that has no channel", () => expect(palettePickChannel(null, [c("a"), c("b")], "gone", label)).toBeNull());
});
```

Channels are one per project, but `dedupeByProject` exists (`projectlabel.ts`); apply it before the
only-project test so two channels on one project still count as one.

- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS + Check.
- [ ] **Step 5: Commit** `feat(palette): cross-project runs and a fallback project`.

---

### Task 4: Start openers — generalized New run prefill, New initiative from anywhere

**Depends on:** none

**Files:**
- Modify: `frontend/app/view/jarvis/newrun.ts`, `newrun.test.ts` (append), `newruncontrol.tsx`,
  `frontend/app/view/agents/canvaspane.tsx`
- Modify: `frontend/app/view/agents/agents.tsx` (`newInitiativeOpenAtom = atom(false)` beside
  `newRunOpenAtom`), `frontend/app/view/jarvis/newinitiativecontrol.tsx`, `frontend/app/cockpit/cockpit-root.tsx`,
  `frontend/app/store/keybindings/dispatcher.ts` (modalOpen includes the new atom),
  `frontend/app/view/jarvis/briefsurface.tsx` (~1345: pass `model` into `NewInitiativeControl`)

**Interfaces — Produces:**

```ts
export type NewRunPrefill = { projectName: string; goal: string; shape: RunShape; prototype?: string };
export function prefillToLaunch(prefill: NewRunPrefill, projectNames: string[]):
    { picked: string | null; shape: RunShape; start: "goal"; goal: string; prototype: string };
// newruncontrol.tsx
export const lastPickedProjectAtom; // now exported (was module-private)
export const newRunPrefillAtom; // unchanged
// agents.tsx model
newInitiativeOpenAtom: PrimitiveAtom<boolean>;
// newinitiativecontrol.tsx
export function NewInitiativeHost({ model }: { model: AgentsViewModel }); // mounted in cockpit-root beside NewRunModalHost
```

Rules: a prototype still forces nothing by itself — `shape` is taken from the prefill; a prefill with a
`prototype` and `shape: "quick"` is corrected to orchestrator (a prototype only rides an orchestrator run).
`canvaspane.tsx`'s Build this… passes `shape: "orchestrator"`. The New run window, after a successful start,
already opens the run — confirm it does (`openTarget` with its runId) and leave it. `NewInitiativeControl`'s
button now sets `model.newInitiativeOpenAtom` (it needs `model`; pass it from `briefsurface.tsx`), and
`NewInitiativeHost` renders `EffortCreateForm` when the atom is true; the ⇧N binding keeps pressing the button.

- [ ] **Step 1: Failing tests** (append to `newrun.test.ts`'s `prefillToLaunch` describe):

```ts
it("takes the shape from the prefill", () => {
    expect(prefillToLaunch({ projectName: "p", goal: "g", shape: "quick" }, ["p"])).toMatchObject({ shape: "quick", prototype: "", picked: "p" });
});
it("a prototype keeps the run an orchestrator run", () => {
    expect(prefillToLaunch({ projectName: "p", goal: "g", shape: "quick", prototype: "/x.html" }, ["p"]).shape).toBe("orchestrator");
});
it("an unregistered project is not picked", () => {
    expect(prefillToLaunch({ projectName: "gone", goal: "g", shape: "orchestrator" }, ["p"]).picked).toBeNull();
});
```

Update the existing `prefillToLaunch` tests to pass `shape`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS + Check.
- [ ] **Step 5: Commit** `feat(newrun): prefill carries a shape; New initiative opens from anywhere`.

---

### Task 5: Needs you model and the shared ask answer

**Depends on:** Task 4

**Files:**
- Create: `frontend/app/cockpit/palette-needs.ts`, `palette-needs.test.ts`
- Create: `frontend/app/view/agents/askanswer.ts` holding `answerAgentAsk(model, agentId, selections, texts)` —
  the answer send at `agents.tsx` ~190-205, sentIds bookkeeping included
- Modify: `frontend/app/view/agents/agents.tsx` (the model's submit calls `answerAgentAsk`; nothing else).
  Task 4 edits `agents.tsx` too, which is why this task waits for it.

**Interfaces — Produces:**

```ts
export type NeedsGroup = "asks" | "reviews" | "blocked";
export const NEEDS_GROUP_LABELS: Record<NeedsGroup, string>; // Asks, Reviews, Blocked
export interface NeedsRow {
    item: AttentionItem;
    group: NeedsGroup;
    agent?: AgentVM; // an ask resolved to its roster agent
    review: boolean; // the agent's ask is a doc review (parseDocReview)
    options: string[]; // inline answer labels; [] = no inline answer, Enter opens the agent at its question
}
export function askAgent(item: AttentionItem, agents: AgentVM[]): AgentVM | undefined; // "ask:block:<oid>" -> blockId
export function needsRows(items: AttentionItem[], agents: AgentVM[]): NeedsRow[]; // radar-triage dropped, server order kept
export function needsGroups(rows: NeedsRow[]): { group: NeedsGroup; rows: NeedsRow[] }[]; // Asks, Reviews, Blocked; empty dropped
export function inlineSelections(row: NeedsRow, optionIndex: number): Record<number, Set<number>> | null;
```

Rules (spec decisions 5, 6 and "Resolved"): `ask`/`escalation` → asks; `gate`/`dag-gate` → reviews; an `ask`
whose agent's ask passes `parseDocReview` → reviews with `review: true` and no options; `dag-blocked`,
`run-land-held`, `run-unverified` and any unknown kind → blocked; `radar-triage` dropped. Options exist only
when the resolved agent's ask has exactly one question, not `multiSelect`, with options.
`inlineSelections(row, i)` returns `{ 0: new Set([i]) }` for a valid index and null otherwise.

- [ ] **Step 1: Failing tests**:

```ts
const agent = (over: Partial<AgentVM>) => ({ id: "t1", name: "juno", state: "asking", blockId: "b1", ...over }) as AgentVM;
const item = (kind: string, key = `${kind}:x`) => ({ kind, key, source: "", text: "", action: "", phaseidx: 0, waitingsince: 0 }) as AttentionItem;
const oneQ = { questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }] };

it("resolves an ask to its agent by block, with or without a channel", () => {
    expect(askAgent(item("ask", "ask:block:b1"), [agent({})])?.id).toBe("t1");
    expect(askAgent(item("ask", "ask:block:zz"), [agent({})])).toBeUndefined();
});
it("groups by kind and drops radar triage", () => {
    const g = needsGroups(needsRows([item("gate"), item("ask", "ask:block:b1"), item("dag-blocked"), item("radar-triage"), item("run-unverified")], [agent({ ask: oneQ })]));
    expect(g.map((x) => [x.group, x.rows.length])).toEqual([["asks", 1], ["reviews", 1], ["blocked", 2]]);
});
it("a doc review ask is a review with no inline options", () => {
    const review = { questions: [{ header: "Spec review", question: "/abs/spec.md\n- one", options: [{ label: "Approve" }, { label: "Request changes" }] }] };
    const [row] = needsRows([item("ask", "ask:block:b1")], [agent({ ask: review })]);
    expect(row).toMatchObject({ group: "reviews", review: true, options: [] });
});
it("inline options only for one single-select question", () => {
    expect(needsRows([item("ask", "ask:block:b1")], [agent({ ask: oneQ })])[0].options).toEqual(["A", "B"]);
    const multi = { questions: [{ question: "q", multiSelect: true, options: [{ label: "A" }] }] };
    expect(needsRows([item("ask", "ask:block:b1")], [agent({ ask: multi })])[0].options).toEqual([]);
    const two = { questions: [oneQ.questions[0], oneQ.questions[0]] };
    expect(needsRows([item("ask", "ask:block:b1")], [agent({ ask: two })])[0].options).toEqual([]);
    expect(needsRows([item("ask", "ask:block:none")], [agent({ ask: oneQ })])[0].options).toEqual([]);
});
it("inlineSelections rejects an out-of-range digit", () => {
    const [row] = needsRows([item("ask", "ask:block:b1")], [agent({ ask: oneQ })]);
    expect(inlineSelections(row, 1)).toEqual({ 0: new Set([1]) });
    expect(inlineSelections(row, 5)).toBeNull();
});
```

Check `parseDocReview`'s exact expectations in `frontend/app/view/agents/docreview.ts` and shape the review
fixture to pass it.

- [ ] **Step 2:** FAIL. **Step 3:** implement + the `answerAgentAsk` extraction (no behavior change on the
  Cockpit; its existing tests stay green).
- [ ] **Step 4:** PASS + Check. **Step 5: Commit** `feat(palette): Needs you model and a shared ask answer`.

---

### Task 6: Run actions

**Depends on:** Task 2, Task 3

**Files:**
- Modify: `frontend/app/cockpit/actions/run.ts`; Create: `frontend/app/cockpit/actions/run.test.ts`
- Modify where a condition is inline JSX (extract into the view's pure model, make the view call it):
  `frontend/app/view/agents/runcards.tsx`, `leadcard.tsx` / `leadcardmodel.ts`, `runbody.tsx`,
  `frontend/app/view/jarvis/runsheet.tsx`, and their existing `*model.ts` neighbours.

**Interfaces:**
- Consumes: `ThingKindDef`, `ThingAction`, `ThingEntry` (Task 2); `allRunsAtom`, `ProjectRun` (Task 3).
- Produces: `export interface RunThing { channelId: string; run: Run; info?: RunInfo; lead?: AgentVM; liveCount: number; /* + whatever the predicates need */ }`,
  `export function buildRunThing(p: ProjectRun, agents: AgentVM[], lineage: Lineage): RunThing`, and `RUN_KIND`
  with `entries(get, model)` = `get(allRunsAtom)` mapped through `buildRunThing` with `get(model.agentsAtom)`
  and `get(model.lineageAtom)`, key `run:<id>`, title `run.goal || "(untitled run)"`.

**Actions** (spec v1 row "Run"; find each button, copy its condition, call its handler):

| id | label | group | source of `applies` / `run` |
|---|---|---|---|
| run:open | Open in Jarvis | open | always; `openTarget(model, { kind: "run", runId })` |
| run:dag | Open the DAG | open | `info?.dag != null`; `openRunDag(model, info)` (`runrailsections.tsx`) |
| run:diff | Open the diff | open | as the run sheet/report shows it; `openDiff(model, diffScopeOfRun(run))` |
| run:lead-terminal | Open the lead's terminal | open | a lead in the roster; `jumpToAgent(model, lead.id)` |
| run:message | Message the lead | steer | the run header's steer send (`runbody.tsx`), extracted to an exported function first; `input: text` |
| run:workers | Workers at once | steer | the lead card's parallelism panel condition (`leadcard.tsx` ~515); the Save handler extracted to `setRunParallelism(run, n)` next to `settingsChangePayload`; `input: pick` 1..max using `clampParallelism` |
| run:relaunch | Relaunch the lead | steer | `leadDown` as `leadcardmodel.ts` computes it; `dagAction(... "relaunch-lead")` as `leadcard.tsx:302` |
| run:focus | Focus the cockpit on it | steer | as `focusswitcher.tsx` offers runs; `enterFocusFor(model, { ref: { kind: "run", id }, label, project })` |
| run:stop-worker | Stop a worker… | stop | survivors list condition in `runcards.tsx` ~110; `input: pick` of those workers; `stopRunWorker(channelId, runId, "tab:<id>")` |
| run:cancel | Cancel run | stop, destructive | `CancelRunButton`'s visibility at its call sites (not cancelling: `cancellingRunIdsAtom`); `confirmCancelRun(channelId, run.id, liveCount)` with `runLiveWorkers` |
| run:resume | Resume | steer | `canResume(run, phaseIdx)` (`runmodel.ts`) for the blocked phase `BlockedCard` is given; `resumeRun` |
| run:end-final | End final stage | stop | the run sheet's condition around `runsheet.tsx:935`; `endFinalStage` with its outcome/reason as `input` (pick outcome, then the view's reason rule) |

If a row's button has no condition you can find, or its handler cannot run outside the view without a larger
refactor, stop and report it via `wsh jarvis dag ask` rather than inventing a predicate.

- [ ] **Step 1: Failing tests** in `run.test.ts`: for each action, one `applies` true case and one false case
  built from plain `Run` objects (e.g. cancel false for a `done` run; resume true only for a blocked resumable
  phase; dag false with no `info.dag`; relaunch true only when the lead is down), plus `buildRunThing` computing
  `liveCount` from `runLiveWorkers`. For every extracted predicate, a test in the view model's own test file.
- [ ] **Step 2:** FAIL. **Step 3:** implement; views now call the extracted predicates/handlers.
- [ ] **Step 4:** `npx vitest run frontend/app/cockpit/actions/run.test.ts <each touched model test>` PASS; Check.
- [ ] **Step 5: Commit** `feat(palette): run actions`.

---

### Task 7: Agent actions

**Depends on:** Task 2

**Files:**
- Modify: `frontend/app/cockpit/actions/agent.ts`; Create `agent.test.ts` beside it.
- Modify: `frontend/app/view/agents/agentactions.ts` — add, beside `driveAgent`:
  `interruptAgent(blockId)` (the header's `interrupt`, `agentheader.tsx` ~126, which then calls it),
  `toggleAgentBackground(model, id)` (sets `model.backgroundedIdsAtom` with `toggleInSet`, as
  `cockpitsurface.tsx` ~377 does; that surface then calls it) and `dismissAgent(model, agent)` (adds
  `dismissKey(agent)` to `model.dismissedAtom`, as `cockpitsurface.tsx:433`).
- Do not touch `agents.tsx` or `agentsviewmodel.ts` — Tasks 4 and 5 edit those in parallel with this task. Both
  atoms above already exist on the model.

**Interfaces — Produces:** `export interface AgentThing { agent: AgentVM; contextLevel: ContextLevel | null; /* … */ }`,
`AGENT_KIND` with entries from `get(model.agentsAtom)`, key `agent:<id>`, title as the palette's agent row
(`a.task ? \`${a.name} — ${a.task}\` : a.name`). Context level: read the same usage the rail reads for its
`ContextLine` (`agentdetailsrail.tsx` ~311, `offersContextReset`); if that usage is not reachable from a Getter,
Compact and Clear use `offersContextReset` with what is reachable and the test documents the gap.

**Actions** (spec v1 row "Agent"):

| id | label | group | source |
|---|---|---|---|
| agent:open | Open terminal | open | always; `model.openTerminal(id)` |
| agent:answer | Answer | open | `state === "asking"`; `model.openTerminal(id)` (the terminal opens at its question) |
| agent:review | Review changes | open | as its button offers; `openDiff(model, agentDiffScope(id, name))` |
| agent:nudge | Nudge (continue) | steer | the rail's nudge condition (`agentdetailsrail.tsx` ~628); `driveAgent(blockId, NUDGE_INPUT)` |
| agent:interrupt | Interrupt | steer | `blockId != null` (header); the extracted interrupt |
| agent:compact | Compact | steer | `offersContextReset(...)`; `driveAgent(blockId, "/compact\r")` |
| agent:clear | Clear | steer, destructive | same; `driveAgent(blockId, "/clear\r")` |
| agent:background | Background / dismiss | steer | `muteMode(state)` as `cockpitsurface.tsx:432-433`: background when working/asking (`toggleAgentBackground`), dismiss when idle (`dismissAgent`) — label follows the mode |
| agent:focus | Focus the cockpit on it | steer | as `focusswitcher.tsx` offers agents; `enterFocusFor` kind `agent` |
| agent:close | Close | stop, destructive | always for a live block; `confirmCloseSession(agent, model)` |

- [ ] **Step 1: Failing tests**: each `applies` true/false from plain `AgentVM` literals (answer only when
  asking; interrupt false without a blockId; background vs dismiss label by state; compact false when the context
  level does not offer a reset).
- [ ] **Step 2:** FAIL. **Step 3:** implement + extractions; the views call the extracted functions.
- [ ] **Step 4:** PASS + Check. **Step 5: Commit** `feat(palette): agent actions`.

---

### Task 8: Session, record, initiative and project actions

**Depends on:** Task 2, Task 4

**Files:** Modify `frontend/app/cockpit/actions/{session,record,initiative,project}.ts`; tests beside each.
Extract inline conditions/handlers into the owning view's pure model as needed:
`sessionsdetail.tsx` / `sessionsruns.ts`, `jarvis/briefpeekview.tsx` (status toggle, uses `setDossierStatus` from
`recordactions.ts`), `jarvis/briefsurface.tsx` (`workOnInitiative` call ~1565), `agents/projectswitcher.tsx`
(`DeleteProjectCommand` ~42, "Remove project"), `jarvis/briefprofileview.tsx` ("Run defaults" ~612).

**Interfaces — Produces:** `SESSION_KIND` (entries from `sessionsArchiveAtom`, only resumable ones as the palette
row filters today, key `session:<runtime>:<id>`; a live session resolved to its roster agent the way the Sessions
surface builds `LiveSession`), `RECORD_KIND` (entries from `taskListAtom`, key `record:<id>`), `INITIATIVE_KIND`
(entries from `paletteEffortsAtom`, key `effort:<oref>` — check `briefpalette.ts` `key: \`${kind}:${id}\``),
`PROJECT_KIND` (entries from `channelsAtom` through `dedupeByProject`, key `channel:<oid>`).

| Kind | id | label | group | source |
|---|---|---|---|---|
| Session | session:resume | Resume | open | `runSessionPrimary(model, session)` when not live and resumable |
| Session | session:open | Open in Sessions | open | the Sessions surface selection + `surfaceAtom = "sessions"`, via `openTarget` if it has a session target, else the Sessions surface's own selection atom |
| Session | session:stop | Stop | stop, destructive | live with a roster agent; `confirmCloseSession(agent, model)` |
| Record | record:open | Open | open | `openAddress(model, "task:<id>")` |
| Record | record:status | Change status | steer | the peek's status toggle condition; `input: pick` of the statuses it offers; `setDossierStatus` |
| Record | record:focus | Focus on it | steer | `enterFocusFor(model, { ref: { kind: "task", id }, label, project: "" })` as the palette's focus drill |
| Initiative | effort:open | Open | open | `openAddress(model, oref)` |
| Initiative | effort:work | Work on it / go to its agent | steer | not archived (the palette's `workOn` rule today); `workOnInitiative(model, e)` |
| Project | channel:switch | Switch to it | open | `openTarget(model, { kind: "channel", channelId })` |
| Project | channel:new-run | New run in it | steer | set `newRunPrefillAtom` with the project name, `shape: "orchestrator"`, empty goal (Task 4's generalized prefill), then `newRunOpenAtom` |
| Project | channel:defaults | Run defaults | steer | what the Brief's "Run defaults" affordance opens, for this channel |
| Project | channel:remove | Remove | stop, destructive | the switcher's own confirm + `DeleteProjectCommand` extracted into an exported function |

`channel:new-run` writes Task 4's generalized prefill: `{ projectName, goal: "", shape: "orchestrator" }`.

- [ ] **Step 1: Failing tests** per kind: `applies` true/false (resume false for a live session; stop false
  without a live agent; work false for an archived initiative), and each kind's `entries` keys match the formats
  above.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS + Check.
- [ ] **Step 5: Commit** `feat(palette): session, record, initiative and project actions`.

---

### Task 9: Palette wiring I — scope row, prefixes, Needs you, Start group, goal block, data

**Depends on:** Task 1, Task 3, Task 5, Task 4

**Files:**
- Modify: `frontend/app/cockpit/command-palette.tsx`, `palette-rows.tsx`, `palette-groups.ts` (+ test),
  `palette-launch.ts` (+ test)

**Interfaces:**
- Consumes: Task 1 (`parsePrefix` via `typeQuery`, `ghostHint`, `placeholderFor`, `"needs"` scope); Task 3
  (`allRunsAtom`, `loadAllRuns`, `palettePickChannel`); Task 5 (`needsRows`, `needsGroups`, `inlineSelections`,
  `answerAgentAsk`); Task 4 (`NewRunPrefill` with `shape`, `newRunPrefillAtom`, `lastPickedProjectAtom`,
  `model.newInitiativeOpenAtom`).
- Produces for Task 10: `GroupKind` gains `"needs"`, `"answer"`, `"start"` (`"start"` also joins
  `ALL_KIND_ORDER`, after `surface`, so it ranks and records MRU like other kinds); `PaletteItem` unchanged except an
  optional `digit?: number` (inline answer rows); the component keeps a single `fire(item)` path.

**What to build** (match `Main.dc.html` states "open", "search All", "narrow with a prefix", "Needs you",
"type a goal" and `ScopeRow.dc.html` option F exactly):
1. **Scope row F**: tabs show labels only (drop the sigil spans); the input shows a narrowed scope reached by
   prefix as a token; the ghost hint renders after the typed letter in All; placeholder from `placeholderFor`
   (Files keeps its project-specific one).
2. **Data on open**: call `primeChannels()` (as `NewRunModalHost` does) and `loadAllRuns(channels)` once channels
   are known; the Runs pool becomes `allRunsAtom` (cross-project, the project label in each row's meta); the
   launch target falls back through `palettePickChannel(channel, channels, get(lastPickedProjectAtom), label)`.
3. **Needs you scope** (`n:`): rows from `attentionAtom` via `needsRows(items, agents)`, grouped by
   `needsGroups`, each row's echo naming what Enter does. Enter on an ask row with options fires nothing new —
   its options render as `answer` rows under it when it is selected, and digits 1–9 answer via
   `inlineSelections` + `answerAgentAsk`, then close. Enter on an ask without options opens the agent at its
   question (`model.openTerminal`). Enter on a review row with `review: true` opens the agent and sets
   `docReviewAtom` to its id. Gate / dag rows open their run (`openTarget` with `runId`, or `openRunDag` for a
   `dag-*` item). Empty All leads with the first three Needs you rows (mockup "open" state) above Recent.
4. **Start group** on every surface: New run… (`model.newRunOpenAtom`), New agent… (`model.newAgentOpenAtom`),
   New initiative… (`model.newInitiativeOpenAtom`) as ordinary `start` rows — in Commands and ranked in All.
   `jarvis:new-run` stays Jarvis's `r` binding.
5. **Goal block**: Enter = Quick and Ctrl+Enter = Orchestrate from *any* row of the launch block (use the row
   `alt` mechanism); add **Set up the run…**, which sets `newRunPrefillAtom` to
   `{ projectName: <target project>, goal, shape: <selected row's shape> }`, opens `model.newRunOpenAtom`, and
   closes the palette. A successful Quick/Orchestrate start opens the run (`openTarget(model, { kind: "run",
   runId })` with the `Run` `createRun` returns) instead of only switching to Jarvis.

- [ ] **Step 1: Failing tests** for the pure parts: in `palette-launch.test.ts`, the launch rows carry an
  Orchestrate `alt` and a `setup` row; in `palette-groups.test.ts`, `assembleAllGroups` with `needs` input leads
  an empty query with at most three Needs you rows, and a `start` row ranks in All by name ("new run" matches
  "New run…" above the name floor, so the goal block no longer leads).
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** `npx vitest run frontend/app/cockpit` PASS; Check;
  `npx prettier --check` and `npx eslint` on the touched files.
- [ ] **Step 5: Commit** `feat(palette): scope prefixes, Needs you, Start group, goal block`.

---

### Task 10: Palette wiring II — actions on every thing

**Depends on:** Task 9, Task 6, Task 7, Task 8

**Files:**
- Modify: `frontend/app/cockpit/command-palette.tsx`, `palette-rows.tsx`, `palette-groups.ts` (+ test)
- Create: `frontend/app/cockpit/palette-actionrows.ts`, `palette-actionrows.test.ts`
- Modify: `docs/keyboard-shortcuts.md` (→, ←, digits in Needs you, Ctrl+Enter in the goal block, prefixes)

**Interfaces:**
- Consumes: `THING_KINDS`, `kindOfKey`, `actionsFor`, `verbRows` (Task 2) and the six filled kinds; Task 1's
  `openActions`, `openActionInput`, `leaveActions`, `caretAtEnd`.
- Produces: `GroupKind` gains `"action"` (added to `ALL_KIND_ORDER` after `run`, capped like every kind).
  ```ts
  // palette-actionrows.ts — pure: a thing's action list as palette groups (open / steer / stop, then Not now)
  export function actionListGroups<T>(def: ThingKindDef<T>, entry: ThingEntry<T>, query: string):
      { groups: { key: string; label: string; actions: ThingAction<T>[] }[]; notNow: string | null };
  ```

**What to build** (mockup states "a run's actions", "narrow to actions"):
1. **→** on a selected row whose key resolves via `kindOfKey` + that kind's `entries` opens its action list as a
   drill (`<noun> › <title>` chip), only when `caretAtEnd(query, input.selectionStart)`; otherwise the key moves
   the caret. **←** or Backspace on an empty action filter leaves (`leaveActions`, restoring query and `sel`).
   Enter on a normal row keeps its main action.
2. **Action list**: sections open / steer / stop from `actionsFor`, filtered by the query with
   `rankPaletteItems`; destructive rows in the error tone; the **Not now** line names the kind's actions that do
   not apply. An action with `input` opens `openActionInput` — a pick input lists its options as rows, a text
   input takes the field's text and Enter submits. Running an action goes through `runPaletteAction`: failure
   shows the error banner (as `launchError` does), success closes.
3. **Verb rows**: in All, `verbRows` across every kind form the `action` group (ranked with the name floor,
   capped at `MAX_IN_ALL`); in the Commands scope, verb rows sit alongside the registry commands. Typing "cancel"
   with cancellable runs lists `Cancel run · <run>` rows and they outrank the goal block.
4. `docs/keyboard-shortcuts.md`: document the palette keys above.

- [ ] **Step 1: Failing tests**: `palette-actionrows.test.ts` (groups in open/steer/stop order, empty groups
  dropped, the Not now line lists non-applicable labels, the query filters actions); `palette-groups.test.ts`
  (an `action` row that meets the name floor makes the name groups lead instead of the launch block; with none,
  the launch block still leads — the "cancel" case both ways).
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** `npx vitest run frontend/app/cockpit` PASS; Check;
  prettier/eslint on touched files.
- [ ] **Step 5: Commit** `feat(palette): actions on every thing`.

---

### Task 11: CDP scenarios

**Depends on:** Task 10

**Files:** Modify `scripts/cdp/scenarios.mjs` (add two scenarios; read the existing `brief-surface` palette
steps ~700-810 and `runs-lifecycle` first — they show `h.rpc`, `h.ev`, fixture setup and teardown).

1. **`palette-actions`**: arrange a channel in a temp dir with one run (use the fixture path `runs-lifecycle` or
   `attention-cross-channel` uses; do not spawn real workers — a run record is enough); open the palette with
   Ctrl+P (or set `paletteOpenAtom` via the same hook the existing palette steps use); type `r:`; assert the
   Runs scope token shows; select the run's row; dispatch ArrowRight; assert the action list shows the Open /
   Steer / Stop sections, `Cancel run` present, and a Not now line; Backspace returns to the run list with the
   run still selected. Scope every query to the palette's container (`[data-palette-input]`'s modal), never
   document-wide.
2. **`palette-goal`**: type a goal that names nothing in All with a project active; assert the launch block
   leads with Quick selected and the footer shows the Ctrl+Enter Orchestrate line; select **Set up the run…**,
   Enter; assert the New run window is open with the goal filled and Orchestrate… not started (no `createrun`
   happens: check the channel's run count is unchanged). Teardown closes the window and deletes the channel.
   Deliberate deviation from the spec's Verification line ("fires Ctrl+Enter against fixtures"): actually
   firing Orchestrate spawns a real lead, so the scenario asserts the Ctrl+Enter binding in the footer and
   drives Set up the run… instead; Ctrl+Enter's handler is covered by `palette-launch.test.ts` (Task 9).

Note: CDP key events may not reach the WebView unless the page has focus — follow the existing palette steps'
way of typing (`Input.insertText` / the input's value setter) and pin the viewport to 1600x950 as other
scenarios do.

- [ ] **Step 1:** Write both scenarios.
- [ ] **Step 2:** If a dev app is reachable (`CDP_PORT`), run `task verify:ui -- palette-actions palette-goal`;
  otherwise `node --check scripts/cdp/scenarios.mjs` and leave the live run to Final.
- [ ] **Step 3: Commit** `test(cdp): palette actions and goal-block scenarios`.
