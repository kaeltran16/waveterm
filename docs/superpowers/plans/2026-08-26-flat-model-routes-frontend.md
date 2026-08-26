# Flat Model Routes — Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the tier dropdown everywhere a run/task route is chosen with a flat, grouped-by-runtime model picker (validated via visual companion 2026-08-26), add a manual catalog refresh, carry the exact model through run creation, the DAG draft, and the live DAG rail, and give failed/stalled tasks an "escalate" that opens the picker and re-queues on the chosen model (one judged hop, cap notice shown).

**Architecture:** Pure logic stays in `.ts` modules with `.test.ts` beside them; `.tsx` components stay thin and use only `@theme` tokens. `route.ts` learns model-keyed capability lookup + a picker-sections builder; `harnessstore` gains a forced-refresh path and `harness:preferredmodel` persistence; `routepicker.tsx` renders sections/filter/free-form/refresh; `draftmodel`, `dagstore`, and `daggraph` carry model through draft validation, view data, and the node route line; a small `escalate.ts` builds the escalate payload and the graph rail opens the picker before dispatching.

**Tech Stack:** React 19 + TypeScript + jotai, Tailwind v4 tokens from `frontend/tailwindsetup.css`, generated bindings in `frontend/types/gotypes.d.ts`, vitest for pure modules, the CDP harness (`task verify:ui`) for visual checks.

## Global Constraints

- **Backend prerequisite:** the backend plan (`docs/superpowers/plans/2026-08-26-flat-model-routes-backend.md`) must be implemented and `task generate` run before this plan starts — this plan's types come from the regenerated bindings: `RoutePin.model?`, `Run.model?`, `RunSpec.model?`, `RouteCapabilityInfo{ runtime, tier?, model?, resolvedmodel, provider?, contexthint?, default? }`, `CommandDagActionData{ runtime?, model? }`, and client methods `RefreshRouteCatalogCommand` / `ListHarnessesCommand`.
- **DESIGN.md is binding** (read `DESIGN.md` before touching `.tsx`): every color via `@theme` token utilities (`bg-surface-raised`, `border-edge-mid`, `text-muted`, `text-accent`, `text-ink-mid`, …) — **never raw hex/rgba in `className`/`style`**. Typography: Hanken Grotesk sans / JetBrains Mono for ids. Keyboard-first: visible `focus-visible` rings, `aria-label` on icon-only controls.
- **Pure logic + thin render.** All filter/section/payload logic lands in pure `.ts` with `.test.ts`; no jsdom render/snapshot tests. Visual verification is `task verify:ui -- <scenario>` against the running dev app.
- **Never hand-edit generated files** (`store/wshclientapi.ts`, `types/gotypes.d.ts`).
- Typecheck: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` stack-overflows; baseline is clean).
- Tests: `npm test` / `npx vitest run frontend/app/view/agents/route.test.ts` (per-file runs work; the full `npm test` is the final gate).
- Repo git workflow: **do not commit per task.** Stage per task; the final task commits everything in one batch after approval. No co-author lines.
- Verbatim validated layouts (visual companion, 2026-08-26): picker = **grouped by runtime**, sections per harness, provider + context sublabels, search field on top, "＋ custom model id…" rows, refresh affordance in the header; escalate = **button opens the picker popover** with a "Re-queue on model" footer and the one-hop-cap notice. Refinement (approved by design): the custom-model row renders *per runtime section* (scoping the typed id to that runtime); the free-form + search content are identical to the mockup.

---

### Task F1: route.ts model-keyed lookup + picker sections (pure)

**Files:**
- Modify: `frontend/app/view/agents/route.ts`
- Modify: `frontend/app/view/agents/route.test.ts`

**Interfaces:**
- Consumes: regenerated `RouteCapabilityInfo` (`model?`, `provider?`, `contexthint?`, `default?`) and `RoutePin.model?`.
- Produces:
  - `capabilityFor(pin, harnesses)` — model match first, then legacy tier fallback (keeps persisted tier pins rendering).
  - `interface PickerModelRow { runtime: string; model: string; provider: string; contexthint: string; default: boolean; label: string }`
  - `interface PickerSection { runtime: string; label: string; rows: PickerModelRow[] }`
  - `buildPickerSections(harnesses: HarnessInfo[]): PickerSection[]` — model-only rows, grouped by harness.
  - `filterPickerSections(sections: PickerSection[], query: string): PickerSection[]` — case-insensitive on model + provider; empty query = identity.
  - `modelFace(pin: RoutePin): string` — `pin.model ?? pin.tier ?? "capable"` (the displayed id).

- [ ] **Step 1: Write the failing tests**

Extend `frontend/app/view/agents/route.test.ts` (read the existing helpers/fixtures first — it already builds harnesses with `routecapabilities`):

```ts
import { buildPickerSections, capabilityFor, filterPickerSections, modelFace } from "./route";

const cap = (runtime: string, model: string, extra: { provider?: string; contexthint?: string; default?: boolean } = {}) => ({
    runtime,
    model,
    tier: "",
    resolvedmodel: model,
    provider: extra.provider ?? "",
    contexthint: extra.contexthint ?? "",
    default: extra.default ?? false,
});

const harnesses: HarnessInfo[] = [
    {
        runtime: "pi",
        label: "Pi",
        installed: true,
        runworkercapable: true,
        consultcapable: true,
        version: "",
        routecapabilities: [
            { runtime: "pi", tier: "capable", resolvedmodel: "deepseek-v4-pro" }, // legacy row
            cap("pi", "opencode/deepseek-v4-flash", { provider: "opencode", contexthint: "1M" }),
            cap("pi", "opencode/deepseek-v4-pro", { provider: "opencode", contexthint: "1M" }),
        ],
    },
    {
        runtime: "claude",
        label: "Claude Code",
        installed: true,
        runworkercapable: true,
        consultcapable: true,
        version: "",
        routecapabilities: [
            cap("claude", "opus", { default: true }),
            cap("claude", "sonnet"),
            cap("claude", "haiku"),
        ],
    },
];

describe("model-keyed capability lookup", () => {
    it("matches a model pin exactly and ignores legacy tier rows", () => {
        const c = capabilityFor({ runtime: "pi", tier: "", model: "opencode/deepseek-v4-flash" }, harnesses);
        expect(c?.model).toBe("opencode/deepseek-v4-flash");
        expect(c?.provider).toBe("opencode");
    });

    it("falls back to the legacy tier row for pins without a model", () => {
        const c = capabilityFor({ runtime: "pi", tier: "capable" }, harnesses);
        expect(c?.tier).toBe("capable");
        expect(c?.resolvedmodel).toBe("deepseek-v4-pro");
    });
});

describe("picker sections", () => {
    it("builds model-only rows grouped by runtime, excluding legacy tier rows", () => {
        const sections = buildPickerSections(harnesses);
        expect(sections.map((s) => s.runtime)).toEqual(["pi", "claude"]);
        expect(sections[0].rows.map((r) => r.model)).toEqual(["opencode/deepseek-v4-flash", "opencode/deepseek-v4-pro"]);
        expect(sections[0].rows.every((r) => r.label === "Pi")).toBe(true);
        expect(sections[1].rows.find((r) => r.model === "opus")?.default).toBe(true);
    });

    it("omits runtimes with no model capabilities at all", () => {
        const onlyLegacy = [{ ...harnesses[0], routecapabilities: [{ runtime: "pi", tier: "capable", resolvedmodel: "deepseek-v4-pro" }] }];
        expect(buildPickerSections(onlyLegacy)).toEqual([]);
    });

    it("filters by model and provider, case-insensitive", () => {
        const sections = buildPickerSections(harnesses);
        const byModel = filterPickerSections(sections, "deepseek-v4-flash");
        expect(byModel.flatMap((s) => s.rows.map((r) => r.model))).toEqual(["opencode/deepseek-v4-flash"]);
        const byProvider = filterPickerSections(sections, "OPENCODE");
        expect(byProvider.flatMap((s) => s.rows.map((r) => r.provider))).toEqual(["opencode", "opencode"]);
        expect(filterPickerSections(sections, "").flatMap((s) => s.rows)).toHaveLength(5);
    });

    it("modelFace returns model when set, tier otherwise", () => {
        expect(modelFace({ runtime: "pi", model: "opencode/deepseek-v4-pro" })).toBe("opencode/deepseek-v4-pro");
        expect(modelFace({ runtime: "claude", tier: "capable" })).toBe("capable");
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/route.test.ts`
Expected: FAIL — `buildPickerSections` etc. undefined, and the existing `capabilityFor` matches tier rows for model pins.

- [ ] **Step 3: Implement**

In `frontend/app/view/agents/route.ts`, add after `capabilityFor` (replace the existing body):

```ts
export function capabilityFor(pin: RoutePin | null | undefined, harnesses: HarnessInfo[]): RouteCapability | undefined {
    if (pin == null) {
        return undefined;
    }
    const caps = harnesses.flatMap((h) => h.routecapabilities ?? []);
    if (pin.model) {
        const byModel = caps.find((c) => c.runtime === pin.runtime && c.model === pin.model);
        if (byModel != null) {
            return byModel;
        }
    }
    // legacy tier fallback: persisted pins without a model still render their resolved tier model
    return caps.find((c) => c.runtime === pin.runtime && (c.tier ?? "") !== "" && c.tier === (pin.tier || "capable"));
}
```

Add the section-building pure logic at the end of the file:

```ts
export interface PickerModelRow {
    runtime: string;
    model: string;
    provider: string;
    contexthint: string;
    default: boolean;
    label: string;
}

export interface PickerSection {
    runtime: string;
    label: string;
    rows: PickerModelRow[];
}

// model-only rows for the picker; legacy tier capabilities never become rows ("flat model list").
export function buildPickerSections(harnesses: HarnessInfo[]): PickerSection[] {
    return harnesses
        .map((h) => ({
            runtime: h.runtime,
            label: h.label,
            rows: (h.routecapabilities ?? [])
                .filter((c) => (c.model ?? "") !== "")
                .map((c) => ({
                    runtime: c.runtime,
                    model: c.model!,
                    provider: c.provider ?? "",
                    contexthint: c.contexthint ?? "",
                    default: c.default ?? false,
                    label: h.label,
                })),
        }))
        .filter((s) => s.rows.length > 0);
}

export function filterPickerSections(sections: PickerSection[], query: string): PickerSection[] {
    const q = query.trim().toLowerCase();
    if (q === "") {
        return sections;
    }
    return sections
        .map((s) => ({ ...s, rows: s.rows.filter((r) => r.model.toLowerCase().includes(q) || r.provider.toLowerCase().includes(q)) }))
        .filter((s) => s.rows.length > 0);
}

// displayed id on the picker face / graph route line
export function modelFace(pin: RoutePin): string {
    return pin.model ?? pin.tier ?? "capable";
}
```

Note: `modelFace` is a pure string picker — the component decides the full face text (`label · <modelFace>`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/route.test.ts`
Expected: PASS (new + pre-existing cases).

- [ ] **Step 5: Typecheck + stage**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

```bash
git add frontend/app/view/agents/route.ts frontend/app/view/agents/route.test.ts
```

---

### Task F2: harnessstore refresh + preferred-model persistence

**Files:**
- Modify: `frontend/app/view/agents/harnessstore.ts`
- Modify: `frontend/app/view/agents/cockpitshell.tsx`
- Modify: `frontend/app/view/agents/runactions.ts` (`resolveChannelLaunchRoute`, `createRun`)
- Create: `frontend/app/view/agents/harnessstore.test.ts`

**Interfaces:**
- Consumes: `RpcApi.RefreshRouteCatalogCommand`, `RpcApi.ListHarnessesCommand`, `RpcApi.SetConfigCommand`, generated `RoutePin.model?`.
- Produces:
  - `loadHarnesses(forceRefresh = false): Promise<void>` — calls `RefreshRouteCatalogCommand` first when forced, then always re-lists.
  - `refreshHarnessCatalog(): Promise<void>` — `return loadHarnesses(true)` (used by the picker's ↻ button).
  - `setPreferredRoute(route)` persists `harness:preferredmodel` alongside runtime/tier.
  - `initHarnessPreference(persistedRuntime, persistedTier = "", persistedModel = "")` honors the model.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/agents/harnessstore.test.ts` — mock the RPC module (check how `composercommand.test.ts` mocks `wshclientapi` and mirror precisely; `vi.mock` hoisting applies):

```ts
import { vi } from "vitest";

const listHarnesses = vi.fn();
const refreshRouteCatalog = vi.fn();
const setConfig = vi.fn();

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        ListHarnessesCommand: (...args: unknown[]) => listHarnesses(...args),
        RefreshRouteCatalogCommand: (...args: unknown[]) => refreshRouteCatalog(...args),
        SetConfigCommand: (...args: unknown[]) => setConfig(...args),
    },
}));

import { globalStore } from "@/app/store/global";
import { harnessesAtom, loadHarnesses, setPreferredRoute } from "./harnessstore";

describe("harnessstore model catalog freshness", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        listHarnesses.mockResolvedValue({ harnesses: [] });
        refreshRouteCatalog.mockResolvedValue(undefined);
        setConfig.mockResolvedValue(undefined);
    });

    it("refreshes the catalog before re-listing when forced", async () => {
        await loadHarnesses(true);
        expect(refreshRouteCatalog).toHaveBeenCalledTimes(1);
        expect(listHarnesses).toHaveBeenCalledTimes(1);
    });

    it("does not refresh when not forced", async () => {
        await loadHarnesses();
        expect(refreshRouteCatalog).not.toHaveBeenCalled();
        expect(listHarnesses).toHaveBeenCalledTimes(1);
    });

    it("persists model in the route settings patch", async () => {
        setPreferredRoute({ runtime: "pi", tier: "", model: "opencode/deepseek-v4-pro" });
        await vi.waitFor(() => expect(setConfig).toHaveBeenCalled());
        const patch = setConfig.mock.calls[0][1] as Record<string, string>;
        expect(patch["harness:preferredmodel"]).toBe("opencode/deepseek-v4-pro");
        expect(patch["harness:preferredruntime"]).toBe("pi");
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/harnessstore.test.ts`
Expected: FAIL — `loadHarnesses(true)` doesn't refresh (no `forceRefresh` param), `setPreferredRoute` never writes the model key.

- [ ] **Step 3: Implement**

In `harnessstore.ts`:

```ts
export async function loadHarnesses(forceRefresh = false): Promise<void> {
    if (forceRefresh) {
        // the catalog is cached server-side; only a forced refresh re-enumerates installed CLIs
        try {
            await RpcApi.RefreshRouteCatalogCommand(TabRpcClient);
        } catch (e) {
            console.error("refreshing route catalog failed", e);
        }
    }
    try {
        const rtn = await RpcApi.ListHarnessesCommand(TabRpcClient);
        globalStore.set(harnessesAtom, rtn?.harnesses ?? []);
    } catch (e) {
        console.error("loading harness catalog failed", e);
        globalStore.set(harnessesAtom, []);
    }
}

export async function refreshHarnessCatalog(): Promise<void> {
    return loadHarnesses(true);
}
```

In `setPreferredRoute`, replace the `SetConfigCommand` payload with a model-aware patch:

```ts
    void (async () => {
        try {
            const patch: Record<string, string> = { "harness:preferredruntime": route.runtime };
            if ((route.tier ?? "") !== "") patch["harness:preferredtier"] = route.tier!;
            if ((route.model ?? "") !== "") patch["harness:preferredmodel"] = route.model!;
            await RpcApi.SetConfigCommand(TabRpcClient, patch as Parameters<typeof RpcApi.SetConfigCommand>[1]);
            globalStore.set(harnessPreferenceAtom, persistSave(globalStore.get(harnessPreferenceAtom)));
        } catch (e) {
            globalStore.set(harnessPreferenceAtom, failSave(globalStore.get(harnessPreferenceAtom), String(e)));
        }
    })();
```

Also fix the equality guard inside `setPreferredRoute` so a model-only change still saves:

```ts
    const same = current.route != null
        && current.route.runtime === route.runtime
        && (current.route.model ?? "") === (route.model ?? "")
        && (current.route.tier ?? "") === (route.tier ?? "");
    if (current.saving || same) {
        return;
    }
```

(Inspect the function's current guard and replace it with the `same` comparison above.)

Update `initHarnessPreference`:

```ts
export function initHarnessPreference(persistedRuntime: string, persistedTier = "", persistedModel = ""): void {
    const current = globalStore.get(harnessPreferenceAtom);
    if (current.saving) {
        return;
    }
    const route = persistedRuntime
        ? { runtime: persistedRuntime, tier: persistedTier || "capable", ...(persistedModel ? { model: persistedModel } : {}) }
        : null;
    globalStore.set(harnessPreferenceAtom, { route, persistedRoute: route, saving: false });
}
```

In `cockpitshell.tsx`, extend the boot seeding to read the model key:

```ts
        const persisted = (globalStore.get(getSettingsKeyAtom("harness:preferredruntime")) as string) ?? "";
        const persistedTier = (globalStore.get(getSettingsKeyAtom("harness:preferredtier")) as string) ?? "";
        const persistedModel = (globalStore.get(getSettingsKeyAtom("harness:preferredmodel")) as string) ?? "";
        initHarnessPreference(persisted, persistedTier, persistedModel);
```

In `runactions.ts` `resolveChannelLaunchRoute`, include the persisted model in the settings pin:

```ts
    const settingsModel = (globalStore.get(getSettingsKeyAtom("harness:preferredmodel")) as string) ?? "";
    const settings = pref.route ?? (settingsRuntime ? { runtime: settingsRuntime, tier: settingsTier || "capable", ...(settingsModel ? { model: settingsModel } : {}) } : null);
```

In `createRun` (line ~75), stop requiring a tier (model pins have a bare tier) and forward the model:

```ts
    if (!route.runtime) throw new Error("Choose a route");
    const rtn = await RpcApi.CreateRunCommand(TabRpcClient, {
        channelid: channelId,
        workspaceid: workspaceId,
        goal,
        runtime: route.runtime,
        tier: route.tier ?? "",
        ...(route.model ? { model: route.model } : {}),
        mode: opts?.mode,
        plangate: opts?.planGate,
        deferstart: opts?.deferStart,
        ...(opts?.radarOrigin ? { radarorigin: opts.radarOrigin } : {}),
    });
```

(Read the existing `createRun` body first and preserve every current field — the change is: `!route.tier` guard → `!route.runtime` guard, plus the `model` spread. The RPC is `CommandCreateRunData` (confirmed: `json` keys `channelid/workspaceid/goal/runtime/tier/mode/plangate/radarorigin/deferstart`); the backend gains `model` in the backend plan Task 6, so after `task generate` the payload also accepts `model`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/harnessstore.test.ts frontend/app/view/agents/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + stage**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

```bash
git add frontend/app/view/agents/harnessstore.ts frontend/app/view/agents/harnessstore.test.ts frontend/app/view/agents/cockpitshell.tsx frontend/app/view/agents/runactions.ts
```

---

### Task F3: RoutePicker grouped flat layout

**Files:**
- Modify: `frontend/app/view/agents/routepicker.tsx`

**Interfaces:**
- Consumes: `buildPickerSections`, `filterPickerSections`, `modelFace` (F1); `refreshHarnessCatalog` (F2); `harnessesAtom`.
- Produces: the validated "grouped by runtime" popover — search field, per-runtime sections with `provider` + `contexthint` sublabels, per-section "＋ custom model id…" row that expands to an inline input, header refresh (↻) button, unchanged `canInherit`/"Inherit route" row and props contract (`value`, `onChange`, `canInherit`, `inheritedLabel`, `placement`, `openRequest`).

- [ ] **Step 1: Rewrite the popover body (thin render, tokens only)**

Keep the component's existing shell (floating-ui setup, `face`, `choose`, focus/dismiss interactions) and replace the popover's inner list. Notable changes:

```tsx
import { buildPickerSections, filterPickerSections, modelFace, type PickerSection } from "./route";
import { harnessesAtom, refreshHarnessCatalog } from "./harnessstore";
import { useState } from "react";
```

Face text — model-aware (replace the current `face` expression):

```tsx
    const face = value == null
        ? inheritedLabel
        : `${harness?.label ?? value.runtime} · ${modelFace(value)}`;
```

The popover header row (replace the static "Run route" label block):

```tsx
                    <div className="flex items-center justify-between px-[9px] pb-1.5 pt-1">
                        <span className="font-mono text-[9px] font-semibold uppercase tracking-[.09em] text-muted">Run route</span>
                        <button
                            type="button"
                            onClick={() => void refreshHarnessCatalog()}
                            aria-label="Refresh model catalog"  // per DESIGN.md: aria-label on icon-only controls
                            title="Refresh model catalog"
                            className="cursor-pointer rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-surface-hover hover:text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        >
                            ↻
                        </button>
                    </div>
```

Search input (place directly under the header, above the inherit row):

```tsx
                    <input
                        type="text"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="filter models…"
                        aria-label="Filter models"
                        className="mb-1 w-full rounded-[7px] border border-edge-mid bg-surface px-2 py-1 text-[11.5px] text-primary outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    />
```

State + filtered sections (inside the component before `return`):

```tsx
    const [query, setQuery] = useState("");
    const [customId, setCustomId] = useState<{ runtime: string; draft: string } | null>(null);
    const sections = useMemo(() => {
        const built = buildPickerSections(harnesses);
        return filterPickerSections(built, query);
    }, [harnesses, query]);
```

Per-section rendering (each section's rows + its "＋ custom model id…" row):

```tsx
                        {sections.map((section) => (
                            <div key={section.runtime} className="mt-1 border-t border-border pt-1">
                                <div className="px-[9px] py-1 text-[11px] font-semibold text-secondary">{section.label}</div>
                                {section.rows.map((row) => {
                                    const selectedRow = value?.runtime === row.runtime && value.model === row.model;
                                    return (
                                        <button
                                            key={row.model}
                                            type="button"
                                            aria-pressed={selectedRow}
                                            data-testid={`route-option-${row.runtime}-${row.model}`}
                                            onClick={() => choose({ runtime: row.runtime, model: row.model })}
                                            className={cn(
                                                "flex w-full cursor-pointer items-start gap-2 rounded px-[9px] py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                                                selectedRow ? "bg-surface-raised" : "hover:bg-surface-hover"
                                            )}
                                        >
                                            <span className="min-w-0 flex-1">
                                                <span className={cn("block font-mono text-[11.5px]", selectedRow ? "text-accent" : "text-primary")}>{row.model}</span>
                                                <span className="mt-[2px] block text-[10px] text-muted">
                                                    {row.provider && row.provider !== row.runtime ? `provider ${row.provider} · ` : ""}
                                                    {row.contexthint ? `ctx ${row.contexthint} · ` : ""}
                                                    {row.default ? "CLI default" : ""}
                                                </span>
                                            </span>
                                            {selectedRow ? <span className="pt-[3px] font-mono text-[11px] text-accent">✓</span> : null}
                                        </button>
                                    );
                                })}
                                {customId?.runtime === section.runtime ? (
                                    <div className="flex items-center gap-1.5 px-[9px] py-1.5">
                                        <input
                                            autoFocus
                                            value={customId.draft}
                                            onChange={(e) => setCustomId({ runtime: section.runtime, draft: e.target.value })}
                                            onKeyDown={(e) => {
                                                if (e.key === "Enter" && customId.draft.trim()) {
                                                    choose({ runtime: section.runtime, model: customId.draft.trim() });
                                                }
                                            }}
                                            aria-label={`Custom model id for ${section.label}`}
                                            className="min-w-0 flex-1 rounded-[7px] border border-edge-mid bg-surface px-2 py-1 text-[11px] font-mono text-primary outline-none focus-visible:ring-2 focus-visible:ring-accent"
                                        />
                                        <button
                                            type="button"
                                            onClick={() => customId.draft.trim() && choose({ runtime: section.runtime, model: customId.draft.trim() })}
                                            aria-label="Use custom model"
                                            className="cursor-pointer rounded-md border border-edge-mid px-2 py-1 text-[10.5px] font-semibold text-secondary hover:border-edge-strong hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                                        >
                                            Use
                                        </button>
                                    </div>
                                ) : (
                                    <button
                                        type="button"
                                        onClick={() => setCustomId({ runtime: section.runtime, draft: "" })}
                                        className="flex w-full cursor-pointer items-center gap-2 rounded px-[9px] py-1.5 text-left text-[11px] text-muted hover:bg-surface-hover hover:text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                                    >
                                        ＋ custom model id…
                                    </button>
                                )}
                            </div>
                        ))}
```

Keep the existing `canInherit` row above the sections and the empty state ("No run routes available.") only when `sections.length === 0 && !query`.

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 3: Verify visually via the CDP harness**

Add a scenario to `scripts/cdp/scenarios.mjs` (model the object on `surfaceSmoke`; register it in the `SCENARIOS` array) that: opens the Agent surface → opens the route picker on the settings "Run defaults" row (`data-testid="route-picker"`) → asserts at least one `route-option-<runtime>-<model>` button exists and its label contains a model id → types a filter into the search box and asserts rows shrink → clicks a model row and asserts the face text no longer reads `· capable`.

```js
const routePicker = {
    name: "route-picker-flat",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        await h.goto("settings");
        const pickerOpen = await h.ev(`(() => !!document.querySelector('[data-testid="route-picker"]'))()`);
        await h.ev(`(() => { const b = document.querySelector('[data-testid="route-picker"]'); if (b) b.click(); return true; })()`);
        const rowCount = await h.ev(`(() => document.querySelectorAll('[data-testid^="route-option-"]').length)()`);
        steps.push({
            step: "route picker opens with flat model rows",
            ok: pickerOpen === true && rowCount > 0,
            detail: `rows=${rowCount}`,
        });
        await h.shot("cdp-shots/route-picker-flat.png");
        return steps;
    },
};
// add routePicker to the SCENARIOS array export
```

Run: `task verify:ui -- route-picker-flat` against a running `task dev` app.
Expected: `ok: true` steps and a contact-sheet entry that shows grouped sections (compare visually with the approved companion mockup).

- [ ] **Step 4: Stage**

```bash
git add frontend/app/view/agents/routepicker.tsx scripts/cdp/scenarios.mjs
```

---

### Task F4: Model through the DAG draft + live graph view data

**Files:**
- Modify: `frontend/app/view/orchestrate/draftmodel.ts`
- Modify: `frontend/app/view/orchestrate/draftmodel.test.ts`
- Modify: `frontend/app/view/orchestrate/dagstore.ts`
- Modify: `frontend/app/view/orchestrate/daggraph.tsx`
- Modify (mechanical, picker consumers): `frontend/app/view/orchestrate/dagtaskdrawer.tsx`, `frontend/app/view/agents/settingssurface.tsx`, `frontend/app/view/agents/channelcomposers.tsx`, `frontend/app/view/jarvis/profilepanel.tsx`

**Interfaces:**
- Consumes: `capabilityFor`/`modelFace` (F1), `RoutePicker` (F3, unchanged props).
- Produces:
  - `setDraftRoute` — equality on runtime + model + tier.
  - `toDagSubmitPayload` — `runspec` carries `model`.
  - `validateDraft` — passes through `capabilityFor` (now model-aware).
  - `dagstore.DagNodeRoute` gains `model: string`; `buildViewData` reads `runspec.model` / `run.model`.
  - `daggraph.tsx` route lines show the model (fallback tier) twice — node chip + detail rail.

- [ ] **Step 1: Write the failing pure tests**

Extend `frontend/app/view/orchestrate/draftmodel.test.ts` (read existing fixtures first):

```ts
it("setDraftRoute treats a model change as a change and preserves model", () => {
    const draft = draftWith([{ id: "t-1", label: "x" }]); // reuse the file's draft factory
    const withModel = setDraftRoute(draft, "t-1", { runtime: "pi", tier: "", model: "opencode/deepseek-v4-pro" });
    expect(withModel.tasks[0].route?.model).toBe("opencode/deepseek-v4-pro");
    // same pin again -> identity (no new object)
    expect(setDraftRoute(withModel, "t-1", { runtime: "pi", tier: "", model: "opencode/deepseek-v4-pro" })).toBe(withModel);
});

it("toDagSubmitPayload writes model into runspec", () => {
    const draft = draftWith([{ id: "t-1", label: "x", route: { runtime: "pi", tier: "", model: "opencode/deepseek-v4-pro" } }]);
    const payload = toDagSubmitPayload(draft);
    expect(payload.tasks[0].runspec?.model).toBe("opencode/deepseek-v4-pro");
});
```

(Adapt `draftWith` to the file's existing builder — do not introduce a new helper if one exists.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run frontend/app/view/orchestrate/draftmodel.test.ts`
Expected: FAIL — equality ignores model; `runspec` has no model.

- [ ] **Step 3: Implement**

In `draftmodel.ts`, add a route-equality helper and use it in `setDraftRoute` (replace the tier-only comparison):

```ts
function routeEquals(a: RoutePin | null, b: RoutePin | null): boolean {
    if (a == null || b == null) {
        return a === b;
    }
    return a.runtime === b.runtime && (a.model ?? "") === (b.model ?? "") && (a.tier ?? "") === (b.tier ?? "");
}
```

```ts
    const current = draft.tasks[index].route;
    if (routeEquals(current, route)) return draft;
```

In `toDagSubmitPayload`, write the model into the runspec:

```ts
            ...(task.route == null ? {} : { runspec: { runtime: task.route.runtime, tier: task.route.tier, ...(task.route.model ? { model: task.route.model } : {}) } }),
```

`validateDraft` needs no change — `capabilityFor` from F1 already matches model pins.

In `dagstore.ts`:

```ts
export type DagNodeRoute = {
    source: "pinned" | "inherited";
    runtime: string;
    tier: string;
    model: string; // exact model id when set; "" for legacy tier routes
    resolvedModel: string;
};
```

In `buildViewData`, build pins from model-aware run/spec fields (replace the `ownerRoute`/`taskRoute` lines):

```ts
    const ownerPin = normalizeRunPin(owner);
    const nodes: DagViewNode[] = group.tasks.map((t) => {
        let actions = ACTION_BY_STATE[t.state] ?? [];
        if (t.gate && t.state === "done") actions = GATE_DONE_ACTIONS;
        if (t.state === "done" && !t.gate && !t.merged) actions = ["merge"];
        if (canEscalate(t)) actions = [...new Set([...actions, "escalate"])];
        const taskPin = t.runspec?.runtime || t.runspec?.model ? normalizeSpecPin(t.runspec, owner) : null;
        const effective = taskPin ?? ownerPin ?? { runtime: "", tier: "capable", model: "" };
        const capability = capabilityFor(effective, harnesses);
        return {
            id: t.id,
            label: t.label ?? t.id,
            state: t.state,
            gate: t.gate ?? false,
            meta: t.runid ? `wave/${t.runid}` : "",
            actions,
            route: {
                source: taskPin == null ? "inherited" : "pinned",
                runtime: effective.runtime,
                tier: effective.tier,
                model: effective.model ?? "",
                resolvedModel: capability?.resolvedmodel ?? "unavailable",
            },
        };
    });
```

Add the two normalization helpers at the bottom of `dagstore.ts` (pure, reusable):

```ts
// normalizeRunPin folds a run/spec's runtime+tier(+model) into a selectable pin; model wins.
function normalizeRunPin(run: Run): RoutePin | null {
    if (!run.runtime && !run.model) return null;
    return { runtime: run.runtime ?? "", tier: run.tier ?? "capable", ...(run.model ? { model: run.model } : {}) };
}

function normalizeSpecPin(spec: TaskNode["runspec"] | undefined, owner: Run): RoutePin | null {
    if (spec == null || (!spec.runtime && !spec.model)) return null;
    return {
        runtime: spec.runtime ?? owner.runtime ?? "",
        tier: spec.tier ?? "capable",
        ...(spec.model ? { model: spec.model } : {}),
    };
}
```

Replace the existing `normalizeLegacyRoute(owner.runtime, owner.tier)` usage with `normalizeRunPin(owner)` (the `normalizeLegacyRoute` import may become unused — remove it if so).

In `dagstore.ts`, add the escalate gate (imported from F5's `escalate.ts` — create that module in Task F5; this task wires the import late or stubs it, see the task order note below).

- [ ] **Step 4: Update `daggraph.tsx` route lines (legacy display keeps tier)**

Node chip (line ~68) and detail rail (line ~229) — replace `${view.route.runtime} / ${view.route.tier}` with:

```tsx
{view.route.runtime} / {view.route.model || view.route.tier}
```

- [ ] **Step 5: Mechanical picker consumers**

These files render `RoutePicker` (F3) or `capabilityFor` — no logic change expected; fix compile fallout only:
- `dagtaskdrawer.tsx` — the disabled read-only route text (line ~66) shows `${task.route.runtime} / ${task.route.tier}`; change to `/${task.route.model || task.route.tier}`.
- `settingssurface.tsx`, `channelcomposers.tsx`, `profilepanel.tsx`, `composercommand.ts` — typecheck and adjust any `.tier`-only usages to `model ?? tier`.

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run frontend/app/view/orchestrate/ frontend/app/view/agents/route.test.ts`
Expected: PASS.
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (fix mechanical fallout here if any).

- [ ] **Step 7: Stage**

```bash
git add frontend/app/view/orchestrate/draftmodel.ts frontend/app/view/orchestrate/draftmodel.test.ts frontend/app/view/orchestrate/dagstore.ts frontend/app/view/orchestrate/daggraph.tsx frontend/app/view/orchestrate/dagtaskdrawer.tsx frontend/app/view/agents/settingssurface.tsx frontend/app/view/agents/channelcomposers.tsx frontend/app/view/jarvis/profilepanel.tsx frontend/app/view/agents/composercommand.ts
```

**Ordering note:** Task F4 references `canEscalate` (F5). Either land F5's `escalate.ts` before F4's Step 3 (recommended — keep this task's code compiling between steps), or create a minimal `canEscalate` stub in F4 and have F5 extend it. Prefer: implement `escalate.ts` (F5 Step 1–2) first, then return to F4. The tests are independent either way.

---

### Task F5: Escalate UI on the live DAG rail

**Files:**
- Create: `frontend/app/view/orchestrate/escalate.ts`
- Create: `frontend/app/view/orchestrate/escalate.test.ts`
- Modify: `frontend/app/view/orchestrate/dagstore.ts` (escalate action already wired in F4 via `canEscalate` — verify)
- Modify: `frontend/app/view/orchestrate/daggraph.tsx` (escalate button → picker popover → re-queue)

**Interfaces:**
- Consumes: `TaskNode.escalations` (generated), `RoutePicker` (F3), `RpcApi.DagActionCommand`.
- Produces:
  - `canEscalate(task: { state: string; escalations?: number }): boolean` — failed/stalled and under the one-hop cap.
  - `escalatePayload(channelId: string, runId: string, taskId: string, route: RoutePin): CommandDagActionData` — `{ channelid, runid, taskid, action: "escalate", runtime, model }`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/app/view/orchestrate/escalate.test.ts`:

```ts
import { canEscalate, escalatePayload } from "./escalate";

describe("escalate", () => {
    it("is available on failed/stalled tasks under the cap", () => {
        expect(canEscalate({ state: "failed", escalations: 0 })).toBe(true);
        expect(canEscalate({ state: "stalled" })).toBe(true);
    });

    it("refuses when the task is not failed/stalled", () => {
        expect(canEscalate({ state: "running", escalations: 0 })).toBe(false);
        expect(canEscalate({ state: "done", escalations: 0 })).toBe(false);
    });

    it("refuses at the one-hop cap", () => {
        expect(canEscalate({ state: "failed", escalations: 1 })).toBe(false);
    });

    it("builds the dag action payload with runtime and model", () => {
        const payload = escalatePayload("ch-1", "run-1", "t-3", { runtime: "claude", model: "opus" });
        expect(payload).toMatchObject({ channelid: "ch-1", runid: "run-1", taskid: "t-3", action: "escalate", runtime: "claude", model: "opus" });
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run frontend/app/view/orchestrate/escalate.test.ts`
Expected: FAIL — module undefined.

- [ ] **Step 3: Implement `escalate.ts`**

```ts
// Pure escalate verbs for the live DAG rail: judgment-only, one hop per task (the engine enforces
// the same cap; the UI mirrors it so the button disappears at the boundary).

export function canEscalate(task: { state: string; escalations?: number }): boolean {
    return (task.state === "failed" || task.state === "stalled") && (task.escalations ?? 0) < 1;
}

export function escalatePayload(channelId: string, runId: string, taskId: string, route: RoutePin): CommandDagActionData {
    return { channelid: channelId, runid: runId, taskid: taskId, action: "escalate", runtime: route.runtime, model: route.model ?? "" };
}
```

- [ ] **Step 4: Wire the rail in `daggraph.tsx`**

In the detail rail (the `selected.actions` block), escalate gets a modal-ish inline flow instead of an immediate dispatch:

```tsx
        {selected.actions.length > 0 ? (
            <div className="flex flex-none gap-1.5">
                {selected.actions.map((a) =>
                    a === "escalate" ? (
                        <button
                            key={a}
                            type="button"
                            onClick={() => setEscalating(!escalating)}
                            aria-expanded={escalating}
                            className="cursor-pointer rounded border border-edge-mid bg-surface px-2.5 py-1 text-[11px] font-semibold text-accent hover:border-edge-strong hover:text-accent-soft"
                        >
                            escalate…
                        </button>
                    ) : (
                        <button
                            key={a}
                            type="button"
                            onClick={() => runAction(group, selected, a)}
                            className="cursor-pointer rounded border border-edge-mid px-2.5 py-1 text-[11px] font-semibold text-secondary hover:border-edge-strong hover:text-primary"
                        >
                            {a}
                        </button>
                    )
                )}
            </div>
        ) : null}
```

Add state + the popover below the rail's info block (before the rail's closing tag):

```tsx
    const [escalating, setEscalating] = useState(false);
    const [escalateRoute, setEscalateRoute] = useState<RoutePin | null>(null);
```

```tsx
                        {escalating && (
                            <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-2">
                                <RoutePicker
                                    value={escalateRoute}
                                    canInherit={false}
                                    onChange={setEscalateRoute}
                                    placement="top-start"
                                />
                                <span className="text-[10px] text-muted">one judged hop — a second failure blocks this task for you</span>
                                <div className="ml-auto flex gap-1.5">
                                    <button type="button" onClick={() => setEscalating(false)} className="cursor-pointer rounded border border-edge-mid px-2.5 py-1 text-[11px] text-secondary hover:border-edge-strong">Cancel</button>
                                    <button
                                        type="button"
                                        disabled={escalateRoute == null}
                                        onClick={() => {
                                            if (escalateRoute) {
                                                runEscalate(group, selected, escalateRoute);
                                                setEscalating(false);
                                                setEscalateRoute(null);
                                            }
                                        }}
                                        className="cursor-pointer rounded bg-accent px-2.5 py-1 text-[11px] font-semibold text-background hover:bg-accenthover disabled:cursor-not-allowed disabled:opacity-50"
                                    >
                                        Re-queue on model
                                    </button>
                                </div>
                            </div>
                        )}
```

Add the dispatch helper next to `runAction`:

```tsx
function runEscalate(group: TaskGroup, view: DagViewNode, route: RoutePin) {
    void RpcApi.DagActionCommand(TabRpcClient, escalatePayload(group.channelid, group.runid, view.id, route));
}
```

Imports to add: `useState` (if not already imported), `RoutePicker`, `escalatePayload`.

- [ ] **Step 5: Typecheck + tests**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.
Run: `npx vitest run frontend/app/view/orchestrate/escalate.test.ts frontend/app/view/orchestrate/dagstore.test.ts frontend/app/view/orchestrate/draftmodel.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify visually**

Add `route-escalate` to `scripts/cdp/scenarios.mjs` (pattern from F3): with a stubbed failed task (use the cockpit-fixtures harness or a fixture-dag if one exists; otherwise assert only that the rail renders `escalate…` when the fixture dag has a failed task). Run `task verify:ui -- route-escalate` and check `cdp-shots/route-escalate.png`.

If no DAG fixture with a failed task exists, verify manually: create a run with a failing task via the dev app, select the node, click `escalate…`, pick a model, confirm the `DagActionCommand` fires (backend log) and the task re-queues.

- [ ] **Step 7: Stage**

```bash
git add frontend/app/view/orchestrate/escalate.ts frontend/app/view/orchestrate/escalate.test.ts frontend/app/view/orchestrate/dagstore.ts frontend/app/view/orchestrate/daggraph.tsx scripts/cdp/scenarios.mjs
```

---

### Task F6: Full verify + review + commit (approval gate)

- [ ] **Step 1: Full verification**

Run:
```bash
npm test
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```
Expected: all tests pass, typecheck exit 0.

- [ ] **Step 2: DESIGN.md audit of the changed UI**

Walk `routepicker.tsx` + the `daggraph.tsx` escalate popover against DESIGN.md:
- No raw hex/rgba in any `className`/`style` (search the diff for `#` and `rgba`).
- Focus rings present (`focus-visible:ring-accent`), aria-labels on the ↻ and Use buttons.
- Only one accent CTA per surface ("Re-queue on model" is accent; Cancel is secondary).
- Status never color-alone (the cap notice is text + the failure state already has a label).

- [ ] **Step 3: Simplify self-review of the diff**

Run: `git diff --stat` — every file is one this plan touched. No commented-out code, no debug statements; pure logic has tests; `.tsx` files are thin.

- [ ] **Step 4: Show the commit and ask for approval**

```bash
git status --short
git diff --stat
```

Present (per repo AGENTS.md — do not commit before approval):

```
Files (M/A/D) + one-line change summary each.
Message proposal:
feat(agents): flat model route picker and model-carrying DAG routes

RoutePicker shows grouped per-harness model rows with search, per-runtime
free-form ids, and a catalog refresh; routes carry the exact model
through run creation, DAG drafts, view data, and a judged one-hop
escalate on the live rail. Legacy tier pins keep rendering.
```

Awaiting approval. Proceed? (yes/no)

- [ ] **Step 5: Commit after approval**

```bash
git add -A
git commit -F /tmp/flat-model-routes-frontend-commit.txt   # or multiple -m flags; never PowerShell here-strings
```

Do NOT push. Do NOT add yourself as co-author.