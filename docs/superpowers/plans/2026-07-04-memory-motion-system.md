# Memory Surface Motion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the Memory surface (`view/agents/memorysurface.tsx` + `memgraph.tsx`) onto the shared cockpit motion layer — load reveal, silent-search/animated-mutation list reflow, detail-rail crossfades, a graph settle cue, and a List↔Graph toggle crossfade — reusing existing tokens with no new motion module.

**Architecture:** Memory mirrors the Sessions/Activity grouped-list idiom exactly. A single `reflowAnimated` boolean (sourced from a new `memReflowAnimatedAtom`) gates list motion: search keystrokes set it `false` (instant), mutations set it `true` (animated). A `mountedEmpty` `useState` latch drives the one-shot load reveal. The DetailRail and toggle use inline opacity crossfades (the m5 idiom Files/Sessions already use). The force-graph keeps its d3 physics; it only gains a one-shot `settle` cue on cooldown and rides the toggle crossfade for its entrance.

**Tech Stack:** React 19, `motion/react` (Framer v12), jotai, Tailwind 4. Shared motion source: `frontend/app/element/motiontokens.ts` + `frontend/app/element/motionhooks.ts` + `frontend/tailwindsetup.css`.

**Reference spec:** `docs/superpowers/specs/2026-07-04-memory-motion-design.md`
**Reference implementations to mirror:** `sessionssurface.tsx` (reflow flag + load reveal), `activitysurface.tsx` (two-level grouped reflow), `agenttree.tsx` (`useSettle` class usage).

## Global Constraints

- **No new motion tokens, helpers, or module.** All durations/eases come from `MOTION` in `motiontokens.ts`; reuse `cardVariants`, `reflowProps`, `useSettle`. Never inline a raw duration/ease number.
- **Import `reflowProps` from `@/app/element/motiontokens`** (the promoted single source), not from `sessionsmotion.ts`.
- **Animate transform/opacity only.** `layout` only on container/row elements. No `x`/`y` on `cardVariants` (opacity+scale only).
- **Reduced motion:** one `<MotionConfig reducedMotion="user">` at the `MemorySurface` root; the graph `settle` uses the `motion-reduce:animate-none` Tailwind variant.
- **No entrance cascade:** `reflowAnimated` defaults `false` and `<AnimatePresence initial={false}>`, so the populated mount fires nothing.
- **Never hand-edit generated files.** None are touched here.
- **Typecheck command (tsc stack-overflows on this repo):** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` — baseline is exit 0; any error it reports is yours.
- **Commits:** per project git policy, do NOT commit per-task. Batch all changes into a **single commit at the end** (Task 5), and only after explicit user approval.
- **No render-test harness exists** for the cockpit (per `CLAUDE.md`). Behavioral verification is: (a) typecheck clean, and (b) visual inspection of the live dev app over CDP (`node scripts/cdp-shot.mjs`). Motion smoothness is judged by inspection, not asserted in code.

---

### Task 1: Reflow-source atom in the store

**Files:**
- Modify: `frontend/app/view/agents/memstore.ts`

**Interfaces:**
- Produces: `memReflowAnimatedAtom: PrimitiveAtom<boolean>` — `true` means "the next re-scan is a mutation and its list diff should animate"; `false` means a search-only change (instant). Set `true` by `createNote`/`deleteNote`/`harvestMemory`; set `false` by the search box (Task 2); read by `MemorySurface` (Task 2).

- [ ] **Step 1: Add the atom**

In `memstore.ts`, after `memSearchAtom` (line 29), add:

```ts
// true = the next re-scan is mutation-driven and its list diff should animate (create/delete/harvest);
// false = a search keystroke changed only the rendered subset, so the reflow stays instant. Written by
// the mutation helpers below + the search box; read by MemorySurface into reflowProps.
export const memReflowAnimatedAtom = atom<boolean>(false) as PrimitiveAtom<boolean>;
```

- [ ] **Step 2: Flag mutations as animated**

Set the flag `true` at the top of the three list-changing mutations (not `saveNote` — a content edit changes no rows). In `createNote` (line 78), as the first statement:

```ts
export async function createNote(name: string, type: string, scope: string, body: string, cwd?: string): Promise<void> {
    globalStore.set(memReflowAnimatedAtom, true); // the create's new row should animate in
    await RpcApi.MemoryCreateCommand(TabRpcClient, { name, type, scope, body, cwd });
    await loadMemory();
}
```

In `deleteNote` (line 95), as the first statement:

```ts
export async function deleteNote(path: string): Promise<void> {
    globalStore.set(memReflowAnimatedAtom, true); // the removed row should play its exit
    await RpcApi.MemoryDeleteCommand(TabRpcClient, { path });
    globalStore.set(memSelectedIdAtom, null);
    globalStore.set(memBodyAtom, null);
    await loadMemory();
}
```

In `harvestMemory` (line 85), guard it to the branch that actually reloads (only when facts landed):

```ts
    if (ingested > 0) {
        globalStore.set(memReflowAnimatedAtom, true); // harvested rows should animate in
        await loadMemory();
    }
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (no new errors).

---

### Task 2: List pane — load reveal, reflow flag, selection micro, MotionConfig root

**Files:**
- Modify: `frontend/app/view/agents/memorysurface.tsx`

**Interfaces:**
- Consumes: `memReflowAnimatedAtom` (Task 1); `MOTION`, `cardVariants`, `reflowProps` from `@/app/element/motiontokens`; `AnimatePresence`, `MotionConfig`, `motion` from `motion/react`.
- Produces: `ListView` now accepts `rp: ReflowProps` and `mountedEmpty: boolean` props (used by Task 4's toggle wiring, which renders `ListView`).

- [ ] **Step 1: Add imports**

At the top of `memorysurface.tsx`, add:

```ts
import { MOTION, cardVariants, reflowProps } from "@/app/element/motiontokens";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
```

And add `memReflowAnimatedAtom` to the existing import block from `./memstore`.

- [ ] **Step 2: Make the search box reset the flag to instant**

In `Header`, the search `onChange` (line 45) currently only sets `memSearchAtom`. Change it to also mark the change search-driven:

```tsx
                onChange={(e) => {
                    globalStore.set(memSearchAtom, e.target.value);
                    globalStore.set(memReflowAnimatedAtom, false); // search filters instantly, never reflow-animated
                }}
```

- [ ] **Step 3: Convert `ListView` to animated rows**

Replace the `ListView` signature and body (lines 79-127) so groups and rows are `motion` elements driven by `rp`, wrapped in a load-reveal fade. `mountedEmpty` gates the one-shot fade; `rp` gates entrance/exit/reflow.

```tsx
function ListView({
    notes,
    selectedId,
    rp,
    mountedEmpty,
}: {
    notes: MemNote[];
    selectedId: string | null;
    rp: ReflowProps;
    mountedEmpty: boolean;
}) {
    const groups = groupByScope(notes);
    return (
        <motion.div
            initial={mountedEmpty ? { opacity: 0 } : false}
            animate={{ opacity: 1 }}
            transition={{ duration: MOTION.durMacro, ease: MOTION.easeFluid }}
            className="mx-auto max-w-[780px] px-[28px] pb-[60px] pt-[10px]"
        >
            <AnimatePresence mode="popLayout" initial={false}>
                {groups.map((g) => (
                    <motion.div
                        key={g.name}
                        layout
                        variants={cardVariants}
                        initial={rp.initial}
                        animate="animate"
                        exit={rp.exit}
                        transition={rp.transition}
                        className="mb-[26px]"
                    >
                        <div className="mb-[11px] flex items-center gap-[10px]">
                            <h2 className="font-mono text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-mid">
                                {g.name}
                            </h2>
                            <span className="font-mono text-[11px] font-semibold text-ink-faint">{g.count}</span>
                            <div className="h-px flex-1 bg-gradient-to-r from-edge-faint to-transparent" />
                        </div>
                        <AnimatePresence mode="popLayout" initial={false}>
                            {g.items.map((n) => {
                                const m = typeMeta(n.type);
                                return (
                                    <motion.button
                                        key={n.id}
                                        layout
                                        variants={cardVariants}
                                        initial={rp.initial}
                                        animate="animate"
                                        exit={rp.exit}
                                        transition={rp.transition}
                                        onClick={() => fireAndForget(() => selectNote(n.id))}
                                        className={cn(
                                            "mb-[8px] flex w-full cursor-pointer items-center gap-[13px] rounded-[11px] border px-[15px] py-[12px] text-left transition-colors duration-150 hover:border-edge-strong",
                                            n.id === selectedId
                                                ? "border-edge-strong bg-surface"
                                                : "border-edge-faint bg-background"
                                        )}
                                    >
                                        <span
                                            className={cn(
                                                "min-w-[78px] flex-none rounded-[5px] px-[8px] py-[3px] text-center font-mono text-[9.5px] font-semibold uppercase tracking-[0.05em]",
                                                m.pillClass
                                            )}
                                            style={{ background: "rgba(255,255,255,0.05)" }}
                                        >
                                            {m.label}
                                        </span>
                                        <div className="min-w-0 flex-1">
                                            <div className="truncate font-mono text-[13px] font-semibold text-foreground">
                                                {n.title}
                                            </div>
                                            <div className="truncate text-[11.5px] text-ink-mid">{n.description}</div>
                                        </div>
                                    </motion.button>
                                );
                            })}
                        </AnimatePresence>
                    </motion.div>
                ))}
            </AnimatePresence>
        </motion.div>
    );
}
```

Note: the per-row `gap-[8px]` wrapper `<div>` from the original is dropped; row spacing moves to `mb-[8px]` on each `motion.button` (a flex-column `gap` fights `popLayout` reflow). `ReflowProps` is imported implicitly via the `reflowProps` import — add the type import: extend the motiontokens import to `import { MOTION, cardVariants, reflowProps, type ReflowProps } from "@/app/element/motiontokens";`.

- [ ] **Step 4: Wire flag + load-reveal state + MotionConfig in `MemorySurface`**

In `MemorySurface` (lines 288-345): read the flag, compute `rp`, add the `mountedEmpty` latch, wrap the return in `<MotionConfig>`, and pass the new props to `ListView`. Add near the other `useAtomValue` calls:

```tsx
    const reflowAnimated = useAtomValue(memReflowAnimatedAtom);
    // fade the list in only on the first-ever populate; memNotesAtom persists across remounts so a
    // cached re-entry mounts non-empty and the reveal is suppressed (mirrors Sessions/Activity).
    const [mountedEmpty] = useState(() => notes.length === 0);
    const rp = reflowProps(reflowAnimated);
```

Wrap the entire returned tree in `<MotionConfig reducedMotion="user"> … </MotionConfig>` (wrap the existing outer `<div className="absolute inset-0 flex flex-col">`). Change the `ListView` render (line 335) to:

```tsx
                    ) : view === "list" ? (
                        <ListView notes={filtered} selectedId={selectedId} rp={rp} mountedEmpty={mountedEmpty} />
                    ) : (
```

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 6: Visual verify (list)**

With `task dev` running, capture the Memory surface list view:
Run: `node scripts/cdp-shot.mjs mem-list.png`
Expected (by inspection): mounting the populated list shows **no** staggered cascade; typing in the search box filters instantly with no strobing; creating a note (via New memory) animates the new row in; deleting a note animates its row out and reflows the rest; selecting a row eases the highlight.

---

### Task 3: DetailRail — content + edit crossfades

**Files:**
- Modify: `frontend/app/view/agents/memorysurface.tsx` (`DetailRail`)

**Interfaces:**
- Consumes: `MOTION`, `AnimatePresence`, `motion` (already imported in Task 2).

- [ ] **Step 1: Crossfade the whole detail on selection (incl. empty→content)**

`DetailRail` currently early-returns the empty placeholder (lines 152-158) then renders the selected `<aside>`. Restructure so the `<aside>` is always rendered and its inner content is an `AnimatePresence mode="wait"` keyed on `sel?.id ?? "empty"`. Replace the empty early-return + the opening `<aside>` of the selected branch with a single always-rendered aside:

```tsx
    return (
        <aside className="w-[330px] flex-none overflow-y-auto border-l border-edge-faint bg-surface px-[20px] pb-[40px] pt-[22px]">
            <AnimatePresence mode="wait">
                <motion.div
                    key={sel ? sel.id : "empty"}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1, transition: { duration: MOTION.durMacro, ease: MOTION.easeFluid } }}
                    exit={{ opacity: 0, transition: { duration: MOTION.durExit, ease: MOTION.easeFluid } }}
                >
                    {!sel ? (
                        <div className="text-[13px] text-ink-mid">Select a memory to see its content.</div>
                    ) : (
                        <DetailBody
                            sel={sel}
                            body={body}
                            related={related}
                            editing={editing}
                            draft={draft}
                            conflict={conflict}
                            setDraft={setDraft}
                            startEdit={startEdit}
                            doSave={doSave}
                            setEditing={setEditing}
                            setConflict={setConflict}
                        />
                    )}
                </motion.div>
            </AnimatePresence>
        </aside>
    );
```

Because the `!sel` guard now lives inside the aside, move the `m`, `relatedIds`, `related`, `startEdit`, `doSave` computations to be guarded (they reference `sel`). Simplest: keep them, but compute `related`/`m` only when `sel` is set by early-defaulting to empty arrays when `sel` is null (they are only read inside `DetailBody`, which renders only when `sel` is set). Guard the derefs:

```tsx
    const m = sel ? typeMeta(sel.type) : null;
    const relatedIds = new Set<string>();
    if (sel) {
        for (const e of edges) {
            if (e.from === sel.id) relatedIds.add(e.to);
            if (e.to === sel.id) relatedIds.add(e.from);
        }
    }
    const related = notes.filter((n) => relatedIds.has(n.id));
```

- [ ] **Step 2: Extract `DetailBody` with the inner content/edit crossfade**

Add a `DetailBody` component (above `DetailRail`) that holds the former selected-note markup (type pill, title, content, meta, buttons, related). Inside it, wrap only the content region (the former `editing ? <textarea> : <div>…</div>`) in a nested `AnimatePresence mode="wait"` keyed on the edit/load state, with `initial={false}` so it does NOT re-animate on a fresh selection mount (the outer crossfade already covers that) — it animates only on subsequent edit-toggle or body-load transitions within the same note:

```tsx
            <div className="mb-[8px] font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-mid">Content</div>
            <AnimatePresence mode="wait" initial={false}>
                <motion.div
                    key={editing ? "edit" : body == null ? "load" : "ready"}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1, transition: { duration: MOTION.durMacro, ease: MOTION.easeFluid } }}
                    exit={{ opacity: 0, transition: { duration: MOTION.durExit, ease: MOTION.easeFluid } }}
                >
                    {editing ? (
                        <textarea
                            autoFocus
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            className="mb-[10px] h-[220px] w-full resize-none rounded-[10px] border border-accent/40 bg-background px-[15px] py-[13px] font-mono text-[12.5px] leading-[1.6] text-ink-hi outline-none"
                        />
                    ) : (
                        <div className="mb-[10px] rounded-[10px] border border-edge-faint bg-background px-[15px] py-[13px] text-[13.5px] leading-[1.6] text-ink-hi">
                            {body == null ? "Loading…" : <MarkdownMessage text={body.body || sel.description} />}
                        </div>
                    )}
                </motion.div>
            </AnimatePresence>
```

The rest of `DetailBody` (conflict banner, buttons, meta rows, related list) is the unchanged markup lifted verbatim from the current `DetailRail` selected branch (lines 186-283), with `m` passed in as non-null (it is guaranteed set when `DetailBody` renders). Keep `MetaRow` as-is.

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. (Watch for null-narrowing on `sel`/`m` — `DetailBody` receives them as non-null props.)

- [ ] **Step 4: Visual verify (detail rail)**

Run: `node scripts/cdp-shot.mjs mem-detail.png`
Expected (by inspection): selecting a different note crossfades the rail content (no hard "Loading…" pop); toggling Edit crossfades between the textarea and rendered markdown; the empty→first-selection transition fades.

---

### Task 4: Graph settle cue + List↔Graph toggle crossfade

**Files:**
- Modify: `frontend/app/view/agents/memgraph.tsx` (settle cue)
- Modify: `frontend/app/view/agents/memorysurface.tsx` (toggle crossfade)

**Interfaces:**
- Consumes: `useSettle` from `@/app/element/motionhooks`; `AnimatePresence`, `motion`, `MOTION` (already imported in Task 2).

- [ ] **Step 1: Add the graph settle cue**

In `memgraph.tsx`, add the import and a `cooled` state, reset it when `data` changes, set it on engine stop, and apply the settle class to the container.

Import (with the existing React imports):

```ts
import { useSettle } from "@/app/element/motionhooks";
```

Add state near the other `useState`/`useRef` (after line 65 `const [size, setSize] = useState(...)`):

```ts
    const [cooled, setCooled] = useState(false); // flips true when the sim cools -> one-shot settle cue (m4)
    const settling = useSettle(cooled);
```

In the data-change reset effect (lines 91-94), also reset `cooled`:

```ts
    useEffect(() => {
        fitted.current = false;
        settled.current = false;
        setCooled(false);
    }, [data]);
```

In `onEngineStop` (line 195), set it true:

```ts
                        onEngineStop={() => {
                            settled.current = true;
                            setCooled(true);
                            if (!fitted.current) {
                                fgRef.current?.zoomToFit?.(600, 50); // animated fit
                                fitted.current = true;
                            }
                            fgRef.current?.refresh?.(); // repaint so labels appear now that it's settled
                        }}
```

Apply the settle class to the container `<div>` (line 169):

```tsx
        <div
            ref={containerRef}
            className={cn(
                "absolute inset-0 overflow-hidden",
                settling && "animate-[settle_0.5s_ease-out] motion-reduce:animate-none"
            )}
        >
```

Add `cn` to the imports from `@/util/util` (the file already imports `fireAndForget` from there):

```ts
import { cn, fireAndForget } from "@/util/util";
```

- [ ] **Step 2: Crossfade the pane on List↔Graph toggle**

In `memorysurface.tsx`, wrap the `view === "list" ? <ListView/> : <MemGraph/>` branch in an `AnimatePresence mode="wait" initial={false}` keyed on `view`, so toggling crossfades and the first mount does not (the list load-reveal / graph sim own first appearance). Replace the loaded/non-empty branch (lines 334-338) with:

```tsx
                    ) : (
                        <AnimatePresence mode="wait" initial={false}>
                            <motion.div
                                key={view}
                                className="absolute inset-0"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                transition={{ duration: MOTION.durMacro, ease: MOTION.easeFluid }}
                            >
                                {view === "list" ? (
                                    <div className="absolute inset-0 overflow-auto">
                                        <ListView notes={filtered} selectedId={selectedId} rp={rp} mountedEmpty={mountedEmpty} />
                                    </div>
                                ) : (
                                    <MemGraph notes={filtered} selectedId={selectedId} />
                                )}
                            </motion.div>
                        </AnimatePresence>
                    )}
```

Because the crossfade wrapper is `absolute inset-0`, drop the `view === "graph" ? "overflow-hidden" : "overflow-auto"` toggle on the outer pane `<div>` (the inner wrappers now own overflow); set the outer pane `<div>` to a plain `className="relative min-w-0 flex-1 overflow-hidden"`. Keep the `!loaded` and `notes.length === 0` branches outside the `AnimatePresence` (they are not a view swap).

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Visual verify (graph + toggle)**

Run: `node scripts/cdp-shot.mjs mem-graph.png` (after toggling to Graph in the running dev app)
Expected (by inspection): switching List↔Graph crossfades the pane (no hard cut, no second entrance firing underneath); the graph plays one soft settle when the sim cools; graph physics otherwise feel unchanged. Only if the settle reads as bouncy, revisit the `d3AlphaDecay`/`cooldownTime` params — do not tune preemptively.

---

### Task 5: Reduced-motion check, tracker update, single commit

**Files:**
- Modify: `docs/superpowers/animation-revamp-tracker.md`

- [ ] **Step 1: Reduced-motion verification**

Enable OS "reduce motion" (Windows: Settings → Accessibility → Visual effects → Animation effects off), reload the dev app, and re-capture:
Run: `node scripts/cdp-shot.mjs mem-reduced.png`
Expected (by inspection): list appears with no fade/cascade; search/toggle/detail changes are instant; the graph settle does not play. (The `MotionConfig reducedMotion="user"` + `motion-reduce:animate-none` handle this.)

- [ ] **Step 2: Full typecheck once more**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 3: Flip the Memory row in the tracker**

In `docs/superpowers/animation-revamp-tracker.md`, change the Memory row (line 72) from `☐ Not started` to shipped, and add the design/plan references at the bottom. Example row:

```markdown
| Memory | ✅ Shipped (2026-07-04) | List: load reveal + reflow flag (silent search / animated mutations, Sessions idiom) + selection micro. DetailRail: content + edit crossfades (m5). Graph: one-shot settle cue (m4) on cooldown; physics untouched. List↔Graph toggle crossfade. `<MotionConfig reducedMotion="user">` at root. No new tokens/module. SHA `<fill-after-commit>`. |
```

Add to the References list:

```markdown
- Memory motion design spec: `docs/superpowers/specs/2026-07-04-memory-motion-design.md`
- Memory motion implementation plan: `docs/superpowers/plans/2026-07-04-memory-motion-system.md`
```

- [ ] **Step 4: Self-review the diff**

Run: `git diff --stat` then review each hunk. Confirm: no per-task commits were made; no debug statements; no commented-out code; no new files besides the spec/plan docs; imports are used; the dropped `overflow` toggle and dropped row-gap wrapper are intentional.

- [ ] **Step 5: Commit (requires explicit user approval first)**

Present the file list and message, ask "Awaiting approval. Proceed? (yes/no)", and only on `yes`:

```bash
git add frontend/app/view/agents/memorysurface.tsx frontend/app/view/agents/memgraph.tsx frontend/app/view/agents/memstore.ts docs/superpowers/specs/2026-07-04-memory-motion-design.md docs/superpowers/plans/2026-07-04-memory-motion-system.md docs/superpowers/animation-revamp-tracker.md
git commit -m "feat(memory): motion system for list, detail rail, and graph"
```

Then fill the real SHA into the tracker's Memory row (amend or a tiny follow-up per the repo's convention for the other surface rows).

---

## Self-Review

**Spec coverage:**
- List load reveal (m1) → Task 2 Step 3/4 (`mountedEmpty` fade). ✓
- List entrance/exit/reflow (m1/m2) + no-cascade → Task 2 Step 3 (`cardVariants` + `AnimatePresence` + `rp`, flag defaults false). ✓
- Search instant / mutation animated → Task 1 (atom + mutation flags) + Task 2 Step 2 (search resets flag). ✓
- Selection micro (m7) → Task 2 Step 3 (`transition-colors duration-150`). ✓
- DetailRail content crossfade + empty→content (m5) → Task 3 Step 1 (outer `AnimatePresence` keyed on `sel?.id ?? "empty"`). ✓
- DetailRail edit swap + load pop → Task 3 Step 2 (inner crossfade keyed on `editing`/`body`, `initial={false}`). ✓
- Related-memory rides the selection crossfade → Task 3 (inside `DetailBody`). ✓
- Graph settle cue (m4) → Task 4 Step 1. ✓
- Graph physics untouched → Task 4 Step 1 (only `cooled` state added; no param change). ✓
- Toggle crossfade → Task 4 Step 2. ✓
- Reduced motion → Task 2 Step 4 (`MotionConfig`) + Task 4 Step 1 (`motion-reduce`) + Task 5 Step 1 (verify). ✓
- No new tokens/module → Global Constraints + all tasks reuse. ✓

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N"; every code step shows full code. The only deferred literal is `<fill-after-commit>` for the SHA, which is unknowable until Task 5 Step 5 — flagged explicitly, not a gap.

**Type consistency:** `ReflowProps` imported as a type in Task 2 and consumed as `ListView`'s `rp` prop; `reflowProps(reflowAnimated)` returns it. `memReflowAnimatedAtom` typed `PrimitiveAtom<boolean>` (Task 1) and read via `useAtomValue` (Task 2). `useSettle(cooled: boolean): boolean` (Task 4) matches `motionhooks.ts`. `DetailBody` receives `sel`/`m` as non-null (guarded by the `!sel` branch in Task 3 Step 1). Names consistent across tasks.
